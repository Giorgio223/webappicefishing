import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TONAPI_KEY = process.env.TONAPI_KEY;
const TREASURY = process.env.TREASURY_TON_ADDRESS;
const MIN_WAIT_MS = 15_000;

function normalizeToRaw(a) {
  return Address.parse(String(a).trim()).toRawString();
}

function rawToFriendly(raw) {
  return Address.parse(raw).toString({ urlSafe: true, bounceable: false, testOnly: false });
}

async function tonapiGet(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
  });
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (!r.ok) throw new Error(`tonapi_${r.status}:${j.error || j.message || "unknown"}`);
  return j;
}

function extractComment(inMsg) {
  if (!inMsg) return "";
  const parts = [];
  if (inMsg.message) parts.push(String(inMsg.message));
  if (inMsg.decoded_body?.text) parts.push(String(inMsg.decoded_body.text));
  if (inMsg.decoded_body?.comment) parts.push(String(inMsg.decoded_body.comment));
  return parts.join(" | ");
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (!TONAPI_KEY) return res.status(500).json({ error: "no_tonapi_key" });
    if (!TREASURY) return res.status(500).json({ error: "no_treasury_address" });

    let intentId = "";
    let userWallet = "";

    if (req.method === "GET") {
      intentId = String(req.query.intentId || "").trim();
      userWallet = String(req.query.address || "").trim();
    } else if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      intentId = String(body.intentId || "").trim();
      userWallet = String(body.address || "").trim();
    } else {
      return res.status(405).json({ error: "method" });
    }

    if (!intentId || !userWallet) {
      return res.status(400).json({ error: "bad_request", need: ["intentId", "address"] });
    }

    const userRaw = normalizeToRaw(userWallet);
    const treasuryRaw = normalizeToRaw(TREASURY);
    const treasuryFriendly = rawToFriendly(treasuryRaw);

    const intentKey = `dep:intent:${intentId}`;
    const intentRaw = await redis.get(intentKey);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });

    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;
    const createdAt = Number(intent.createdAt || 0);
    if (createdAt && Date.now() - createdAt < MIN_WAIT_MS) {
      return res.status(200).json({ status: "wait" });
    }

    const creditedKey = `dep:credited:${intentId}`;
    if (await redis.get(creditedKey)) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano || 0) / 1e9 });
    }

    const wantAmountNano = String(intent.amountNano || "0");
    const wantComment = String(intent.comment || `ICEFISHING_DEPOSIT:${intentId}`).trim();
    const createdAtSec = createdAt ? Math.floor(createdAt / 1000) : 0;

    const txs = await tonapiGet(`/blockchain/accounts/${encodeURIComponent(treasuryFriendly)}/transactions?limit=250`);
    const list = txs.transactions || [];

    let found = null;
    for (const tx of list) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      const value = String(inMsg.value || "0");
      if (value !== wantAmountNano) continue;

      const utime = Number(tx.utime || tx.now || 0);
      if (createdAtSec && utime && utime < createdAtSec - 180) continue;

      // destination == treasury (best effort)
      try {
        const destLike = inMsg.destination || inMsg?.destination?.address;
        if (destLike) {
          const destRaw = normalizeToRaw(destLike);
          if (destRaw !== treasuryRaw) continue;
        }
      } catch {}

      // comment match if visible, иначе fallback amount+time
      const blob = extractComment(inMsg);
      if (blob && blob.includes(wantComment)) {
        found = tx; break;
      }
      found = tx; break;
    }

    if (!found) {
      return res.status(200).json({
        status: "pending",
        debug: { treasuryFriendly, wantAmountNano, wantComment }
      });
    }

    // ✅ CREDIT
    const balKey = `bal:${userRaw}`;
    const cur = Number((await redis.get(balKey)) || "0") || 0;
    const next = cur + Number(intent.amountNano || 0);

    await redis.set(balKey, String(next));
    await redis.set(creditedKey, "1", { ex: 60 * 60 * 24 });

    await redis.set(intentKey, JSON.stringify({ ...intent, status: "credited", creditedAt: Date.now() }), { ex: 60 * 60 });

    return res.status(200).json({
      status: "credited",
      creditedTon: Number(intent.amountNano || 0) / 1e9,
      balKey,
      newBalanceNano: String(next)
    });
  } catch (e) {
    return res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
