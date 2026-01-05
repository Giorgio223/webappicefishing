import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TONAPI_KEY = process.env.TONAPI_KEY;
const TO_ADDRESS = process.env.TREASURY_TON_ADDRESS;

async function tonapiGetJson(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
  });
  if (!r.ok) throw new Error(`tonapi_${r.status}`);
  return await r.json();
}

// TonAPI может отдавать разные форматы адресов. Упростим сравнение: lower + trim
function normAddr(a) {
  return String(a || "").trim().toLowerCase();
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    if (!TONAPI_KEY) return res.status(500).json({ error: "no_tonapi_key" });
    if (!TO_ADDRESS) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const intentId = String(body.intentId || "");
    const address = String(body.address || ""); // адрес подключённого кошелька
    if (!intentId || !address) return res.status(400).json({ error: "bad_request" });

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });

    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    const creditedKey = `dep:credited:${intentId}`;
    const already = await redis.get(creditedKey);
    if (already) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
    }

    // Берём последние входящие на treasury
    const txs = await tonapiGetJson(`/blockchain/accounts/${encodeURIComponent(TO_ADDRESS)}/transactions?limit=30`);
    const wantComment = String(intent.comment || "").trim();
    const wantAmount = String(intent.amountNano || "0");

    let found = null;

    for (const tx of (txs.transactions || [])) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // 1) сумма
      const amount = String(inMsg.value || "0");
      if (amount !== wantAmount) continue;

      // 2) comment
      const msg = String(inMsg.message || "").trim();
      if (msg !== wantComment) continue;

      // 3) отправитель (если TonAPI отдаёт)
      // у TonAPI бывает: in_msg.source.address / in_msg.source
      const src =
        inMsg.source?.address ||
        inMsg.source ||
        inMsg.src?.address ||
        inMsg.src ||
        "";

      if (src) {
        if (normAddr(src) !== normAddr(address)) continue;
      }
      // если src отсутствует — всё равно можно принять по comment+amount (но лучше чтобы был)
      found = tx;
      break;
    }

    if (!found) return res.status(200).json({ status: "pending" });

    // ✅ зачисление на баланс ЭТОГО адреса
    const balKey = `bal:${address}`;
    const current = Number((await redis.get(balKey)) || "0");
    const next = current + Number(intent.amountNano);
    await redis.set(balKey, String(next));

    await redis.set(creditedKey, "1", { ex: 60 * 60 * 24 });
    await redis.set(
      `dep:intent:${intentId}`,
      JSON.stringify({ ...intent, status: "credited", creditedAt: Date.now() }),
      { ex: 60 * 60 }
    );

    return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
  } catch (e) {
    res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
