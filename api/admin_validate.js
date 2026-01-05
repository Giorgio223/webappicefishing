import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const token = String(req.headers["x-admin-token"] || "");
    if (!token) return res.status(401).json({ ok: false, error: "no_token" });

    const v = await redis.get(`admin:token:${token}`);
    if (!v) return res.status(401).json({ ok: false, error: "bad_or_expired_token" });

    return res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "admin_validate_error", message: String(e) });
  }
}
