import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

function normalizeToRaw(addressLike) {
  return Address.parse(String(addressLike).trim()).toRawString(); // "0:..."
}

function rawToFriendly(raw) {
  return Address.parse(raw).toString({
    urlSafe: true,
    bounceable: false,
    testOnly: false,
  });
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const addressIn = String(req.query.address || "").trim();
    if (!addressIn) return res.status(400).json({ error: "no_address" });

    let raw;
    try {
      raw = normalizeToRaw(addressIn);
    } catch {
      return res.status(400).json({ error: "bad_address" });
    }

    const nano = Number((await redis.get(`bal:${raw}`)) || "0");

    return res.status(200).json({
      ok: true,
      addressRaw: raw,
      addressFriendly: rawToFriendly(raw),
      nano,
      ton: nano / 1e9,
      balanceTon: nano / 1e9,
    });
  } catch (e) {
    return res.status(500).json({ error: "balance_error", message: String(e) });
  }
}
