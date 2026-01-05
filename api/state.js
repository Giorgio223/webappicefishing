import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PERIOD_MS = 10000;     // ✅ 10 секунд
const N = 53;
const HISTORY_MAX = 18;

function winnerForRound(roundId) {
  const seed = process.env.WHEEL_SEED || "dev-seed";
  const h = crypto.createHmac("sha256", seed).update(String(roundId)).digest();
  const num = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return (num >>> 0) % N;
}

async function ensureHistoryUpTo(lastCompletedRoundId) {
  // lock чтобы не писали одновременно
  const lockKey = `wheel:lock:${lastCompletedRoundId}`;
  const got = await redis.set(lockKey, "1", { nx: true, px: 5000 });
  if (!got) return;

  const lastRaw = await redis.get("wheel:lastRoundId");
  const last = lastRaw === null ? null : Number(lastRaw);

  // если вообще пусто — создадим сразу окно из HISTORY_MAX
  if (last === null) {
    const from = Math.max(0, lastCompletedRoundId - (HISTORY_MAX - 1));
    await redis.del("wheel:history");
    for (let r = from; r <= lastCompletedRoundId; r++) {
      await redis.rpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: winnerForRound(r) }));
    }
    await redis.set("wheel:lastRoundId", lastCompletedRoundId);
    return;
  }

  // добавляем недостающие завершенные раунды в конец
  if (last < lastCompletedRoundId) {
    for (let r = last + 1; r <= lastCompletedRoundId; r++) {
      await redis.rpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: winnerForRound(r) }));
    }
    // режем список, оставляем последние HISTORY_MAX (в конце)
    await redis.ltrim("wheel:history", -HISTORY_MAX, -1);
    await redis.set("wheel:lastRoundId", lastCompletedRoundId);
  } else {
    // на всякий: держим размер в норме
    await redis.ltrim("wheel:history", -HISTORY_MAX, -1);
  }
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();
    const roundId = Math.floor(now / PERIOD_MS);
    const startAt = roundId * PERIOD_MS;
    const endAt = startAt + PERIOD_MS;

    // ✅ завершенный раунд = текущий - 1
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
      periodMs: PERIOD_MS,
      round: {
        roundId,
        startAt,
        endAt,
        winnerIndex: winnerForRound(roundId), // ✅ winner текущего (для спина)
      },
      history, // ✅ только завершенные и по порядку
    });
  } catch (e) {
    res.status(500).json({ error: "state_error", message: String(e) });
  }
}
