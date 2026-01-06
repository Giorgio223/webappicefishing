import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TONAPI_KEY = process.env.TONAPI_KEY || "";
const TREASURY = process.env.TREASURY_TON_ADDRESS || "";
const TX_LIMIT = 50;

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}
function canonicalRaw(addr) {
  return Address.parse(String(addr)).toRawString();
}

async function tonapiGet(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`tonapi_${r.status}:${JSON.stringify(j)}`);
  return j;
}

function pickFirstString(...vals) {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

function getComment(tx) {
  return pickFirstString(
    tx?.in_msg?.decoded_body?.comment,
    tx?.in_msg?.decoded_body?.text,
    tx?.in_msg?.message,
    tx?.in_msg?.decoded_op_name
  );
}

function getAmountNano(tx) {
  const v = tx?.in_msg?.value;
  if (typeof v === "string" && v) return Number(v);
  if (typeof v === "number") return v;
  return 0;
}

function getHash(tx) {
  return pickFirstString(tx?.hash, tx?.transaction_id?.hash);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    let intentId = "";
    let address = "";

    if (req.method === "POST") {
      intentId = String(req.body?.intentId || "").trim();
      address = String(req.body?.address || "").trim();
    } else if (req.method === "GET") {
      intentId = String(req.query?.intentId || "").trim();
      address = String(req.query?.address || "").trim();
    } else {
      return res.status(405).json({ error: "method" });
    }

    if (!intentId) return res.status(400).json({ error: "no_intentId" });
    if (!address) return res.status(400).json({ error: "no_address" });
    if (!TREASURY) return res.status(500).json({ error: "no_treasury" });

    const userWallet = canonicalFriendly(address);

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });

    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    if (intent.status === "credited") {
      // на всякий случай чистим pending
      await redis.srem(`dep:pending:${userWallet}`, intentId);
      return res.status(200).json({
        status: "credited",
        creditedTon: Number(intent.amountNano) / 1e9,
      });
    }

    const wantComment = String(intent.comment || "").trim();
    const needNano = Number(intent.amountNano || "0");

    const treasuryRaw = canonicalRaw(TREASURY);

    const txs = await tonapiGet(
      `/blockchain/accounts/${encodeURIComponent(treasuryRaw)}/transactions?limit=${TX_LIMIT}`
    );

    const list = Array.isArray(txs?.transactions) ? txs.transactions : [];

    let matched = null;
    for (const tx of list) {
      const c = getComment(tx);
      if (c !== wantComment) continue;

      const amount = getAmountNano(tx);
      if (!Number.isFinite(amount) || amount < needNano) continue;

      matched = tx;
      break;
    }

    if (!matched) return res.status(200).json({ status: "pending", checked: list.length });

    const txHash = getHash(matched);
    if (!txHash) return res.status(200).json({ status: "pending" });

    // идемпотентность по tx_hash
    const txKey = `dep:tx:${txHash}`;
    const locked = await redis.set(txKey, "1", { nx: true, ex: 24 * 60 * 60 });

    const markCredited = async () => {
      const newIntent = {
        ...intent,
        status: "credited",
        creditedAt: Date.now(),
        txHash,
        creditedTo: userWallet,
      };
      await redis.set(`dep:intent:${intentId}`, JSON.stringify(newIntent), { ex: 24 * 60 * 60 });
      await redis.set(`dep:credited:${intentId}`, JSON.stringify(newIntent), { ex: 24 * 60 * 60 });
      await redis.srem(`dep:pending:${userWallet}`, intentId);
    };

    if (!locked) {
      await markCredited();
      return res.status(200).json({ status: "credited", creditedTon: needNano / 1e9 });
    }

    // начисляем
    await redis.incrby(`bal:${userWallet}`, needNano);
    await markCredited();

    return res.status(200).json({ status: "credited", creditedTon: needNano / 1e9 });
  } catch (e) {
    return res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
