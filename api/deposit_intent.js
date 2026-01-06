import { Redis } from "@upstash/redis";
import crypto from "crypto";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TREASURY = process.env.TREASURY_TON_ADDRESS;

function toNano(amountTon) {
  const n = Number(amountTon);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e9);
}

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

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    if (!TREASURY) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const amountTon = Number(body.amountTon);

    if (!Number.isFinite(amountTon) || amountTon <= 0) return res.status(400).json({ error: "bad_amount" });
    if (amountTon < 0.1) return res.status(400).json({ error: "min_0_1" });

    const baseNano = toNano(amountTon);
    if (baseNano === null) return res.status(400).json({ error: "bad_amount" });

    // ✅ уникальный хвост 1..999 nanoTON (чтобы отличать одинаковые депозиты)
    const tail = 1 + Math.floor(Math.random() * 999);
    const amountNano = String(baseNano + tail);
    const amountTonExact = Number(amountNano) / 1e9;

    // ✅ нормализуем treasury
    let treasuryRaw;
    try {
      treasuryRaw = normalizeToRaw(TREASURY);
    } catch {
      return res.status(500).json({ error: "bad_treasury_address" });
    }

    const treasuryFriendly = rawToFriendly(treasuryRaw);

    const intentId = crypto.randomBytes(16).toString("hex");

    // ✅ ЭТОТ comment мы ищем в confirm_deposit.js
    const comment = `ICEFISHING_DEPOSIT:${intentId}`;

    const intent = {
      intentId,

      // адрес получателя депозита
      toAddress: TREASURY,                 // как задано в env (для совместимости)
      toAddressRaw: treasuryRaw,           // ✅ всегда RAW
      toAddressFriendly: treasuryFriendly, // ✅ friendly для фронта

      amountNano,
      amountTon,
      amountTonExact,

      // comment должен реально уйти в транзакцию TonConnect
      comment,

      createdAt: Date.now(),
      status: "created",
    };

    await redis.set(`dep:intent:${intentId}`, JSON.stringify(intent), { ex: 60 * 60 });

    return res.status(200).json(intent);
  } catch (e) {
    return res.status(500).json({ error: "deposit_intent_error", message: String(e) });
  }
}
