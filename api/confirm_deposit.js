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

function extractCommentAny(inMsg) {
  if (!inMsg) return "";
  if (typeof inMsg.message === "string" && inMsg.message.trim()) return inMsg.message.trim();

  const decoded = inMsg.decoded_body;
  if (decoded && typeof decoded.text === "string" && decoded.text.trim()) return decoded.text.trim();

  return "";
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    if (!TONAPI_KEY) return res.status(500).json({ error: "no_tonapi_key" });
    if (!TO_ADDRESS) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const intentId = String(body.intentId || "");
    const address = String(body.address || ""); // ✅ это адрес, по которому UI читает баланс (bal:<address>)
    if (!intentId || !address) return res.status(400).json({ error: "bad_request" });

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });
    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    // ждём 45 секунд от создания intent (как ты хотел)
    const createdAt = Number(intent.createdAt || 0);
    const age = Date.now() - createdAt;
    if (createdAt && age < MIN_WAIT_MS) {
      return res.status(200).json({ status: "wait", retryAfterMs: MIN_WAIT_MS - age });
    }

    // уже зачислено?
    const creditedKey = `dep:credited:${intentId}`;
    const already = await redis.get(creditedKey);
    if (already) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
    }

    const wantAmount = String(intent.amountNano || "0");
    const wantComment = String(intent.comment || "").trim();
    const createdAtSec = createdAt ? Math.floor(createdAt / 1000) : 0;

    // берём побольше транзакций
    const txs = await tonapiGetJson(
      `/blockchain/accounts/${encodeURIComponent(TO_ADDRESS)}/transactions?limit=80`
    );

    let found = null;

    for (const tx of (txs.transactions || [])) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // 1) сумма
      const amount = String(inMsg.value || "0");
      if (amount !== wantAmount) continue;

      // 2) время (чтобы не поймать старую транзу на ту же сумму)
      // tonapi обычно даёт utime / now (в секундах)
      const utime = Number(tx.utime || tx.now || 0);
      if (createdAtSec && utime && utime < (createdAtSec - 60)) continue;

      // 3) comment (не строго равно, а contains)
      const msg = extractCommentAny(inMsg);
      if (!msg) continue;
      if (!(msg === wantComment || msg.includes(wantComment))) continue;

      // ❗ sender-check УБРАН специально, потому что форматы адресов разные
      found = tx;
      break;
    }

    if (!found) return res.status(200).json({ status: "pending" });

    // ✅ зачисление на баланс адреса, который видит UI
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
