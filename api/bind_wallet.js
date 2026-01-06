import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

function normalizeToRaw(addr) {
  return Address.parse(String(addr).trim()).toRawString();
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const walletAddress = String(body.walletAddress || "").trim();
    const initData = String(body.initData || "").trim();

    if (!walletAddress) return res.status(400).json({ error: "no_wallet" });

    const walletRaw = normalizeToRaw(walletAddress);

    // Если хочешь — можно хранить привязку initData->walletRaw, но это не обязательно для баланса
    if (initData) {
      await redis.set(`tg:wallet:${initData}`, walletRaw, { ex: 60 * 60 * 24 });
    }

    // ✅ создаём ключ баланса сразу, чтобы он появился в Upstash
    const balKey = `bal:${walletRaw}`;
    const exists = await redis.get(balKey);
    if (exists === null || typeof exists === "undefined") {
      await redis.set(balKey, "0");
    }

    return res.status(200).json({ ok: true, walletRaw, balKey });
  } catch (e) {
    return res.status(500).json({ error: "bind_error", message: String(e) });
  }
}
