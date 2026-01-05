import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TONAPI_KEY = process.env.TONAPI_KEY;
const TREASURY = process.env.TREASURY_TON_ADDRESS;

const MIN_WAIT_MS = 45_000;

async function tonapiGet(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`tonapi_${r.status}:${j.error || j.message || "unknown"}`);
  return j;
}

function extractComment(inMsg) {
  if (!inMsg) return "";
  // TonAPI часто кладёт комментарий сюда:
  if (typeof inMsg.message === "string" && inMsg.message.trim()) return inMsg.message.trim();
  // иногда так:
  if (inMsg.decoded_body && typeof inMsg.decoded_body.text === "string" && inMsg.decoded_body.text.trim()) {
    return inMsg.decoded_body.text.trim();
  }
  return "";
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    if (!TONAPI_KEY) return res.status(500).json({ error: "no_tonapi_key" });
    if (!TREASURY) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const intentId = String(body.intentId || "").trim();
    const userWallet = String(body.address || "").trim(); // ✅ ЭТО ДОЛЖЕН БЫТЬ КОШЕЛЕК ПОЛЬЗОВАТЕЛЯ (EQ/UQ)

    if (!intentId || !userWallet) return res.status(400).json({ error: "bad_request" });

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });

    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    const createdAt = Number(intent.createdAt || 0);
    const age = Date.now() - createdAt;

    // ждём 45 секунд
    if (createdAt && age < MIN_WAIT_MS) {
      return res.status(200).json({ status: "wait", retryAfterMs: MIN_WAIT_MS - age });
    }

    // уже зачислили?
    const creditedKey = `dep:credited:${intentId}`;
    const already = await redis.get(creditedKey);
    if (already) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
    }

    const wantAmountNano = String(intent.amountNano || "0");
    const wantComment = String(intent.comment || "").trim();
    const createdAtSec = createdAt ? Math.floor(createdAt / 1000) : 0;

    // берём транзакции treasury
    const txs = await tonapiGet(
      `/blockchain/accounts/${encodeURIComponent(TREASURY)}/transactions?limit=80`
    );

    let okTx = null;

    for (const tx of (txs.transactions || [])) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // сумма
      const value = String(inMsg.value || "0");
      if (value !== wantAmountNano) continue;

      // время (чтобы не поймать старую транзу)
      const utime = Number(tx.utime || tx.now || 0);
      if (createdAtSec && utime && utime < (createdAtSec - 60)) continue;

      // комментарий
      const msg = extractComment(inMsg);
      if (!msg) continue;
      if (!(msg === wantComment || msg.includes(wantComment))) continue;

      okTx = tx;
      break;
    }

    if (!okTx) return res.status(200).json({ status: "pending" });

    // ✅ ЗАЧИСЛЯЕМ НА БАЛАНС ПОЛЬЗОВАТЕЛЯ, А НЕ TREASURY
    const balKey = `bal:${userWallet}`;
    const cur = Number((await redis.get(balKey)) || "0");
    const next = cur + Number(intent.amountNano);

    await redis.set(balKey, String(next));
    await redis.set(creditedKey, "1", { ex: 60 * 60 * 24 });

    await redis.set(
      `dep:intent:${intentId}`,
      JSON.stringify({ ...intent, status: "credited", creditedAt: Date.now() }),
      { ex: 60 * 60 }
    );

    return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
  } catch (e) {
    return res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
