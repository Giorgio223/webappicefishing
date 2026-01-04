import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PERIOD_MS = 10000; // ✅ 10 секунд
const N = 53;
const HISTORY_MAX = 18;

// winner детерминированный (одинаково у всех 24/7)
function winnerForRound(roundId) {
  const seed = process.env.WHEEL_SEED || "dev-seed";
  const h = crypto.createHmac("sha256", seed).update(String(roundId)).digest();
  const num = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return (num >>> 0) % N;
}

function safeParse(item) {
  if (!item) return null;
  if (typeof item === "object") {
    if (typeof item.roundId === "number" && typeof item.winnerIndex === "number") return item;
    if (typeof item.value === "string") item = item.value;
    else return null;
  }
  if (typeof item !== "string") return null;
  try {
    const obj = JSON.parse(item);
    if (obj && typeof obj.roundId === "number" && typeof obj.winnerIndex === "number") return obj;
  } catch {}
  return null;
}

// пересобираем историю так, чтобы она была по завершённым раундам
async function rebuildHistoryToRound(lastCompletedRoundId) {
  await redis.del("wheel:history");
  const from = Math.max(0, lastCompletedRoundId - (HISTORY_MAX - 1));
  for (let r = from; r <= lastCompletedRoundId; r++) {
    const w = winnerForRound(r);
    await redis.rpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: w }));
  }
  await redis.set("wheel:lastRoundId", lastCompletedRoundId);
}

function uniqByRoundId(arr) {
  const map = new Map();
  for (const x of arr) map.set(x.roundId, x);
  return Array.from(map.values()).sort((a, b) => a.roundId - b.roundId);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();

    // текущий активный раунд
    const roundId = Math.floor(now / PERIOD_MS);
    const startAt = roundId * PERIOD_MS;
    const endAt = startAt + PERIOD_MS;

    // ✅ завершённый раунд = текущий - 1
    const lastCompletedRoundId = Math.max(0, roundId - 1);

    // ---------- 1) LOCK: обновляем историю только одним запросом ----------
    // lock на "завершённый раунд", чтобы не было дублей
    const lockKey = `wheel:lock:${lastCompletedRoundId}`;
    const gotLock = await redis.set(lockKey, "1", { nx: true, px: 7000 }); // < 10с

    if (gotLock) {
      const lastRoundIdRaw = await redis.get("wheel:lastRoundId");
      const lastRoundId = lastRoundIdRaw === null ? null : Number(lastRoundIdRaw);

      if (lastRoundId === null) {
        // если истории нет — создадим по последним completed
        await rebuildHistoryToRound(lastCompletedRoundId);
      } else if (lastRoundId < lastCompletedRoundId) {
        // ✅ добавляем только завершённые раунды (до lastCompletedRoundId)
        for (let r = lastRoundId + 1; r <= lastCompletedRoundId; r++) {
          const w = winnerForRound(r);
          await redis.lpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: w }));
        }
        // оставим запас для дедупа
        await redis.ltrim("wheel:history", 0, HISTORY_MAX * 6);
        await redis.set("wheel:lastRoundId", lastCompletedRoundId);
      }
    }

    // ---------- 2) читаем историю и чистим дубли ----------
    const raw = await redis.lrange("wheel:history", 0, HISTORY_MAX * 6);
    const parsed = raw.map(safeParse).filter(Boolean);

    if (parsed.length === 0) {
      await rebuildHistoryToRound(lastCompletedRoundId);
      const raw2 = await redis.lrange("wheel:history", 0, HISTORY_MAX - 1);
      const parsed2 = raw2.map(safeParse).filter(Boolean);
      const history2 = uniqByRoundId(parsed2).slice(-HISTORY_MAX);
      return res.status(200).json({
        serverNow: now,
        periodMs: PERIOD_MS,
        round: {
          roundId,
          startAt,
          endAt,
          winnerIndex: winnerForRound(roundId), // winner текущего (для спина)
        },
        history: history2, // ✅ только завершённые
        rebuilt: true,
        deduped: false,
      });
    }

    const unique = uniqByRoundId(parsed);

    let deduped = false;
    if (unique.length !== parsed.length) {
      deduped = true;
      const keep = unique.slice(-HISTORY_MAX);

      await redis.del("wheel:history");
      for (const item of keep) {
        await redis.rpush("wheel:history", JSON.stringify(item));
      }
      await redis.set("wheel:lastRoundId", keep[keep.length - 1].roundId);
    }

    // ✅ в ответе история только завершённых (и по порядку)
    const history = unique.slice(-HISTORY_MAX);

    return res.status(200).json({
      serverNow: now,
      periodMs: PERIOD_MS,
      round: {
        roundId,
        startAt,
        endAt,
        winnerIndex: winnerForRound(roundId), // winner текущего (он крутится на endAt)
      },
      history,
      rebuilt: false,
      deduped,
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
