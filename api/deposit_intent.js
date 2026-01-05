import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TO_ADDRESS = process.env.TREASURY_TON_ADDRESS;

function toNanoString(ton) {
  return String(Math.floor(ton * 1e9));
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    if (!TO_ADDRESS) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const amountTon = Number(body.amountTon);

    if (!amountTon || amountTon <= 0) return res.status(400).json({ error: "bad_amount" });
    if (amountTon < 0.1) return res.status(400).json({ error: "min_amount_0_1" });

    const intentId = crypto.randomBytes(16).toString("hex");
    const comment = `ICEFISHING_DEPOSIT:${intentId}`;
    const amountNano = toNanoString(amountTon);

    await redis.set(
      `dep:intent:${intentId}`,
      JSON.stringify({
        intentId,
        toAddress: TO_ADDRESS,
        amountNano,
        amountTon,
        comment,
        createdAt: Date.now(),
        status: "created",
      }),
      { ex: 60 * 30 }
    );

    // payload будет собираться на фронте как BOC (Cell)
    res.status(200).json({
      intentId,
      toAddress: TO_ADDRESS,
      amountTon,
      amountNano,
      comment,
      createdAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: "deposit_intent_error", message: String(e) });
  }
}
