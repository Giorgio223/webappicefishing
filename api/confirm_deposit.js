import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TONAPI_KEY = process.env.TONAPI_KEY || "";
const TREASURY = process.env.TREASURY_TON_ADDRESS || "";

// сколько транзакций казны смотрим (если казна активная — увеличь до 50/100)
const TX_LIMIT = 30;

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

async function tonapiGet(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`tonapi_error:${r.status}:${JSON.stringify(j)}`);
  }
  return j;
}

function extractComment(tx) {
  // tonapi может класть коммент в разных местах
  const c1 = tx?.in_msg?.decoded_body?.comment;
  if (typeof c1 === "string" && c1) return c1;

  const c2 = tx?.in_msg?.message;
  if (typeof c2 === "string" && c2) return c2;

  return "";
}

function extractAmountNano(tx) {
  const v = tx?.in_msg?.value;
  if (typeof v === "string" && v) return v;
  if (typeof v === "number") return String(v);
  return "0";
}

function extractTxHash(tx) {
  return tx?.hash || tx?.transaction_id?.hash || "";
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const method = req.method || "GET";

    // поддержим и GET и POST (у тебя раньше было {"error":"method"})
    let intentId = "";
    let address = "";

    if (method === "POST") {
      intentId = String(req.body?.intentId || "").trim();
      address = String(req.body?.address || "").trim();
    } else if (method === "GET") {
      intentId = String(req.query?.intentId || "").trim();
      address = String(req.query?.address || "").trim();
    } else {
      return res.status(405).json({ error: "method" });
    }

    if (!intentId) return res.status(400).json({ error: "no_intentId" });
    if (!address) return res.status(400).json({ error: "no_address" });
    if (!TREASURY) return res.status(500).json({ error: "no_treasury_address" });

    const userWallet = canonicalFriendly(address);
    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });

    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    if (intent.status === "credited") {
      return res.status(200).json({
        status: "credited",
        creditedTon: Number(intent.amountNano) / 1e9,
      });
    }

    const treasuryFriendly = canonicalFriendly(TREASURY);

    // 1) берём последние транзакции казны
    const txs = await tonapiGet(
      `/blockchain/accounts/${encodeURIComponent(treasuryFriendly)}/transactions?limit=${TX_LIMIT}`
    );

    const list = Array.isArray(txs?.transactions) ? txs.transactions : [];

    // 2) ищем входящий перевод с нашим комментом
    const wantComment = String(intent.comment || "");
    let matched = null;

    for (const tx of list) {
      const comment = extractComment(tx);
      if (comment !== wantComment) continue;

      const amountNanoStr = extractAmountNano(tx);
      const amountNano = Number(amountNanoStr || "0");

      const need = Number(intent.amountNano || "0");
      if (!Number.isFinite(amountNano) || amountNano < need) continue;

      matched = tx;
      break;
    }

    if (!matched) {
      return res.status(200).json({ status: "pending" });
    }

    const txHash = extractTxHash(matched);
    if (!txHash) {
      // редкий кейс, но пусть не кредитит без хеша
      return res.status(200).json({ status: "pending" });
    }

    // 3) защита от двойного начисления по tx_hash
    const lockKey = `dep:tx:${txHash}`;
    const locked = await redis.set(lockKey, "1", { nx: true, ex: 24 * 60 * 60 });
    if (!locked) {
      // уже кредитили по этой транзе
      await redis.set(
        `dep:intent:${intentId}`,
        JSON.stringify({ ...intent, status: "credited", creditedAt: Date.now(), txHash }),
        { ex: 60 * 60 }
      );
      return res.status(200).json({
        status: "credited",
        creditedTon: Number(intent.amountNano) / 1e9,
      });
    }

    // 4) начисляем баланс
    const addNano = Number(intent.amountNano || "0");
    if (!Number.isFinite(addNano) || addNano <= 0) {
      return res.status(400).json({ error: "bad_intent_amount" });
    }

    const balKey = `bal:${userWallet}`;
    await redis.incrby(balKey, addNano);

    // 5) помечаем intent credited
    const creditedAt = Date.now();
    const newIntent = { ...intent, status: "credited", creditedAt, txHash, creditedTo: userWallet };

    await redis.set(`dep:intent:${intentId}`, JSON.stringify(newIntent), { ex: 60 * 60 });
    await redis.set(`dep:credited:${intentId}`, JSON.stringify(newIntent), { ex: 24 * 60 * 60 });

    return res.status(200).json({
      status: "credited",
      creditedTon: addNano / 1e9,
    });
  } catch (e) {
    return res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
