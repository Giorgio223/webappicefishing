import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;               // ENV
const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID || "0");  // ENV (581727401)
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";       // ENV
const WEBAPP_URL = "https://www.icefishing.business/";          // твой сайт

function toNanoInt(ton) {
  const n = Number(ton);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n * 1e9);
}

async function tgSendMessage(chatId, text, opts = {}) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...opts,
    }),
  });
}

function parseUpdate(update) {
  const msg = update?.message || update?.edited_message;
  const text = msg?.text || "";
  const fromId = msg?.from?.id;
  const chatId = msg?.chat?.id;
  return { text: String(text), fromId, chatId };
}

function isLikelyWallet(s) {
  return typeof s === "string" && s.length >= 20;
}

async function creditWalletBalance(walletAddress, deltaNano) {
  const key = `bal:${walletAddress}`;
  const cur = Number((await redis.get(key)) || "0");
  const next = cur + Number(deltaNano);
  await redis.set(key, String(next));
  return next;
}

async function resolveWalletByTarget(target) {
  // target может быть:
  // 1) @username
  // 2) tgId (цифры)
  // 3) wallet address (EQ.../UQ...)
  if (!target) return { ok: false, reason: "no_target" };

  // wallet directly
  if (isLikelyWallet(target) && !target.startsWith("@")) {
    return { ok: true, wallet: target, resolvedFrom: "wallet" };
  }

  // @username
  if (target.startsWith("@")) {
    const uname = target.slice(1).toLowerCase();
    const tgIdStr = await redis.get(`tg:username:${uname}`);
    if (!tgIdStr) return { ok: false, reason: "username_not_found" };

    const wallet = await redis.get(`tg:wallet:${tgIdStr}`);
    if (!wallet) return { ok: false, reason: "user_has_no_wallet" };

    return { ok: true, wallet: String(wallet), resolvedFrom: `@${uname}` };
  }

  // tgId numeric
  if (/^\d+$/.test(target)) {
    const wallet = await redis.get(`tg:wallet:${target}`);
    if (!wallet) return { ok: false, reason: "user_has_no_wallet" };
    return { ok: true, wallet: String(wallet), resolvedFrom: `tgId:${target}` };
  }

  return { ok: false, reason: "bad_target_format" };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "method" });
    }

    // ✅ Защита Webhook секретом (который задаёшь в setWebhook secret_token)
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
    const { text, fromId, chatId } = parseUpdate(body);

    // Telegram нужен быстрый 200 OK
    res.status(200).json({ ok: true });

    if (!chatId) return;

    const t = String(text || "").trim();

    // ✅ /start и /help — ДЛЯ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ
    if (t === "/start" || t === "/help") {
      await tgSendMessage(
        chatId,
        "🎣 IceFishing\nНажми кнопку, чтобы открыть игру:",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "▶️ Открыть IceFishing", url: WEBAPP_URL }]],
          },
        }
      );
      return;
    }

    // Ниже — только админ
    const isAdmin = Number(fromId) === ADMIN_ID;
    if (!isAdmin) {
      // молча игнорим любые другие сообщения от не-админов
      return;
    }

    // ✅ выдача одноразовой ссылки в админку
    if (t === "/admin") {
      const tok = crypto.randomBytes(24).toString("hex");
      await redis.set(`admin:token:${tok}`, "1", { ex: 60 * 5 }); // 5 минут

      const link = `https://www.icefishing.business/admin.html?token=${tok}`;
      await tgSendMessage(chatId, "🔐 Админ-вход (5 минут):\n" + link);
      return;
    }

    // ✅ кто такой @username / tgId (проверка привязки)
    if (t.startsWith("/who")) {
      const parts = t.split(/\s+/);
      const target = parts[1];

      if (!target) {
        await tgSendMessage(chatId, "Используй: /who @username  (или /who tgId)");
        return;
      }

      if (target.startsWith("@")) {
        const uname = target.slice(1).toLowerCase();
        const tgIdStr = await redis.get(`tg:username:${uname}`);
        if (!tgIdStr) {
          await tgSendMessage(chatId, `❌ @${uname} не найден (он должен 1 раз зайти в WebApp и привязать кошелёк).`);
          return;
        }
        const wallet = await redis.get(`tg:wallet:${tgIdStr}`);
        await tgSendMessage(chatId, `@${uname} -> tgId=${tgIdStr}\nwallet=${wallet || "не привязан"}`);
        return;
      }

      if (/^\d+$/.test(target)) {
        const wallet = await redis.get(`tg:wallet:${target}`);
        await tgSendMessage(chatId, `tgId=${target}\nwallet=${wallet || "не привязан"}`);
        return;
      }

      await tgSendMessage(chatId, "Формат: /who @username  или  /who tgId");
      return;
    }

    // ✅ баланс по кошельку
    if (t.startsWith("/bal")) {
      const parts = t.split(/\s+/);
      const wallet = parts[1];
      if (!wallet) {
        await tgSendMessage(chatId, "Используй: /bal <walletAddress>");
        return;
      }
      const cur = Number((await redis.get(`bal:${wallet}`)) || "0") / 1e9;
      await tgSendMessage(chatId, `Баланс ${wallet} = ${cur} TON`);
      return;
    }

    // ✅ топап
    if (t.toLowerCase().startsWith("/topup")) {
      const parts = t.split(/\s+/);
      const target = parts[1];
      const amountTon = parts[2];

      if (!target || !amountTon) {
        await tgSendMessage(
          chatId,
          "Используй:\n" +
            "/topup @username amountTon\n" +
            "/topup tgId amountTon\n" +
            "/topup walletAddress amountTon\n\n" +
            "Пример: /topup @vasya 1.5"
        );
        return;
      }

      const deltaNano = toNanoInt(amountTon);
      if (deltaNano === null) {
        await tgSendMessage(chatId, "❌ Некорректная сумма. Пример: 0.1 / 1 / 2.5");
        return;
      }

      const resolved = await resolveWalletByTarget(target);
      if (!resolved.ok) {
        const msg =
          resolved.reason === "username_not_found"
            ? "❌ Username не найден. Пользователь должен 1 раз открыть WebApp и привязать кошелёк."
            : resolved.reason === "user_has_no_wallet"
            ? "❌ У пользователя нет привязанного кошелька."
            : "❌ Неверный формат. Используй /topup @username amount";
        await tgSendMessage(chatId, msg);
        return;
      }

      const nextNano = await creditWalletBalance(resolved.wallet, deltaNano);
      const nextTon = nextNano / 1e9;

      await tgSendMessage(
        chatId,
        `✅ TopUp OK\nКому: ${target} (${resolved.resolvedFrom})\nКошелёк: ${resolved.wallet}\nСумма: +${Number(amountTon)} TON\nНовый баланс: ${nextTon} TON`
      );
      return;
    }

    // Если команда неизвестна:
    await tgSendMessage(chatId, "Команды:\n/admin\n/topup\n/who\n/bal");
  } catch (e) {
    try {
      if (!res.headersSent) res.status(500).json({ ok: false, error: "webhook_error", message: String(e) });
    } catch {}
  }
}
