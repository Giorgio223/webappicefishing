import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TONAPI_KEY = process.env.TONAPI_KEY;
const TREASURY = process.env.TREASURY_TON_ADDRESS;
const MIN_WAIT_MS = 45_000;

function normalizeToRaw(addressLike) {
  return Address.parse(String(addressLike).trim()).toRawString(); // "0:..."
}

function rawToFriendly(raw) {
  return Address.parse(raw).toString({
    urlSafe: true,
    bounceable: false,
    testOnly: false,
  });
}

async function tonapiGet(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`tonapi_${r.status}:${j.error || j.message || "unknown"}`);
  return j;
}

function extractComment(inMsg) {
  if (!inMsg) return "";
  // tonapi может раскладывать по-разному
  const parts = [];
  if (inMsg.message) parts.push(String(inMsg.message));
  if (inMsg.decoded_body?.text) parts.push(String(inMsg.decoded_body.text));
  if (inMsg.decoded_body?.comment) parts.push(String(inMsg.decoded_body.comment));
  return parts.join(" | ");
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    if (!TONAPI_KEY) return res.status(500).json({ error: "no_tonapi_key" });
    if (!TREASURY) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const intentId = String(body.intentId || "").trim();
    const userWalletIn = String(body.address || "").trim();
    if (!intentId || !userWalletIn) return res.status(400).json({ error: "bad_request" });

    let userWalletRaw;
    try { userWalletRaw = normalizeToRaw(userWalletIn); }
    catch { return res.status(400).json({ error: "bad_wallet_address" }); }

    let treasuryRaw;
    try { treasuryRaw = normalizeToRaw(TREASURY); }
    catch { return res.status(500).json({ error: "bad_treasury_address" }); }
    const treasuryFriendly = rawToFriendly(treasuryRaw);

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });
    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    const createdAt = Number(intent.createdAt || 0);
    const age = Date.now() - createdAt;
    if (createdAt && age < MIN_WAIT_MS) {
      return res.status(200).json({ status: "wait", retryAfterMs: MIN_WAIT_MS - age });
    }

    const creditedKey = `dep:credited:${intentId}`;
    if (await redis.get(creditedKey)) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano||0)/1e9 });
    }

    const wantAmountNano = String(intent.amountNano || "0");
    const wantComment = String(intent.comment || `ICEFISHING_DEPOSIT:${intentId}`).trim();
    const createdAtSec = createdAt ? Math.floor(createdAt / 1000) : 0;

    const txs = await tonapiGet(
      `/blockchain/accounts/${encodeURIComponent(treasuryFriendly)}/transactions?limit=250`
    );
    const list = txs.transactions || [];

    let found = null;
    for (const tx of list) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      const value = String(inMsg.value || "0");
      if (value !== wantAmountNano) continue;

      const utime = Number(tx.utime || tx.now || 0);
      if (createdAtSec && utime && utime < createdAtSec - 120) continue;

      // destination must be treasury (best effort)
      try {
        const destLike = inMsg.destination || inMsg?.destination?.address;
        if (destLike) {
          const destRaw = normalizeToRaw(destLike);
          if (destRaw !== treasuryRaw) continue;
        }
      } catch {}

      // If comment is visible, use it. If not visible, still accept amount+time match.
      const blob = extractComment(inMsg);
      if (blob && wantComment && blob.includes(wantComment)) {
        found = tx; break;
      }

      // fallback: amount+time is enough
      found = tx; break;
    }

    if (!found) {
      return res.status(200).json({
        status: "pending",
        debug: { treasuryFriendly, wantAmountNano, wantComment, createdAt }
      });
    }

    // credit balance (RAW key only)
    const balKey = `bal:${userWalletRaw}`;
    const cur = Number((await redis.get(balKey)) || "0");
    const next = cur + Number(intent.amountNano || 0);

    await redis.set(balKey, String(next));
    await redis.set(creditedKey, "1", { ex: 60 * 60 * 24 });

    await redis.set(
      `dep:intent:${intentId}`,
      JSON.stringify({ ...intent, status: "credited", creditedAt: Date.now() }),
      { ex: 60 * 60 }
    );

    return res.status(200).json({
      status: "credited",
      creditedTon: Number(intent.amountNano||0)/1e9,
      addressRaw: userWalletRaw,
      balKey,
      newBalanceNano: String(next)
    });
  } catch (e) {
    return res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
