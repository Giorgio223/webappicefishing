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
    const address = String(body.address || "").trim();
    const deltaNano = Number(body.deltaNano);

    if (!address) return res.status(400).json({ error: "no_address" });
    if (!Number.isFinite(deltaNano)) return res.status(400).json({ error: "bad_delta" });

    const raw = normalizeToRaw(address);
    const key = `bal:${raw}`;

    const cur = Number((await redis.get(key)) || "0") || 0;
    const next = cur + Math.trunc(deltaNano);

    if (next < 0) return res.status(400).json({ error: "insufficient" });

    await redis.set(key, String(next));

    return res.status(200).json({
      addressRaw: raw,
      nano: next,
      balanceTon: next / 1e9
    });
  } catch (e) {
    return res.status(500).json({ error: "balance_adjust_error", message: String(e) });
  }
}
