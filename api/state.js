import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PERIOD_MS = 6000;
const N = 53;
const HISTORY_MAX = 18;

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

async function rebuildHistoryToRound(roundId) {
  await redis.del("wheel:history");
  const from = Math.max(0, roundId - (HISTORY_MAX - 1));
  for (let r = from; r <= roundId; r++) {
    const w = winnerForRound(r);
    await redis.rpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: w }));
  }
  await redis.set("wheel:lastRoundId", roundId);
}

function uniqByRoundId(arr) {
  // оставляем только последний элемент для каждого roundId
  const map = new Map();
  for (const x of arr) map.set(x.roundId, x);
  return Array.from(map.values()).sort((a,b)=>a.roundId-b.roundId);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");

    const now = Date.now();
    const roundId = Math.floor(now / PERIOD_MS);
    const startAt = roundId * PERIOD_MS;
    const endAt = startAt + PERIOD_MS;

    // ---------- 1) LOCK на обновление истории ----------
    // если параллельно пришли 2 запроса — только один сможет обновить историю
    const lockKey = `wheel:lock:${roundId}`;
    const gotLock = await redis.set(lockKey, "1", { nx: true, px: 4500 }); // держим ~4.5 сек

    if (gotLock) {
      const lastRoundIdRaw = await redis.get("wheel:lastRoundId");
      const lastRoundId = lastRoundIdRaw === null ? null : Number(lastRoundIdRaw);

      if (lastRoundId === null) {
        await rebuildHistoryToRound(roundId);
      } else if (lastRoundId < roundId) {
        for (let r = lastRoundId + 1; r <= roundId; r++) {
          const w = winnerForRound(r);
          await redis.lpush("wheel:history", JSON.stringify({ roundId: r, winnerIndex: w }));
        }
        await redis.ltrim("wheel:history", 0, HISTORY_MAX * 6); // чуть больше, чтобы было что чистить
        await redis.set("wheel:lastRoundId", roundId);
      }
      // lock сам протухнет по PX
    }

    // ---------- 2) ЧИТАЕМ историю и чистим дубли ----------
    const raw = await redis.lrange("wheel:history", 0, HISTORY_MAX * 6);
    const parsed = raw.map(safeParse).filter(Boolean);

    // если мусор/пусто — пересоберём
    if (parsed.length === 0) {
      await rebuildHistoryToRound(roundId);
      const raw2 = await redis.lrange("wheel:history", 0, HISTORY_MAX - 1);
      const parsed2 = raw2.map(safeParse).filter(Boolean).reverse();
      return res.status(200).json({
        serverNow: now,
        periodMs: PERIOD_MS,
        round: { roundId, startAt, endAt, winnerIndex: winnerForRound(roundId) },
        history: parsed2,
        rebuilt: true,
        deduped: false,
      });
    }

    // чистим дубли roundId
    const unique = uniqByRoundId(parsed);

    // если были дубли — перепишем список красиво (последние HISTORY_MAX раундов)
    let deduped = false;
    if (unique.length !== parsed.length) {
      deduped = true;
      const keep = unique.slice(-HISTORY_MAX);

      await redis.del("wheel:history");
      for (const item of keep) {
        await redis.rpush("wheel:history", JSON.stringify(item));
      }
      // lastRoundId тоже обновим на самый новый
      await redis.set("wheel:lastRoundId", keep[keep.length - 1].roundId);
    }

    // возвращаем ровно последние HISTORY_MAX, старые->новые
    const history = unique.slice(-HISTORY_MAX);

    return res.status(200).json({
      serverNow: now,
      periodMs: PERIOD_MS,
      round: { roundId, startAt, endAt, winnerIndex: winnerForRound(roundId) },
      history,
      rebuilt: false,
      deduped,
    });
  } catch (e) {
    return res.status(500).json({ error: "state_error", message: String(e) });
  }
}
