import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function toNanoInt(ton) {
  const n = Number(ton);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n * 1e9);
}

function isLikelyWallet(s) {
  return typeof s === "string" && s.length >= 20;
}

async function requireAdminToken(req) {
  const token = String(req.headers["x-admin-token"] || "");
  if (!token) return { ok: false, error: "no_token" };
  const v = await redis.get(`admin:token:${token}`);
  if (!v) return { ok: false, error: "bad_or_expired_token" };
  return { ok: true };
}

async function resolveWallet(targetRaw) {
  const target = String(targetRaw || "").trim();
  if (!target) return { ok: false, error: "no_target" };

  // wallet directly
  if (isLikelyWallet(target) && !target.startsWith("@")) {
    return { ok: true, wallet: target, resolvedFrom: "wallet" };
  }

  // @username
  if (target.startsWith("@")) {
    const uname = target.slice(1).toLowerCase();
    const tgIdStr = await redis.get(`tg:username:${uname}`);
    if (!tgIdStr) return { ok: false, error: "username_not_found" };
    const wallet = await redis.get(`tg:wallet:${tgIdStr}`);
    if (!wallet) return { ok: false, error: "user_has_no_wallet" };
    return { ok: true, wallet: String(wallet), resolvedFrom: `@${uname}` };
  }

  // tgId numeric
  if (/^\d+$/.test(target)) {
    const wallet = await redis.get(`tg:wallet:${target}`);
    if (!wallet) return { ok: false, error: "user_has_no_wallet" };
    return { ok: true, wallet: String(wallet), resolvedFrom: `tgId:${target}` };
  }

  return { ok: false, error: "bad_target_format" };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const auth = await requireAdminToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const target = body.target;
    const amountTon = body.amountTon;

    const deltaNano = toNanoInt(amountTon);
    if (deltaNano === null) return res.status(400).json({ error: "bad_amount" });

    const r = await resolveWallet(target);
    if (!r.ok) return res.status(400).json({ error: r.error });

    const k = `bal:${r.wallet}`;
    const cur = Number((await redis.get(k)) || "0");
    const next = cur + deltaNano;
    await redis.set(k, String(next));

    return res.status(200).json({
      ok: true,
      target,
      resolvedFrom: r.resolvedFrom,
      wallet: r.wallet,
      addedTon: Number(amountTon),
      balanceTon: next / 1e9,
    });
  } catch (e) {
    res.status(500).json({ error: "admin_topup_error", message: String(e) });
  }
}
