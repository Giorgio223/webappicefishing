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
    const address = String(req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "no_address" });

    const raw = normalizeToRaw(address);
    const key = `bal:${raw}`;
    const nanoStr = String((await redis.get(key)) || "0");
    const nano = Number(nanoStr) || 0;

    return res.status(200).json({
      addressRaw: raw,
      nano,
      balanceTon: nano / 1e9
    });
  } catch (e) {
    return res.status(500).json({ error: "balance_error", message: String(e) });
  }
}
