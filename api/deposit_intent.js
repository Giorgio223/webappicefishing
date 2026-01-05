import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ⚠️ куда пользователи будут отправлять TON (твой “treasury” адрес)
const TO_ADDRESS = process.env.TREASURY_TON_ADDRESS;
// минимальный депозит (например 0.2 TON)
const AMOUNT_TON = Number(process.env.DEPOSIT_AMOUNT_TON || "0.2");

function toNanoString(ton) {
  return String(Math.floor(ton * 1e9));
}

// делаем base64 payload с комментарием (просто и стабильно)
function commentToBase64(comment) {
  // plain text comment -> base64 (TonConnect wallets понимают как payload)
  return btoa(unescape(encodeURIComponent(comment)));
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    if (!TO_ADDRESS) return res.status(500).json({ error: "no_treasury_address" });

    const intentId = crypto.randomBytes(16).toString("hex");
    const comment = `ICEFISHING_DEPOSIT:${intentId}`;

    // сохраняем intent (потом по нему будем подтверждать)
    await redis.set(`dep:intent:${intentId}`, JSON.stringify({
      intentId,
      toAddress: TO_ADDRESS,
      amountNano: toNanoString(AMOUNT_TON),
      comment,
      createdAt: Date.now(),
      status: "created"
    }), { ex: 60 * 30 }); // 30 минут

    res.status(200).json({
      intentId,
      toAddress: TO_ADDRESS,
      amountTon: AMOUNT_TON,
      amountNano: toNanoString(AMOUNT_TON),
      payloadBase64: commentToBase64(comment)
    });
  } catch (e) {
    res.status(500).json({ error: "deposit_intent_error", message: String(e) });
  }
}
