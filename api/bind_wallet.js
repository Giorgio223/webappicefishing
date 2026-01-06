import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Проверка Telegram WebApp initData (чтобы никто не подделал userId)
function verifyInitData(initData) {
  if (!BOT_TOKEN) throw new Error("no_bot_token");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };

  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  return { ok: hmac === hash, params };
}

function normalizeToRaw(addressLike) {
  // принимает EQ/UQ/0:... и приводит к RAW 0:...
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
    const initData = String(body.initData || "");
    const walletAddressIn = String(body.walletAddress || "").trim();

    if (!initData) return res.status(400).json({ error: "no_initData" });
    if (!walletAddressIn) return res.status(400).json({ error: "no_wallet" });

    const v = verifyInitData(initData);
    if (!v.ok) return res.status(401).json({ error: "bad_initData" });

    const userJson = v.params.get("user");
    if (!userJson) return res.status(400).json({ error: "no_user" });

    const user = JSON.parse(userJson);
    const tgId = Number(user.id);
    const username = (user.username ? String(user.username) : "").toLowerCase();

    if (!tgId) return res.status(400).json({ error: "bad_user_id" });

    // Нормализуем кошелёк
    let walletRaw;
    try {
      walletRaw = normalizeToRaw(walletAddressIn);
    } catch {
      return res.status(400).json({ error: "bad_wallet_address" });
    }

    const walletFriendly = rawToFriendly(walletRaw);

    // tgId -> RAW wallet
    await redis.set(`tg:wallet:${tgId}`, walletRaw);

    // Дополнительно сохраним friendly (иногда удобно отдавать на фронт)
    await redis.set(`tg:wallet_friendly:${tgId}`, walletFriendly);

    // username -> tgId (если есть username)
    if (username) {
      await redis.set(`tg:username:${username}`, String(tgId));
    }

    res.status(200).json({
      ok: true,
      tgId,
      username,
      walletRaw,
      walletFriendly,
    });
  } catch (e) {
    res.status(500).json({ error: "bind_wallet_error", message: String(e) });
  }
}
