import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const address = String(req.query.address || "");
    if (!address) return res.status(400).json({ error: "no_address" });

    const key = `bal:${address}`;
    const balNano = (await redis.get(key)) || "0";
    const balTon = Number(balNano) / 1e9;

    res.status(200).json({ address, balanceNano: String(balNano), balanceTon: balTon });
  } catch (e) {
    res.status(500).json({ error: "balance_error", message: String(e) });
  }
}
