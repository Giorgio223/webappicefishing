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
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const address = String(req.body?.address || "").trim();
    const deltaNano = Number(req.body?.deltaNano);

    if (!address) return res.status(400).json({ error: "no_address" });
    if (!Number.isFinite(deltaNano) || !Number.isInteger(deltaNano)) {
      return res.status(400).json({ error: "bad_delta" });
    }

    let friendly = "";
    try {
      friendly = canonicalFriendly(address);
    } catch {
      return res.status(400).json({ error: "bad_address" });
    }

    const key = `bal:${friendly}`;
    const curRaw = await redis.get(key);
    const cur = Number(curRaw || "0");

    const next = cur + deltaNano;
    if (next < 0) return res.status(400).json({ error: "insufficient" });

    await redis.set(key, String(next));

    return res.status(200).json({
      ok: true,
      address: friendly,
      nano: next,
      ton: next / 1e9,
      balanceTon: next / 1e9,
    });
  } catch (e) {
    return res.status(500).json({ error: "balance_adjust_error", message: String(e) });
  }
}
