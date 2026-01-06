import { Redis } from "@upstash/redis";
import crypto from "crypto";
import { Address } from "@ton/core";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// должно совпадать со state.js
const SPIN_MS = 8600;
const POST_DELAY_MS = 15000;
const ROUND_MS = SPIN_MS + POST_DELAY_MS;

const N = 53;

// индексы рыб как у тебя в колесе
const IDX_HUGE = 0;
const IDX_ORANGES = new Set([13, 39]);
const IDX_BLUES = new Set([7, 20, 33, 46]);

function winnerForRound(roundId) {
  const seed = process.env.WHEEL_SEED || "dev-seed";
  const h = crypto.createHmac("sha256", seed).update(String(roundId)).digest();
  const num = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return (num >>> 0) % N;
}

function kindForIndex(i){
  if (i === IDX_HUGE) return "hugered";
  if (IDX_ORANGES.has(i)) return "bigoranges";
  if (IDX_BLUES.has(i)) return "lilblues";
  // остальное листья
  // (в твоей сборке листья чередуются leaf1/leaf2 — на сервере мы считаем:
  // четные индексы = leaf1, нечетные = leaf2 — если у тебя другая схема, скажи, я подстрою точно под твой сектор-мэп)
  return (i % 2 === 0) ? "leaf1" : "leaf2";
}

function payoutMultiplier(target){
  // из твоего примера: leaf дает +0.2 при ставке 0.1 => x2 payout
  if (target === "leaf1") return 2;
  if (target === "leaf2") return 2;
  // рыбы: “вернуло ставку”
  if (target === "lilblues") return 1;
  if (target === "bigoranges") return 1;
  if (target === "hugered") return 1;
  return 0;
}

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

export default async function handler(req, res){
  try{
    res.setHeader("Cache-Control","no-store");
    if (req.method !== "POST") return res.status(405).json({ error:"method" });

    const address = String(req.body?.address||"").trim();
    if (!address) return res.status(400).json({ error:"no_address" });

    const userWallet = canonicalFriendly(address);

    const now = Date.now();
    const roundId = Math.floor(now / ROUND_MS);
    const roundStartAt = roundId * ROUND_MS;
    const endAt = roundStartAt + SPIN_MS;

    // завершённые раунды: если now>=endAt -> текущий завершен
    const lastCompleted = (now >= endAt) ? roundId : (roundId - 1);

    const pendingKey = `bet:pending:${userWallet}`;
    const rounds = await redis.smembers(pendingKey);
    const list = (Array.isArray(rounds) ? rounds : [])
      .map(x => Number(x))
      .filter(x => Number.isInteger(x) && x >= 0)
      .sort((a,b)=>a-b);

    let creditedNanoTotal = 0;
    const settled = [];

    // проверяем максимум 10 round’ов за вызов (чтобы выдержать массовость)
    for (const r of list.slice(0, 10)){
      if (r > lastCompleted) continue; // еще не закончился

      const settleLock = `bet:settled:${r}:${userWallet}`;
      const got = await redis.set(settleLock, "1", { nx:true, ex: 24*60*60 });
      if (!got) {
        // уже считали
        await redis.srem(pendingKey, String(r));
        continue;
      }

      const betKey = `bet:${r}:${userWallet}`;
      const bets = await redis.hgetall(betKey) || {};

      const winnerIdx = winnerForRound(r);
      const winnerKind = kindForIndex(winnerIdx);

      let roundCredit = 0;

      for (const [target, nanoStr] of Object.entries(bets)){
        const staked = Number(nanoStr || "0");
        if (!Number.isFinite(staked) || staked <= 0) continue;

        const mult = payoutMultiplier(target);

        if (target === winnerKind) {
          roundCredit += Math.floor(staked * mult);
        }
      }

      if (roundCredit > 0){
        await redis.incrby(`bal:${userWallet}`, roundCredit);
        creditedNanoTotal += roundCredit;
      }

      // чистим ставки
      await redis.del(betKey);
      await redis.srem(pendingKey, String(r));

      settled.push({ roundId: r, winnerIndex: winnerIdx, winnerKind, creditedNano: roundCredit });
    }

    return res.status(200).json({
      ok:true,
      lastCompletedRoundId: lastCompleted,
      settled,
      creditedNanoTotal,
      creditedTonTotal: creditedNanoTotal / 1e9
    });

  }catch(e){
    return res.status(500).json({ error:"bet_settle_error", message:String(e) });
  }
}
