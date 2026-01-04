import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PERIOD_MS = 6000;     // 6 секунд
const N = 53;               // 53 ячейки
const HISTORY_MAX = 18;

function winnerForRound(roundId) {
  const seed = process.env.WHEEL_SEED || "dev-seed";
  const h = crypto.createHmac("sha256", seed).update(String(roundId)).digest();
  const num = (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
  return (num >>> 0) % N;
}

function safeParseHistoryItem(item) {
  // Upstash может вернуть строку, а может вернуть объект (в зависимости от того, что там лежит)
  if (item && typeof item === "object") {
    if (typeof item.roundId === "number" && typeof item.winnerIndex === "number") return item;
    // иногда объект может быть вида { value: "..." }
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

async function rebuildHistoryToRound(roundId) {
  // пересоздаём историю последними HISTORY_MAX раундами
  await redis.del("wheel:history");
  const from = Math.max(0, roundId - (HISTORY_MAX - 1));
  for (let r = from; r <= roundId; r++) {
    const w = winnerForRound(r);
    await redis.rpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: w }));
  }
  await redis.set("wheel:lastRoundId", roundId);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();
    const roundId = Math.floor(now / PERIOD_MS);
    const startAt = roundId * PERIOD_MS;
    const endAt = startAt + PERIOD_MS;

    // 1) обновим историю, если ушли в новый раунд
    const lastRoundIdRaw = await redis.get("wheel:lastRoundId");
    const lastRoundId = lastRoundIdRaw === null ? null : Number(lastRoundIdRaw);

    if (lastRoundId === null) {
      await rebuildHistoryToRound(roundId);
    } else if (lastRoundId < roundId) {
      // добавим пропущенные раунды
      for (let r = lastRoundId + 1; r <= roundId; r++) {
        const w = winnerForRound(r);
        await redis.lpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: w }));
      }
      await redis.ltrim("wheel:history", 0, HISTORY_MAX - 1);
      await redis.set("wheel:lastRoundId", roundId);
    }

    // 2) прочитаем историю и аккуратно распарсим
    const raw = await redis.lrange("wheel:history", 0, HISTORY_MAX - 1);
    const parsed = raw.map(safeParseHistoryItem).filter(Boolean);

    // 3) если история “битая” — восстановим и перечитаем
    if (parsed.length === 0 || parsed.length !== raw.length) {
      await rebuildHistoryToRound(roundId);
      const raw2 = await redis.lrange("wheel:history", 0, HISTORY_MAX - 1);
      const parsed2 = raw2.map(safeParseHistoryItem).filter(Boolean).reverse();
      return res.status(200).json({
        serverNow: now,
        periodMs: PERIOD_MS,
        round: { roundId, startAt, endAt, winnerIndex: winnerForRound(roundId) },
        history: parsed2,
        rebuilt: true,
      });
    }

    // raw приходит “новые->старые”, делаем “старые->новые”
    const history = parsed.reverse();

    return res.status(200).json({
      serverNow: now,
      periodMs: PERIOD_MS,
      round: { roundId, startAt, endAt, winnerIndex: winnerForRound(roundId) },
      history,
      rebuilt: false,
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
