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
  return Address.parse(String(addressLike).trim()).toRawString(); // всегда "0:..."
}

async function tonapiGet(path) {
  const r = await fetch(`https://tonapi.io/v2${path}`, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
  });

  const text = await r.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text };
  }
  if (!r.ok) throw new Error(`tonapi_${r.status}:${j.error || j.message || "unknown"}`);
  return j;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    if (!TONAPI_KEY) return res.status(500).json({ error: "no_tonapi_key" });
    if (!TREASURY) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const intentId = String(body.intentId || "").trim();
    const userWalletIn = String(body.address || "").trim(); // может быть EQ/UQ/0:...
    if (!intentId || !userWalletIn) return res.status(400).json({ error: "bad_request" });

    // ✅ нормализуем адрес пользователя в RAW (0:...)
    let userWalletRaw;
    try {
      userWalletRaw = normalizeToRaw(userWalletIn);
    } catch {
      return res.status(400).json({ error: "bad_wallet_address" });
    }

    // ✅ нормализуем TREASURY тоже в RAW (на случай если он задан friendly)
    let treasuryRaw;
    try {
      treasuryRaw = normalizeToRaw(TREASURY);
    } catch {
      return res.status(500).json({ error: "bad_treasury_address" });
    }

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });

    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    const createdAt = Number(intent.createdAt || 0);
    const age = Date.now() - createdAt;
    if (createdAt && age < MIN_WAIT_MS) {
      return res.status(200).json({ status: "wait", retryAfterMs: MIN_WAIT_MS - age });
    }

    const creditedKey = `dep:credited:${intentId}`;
    const already = await redis.get(creditedKey);
    if (already) {
      return res.status(200).json({
        status: "credited",
        creditedTon: Number(intent.amountNano || 0) / 1e9,
      });
    }

    const wantAmountNano = String(intent.amountNano || "0");
    const createdAtSec = createdAt ? Math.floor(createdAt / 1000) : 0;

    // ✅ Берём транзакции входящие на TREASURY
    // В tonapi endpoint принимает friendly адрес, но RAW тоже обычно проходит.
    // Чтобы не гадать — отправляем адрес как в env (TREASURY), но фильтруем уже через RAW.
    const txs = await tonapiGet(
      `/blockchain/accounts/${encodeURIComponent(TREASURY)}/transactions?limit=160`
    );
    const list = txs.transactions || [];

    // Если в intent есть comment (или payload), попробуем матчить по нему
    // (это сильно повышает точность)
    const wantComment = String(intent.comment || intent.payload || intentId || "").trim();

    let found = null;

    for (const tx of list) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // 1) сумма должна совпасть
      const value = String(inMsg.value || "0");
      if (value !== wantAmountNano) continue;

      // 2) по времени (если знаем createdAt)
      const utime = Number(tx.utime || tx.now || 0);
      if (createdAtSec && utime && utime < createdAtSec - 120) continue;

      // 3) destination должен быть treasury (на всякий)
      // tonapi может отдавать адреса по-разному, поэтому нормализуем
      try {
        const dest = inMsg.destination ? normalizeToRaw(inMsg.destination) : "";
        if (dest && dest !== treasuryRaw) continue;
      } catch {
        // если destination не парсится — не заваливаем, просто не фильтруем по нему
      }

      // 4) Если есть comment/payload — матчим по нему (лучший вариант)
      // В tonapi поле бывает "message" (текстовый комментарий)
      const msgText = String(inMsg.message || "");
      if (wantComment) {
        // если в intent нет comment, wantComment = intentId
        // тогда тоже нормально: можно передавать intentId в комментарий транзакции
        if (msgText && msgText.includes(wantComment)) {
          found = tx;
          break;
        }
      } else {
        // комментарий не задан — тогда достаточно суммы + времени
        found = tx;
        break;
      }
    }

    if (!found) return res.status(200).json({ status: "pending" });

    // ✅ Начисляем баланс ТОЛЬКО по RAW ключу (как в balance.js / balance_adjust.js)
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
      creditedTon: Number(intent.amountNano || 0) / 1e9,
      addressRaw: userWalletRaw,
    });
  } catch (e) {
    return res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
