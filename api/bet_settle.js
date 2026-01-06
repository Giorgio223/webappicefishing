import { Redis } from "@upstash/redis";
import { createHmac } from "node:crypto";
import { Address } from "@ton/core";

export const config = { runtime: "nodejs" };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ДОЛЖНО совпадать со state.js / index.html
const SPIN_MS = 8600;
const POST_DELAY_MS = 15000;
const ROUND_MS = SPIN_MS + POST_DELAY_MS;

const N = 53;

// индексы рыб (как у тебя)
const IDX_HUGE = 0;
const IDX_ORANGES = new Set([13, 39]);
const IDX_BLUES = new Set([7, 20, 33, 46]);

function canonicalFriendly(addr) {
  const a = Address.parse(String(addr));
  return a.toString({ urlSafe: true, bounceable: false, testOnly: false });
}

function winnerForRound(roundId) {
  const seed = process.env.WHEEL_SEED || "dev-seed";
  const h = createHmac("sha256", seed).update(String(roundId)).digest();
  const num = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return (num >>> 0) % N;
}

function kindForIndex(i) {
  if (i === IDX_HUGE) return "hugered";
  if (IDX_ORANGES.has(i)) return "bigoranges";
  if (IDX_BLUES.has(i)) return "lilblues";
  // листья: если у тебя иная схема leaf1/leaf2 — скажи, подстрою
  return (i % 2 === 0) ? "leaf1" : "leaf2";
}

function payoutMultiplier(target) {
  // листья x2 (как ты описал)
  if (target === "leaf1") return 2;
  if (target === "leaf2") return 2;
  // рыбы x1 (вернуло ставку)
  if (target === "lilblues") return 1;
  if (target === "bigoranges") return 1;
  if (target === "hugered") return 1;
  return 0;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const address = String(req.body?.address || "").trim();
    if (!address) return res.status(400).json({ error: "no_address" });

    const userWallet = canonicalFriendly(address);

    // считаем текущий раунд по времени
    const now = Date.now();
    const roundId = Math.floor(now / ROUND_MS);
    const roundStartAt = roundId * ROUND_MS;
    const endAt = roundStartAt + SPIN_MS;

    // последний завершенный
    const lastCompleted = (now >= endAt) ? roundId : (roundId - 1);

    const pendingKey = `bet:pending:${userWallet}`;
    const roundsRaw = await redis.smembers(pendingKey);
    const rounds = (Array.isArray(roundsRaw) ? roundsRaw : [])
      .map(x => Number(x))
      .filter(x => Number.isInteger(x) && x >= 0)
      .sort((a, b) => a - b);

    let creditedNanoTotal = 0;
    const settled = [];

    // максимум 10 за раз
    for (const r of rounds.slice(0, 10)) {
      if (r > lastCompleted) continue;

      // идемпотентность settlement на раунд
      const settleLock = `bet:settled:${r}:${userWallet}`;
      const got = await redis.set(settleLock, "1", { nx: true, ex: 24 * 60 * 60 });
      if (!got) {
        await redis.srem(pendingKey, String(r));
        continue;
      }

      const betKey = `bet:${r}:${userWallet}`;
      const bets = (await redis.hgetall(betKey)) || {};

      const winnerIdx = winnerForRound(r);
      const winnerKind = kindForIndex(winnerIdx);

      let roundCredit = 0;

      for (const [target, nanoStr] of Object.entries(bets)) {
        const staked = Number(nanoStr || "0");
        if (!Number.isFinite(staked) || staked <= 0) continue;

        const mult = payoutMultiplier(target);
        if (target === winnerKind) {
          roundCredit += Math.floor(staked * mult);
        }
      }

      if (roundCredit > 0) {
        await redis.incrby(`bal:${userWallet}`, roundCredit);
        creditedNanoTotal += roundCredit;
      }

      // чистим ставки и pending
      await redis.del(betKey);
      await redis.srem(pendingKey, String(r));

      settled.push({ roundId: r, winnerIndex: winnerIdx, winnerKind, creditedNano: roundCredit });
    }

    return res.status(200).json({
      ok: true,
      lastCompletedRoundId: lastCompleted,
      settled,
      creditedNanoTotal,
      creditedTonTotal: creditedNanoTotal / 1e9,
    });
  } catch (e) {
    return res.status(500).json({ error: "bet_settle_error", message: String(e) });
  }
}
