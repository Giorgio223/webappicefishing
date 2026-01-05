import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TREASURY = process.env.TREASURY_TON_ADDRESS;

function toNanoSafe(amountTon) {
  const n = Number(amountTon);
  if (!Number.isFinite(n) || n <= 0) return null;
  // безопасно: округляем до 9 знаков, потом переводим в nano
  const fixed = Math.round(n * 1e9);
  return fixed;
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

    const baseNano = toNanoSafe(amountTon);
    if (baseNano === null) return res.status(400).json({ error: "bad_amount" });

    // ✅ уникальный хвост (1..999 nanoTON) — не влияет на игрока, но делает депозит уникальным
    const tail = 1 + Math.floor(Math.random() * 999);
    const amountNano = String(baseNano + tail);

    // точное значение TON, чтобы показать пользователю (до 9 знаков)
    const amountTonExact = (Number(amountNano) / 1e9);

    const intentId = crypto.randomBytes(16).toString("hex");
    const comment = `ICEFISHING_DEPOSIT:${intentId}`; // можно оставить для удобства, но подтверждение будет по amountNano

    const intent = {
      intentId,
      toAddress: TREASURY,
      amountNano,         // ✅ именно эту сумму отправляем
      amountTon,          // то, что ввёл
      amountTonExact,     // ✅ то, что реально надо отправить (с хвостом)
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
