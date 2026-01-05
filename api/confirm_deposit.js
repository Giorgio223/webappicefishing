import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TONAPI_KEY = process.env.TONAPI_KEY;
const TO_ADDRESS = process.env.TREASURY_TON_ADDRESS;

async function tonapiGetJson(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { "Authorization": `Bearer ${TONAPI_KEY}` } : {}
  });
  if (!r.ok) throw new Error(`tonapi_${r.status}`);
  return await r.json();
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const { intentId, address } = req.body || {};
    if (!intentId || !address) return res.status(400).json({ error: "bad_request" });
    if (!TO_ADDRESS) return res.status(500).json({ error: "no_treasury_address" });

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });

    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    // если уже зачислено — вернуть статус
    const creditedKey = `dep:credited:${intentId}`;
    const already = await redis.get(creditedKey);
    if (already) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
    }

    if (!TONAPI_KEY) {
      return res.status(500).json({ error: "no_tonapi_key", message: "Add TONAPI_KEY env" });
    }

    // Ищем транзакцию на адрес TO_ADDRESS с comment = intent.comment
    // В TonAPI есть endpoint по событиям/транзакциям адреса
    const txs = await tonapiGetJson(`/blockchain/accounts/${encodeURIComponent(TO_ADDRESS)}/transactions?limit=20`);

    const wantComment = intent.comment;
    const wantAmount = String(intent.amountNano);

    let found = null;

    for (const tx of (txs.transactions || [])) {
      // ищем входящее сообщение (in_msg)
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // amount
      const amount = String(inMsg.value || "0");
      if (amount !== wantAmount) continue;

      // comment / payload text
      const msg = (inMsg.message || "").trim();
      if (msg !== wantComment) continue;

      found = tx;
      break;
    }

    if (!found) {
      return res.status(200).json({ status: "pending" });
    }

    // ✅ Зачисляем баланс пользователю (по его wallet address)
    const balKey = `bal:${address}`;
    const current = Number((await redis.get(balKey)) || "0");
    const next = current + Number(intent.amountNano);
    await redis.set(balKey, String(next));

    await redis.set(creditedKey, "1", { ex: 60 * 60 * 24 }); // 24 часа защита от повторного зачёта
    await redis.set(`dep:intent:${intentId}`, JSON.stringify({ ...intent, status: "credited", creditedAt: Date.now() }), { ex: 60 * 60 });

    return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
  } catch (e) {
    return res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
