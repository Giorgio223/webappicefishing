import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const address = String(body.address || "");
    const deltaNano = toInt(body.deltaNano);

    if (!address) return res.status(400).json({ error: "no_address" });
    if (deltaNano === null) return res.status(400).json({ error: "bad_delta" });

    const key = `bal:${address}`;
    const cur = Number((await redis.get(key)) || "0");
    const next = cur + deltaNano;

    if (next < 0) return res.status(400).json({ error: "insufficient_balance" });

    await redis.set(key, String(next));

    res.status(200).json({ address, balanceNano: String(next), balanceTon: next / 1e9 });
  } catch (e) {
    res.status(500).json({ error: "balance_adjust_error", message: String(e) });
  }
}
