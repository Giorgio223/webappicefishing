import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || "0");
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

function toNanoInt(ton) {
  const n = Number(ton);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n * 1e9);
}

async function tgSendMessage(chatId, text) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
}

function parseText(update) {
  const msg = update?.message || update?.edited_message;
  const text = msg?.text || "";
  const fromId = msg?.from?.id;
  const chatId = msg?.chat?.id;
  return { text: String(text), fromId, chatId };
}

async function creditBalance(address, deltaNano) {
  const key = `bal:${address}`;
  const cur = Number((await redis.get(key)) || "0");
  const next = cur + Number(deltaNano);
  await redis.set(key, String(next));
  return next;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method" });

    // защита webhook секретом
    if (SECRET) {
      const headerSecret =
        req.headers["x-telegram-bot-api-secret-token"] ||
        req.headers["X-Telegram-Bot-Api-Secret-Token"];
      if (String(headerSecret || "") !== String(SECRET)) {
        return res.status(401).json({ ok: false, error: "bad_secret" });
      }
    }

    if (!BOT_TOKEN) return res.status(500).json({ ok: false, error: "no_bot_token" });
    if (!ADMIN_ID) return res.status(500).json({ ok: false, error: "no_admin_id" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { text, fromId, chatId } = parseText(body);

    // Telegram ждёт 200 OK быстро
    res.status(200).json({ ok: true });

    if (!chatId) return;

    // доступ только тебе
    if (Number(fromId) !== ADMIN_ID) {
      await tgSendMessage(chatId, "❌ Нет доступа.");
      return;
    }

    const t = text.trim();

    // HELP
    if (t === "/start" || t === "/help") {
      await tgSendMessage(
        chatId,
        "Админ команды:\n" +
          "/topup <wallet> <amountTon>\n" +
          "/bal <wallet>\n\n" +
          "Пример:\n/topup EQD... 1.5"
      );
      return;
    }

    // BALANCE CHECK
    if (t.startsWith("/bal")) {
      const parts = t.split(/\s+/);
      const address = parts[1];
      if (!address) {
        await tgSendMessage(chatId, "Используй: /bal <wallet>");
        return;
      }
      const cur = Number((await redis.get(`bal:${address}`)) || "0") / 1e9;
      await tgSendMessage(chatId, `Баланс ${address} = ${cur} TON`);
      return;
    }

    // TOPUP
    if (t.startsWith("/topup")) {
      const parts = t.split(/\s+/);
      const address = parts[1];
      const amountTon = parts[2];

      if (!address || !amountTon) {
        await tgSendMessage(chatId, "Используй: /topup <wallet> <amountTon>\nПример: /topup EQD... 0.5");
        return;
      }

      const deltaNano = toNanoInt(amountTon);
      if (deltaNano === null) {
        await tgSendMessage(chatId, "❌ Некорректная сумма. Пример: 0.1 / 1 / 2.5");
        return;
      }

      const nextNano = await creditBalance(address, deltaNano);
      const nextTon = nextNano / 1e9;

      await tgSendMessage(chatId, `✅ Пополнено: +${Number(amountTon)} TON\nКошелёк: ${address}\nНовый баланс: ${nextTon} TON`);
      return;
    }

    // ignore everything else
  } catch (e) {
    // даже при ошибке стараемся вернуть 200 ранее, но на всякий:
    try {
      if (!res.headersSent) res.status(500).json({ ok: false, error: "webhook_error", message: String(e) });
    } catch {}
  }
}
