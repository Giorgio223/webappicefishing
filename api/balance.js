import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const address = String(req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "no_address" });

    let friendly = "";
    try {
      friendly = canonicalFriendly(address);
    } catch {
      return res.status(400).json({ error: "bad_address" });
    }

    const raw = await redis.get(`bal:${friendly}`);
    const nano = Number(raw || "0");

    return res.status(200).json({
      ok: true,
      address: friendly,
      nano,
      ton: nano / 1e9,
      balanceTon: nano / 1e9,
    });
  } catch (e) {
    return res.status(500).json({ error: "balance_error", message: String(e) });
  }
}
