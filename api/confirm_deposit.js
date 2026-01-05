import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TO_ADDRESS = process.env.TREASURY_TON_ADDRESS;

const TONCENTER_ENDPOINT = process.env.TONCENTER_ENDPOINT || "https://toncenter.com/api/v2";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || "";

const MIN_WAIT_MS = 45_000;

// ---- TonCenter helpers ----
async function tcJson(path, params = {}) {
  const url = new URL(TONCENTER_ENDPOINT + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (TONCENTER_API_KEY) url.searchParams.set("api_key", TONCENTER_API_KEY);

  const r = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`toncenter_${r.status}:${j.error || "unknown"}`);
  return j;
}

async function unpackToRaw(address) {
  // TonCenter unpackAddress принимает friendly(EQ..) и raw(0:..) и возвращает единый вид
  const j = await tcJson("/unpackAddress", { address });
  // result: { raw_form: "0:....", ... } (у TonCenter может называться raw_form)
  const r = j.result || {};
  return String(r.raw_form || r.raw || r.address || "").toLowerCase();
}

async function getTreasuryTxs(limit = 80) {
  const j = await tcJson("/getTransactions", { address: TO_ADDRESS, limit });
  return j.result || [];
}

function toNanoStr(v) {
  return String(v || "0");
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    if (!TO_ADDRESS) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const intentId = String(body.intentId || "");
    const userWalletFriendlyOrRaw = String(body.address || "");

    if (!intentId || !userWalletFriendlyOrRaw) return res.status(400).json({ error: "bad_request" });

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });
    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    // wait 45s
    const createdAt = Number(intent.createdAt || 0);
    const age = Date.now() - createdAt;
    if (createdAt && age < MIN_WAIT_MS) {
      return res.status(200).json({ status: "wait", retryAfterMs: MIN_WAIT_MS - age });
    }

    // already credited
    const creditedKey = `dep:credited:${intentId}`;
    const already = await redis.get(creditedKey);
    if (already) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
    }

    // ✅ normalize user wallet to RAW so it can match TonCenter tx source
    const userRaw = await unpackToRaw(userWalletFriendlyOrRaw);
    if (!userRaw) return res.status(500).json({ error: "cannot_unpack_user_wallet" });

    const wantAmountNano = toNanoStr(intent.amountNano);
    const createdAtSec = Math.floor(createdAt / 1000);

    const txs = await getTreasuryTxs(80);

    let found = null;

    for (const tx of txs) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      // amount
      const value = toNanoStr(inMsg.value);
      if (value !== wantAmountNano) continue;

      // time: only tx after intent was created (small tolerance -60s)
      const utime = Number(tx.utime || 0);
      if (createdAtSec && utime && utime < (createdAtSec - 60)) continue;

      // sender
      const src = String(inMsg.source || "");
      if (!src) continue;

      // src from TonCenter is usually already raw; still normalize for safety
      const srcRaw = src.includes(":") ? src.toLowerCase() : await unpackToRaw(src);
      if (!srcRaw) continue;

      if (srcRaw === userRaw) {
        found = tx;
        break;
      }
    }

    if (!found) return res.status(200).json({ status: "pending" });

    // credit
    const balKey = `bal:${userWalletFriendlyOrRaw}`; // баланс хранится по тому ключу, который ты используешь в /api/balance
    const cur = Number((await redis.get(balKey)) || "0");
    const next = cur + Number(intent.amountNano);

    await redis.set(balKey, String(next));
    await redis.set(creditedKey, "1", { ex: 60 * 60 * 24 });

    await redis.set(
      `dep:intent:${intentId}`,
      JSON.stringify({ ...intent, status: "credited", creditedAt: Date.now() }),
      { ex: 60 * 60 }
    );

    return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
  } catch (e) {
    return res.status(500).json({ error: "confirm_error", message: String(e) });
  }
}
