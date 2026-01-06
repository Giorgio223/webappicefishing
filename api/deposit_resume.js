import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

async function confirmOne(intentId, address) {
  const url = `/api/confirm_deposit?intentId=${encodeURIComponent(intentId)}&address=${encodeURIComponent(address)}`;
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, json: j };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") return res.status(405).json({ error: "method" });

    const address = String(req.query.address || "").trim();
    if (!address) return res.status(400).json({ error: "no_address" });

    const userWallet = canonicalFriendly(address);

    const ids = await redis.smembers(`dep:pending:${userWallet}`);
    const list = Array.isArray(ids) ? ids : [];

    let credited = 0;
    let pending = 0;

    // проверяем максимум 6 за раз (чтобы не DDOS’ить tonapi на большой аудитории)
    for (const intentId of list.slice(0, 6)) {
      const { ok, json } = await confirmOne(intentId, userWallet);
      if (ok && json?.status === "credited") credited++;
      else pending++;
    }

    return res.status(200).json({ ok: true, pendingCount: list.length, checked: Math.min(6, list.length), credited, pending });
  } catch (e) {
    return res.status(500).json({ error: "resume_error", message: String(e) });
  }
}
