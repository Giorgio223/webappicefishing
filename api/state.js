import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ✅ требования под твой фронт/логику
const SPIN_MS = 8600;          // длительность вращения
const POST_DELAY_MS = 15000;   // 15 сек после окончания спина
const ROUND_MS = SPIN_MS + POST_DELAY_MS; // полный цикл раунда

const N = 53;
const HISTORY_MAX = 18;

// защита от сильного сдвига истории (в раундах)
const MAX_ROUND_DRIFT = 60 * 60;

function winnerForRound(roundId) {
  const seed = process.env.WHEEL_SEED || "dev-seed";
  const h = crypto.createHmac("sha256", seed).update(String(roundId)).digest();
  const num = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return (num >>> 0) % N;
}

async function rebuildHistory(lastCompletedRoundId) {
  const from = Math.max(0, lastCompletedRoundId - (HISTORY_MAX - 1));
  await redis.del("wheel:history");
  for (let r = from; r <= lastCompletedRoundId; r++) {
    await redis.rpush(
      "wheel:history",
      JSON.stringify({ roundId: r, winnerIndex: winnerForRound(r) })
    );
  }
  await redis.set("wheel:lastRoundId", lastCompletedRoundId);
}

async function ensureHistoryUpTo(lastCompletedRoundId) {
  const lockKey = `wheel:lock:${lastCompletedRoundId}`;
  const got = await redis.set(lockKey, "1", { nx: true, px: 5000 });
  if (!got) return;

  const lastRaw = await redis.get("wheel:lastRoundId");
  const last = lastRaw === null ? null : Number(lastRaw);

  if (last === null || Number.isNaN(last)) {
    await rebuildHistory(lastCompletedRoundId);
    return;
  }

  const drift = Math.abs(last - lastCompletedRoundId);
  if (last > lastCompletedRoundId || drift > MAX_ROUND_DRIFT) {
    await rebuildHistory(lastCompletedRoundId);
    return;
  }

  if (last < lastCompletedRoundId) {
    for (let r = last + 1; r <= lastCompletedRoundId; r++) {
      await redis.rpush(
        "wheel:history",
        JSON.stringify({ roundId: r, winnerIndex: winnerForRound(r) })
      );
    }
    await redis.ltrim("wheel:history", -HISTORY_MAX, -1);
    await redis.set("wheel:lastRoundId", lastCompletedRoundId);
  } else {
    await redis.ltrim("wheel:history", -HISTORY_MAX, -1);
  }
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();

    // ✅ roundId теперь по ROUND_MS (8.6s spin + 15s pause)
    const roundId = Math.floor(now / ROUND_MS);
    const roundStartAt = roundId * ROUND_MS;

    // ✅ время спина и паузы внутри раунда
    const spinStartAt = roundStartAt;          // начало вращения
    const endAt = roundStartAt + SPIN_MS;      // конец вращения
    const nextRoundAt = roundStartAt + ROUND_MS; // начало следующего раунда

    const lastCompletedRoundId = Math.max(0, roundId - 1);

    await ensureHistoryUpTo(lastCompletedRoundId);

    const raw = await redis.lrange("wheel:history", 0, -1);
    const history = (raw || [])
      .map((x) => (typeof x === "string" ? JSON.parse(x) : x))
      .filter(Boolean)
      .sort((a, b) => a.roundId - b.roundId)
      .slice(-HISTORY_MAX);

    res.status(200).json({
      serverNow: now,

      // полезно для клиента (если захочешь)
      roundMs: ROUND_MS,
      spinMs: SPIN_MS,
      postDelayMs: POST_DELAY_MS,

      round: {
        roundId,
        startAt: spinStartAt,  // ✅ теперь startAt = начало спина
        endAt,                 // ✅ конец спина
        nextRoundAt,           // ✅ когда начнётся следующий раунд
        winnerIndex: winnerForRound(roundId),
      },
      history,
    });
  } catch (e) {
    res.status(500).json({ error: "state_error", message: String(e) });
  }
}
