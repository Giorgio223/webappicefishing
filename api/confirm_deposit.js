import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TONAPI_KEY = process.env.TONAPI_KEY;
const TO_ADDRESS = process.env.TREASURY_TON_ADDRESS;

const MIN_WAIT_MS = 45_000;

async function tonapiGetJson(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
  });
  if (!r.ok) throw new Error(`tonapi_${r.status}`);
  return await r.json();
}

function normAddr(a) {
  return String(a || "").trim().toLowerCase();
}

// TonAPI может прятать комментарий в разных местах
function extractPossibleComment(inMsg) {
  if (!inMsg) return "";

  // 1) классика
  if (typeof inMsg.message === "string" && inMsg.message.trim()) return inMsg.message.trim();

  // 2) decoded_body.text (часто так)
  if (inMsg.decoded_body && typeof inMsg.decoded_body.text === "string" && inMsg.decoded_body.text.trim()) {
    return inMsg.decoded_body.text.trim();
  }

  // 3) иногда comment/text лежит иначе — пробуем найти строку в JSON
  try {
    const s = JSON.stringify(inMsg);
    return s; // вернём строку, ниже будем делать includes
  } catch {
    return "";
  }
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    if (!TONAPI_KEY) return res.status(500).json({ error: "no_tonapi_key" });
    if (!TO_ADDRESS) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const intentId = String(body.intentId || "");
    const address = String(body.address || "");
    if (!intentId || !address) return res.status(400).json({ error: "bad_request" });

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });
    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    // ждём минимум 45 сек от createdAt
    const createdAt = Number(intent.createdAt || 0);
    if (createdAt && Date.now() - createdAt < MIN_WAIT_MS) {
      return res.status(200).json({ status: "wait", retryAfterMs: MIN_WAIT_MS - (Date.now() - createdAt) });
    }

    const creditedKey = `dep:credited:${intentId}`;
    const already = await redis.get(creditedKey);
    if (already) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
    }

    const wantComment = String(intent.comment || "").trim();
    const wantAmount = String(intent.amountNano || "0");

    // берём побольше транзакций
    const txs = await tonapiGetJson(`/blockchain/accounts/${encodeURIComponent(TO_ADDRESS)}/transactions?limit=50`);

    let found = null;

    for (const tx of (txs.transactions || [])) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // сумма
      const amount = String(inMsg.value || "0");
      if (amount !== wantAmount) continue;

      // sender обязателен и должен совпасть
      const src =
        inMsg.source?.address ||
        inMsg.source ||
        inMsg.src?.address ||
        inMsg.src ||
        "";

      if (!src) continue;
      if (normAddr(src) !== normAddr(address)) continue;

      // comment ищем гибко
      const extracted = extractPossibleComment(inMsg);

      // если extracted это ровно comment
      if (typeof extracted === "string" && extracted.trim() === wantComment) {
        found = tx;
        break;
      }

      // если extracted это JSON-string (fallback) — проверяем contains
      if (typeof extracted === "string" && extracted.includes(wantComment)) {
        found = tx;
        break;
      }
    }

    if (!found) return res.status(200).json({ status: "pending" });

    // зачисляем
    const balKey = `bal:${address}`;
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
    res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
