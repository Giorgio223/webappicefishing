import { Redis } from "@upstash/redis";
import crypto from "crypto";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function toNano(amountTon) {
  const n = Number(amountTon);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1e9);
}

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const { amountTon, address } = req.body || {};
    const amountNano = toNano(amountTon);
    if (!amountNano || amountNano <= 0) return res.status(400).json({ error: "bad_amount" });

    const TREASURY = process.env.TREASURY_TON_ADDRESS;
    if (!TREASURY) return res.status(500).json({ error: "no_treasury_address" });

    let userWallet = null;
    if (address) {
      try { userWallet = canonicalFriendly(address); } catch { userWallet = null; }
    }

    const toAddressFriendly = canonicalFriendly(TREASURY);
    const toAddressRaw = Address.parse(TREASURY).toRawString();

    const intentId = crypto.randomBytes(16).toString("hex");
    const comment = `ICEFISHING_DEPOSIT:${intentId}`;

    const intent = {
      intentId,
      toAddress: toAddressFriendly,
      toAddressRaw,
      toAddressFriendly,
      amountNano: String(amountNano),
      amountTon: amountNano / 1e9,
      amountTonExact: amountNano / 1e9,
      comment,
      createdAt: Date.now(),
      status: "created",
      userWallet, // может быть null
    };

    // intent храним 24 часа (чтобы “после закрытия” тоже успел)
    await redis.set(`dep:intent:${intentId}`, JSON.stringify(intent), { ex: 24 * 60 * 60 });

    // если знаем кошелёк юзера — добавляем в pending
    if (userWallet) {
      await redis.sadd(`dep:pending:${userWallet}`, intentId);
      await redis.expire(`dep:pending:${userWallet}`, 24 * 60 * 60);
    }

    return res.status(200).json(intent);
  } catch (e) {
    return res.status(500).json({ error: "deposit_intent_error", message: String(e) });
  }
}
