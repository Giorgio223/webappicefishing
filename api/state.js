import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PERIOD_MS = 6000;     // 6 секунд
const N = 53;               // 53 ячейки
const HISTORY_MAX = 18;     // сколько показываем в истории

function winnerForRound(roundId) {
  const seed = process.env.WHEEL_SEED || "dev-seed";
  const h = crypto.createHmac("sha256", seed).update(String(roundId)).digest();
  const num = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return (num >>> 0) % N;
}

export default async function handler(req, res) {
  try {
    // отключим кеширование, чтобы всегда было "live"
    res.setHeader("Cache-Control", "no-store");

    const now = Date.now();
    const roundId = Math.floor(now / PERIOD_MS);
    const startAt = roundId * PERIOD_MS;
    const endAt = startAt + PERIOD_MS;

    // обновляем историю, если сервер перескочил в новые раунды
    const lastRoundIdRaw = await redis.get("wheel:lastRoundId");
    const lastRoundId = lastRoundIdRaw === null ? null : Number(lastRoundIdRaw);

    if (lastRoundId === null || lastRoundId < roundId) {
      const from = lastRoundId === null ? roundId : lastRoundId + 1;

      for (let r = from; r <= roundId; r++) {
        const w = winnerForRound(r);
        await redis.lpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: w }));
      }

      await redis.ltrim("wheel:history", 0, HISTORY_MAX - 1);
      await redis.set("wheel:lastRoundId", roundId);
    }

    const historyRaw = await redis.lrange("wheel:history", 0, HISTORY_MAX - 1);
    const history = historyRaw
      .map((s) => JSON.parse(s))
      .reverse(); // старые -> новые

    res.status(200).json({
      serverNow: now,
      periodMs: PERIOD_MS,
      round: {
        roundId,
        startAt,
        endAt,
        winnerIndex: winnerForRound(roundId),
      },
      history,
    });
  } catch (e) {
    res.status(500).json({ error: "state_error", message: String(e) });
  }
}
