import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REST_TOKEN,
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

// Telegram WebApp initData verify
function verifyInitData(initData) {
  if (!BOT_TOKEN) throw new Error("no_bot_token");
  const params = new URLSearchParams(initData);

  const hash = params.get("hash");
  if (!hash) throw new Error("no_hash");

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calcHash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  if (calcHash !== hash) throw new Error("bad_init_data");
  return params;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const initData = String(req.body?.initData || "").trim();
    const walletAddress = String(req.body?.walletAddress || "").trim();
    if (!initData) return res.status(400).json({ error: "no_initData" });
    if (!walletAddress) return res.status(400).json({ error: "no_walletAddress" });

    const params = verifyInitData(initData);

    const userJson = params.get("user");
    if (!userJson) return res.status(400).json({ error: "no_user" });

    const user = JSON.parse(userJson);
    const tgId = Number(user?.id);
    if (!Number.isFinite(tgId)) return res.status(400).json({ error: "bad_user_id" });

    const username = String(user?.username || "").trim() || null;

    let friendly = "";
    try {
      friendly = canonicalFriendly(walletAddress);
    } catch {
      return res.status(400).json({ error: "bad_wallet" });
    }

    await redis.set(`tg:wallet:${tgId}`, friendly);
    if (username) await redis.set(`tg:username:${username}`, String(tgId));

    return res.status(200).json({ ok: true, tgId, username, walletAddress: friendly });
  } catch (e) {
    return res.status(500).json({ error: "bind_wallet_error", message: String(e) });
  }
}
