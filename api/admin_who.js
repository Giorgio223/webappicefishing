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

    const target = String(req.query.target || "").trim();
    if (!target) return res.status(400).json({ error: "no_target" });

    if (target.startsWith("@")) {
      const uname = target.slice(1).toLowerCase();
      const tgIdStr = await redis.get(`tg:username:${uname}`);
      if (!tgIdStr) return res.status(404).json({ error: "username_not_found", username: uname });
      const wallet = await redis.get(`tg:wallet:${tgIdStr}`);
      return res.status(200).json({ ok: true, username: uname, tgId: tgIdStr, wallet: wallet || null });
    }

    if (/^\d+$/.test(target)) {
      const wallet = await redis.get(`tg:wallet:${target}`);
      return res.status(200).json({ ok: true, tgId: target, wallet: wallet || null });
    }

    return res.status(400).json({ error: "use_@username_or_tgId" });
  } catch (e) {
    res.status(500).json({ error: "admin_who_error", message: String(e) });
  }
}
