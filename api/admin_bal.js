import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function requireAdminToken(req) {
  const token = String(req.headers["x-admin-token"] || "");
  if (!token) return { ok: false, error: "no_token" };
  const v = await redis.get(`admin:token:${token}`);
  if (!v) return { ok: false, error: "bad_or_expired_token" };
  return { ok: true };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const auth = await requireAdminToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const wallet = String(req.query.wallet || "").trim();
    if (!wallet) return res.status(400).json({ error: "no_wallet" });

    const bal = Number((await redis.get(`bal:${wallet}`)) || "0");
    return res.status(200).json({ ok: true, wallet, balanceTon: bal / 1e9 });
  } catch (e) {
    res.status(500).json({ error: "admin_bal_error", message: String(e) });
  }
}
