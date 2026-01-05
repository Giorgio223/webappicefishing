import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const address = String(req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "no_address" });

    if (address.startsWith("0:")) {
      return res.status(400).json({ error: "bad_wallet_format", message: "Use friendly UQ/EQ address" });
    }

    const raw = await redis.get(`bal:${address}`);
    const nano = Number(raw || "0");

    return res.status(200).json({
      ok: true,
      address,
      nano,
      ton: nano / 1e9,
      balanceTon: nano / 1e9
    });
  } catch (e) {
    return res.status(500).json({ error: "balance_error", message: String(e) });
  }
}
