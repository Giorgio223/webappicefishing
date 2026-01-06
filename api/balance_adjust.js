import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

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

function normalizeToRaw(addressLike) {
  return Address.parse(String(addressLike).trim()).toRawString();
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
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const addressIn = String(body.address || "").trim();
    const deltaNano = toInt(body.deltaNano);

    if (!addressIn) return res.status(400).json({ error: "no_address" });
    if (deltaNano === null) return res.status(400).json({ error: "bad_delta" });

    let raw;
    try {
      raw = normalizeToRaw(addressIn);
    } catch {
      return res.status(400).json({ error: "bad_address" });
    }

    const key = `bal:${raw}`;
    const cur = Number((await redis.get(key)) || "0");
    const next = cur + deltaNano;
    if (next < 0) return res.status(400).json({ error: "insufficient_balance" });

    await redis.set(key, String(next));

    res.status(200).json({
      ok: true,
      addressRaw: raw,
      addressFriendly: rawToFriendly(raw),
      balanceNano: String(next),
      balanceTon: next / 1e9,
    });
  } catch (e) {
    res.status(500).json({ error: "balance_adjust_error", message: String(e) });
  }
}
