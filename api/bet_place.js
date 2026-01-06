import { Redis } from "@upstash/redis";
import { Address } from "@ton/core";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ALLOWED = new Set(["leaf1", "leaf2", "lilblues", "bigoranges", "hugered"]);

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const address = String(req.body?.address || "").trim();
    const roundId = Number(req.body?.roundId);
    const target = String(req.body?.target || "").trim();
    const amountNano = Number(req.body?.amountNano);

    if (!address) return res.status(400).json({ error: "no_address" });
    if (!Number.isInteger(roundId) || roundId < 0) return res.status(400).json({ error: "bad_roundId" });
    if (!ALLOWED.has(target)) return res.status(400).json({ error: "bad_target" });
    if (!Number.isInteger(amountNano) || amountNano <= 0) return res.status(400).json({ error: "bad_amount" });

    const userWallet = canonicalFriendly(address);

    const balKey = `bal:${userWallet}`;
    const betKey = `bet:${roundId}:${userWallet}`;          // hash target->nano
    const pendingKey = `bet:pending:${userWallet}`;         // set roundIds

    // маленькая блокировка (анти-дубльклик)
    const lockKey = `lock:bet:${roundId}:${userWallet}`;
    const locked = await redis.set(lockKey, "1", { nx: true, px: 2500 });
    if (!locked) return res.status(429).json({ error: "busy" });

    const curRaw = await redis.get(balKey);
    const cur = Number(curRaw || "0");
    if (!Number.isFinite(cur) || cur < amountNano) return res.status(400).json({ error: "insufficient" });

    // списываем баланс
    await redis.set(balKey, String(cur - amountNano));

    // пишем ставку в hash (накапливаем по target)
    const prevRaw = await redis.hget(betKey, target);
    const prev = Number(prevRaw || "0");
    const next = prev + amountNano;
    await redis.hset(betKey, { [target]: String(next) });

    // помечаем pending round
    await redis.sadd(pendingKey, String(roundId));
    await redis.expire(pendingKey, 24 * 60 * 60);
    await redis.expire(betKey, 24 * 60 * 60);

    return res.status(200).json({
      ok: true,
      roundId,
      target,
      amountNano,
      balanceNano: cur - amountNano,
      balanceTon: (cur - amountNano) / 1e9,
    });
  } catch (e) {
    return res.status(500).json({ error: "bet_place_error", message: String(e) });
  }
}
