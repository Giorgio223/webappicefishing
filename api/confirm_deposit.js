import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TO_ADDRESS = process.env.TREASURY_TON_ADDRESS;

const TONCENTER_ENDPOINT = process.env.TONCENTER_ENDPOINT || "https://toncenter.com/api/v2";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || ""; // можно пустым, если у тебя без ключа работает

const MIN_WAIT_MS = 45_000;

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// TON Center v2: /getTransactions?address=...&limit=...
async function toncenterGetTransactions(address, limit = 50) {
  const url = new URL(TONCENTER_ENDPOINT + "/getTransactions");
  url.searchParams.set("address", address);
  url.searchParams.set("limit", String(limit));
  if (TONCENTER_API_KEY) url.searchParams.set("api_key", TONCENTER_API_KEY);

  const r = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(`toncenter_error:${r.status}:${j.error || "unknown"}`);
  }
  return j.result || [];
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    if (!TO_ADDRESS) return res.status(500).json({ error: "no_treasury_address" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const intentId = String(body.intentId || "");
    const address = String(body.address || ""); // привязанный кошелек (sender)
    if (!intentId || !address) return res.status(400).json({ error: "bad_request" });

    const intentRaw = await redis.get(`dep:intent:${intentId}`);
    if (!intentRaw) return res.status(404).json({ error: "intent_not_found" });
    const intent = typeof intentRaw === "string" ? JSON.parse(intentRaw) : intentRaw;

    // wait 45s
    const createdAt = Number(intent.createdAt || 0);
    const age = Date.now() - createdAt;
    if (createdAt && age < MIN_WAIT_MS) {
      return res.status(200).json({ status: "wait", retryAfterMs: MIN_WAIT_MS - age });
    }

    // already credited?
    const creditedKey = `dep:credited:${intentId}`;
    const already = await redis.get(creditedKey);
    if (already) {
      return res.status(200).json({ status: "credited", creditedTon: Number(intent.amountNano) / 1e9 });
    }

    const wantComment = String(intent.comment || "").trim();
    const wantAmountNano = String(intent.amountNano || "0");

    // fetch last txs of treasury
    const txs = await toncenterGetTransactions(TO_ADDRESS, 80);

    // TON Center tx format: each tx has in_msg { source, value, message }
    let found = null;

    for (const tx of txs) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      const value = String(inMsg.value || "0");
      if (value !== wantAmountNano) continue;

      const src = inMsg.source;
      if (!src) continue;
      if (norm(src) !== norm(address)) continue;

      const msg = String(inMsg.message || "").trim();
      // comment may be exact or included
      if (msg === wantComment || (msg && msg.includes(wantComment))) {
        found = tx;
        break;
      }
    }

    if (!found) return res.status(200).json({ status: "pending" });

    // credit balance
    const balKey = `bal:${address}`;
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
