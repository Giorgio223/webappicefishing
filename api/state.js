import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PERIOD_MS = 9000;   // ✅ 9 секунд
const N = 53;
const HISTORY_MAX = 18;

function winnerForRound(roundId) {
  const seed = process.env.WHEEL_SEED || "dev-seed";
  const h = crypto.createHmac("sha256", seed).update(String(roundId)).digest();
  const num = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return (num >>> 0) % N;
}

function safeParseHistoryItem(item) {
  if (item && typeof item === "object") {
    if (typeof item.roundId === "number" && typeof item.winnerIndex === "number") return item;
    if (typeof item.value === "string") item = item.value;
    else return null;
  }
  if (typeof item !== "string") return null;
  try {
    const obj = JSON.parse(item);
    if (obj && typeof obj.roundId === "number" && typeof obj.winnerIndex === "number") return obj;
    return null;
  } catch {
    return null;
  }
}

async function rebuildHistoryToFinishedRound(finishedRoundId) {
  await redis.del("wheel:history");
  const from = Math.max(0, finishedRoundId - (HISTORY_MAX - 1));
  for (let r = from; r <= finishedRoundId; r++) {
    await redis.rpush(
      "wheel:history",
      JSON.stringify({ roundId: r, winnerIndex: winnerForRound(r) })
    );
  }
  await redis.set("wheel:lastFinishedRoundId", finishedRoundId);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();

    // ✅ ПРАВИЛЬНО:
    // currentRoundId = текущий активный раунд
    // finishedRoundId = последний полностью завершённый
    const currentRoundId = Math.floor(now / PERIOD_MS);
    const finishedRoundId = currentRoundId - 1;

    const startAt = currentRoundId * PERIOD_MS;
    const endAt = startAt + PERIOD_MS;

    // обновляем историю только до finishedRoundId
    const lastFinishedRaw = await redis.get("wheel:lastFinishedRoundId");
    const lastFinished = lastFinishedRaw === null ? null : Number(lastFinishedRaw);

    // ✅ если из-за прошлой ошибки lastFinished оказался "в будущем" — пересобираем
    if (lastFinished !== null && lastFinished > finishedRoundId) {
      await rebuildHistoryToFinishedRound(finishedRoundId);
    } else if (lastFinished === null) {
      await rebuildHistoryToFinishedRound(finishedRoundId);
    } else if (lastFinished < finishedRoundId) {
      for (let r = lastFinished + 1; r <= finishedRoundId; r++) {
        await redis.lpush(
          "wheel:history",
          JSON.stringify({ roundId: r, winnerIndex: winnerForRound(r) })
        );
      }
      await redis.ltrim("wheel:history", 0, HISTORY_MAX - 1);
      await redis.set("wheel:lastFinishedRoundId", finishedRoundId);
    }

    const raw = await redis.lrange("wheel:history", 0, HISTORY_MAX - 1);
    const parsed = raw.map(safeParseHistoryItem).filter(Boolean);

    if (parsed.length === 0 || parsed.length !== raw.length) {
      await rebuildHistoryToFinishedRound(finishedRoundId);
      const raw2 = await redis.lrange("wheel:history", 0, HISTORY_MAX - 1);
      const hist2 = raw2.map(safeParseHistoryItem).filter(Boolean).reverse();
      return res.status(200).json({
        serverNow: now,
        periodMs: PERIOD_MS,
        round: {
          roundId: currentRoundId,
          startAt,
          endAt,
          winnerIndex: winnerForRound(currentRoundId),
        },
        history: hist2,
        rebuilt: true,
      });
    }

    const history = parsed.reverse(); // старые->новые

    return res.status(200).json({
      serverNow: now,
      periodMs: PERIOD_MS,
      round: {
        roundId: currentRoundId,
        startAt,
        endAt,
        winnerIndex: winnerForRound(currentRoundId),
      },
      history,
      rebuilt: false,
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
