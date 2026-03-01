import "dotenv/config";
import express from "express";
import axios from "axios";
import OpenAI from "openai";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.PORT || 4010);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TELEGRAM_MODE = String(process.env.TELEGRAM_MODE || "polling").toLowerCase();

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is missing in .env");
  process.exit(1);
}
if (!TELEGRAM_WEBHOOK_SECRET) {
  console.error("TELEGRAM_WEBHOOK_SECRET is missing in .env");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;
const PUBLIC_URL = String(process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const YOOKASSA_SHOP_ID = String(process.env.YOOKASSA_SHOP_ID || "").trim();
const YOOKASSA_SECRET_KEY = String(process.env.YOOKASSA_SECRET_KEY || "").trim();
const YOOKASSA_API = "https://api.yookassa.ru/v3";
const TRIAL_DAYS = 3;
const prisma = new PrismaClient();
const STATE_FILE = path.resolve(process.cwd(), "data", "bot-state.json");

const app = express();
app.use(express.json());

const MODES = {
  normal: {
    label: "Обычный",
    system: "Пиши естественный ответ как человек. 1-2 предложения, без лишней воды.",
  },
  short: {
    label: "Коротко",
    system: "Пиши очень кратко: 1 предложение, по сути, без вступлений.",
  },
  polite: {
    label: "Вежливо",
    system: "Пиши максимально вежливо и уважительно, но коротко и понятно.",
  },
  tothepoint: {
    label: "По делу",
    system: "Пиши строго по делу, факты и действие, без лишних слов.",
  },
  refuse: {
    label: "Отказать",
    system: "Сформулируй мягкий и корректный отказ, без грубости.",
  },
  busy: {
    label: "Занят",
    system: "Сформулируй короткий ответ, что сейчас занят и вернешься позже.",
  },
};

const sessions = new Map();
const replyKeyboardRemovedUsers = new Set();
const pendingPayments = new Map();
let botUsernameCache = (process.env.TELEGRAM_BOT_USERNAME || "").trim();
let prismaTelegramSchemaReady = true;

async function readStateFile() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : { users: {} };
  } catch {
    return { users: {} };
  }
}

async function writeStateFile(data) {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("state write error:", e?.message || e);
  }
}

async function fallbackUpsertUser(userId, username = null) {
  const tg = String(userId);
  const state = await readStateFile();
  if (!state.users[tg]) {
    state.users[tg] = {
      telegramId: tg,
      username: username || null,
      subscriptionTil: null,
      onboardingCompleted: false,
      trialUsed: false,
      createdAt: new Date().toISOString(),
    };
  } else if (username) {
    state.users[tg].username = username;
  }
  if (typeof state.users[tg].onboardingCompleted !== "boolean") {
    // Для старых пользователей считаем онбординг пройденным.
    state.users[tg].onboardingCompleted = true;
  }
  if (typeof state.users[tg].trialUsed !== "boolean") {
    state.users[tg].trialUsed = false;
  }
  await writeStateFile(state);
  return state.users[tg];
}

async function fallbackSetSubscription(userId, until) {
  const tg = String(userId);
  const state = await readStateFile();
  if (!state.users[tg]) {
    state.users[tg] = {
      telegramId: tg,
      username: null,
      subscriptionTil: null,
      onboardingCompleted: false,
      trialUsed: false,
      createdAt: new Date().toISOString(),
    };
  }
  state.users[tg].subscriptionTil = until.toISOString();
  await writeStateFile(state);
}

async function hasUsedTrial(userId, username = null) {
  const user = await fallbackUpsertUser(userId, username);
  return Boolean(user?.trialUsed);
}

async function markTrialUsed(userId, username = null) {
  const tg = String(userId);
  const state = await readStateFile();
  if (!state.users[tg]) {
    state.users[tg] = {
      telegramId: tg,
      username: username || null,
      subscriptionTil: null,
      onboardingCompleted: false,
      trialUsed: true,
      createdAt: new Date().toISOString(),
    };
  } else {
    if (username) state.users[tg].username = username;
    state.users[tg].trialUsed = true;
  }
  await writeStateFile(state);
}

async function getOnboardingCompleted(userId, username = null) {
  const user = await fallbackUpsertUser(userId, username);
  return Boolean(user?.onboardingCompleted);
}

async function setOnboardingCompleted(userId, done, username = null) {
  const tg = String(userId);
  const state = await readStateFile();
  if (!state.users[tg]) {
    state.users[tg] = {
      telegramId: tg,
      username: username || null,
      subscriptionTil: null,
      onboardingCompleted: Boolean(done),
      createdAt: new Date().toISOString(),
    };
  } else {
    if (username) state.users[tg].username = username;
    state.users[tg].onboardingCompleted = Boolean(done);
  }
  await writeStateFile(state);
}

function escapeHtml(input = "") {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSession(userId) {
  const key = String(userId);
  if (!sessions.has(key)) {
    sessions.set(key, {
      mode: "normal",
      delaySec: 10,
      awaitingInput: false,
      lastIncomingText: "",
      lastDraft: "",
      subscriptionUntil: null,
      trialUsed: false,
      pendingTimer: null,
      pendingToken: null,
    });
  }
  return sessions.get(key);
}

function setSession(userId, patch) {
  const s = getSession(userId);
  Object.assign(s, patch);
  sessions.set(String(userId), s);
  return s;
}

async function ensureUserAndHydrateSession(userId, username = null) {
  const telegramId = String(userId);
  const uname = username ? String(username) : null;
  const trialUsed = await hasUsedTrial(userId, uname);
  if (prismaTelegramSchemaReady) {
    try {
      const user = await prisma.user.upsert({
        where: { telegramId },
        update: { ...(uname ? { username: uname } : {}) },
        create: { telegramId, username: uname, style: "default" },
      });

      setSession(userId, {
        subscriptionUntil: user?.subscriptionTil ? new Date(user.subscriptionTil).toISOString() : null,
        trialUsed,
      });

      return user;
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("Unknown argument `telegramId`") || msg.includes("Invalid `prisma.user.upsert()` invocation")) {
        prismaTelegramSchemaReady = false;
      }
      console.error("prisma upsert fallback:", msg);
    }
  }

  const user = await fallbackUpsertUser(userId, uname);
  setSession(userId, {
    subscriptionUntil: user?.subscriptionTil ? new Date(user.subscriptionTil).toISOString() : null,
    trialUsed: Boolean(user?.trialUsed),
  });
  return user;
}

function getTariffByAction(action) {
  const tariffs = {
    buy_7: { code: "7", title: "Неделя", price: 150, days: 7 },
    buy_30: { code: "30", title: "Месяц", price: 450, days: 30 },
    buy_180: { code: "180", title: "Полгода", price: 1990, days: 180 },
    buy_365: { code: "365", title: "Год", price: 3184, days: 365 },
  };
  return tariffs[action] || null;
}

function getYooAuthHeader() {
  const raw = `${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function activateSubscription(userId, days, username = null) {
  const user = await ensureUserAndHydrateSession(userId, username);
  const now = new Date();
  let base = now;
  if (user?.subscriptionTil) {
    const old = new Date(user.subscriptionTil);
    if (!Number.isNaN(old.getTime()) && old > now) base = old;
  }
  const until = new Date(base);
  until.setDate(until.getDate() + Number(days || 0));
  if (prismaTelegramSchemaReady) {
    try {
      await prisma.user.update({
        where: { telegramId: String(userId) },
        data: { subscriptionTil: until },
      });
    } catch (e) {
      const msg = String(e?.message || "");
      console.error("prisma update fallback:", msg);
      prismaTelegramSchemaReady = false;
      await fallbackSetSubscription(userId, until);
    }
  } else {
    await fallbackSetSubscription(userId, until);
  }

  setSession(userId, { subscriptionUntil: until.toISOString() });
  return until;
}

async function createYooPayment({ userId, plan, username }) {
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    throw new Error("YOOKASSA credentials are not configured");
  }

  const returnUrl = username ? `https://t.me/${username}` : "https://t.me";
  const idempotenceKey = crypto.randomUUID();

  const payload = {
    amount: {
      value: Number(plan.price).toFixed(2),
      currency: "RUB",
    },
    capture: true,
    confirmation: {
      type: "redirect",
      return_url: returnUrl,
    },
    description: `ИИ-секретарь: ${plan.title} (${plan.days} дн.)`,
    metadata: {
      user_id: String(userId),
      plan_code: plan.code,
      plan_days: String(plan.days),
    },
  };

  const resp = await axios.post(`${YOOKASSA_API}/payments`, payload, {
    headers: {
      "Idempotence-Key": idempotenceKey,
      Authorization: getYooAuthHeader(),
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  const payment = resp.data;
  if (!payment?.id || !payment?.confirmation?.confirmation_url) {
    throw new Error("Invalid YooKassa create payment response");
  }

  pendingPayments.set(String(payment.id), {
    userId: String(userId),
    days: plan.days,
    title: plan.title,
    price: plan.price,
    createdAt: Date.now(),
  });

  return payment;
}

async function getYooPayment(paymentId) {
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    throw new Error("YOOKASSA credentials are not configured");
  }
  const resp = await axios.get(`${YOOKASSA_API}/payments/${paymentId}`, {
    headers: {
      Authorization: getYooAuthHeader(),
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
  return resp.data;
}

function isPremium(s) {
  if (!s?.subscriptionUntil) return false;
  const dt = new Date(s.subscriptionUntil);
  if (Number.isNaN(dt.getTime())) return false;
  return dt > new Date();
}

function cancelPending(userId) {
  const s = getSession(userId);
  if (s.pendingTimer) {
    try {
      clearTimeout(s.pendingTimer);
    } catch {}
  }
  setSession(userId, { pendingTimer: null, pendingToken: null });
}

async function tg(method, payload) {
  const url = `${TELEGRAM_API}/${method}`;
  const resp = await axios.post(url, payload);
  if (!resp.data?.ok) {
    throw new Error(`Telegram API ${method} failed: ${JSON.stringify(resp.data)}`);
  }
  return resp.data.result;
}

async function ensureWebhook() {
  if (!PUBLIC_URL) {
    console.log("PUBLIC_URL is not set, webhook auto-setup skipped");
    return;
  }

  const webhookUrl = `${PUBLIC_URL}/webhook/${TELEGRAM_WEBHOOK_SECRET}`;

  try {
    await tg("setWebhook", { url: webhookUrl });
    const info = await tg("getWebhookInfo", {});
    console.log("Webhook set:", webhookUrl);
    console.log("Webhook pending_update_count:", info?.pending_update_count ?? 0);
    if (info?.last_error_message) {
      console.log("Webhook last_error_message:", info.last_error_message);
    }
  } catch (e) {
    console.error("Webhook setup failed:", e?.response?.data || e?.message || e);
  }
}

async function sendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  try {
    return await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...extra,
    });
  } catch (e) {
    const desc = e?.response?.data?.description || e?.message || "";
    if (String(desc).includes("message is not modified")) return null;
    throw e;
  }
}

async function answerCallbackQuery(callbackQueryId, extra = {}) {
  try {
    return await tg("answerCallbackQuery", { callback_query_id: callbackQueryId, ...extra });
  } catch {
    return null;
  }
}

async function ensureReplyKeyboardRemoved(chatId, userId) {
  const key = String(userId || "");
  if (!key || replyKeyboardRemovedUsers.has(key)) return;
  replyKeyboardRemovedUsers.add(key);

  try {
    await sendMessage(chatId, "Старое меню скрыто.", {
      reply_markup: { remove_keyboard: true },
    });
  } catch (e) {
    console.error("remove_keyboard error:", e?.response?.data || e?.message || e);
  }
}

async function resolveBotUsername() {
  if (botUsernameCache) return botUsernameCache;
  try {
    const me = await tg("getMe", {});
    if (me?.username) botUsernameCache = String(me.username);
  } catch {}
  return botUsernameCache;
}

function homeKeyboard(userId, username) {
  const s = getSession(userId);
  const showTrialButton = !isPremium(s) && !s.trialUsed;
  const rows = [
    [{ text: "✍️ Подготовить ответ", callback_data: "quick_reply_start" }],
    [{ text: "💳 Подписка", callback_data: "menu_sub" }],
    [{ text: "⚙️ Настройки", callback_data: "menu_settings" }],
    ...(showTrialButton ? [[{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }]] : []),
  ];
  return { inline_keyboard: rows };
}

function quickReplyKeyboard(userId) {
  const s = getSession(userId);
  const premium = isPremium(s);

  const modeButton = (key, label) => {
    const mark = s.mode === key ? "✅ " : "";
    const locked = !premium && !["normal", "short"].includes(key);
    return {
      text: locked ? `🔒 ${label}` : `${mark}${label}`,
      callback_data: locked ? "menu_sub" : `quick_mode_${key}`,
    };
  };

  const delayButton = (sec) => ({
    text: `${s.delaySec === sec ? "✅ " : ""}⏱ ${sec} сек`,
    callback_data: `quick_delay_${sec}`,
  });

  return {
    inline_keyboard: [
      [modeButton("normal", "🧠 Обычный"), modeButton("short", "⚡ Коротко")],
      [modeButton("polite", "🤝 Вежливо"), modeButton("tothepoint", "🎯 По делу")],
      [modeButton("refuse", "🙅 Отказать"), modeButton("busy", "⏳ Занят")],
      [delayButton(10), delayButton(20)],
      [{ text: "✍️ Ввести текст", callback_data: "quick_input" }],
      ...(s.lastIncomingText
        ? [[{ text: "⚡ Ответить на последнее", callback_data: "quick_use_last" }]]
        : []),
      [{ text: "⬅ Назад", callback_data: "menu_home" }],
    ],
  };
}

function settingsKeyboard(username) {
  const rows = [
    [{ text: "👥 Группы (подсказки)", callback_data: "connect_chat" }],
    [{ text: "❓ Помощь", callback_data: "help_how" }],
    [{ text: "💳 Подписка", callback_data: "menu_sub" }],
    [{ text: "🔄 Пройти онбординг заново", callback_data: "onboarding_restart" }],
  ];
  rows.push([{ text: "⬅ Назад", callback_data: "menu_home" }]);
  return { inline_keyboard: rows };
}

function formatShortDate(input) {
  if (!input) return "";
  const dt = new Date(input);
  if (Number.isNaN(dt.getTime())) return "";
  const d = dt.getDate();
  const m = dt.getMonth() + 1;
  const y = dt.getFullYear();
  return `${d}/${m}/${y}`;
}

function formatUsDate(input) {
  if (!input) return "";
  const dt = new Date(input);
  if (Number.isNaN(dt.getTime())) return "";
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  const y = dt.getFullYear();
  return `${m}/${d}/${y}`;
}

function getStyleFromMode(mode) {
  const map = {
    normal: "Обычный",
    short: "Короткий",
    polite: "Вежливый",
    tothepoint: "По делу",
    refuse: "Строгий",
    busy: "Сдержанный",
  };
  return map[mode] || "Обычный";
}

function buildHomeText(userId) {
  const s = getSession(userId);
  const showUpsell = !isPremium(s) && !s.trialUsed;
  return (
    "🤖 <b>Готовые ответы для твоих чатов - за 10 секунд</b>\n\n" +
    "Ты вставляешь сообщение - я предлагаю вариант ответа. Ты копируешь и отправляешь его сам.\n\n" +
    "<b>Что сделать сейчас:</b>\n" +
    "1) Нажми ✍️ <b>Подготовить ответ</b>\n" +
    "2) Выбери режим и отправь текст\n" +
    "3) Скопируй готовый ответ и отправь собеседнику\n\n" +
    "Пример:\n" +
    "«Можно созвониться завтра?» ->\n" +
    "«Да, давай после 16:00. Напиши, какое время тебе удобно»\n\n" +
    "🆓 Бесплатно: 5 черновиков в день.\n" +
    (showUpsell ? "🎁 Все режимы и больше вариантов доступны в подписке. Начни с <b>пробной 0 ₽</b>.\n\n" : "\n") +
    "👇 Нажми кнопку ниже и попробуй."
  );
}

function buildQuickStartText() {
  return (
    "✍️ <b>Подготовить первый ответ</b>\n\n" +
    "Пришли сюда <b>одно сообщение</b> - текст, на который ты хочешь ответить.\n" +
    "Я предложу готовый вариант, а ты его скопируешь и отправишь сам.\n\n" +
    "⏱ Задержка — это пауза перед ответом. Так переписка выглядит естественно.\n\n" +
    "Пример:\n" +
    "«Можно созвониться завтра?» -> «Да, давай после 16:00. Какое время тебе удобно?»\n\n" +
    "👇 Просто отправь сюда сообщение - и я предложу готовый ответ."
  );
}

function buildSettingsText(userId) {
  const s = getSession(userId);
  const styleLabel = getStyleFromMode(s.mode);
  const subLabel = isPremium(s)
    ? `✅ активна до ${formatShortDate(s.subscriptionUntil)}`
    : "🆓 бесплатный режим";

  return (
    "⚙️ <b>Настройки</b>\n\n" +
    "Здесь ты управляешь ботом: подпиской, подсказками для групп и справкой.\n\n" +
    `💳 <b>Подписка:</b> ${subLabel}\n` +
    `🎨 <b>Стиль:</b> ${escapeHtml(styleLabel)}`
  );
}

function buildHelpText() {
  return (
    "🆘 <b>Помощь</b>\n\n" +
    "Доступные команды:\n" +
    "• /start - главное меню\n" +
    "• /status - твой статус и подписка\n" +
    "• /profile - профиль (то же, что /status)\n" +
    "• /help - эта справка\n" +
    "• /onboarding - пройти онбординг заново\n\n" +
    "Основное управление - через кнопки в меню."
  );
}

function buildSubText(userId) {
  const s = getSession(userId);
  const status = isPremium(s)
    ? `✅ Активна до ${formatUsDate(s.subscriptionUntil)}`
    : "❌ Нет активной подписки";
  return (
    "💳 <b>Подписка на ИИ-секретаря</b>\n\n" +
    "Что даёт подписка:\n" +
    "• 🔗 черновики автоответчика в личке (без лимита)\n" +
    "• 🎭 стили общения\n" +
    "• 🧠 личный промпт\n" +
    "• 🧾 логи сообщений\n\n" +
    "Бесплатно доступно:\n" +
    "• базовые ответы\n" +
    "• автоответчик-черновики: 5/день\n\n" +
    `Статус: ${status}\n\n` +
    "Выберите тариф ниже:"
  );
}

function subKeyboard(userId) {
  const s = getSession(userId);
  const canShowTrial = !s.trialUsed;
  return {
    inline_keyboard: [
      ...(canShowTrial ? [[{ text: "🎁 Пробная — 0 ₽", callback_data: "buy_trial" }]] : []),
      [{ text: "Неделя — 150 ₽", callback_data: "buy_7" }],
      [{ text: "Месяц — 450 ₽", callback_data: "buy_30" }],
      [{ text: "Полгода — 1990 ₽", callback_data: "buy_180" }],
      [{ text: "Год — 3184 ₽", callback_data: "buy_365" }],
      [{ text: "🔄 Обновить", callback_data: "menu_sub" }],
      [{ text: "⬅️ Назад", callback_data: "menu_home" }],
    ],
  };
}

function draftResultKeyboard(userId) {
  const s = getSession(userId);
  return {
    inline_keyboard: [
      [{ text: "📋 Скопировать", callback_data: "quick_copy" }],
      [{ text: "🔄 Еще вариант", callback_data: "quick_reply_regen" }],
      ...(!isPremium(s) && !s.trialUsed
        ? [
            [{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }],
            [{ text: "✨ Что дает подписка", callback_data: "sub_benefits" }],
          ]
        : []),
      [
        { text: "✍️ Подготовить еще", callback_data: "quick_reply_start" },
        { text: "🏠 Главное меню", callback_data: "menu_home" },
      ],
    ],
  };
}

async function createDraft(incomingText, mode) {
  const safeMode = MODES[mode] ? mode : "normal";
  const modePrompt = MODES[safeMode].system;

  if (!openai) {
    const fallback = {
      normal: "Понял. Спасибо за сообщение, сейчас уточню детали и вернусь с ответом.",
      short: "Понял, уточню детали и отвечу.",
      polite: "Благодарю за сообщение. Уточните, пожалуйста, детали, чтобы я ответил точнее.",
      tothepoint: "Принято. Нужны сроки и конкретика для точного ответа.",
      refuse: "Спасибо за предложение, но сейчас не смогу подключиться.",
      busy: "Сейчас занят, отвечу чуть позже.",
    };
    return fallback[safeMode] || fallback.normal;
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.5,
    max_tokens: 180,
    messages: [
      {
        role: "system",
        content:
          "Ты личный помощник по переписке. Генерируешь один готовый текст ответа, который пользователь скопирует и отправит сам. Без кавычек, без заголовков, без пояснений.",
      },
      {
        role: "system",
        content: modePrompt,
      },
      {
        role: "user",
        content: `Сообщение собеседника:\n${incomingText}`,
      },
    ],
  });

  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty model response");
  return text;
}

async function sendDraftWithDelay({ chatId, userId, incomingText }) {
  const s = getSession(userId);
  cancelPending(userId);

  await sendMessage(chatId, `⏳ Думаю над ответом...\nПришлю вариант через ${s.delaySec} сек.`, {
    parse_mode: "HTML",
  });

  const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  setSession(userId, { pendingToken: token, lastIncomingText: incomingText, awaitingInput: false });

  const timer = setTimeout(async () => {
    const current = getSession(userId);
    if (current.pendingToken !== token) return;

    try {
      const draft = await createDraft(incomingText, current.mode);
      setSession(userId, { lastDraft: draft, pendingToken: null, pendingTimer: null });

      const upsell = !isPremium(current)
        ? "\n\n<b>Хочешь еще сильнее?</b>\nПодписка открывает режимы: <b>Вежливо, По делу, Отказать, Занят</b> и дает больше вариантов."
        : "";

      await sendMessage(
        chatId,
        "📝 <b>Готовый ответ:</b>\n\n" +
          `${escapeHtml(draft)}\n\n` +
          "<i>(Скопируй и отправь собеседнику)</i>" +
          upsell,
        {
          parse_mode: "HTML",
          reply_markup: draftResultKeyboard(userId),
        }
      );
    } catch (err) {
      console.error("draft generation error:", err?.message || err);
      await sendMessage(chatId, "Не получилось подготовить ответ. Попробуй еще раз.", {
        reply_markup: { inline_keyboard: [[{ text: "✍️ Подготовить ответ", callback_data: "quick_reply_start" }]] },
      });
      setSession(userId, { pendingToken: null, pendingTimer: null });
    }
  }, Math.max(1, Number(s.delaySec || 10)) * 1000);

  setSession(userId, { pendingTimer: timer });
}

async function renderHome(chatId, userId, messageId = null) {
  const username = await resolveBotUsername();
  const payload = {
    parse_mode: "HTML",
    reply_markup: homeKeyboard(userId, username),
  };
  if (messageId) {
    return editMessageText(chatId, messageId, buildHomeText(userId), payload);
  }
  return sendMessage(chatId, buildHomeText(userId), payload);
}

async function renderQuickStart(chatId, userId, messageId) {
  setSession(userId, { awaitingInput: true });
  return editMessageText(chatId, messageId, buildQuickStartText(), {
    parse_mode: "HTML",
    reply_markup: quickReplyKeyboard(userId),
  });
}

async function renderSettings(chatId, userId, messageId) {
  const username = await resolveBotUsername();
  return editMessageText(chatId, messageId, buildSettingsText(userId), {
    parse_mode: "HTML",
    reply_markup: settingsKeyboard(username),
  });
}

async function renderHelp(chatId, messageId) {
  return editMessageText(chatId, messageId, buildHelpText(), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "⬅ Назад", callback_data: "menu_home" }]] },
  });
}

async function renderConnect(chatId, messageId) {
  const text =
    "👥 <b>Группы (подсказки)</b>\n\n" +
    "Бот не отправляет сообщения в группы от твоего имени.\n" +
    "Он подготавливает черновики в личке, а ты отправляешь их сам.\n\n" +
    "Чтобы использовать в группах:\n" +
    "1) Добавь бота в группу\n" +
    "2) Пиши в личку боту и готовь ответ\n" +
    "3) Копируй и отправляй вручную";

  return editMessageText(chatId, messageId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "⬅ Назад", callback_data: "menu_home" }]] },
  });
}

async function renderOnboarding(chatId, userId, step = 1, messageId = null) {
  let text = "";
  let keyboard = { inline_keyboard: [] };

  if (step === 1) {
    text =
      "🤖 <b>Добро пожаловать!</b>\n\n" +
      "Я помогу быстро готовить ответы в переписке.\n" +
      "Ты вставляешь сообщение, я даю готовый вариант,\n" +
      "ты копируешь и отправляешь сам.\n\n" +
      "Давай покажу, как пользоваться.";
    keyboard = {
      inline_keyboard: [
        [{ text: "🚀 Начать", callback_data: "onb_next_2" }],
        [{ text: "⏭ Пропустить", callback_data: "onb_done" }],
      ],
    };
  }

  if (step === 2) {
    text =
      "✍️ <b>Как получить первый ответ</b>\n\n" +
      "1) Нажми «Подготовить ответ»\n" +
      "2) Выбери режим (обычный/коротко и т.д.)\n" +
      "3) Нажми «Ввести текст» и отправь сообщение\n\n" +
      "Я пришлю готовый вариант, который можно сразу отправить.";
    keyboard = {
      inline_keyboard: [
        [{ text: "⬅ Назад", callback_data: "onb_back_1" }],
        [{ text: "Дальше ➡️", callback_data: "onb_next_3" }],
      ],
    };
  }

  if (step === 3) {
    text =
      "⚙️ <b>Что ещё важно</b>\n\n" +
      "• В «Настройках» есть помощь и повтор онбординга\n" +
      "• В «Подписке» доступны все режимы и тарифы\n" +
      "• Кнопка «Группы» — для подсказок по чатам\n\n" +
      "Готово. Можно начинать использовать бота.";
    keyboard = {
      inline_keyboard: [
        [{ text: "⬅ Назад", callback_data: "onb_back_2" }],
        [{ text: "✅ Поехали", callback_data: "onb_done" }],
      ],
    };
  }

  if (messageId) {
    return editMessageText(chatId, messageId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  return sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

async function handleCommand(message, text) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!userId) return;
  await ensureUserAndHydrateSession(userId, message.from?.username || null);

  const cmd = text.split(" ")[0].toLowerCase();

  if (cmd === "/start") {
    const onboardingDone = await getOnboardingCompleted(userId, message.from?.username || null);
    if (!onboardingDone) return renderOnboarding(chatId, userId, 1);
    return renderHome(chatId, userId);
  }
  if (cmd === "/help") {
    return sendMessage(chatId, buildHelpText(), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "📋 Секретарские команды", callback_data: "help_secretary" }]],
      },
    });
  }
  if (cmd === "/onboarding") {
    setSession(userId, { awaitingInput: false });
    await setOnboardingCompleted(userId, false, message.from?.username || null);
    return renderOnboarding(chatId, userId, 1);
  }
  if (cmd === "/status" || cmd === "/profile") {
    const s = getSession(userId);
    const statusText =
      "📊 <b>Твой профиль</b>\n\n" +
      `💳 <b>Подписка:</b> ${isPremium(s) ? "✅ активна (пробная)" : "🆓 бесплатный режим"}\n` +
      `🎨 <b>Режим:</b> ${escapeHtml(MODES[s.mode]?.label || MODES.normal.label)}\n` +
      `⏱ <b>Задержка:</b> ${s.delaySec} сек`;
    return sendMessage(chatId, statusText, { parse_mode: "HTML" });
  }
}

async function handleCallback(query) {
  const data = query.data;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const userId = query.from?.id;
  if (!data || !chatId || !messageId || !userId) return;
  await ensureUserAndHydrateSession(userId, query.from?.username || null);

  await answerCallbackQuery(query.id);

  if (data === "onb_next_2") return renderOnboarding(chatId, userId, 2, messageId);
  if (data === "onb_next_3") return renderOnboarding(chatId, userId, 3, messageId);
  if (data === "onb_back_1") return renderOnboarding(chatId, userId, 1, messageId);
  if (data === "onb_back_2") return renderOnboarding(chatId, userId, 2, messageId);
  if (data === "onb_done" || data === "onb_skip") {
    await setOnboardingCompleted(userId, true, query.from?.username || null);
    return renderHome(chatId, userId, messageId);
  }

  if (data === "menu_home") return renderHome(chatId, userId, messageId);
  if (data === "quick_reply_start") return renderQuickStart(chatId, userId, messageId);
  if (data === "quick_input") {
    setSession(userId, { awaitingInput: true });
    return sendMessage(
      chatId,
      "✍️ <b>Ввести текст</b>\n\nПришли одно сообщение, на которое нужно подготовить ответ.",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅ Назад", callback_data: "quick_reply_start" }],
            [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
          ],
        },
      }
    );
  }

  if (data === "quick_use_last") {
    const s = getSession(userId);
    if (!s.lastIncomingText) {
      return sendMessage(chatId, "Нет последнего сообщения. Нажми «✍️ Ввести текст».", {
        reply_markup: { inline_keyboard: [[{ text: "✍️ Ввести текст", callback_data: "quick_input" }]] },
      });
    }
    return sendDraftWithDelay({ chatId, userId, incomingText: s.lastIncomingText });
  }

  if (data === "quick_copy") {
    const s = getSession(userId);
    if (!s.lastDraft) {
      return answerCallbackQuery(query.id, { text: "Черновика еще нет", show_alert: true });
    }
    return sendMessage(chatId, "📋 <b>Текст для копирования:</b>\n\n" + escapeHtml(s.lastDraft), {
      parse_mode: "HTML",
      reply_markup: draftResultKeyboard(userId),
    });
  }

  if (data === "quick_reply_regen") {
    const s = getSession(userId);
    if (!s.lastIncomingText) {
      return answerCallbackQuery(query.id, { text: "Сначала пришли текст", show_alert: true });
    }
    return sendDraftWithDelay({ chatId, userId, incomingText: s.lastIncomingText });
  }

  if (data.startsWith("quick_delay_")) {
    const delay = Number(data.replace("quick_delay_", ""));
    if (delay === 10 || delay === 20) {
      setSession(userId, { delaySec: delay });
      await answerCallbackQuery(query.id, { text: `Задержка: ${delay} сек` });
    }
    return editMessageText(chatId, messageId, buildQuickStartText(), {
      parse_mode: "HTML",
      reply_markup: quickReplyKeyboard(userId),
    });
  }

  if (data.startsWith("quick_mode_")) {
    const nextMode = data.replace("quick_mode_", "");
    const s = getSession(userId);
    if (!MODES[nextMode]) return;

    if (!isPremium(s) && !["normal", "short"].includes(nextMode)) {
      return editMessageText(
        chatId,
        messageId,
        "🔒 <b>Режимы доступны по подписке</b>\n\nОткрой пробную подписку за 0 ₽, чтобы включить расширенные режимы.",
        { parse_mode: "HTML", reply_markup: subKeyboard(userId) }
      );
    }

    setSession(userId, { mode: nextMode });
    await answerCallbackQuery(query.id, { text: `Режим: ${MODES[nextMode].label}` });
    return editMessageText(chatId, messageId, buildQuickStartText(), {
      parse_mode: "HTML",
      reply_markup: quickReplyKeyboard(userId),
    });
  }

  if (data === "menu_settings") return renderSettings(chatId, userId, messageId);
  if (data === "help_how") return renderHelp(chatId, messageId);
  if (data === "connect_chat") return renderConnect(chatId, messageId);
  if (data === "menu_sub") {
    return editMessageText(chatId, messageId, buildSubText(userId), {
      parse_mode: "HTML",
      reply_markup: subKeyboard(userId),
    });
  }
  if (data === "sub_benefits") {
    return editMessageText(
      chatId,
      messageId,
      "✨ <b>Что даёт подписка</b>\n\n" +
        "• ♾️ безлимит на черновики\n" +
        "• 🎯 все режимы ответа: Вежливо, По делу, Отказать, Занят\n" +
        "• 🔄 больше вариантов на одно сообщение\n" +
        "• ⚡ приоритет генерации\n" +
        "• 🧾 история и логи",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            ...(!getSession(userId).trialUsed ? [[{ text: "🎁 Пробная — 0 ₽", callback_data: "buy_trial" }]] : []),
            [{ text: "⬅ Назад", callback_data: "menu_sub" }],
          ],
        },
      }
    );
  }
  if (data === "buy_trial") {
    const s = getSession(userId);
    if (s.trialUsed) {
      return editMessageText(
        chatId,
        messageId,
        "ℹ️ <b>Пробная подписка уже использована.</b>\n\nВыбери один из платных тарифов ниже.",
        {
          parse_mode: "HTML",
          reply_markup: subKeyboard(userId),
        }
      );
    }
    const until = await activateSubscription(userId, TRIAL_DAYS, query.from?.username || null);
    await markTrialUsed(userId, query.from?.username || null);
    setSession(userId, { trialUsed: true });
    return editMessageText(
      chatId,
      messageId,
      `🎁 <b>Пробная подписка активирована</b>\n\nПробный период: ${TRIAL_DAYS} дня.\nАктивна до ${formatShortDate(until)}.\nТеперь доступны все режимы ответов.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✍️ Подготовить ответ", callback_data: "quick_reply_start" }],
            [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
          ],
        },
      }
    );
  }
  if (data.startsWith("pay_check:")) {
    const paymentId = data.replace("pay_check:", "").trim();
    if (!paymentId) return;

    const pending = pendingPayments.get(paymentId);
    if (!pending || pending.userId !== String(userId)) {
      return editMessageText(
        chatId,
        messageId,
        "⚠️ Платёж не найден в текущей сессии.\n\nОткрой «Подписка» и создай оплату заново.",
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "⬅️ К подписке", callback_data: "menu_sub" }]] },
        }
      );
    }

    try {
      const payment = await getYooPayment(paymentId);
      const status = String(payment?.status || "");

      if (status !== "succeeded") {
        return editMessageText(
          chatId,
          messageId,
          "⏳ <b>Оплата ещё не завершена</b>\n\n" +
            `Статус: <b>${escapeHtml(status || "pending")}</b>\n` +
            "Если ты уже оплатил, нажми «Проверить ещё раз».",
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Проверить ещё раз", callback_data: `pay_check:${paymentId}` }],
                [{ text: "⬅️ К подписке", callback_data: "menu_sub" }],
              ],
            },
          }
        );
      }

      const until = await activateSubscription(userId, pending.days, query.from?.username || null);
      pendingPayments.delete(paymentId);

      return editMessageText(
        chatId,
        messageId,
        "✅ <b>Оплата прошла</b>\n\n" +
          `Тариф: <b>${escapeHtml(pending.title)}</b>\n` +
          `Подписка активна до: <b>${formatUsDate(until)}</b>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Открыть подписку", callback_data: "menu_sub" }],
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        }
      );
    } catch (e) {
      console.error("pay_check error:", e?.response?.data || e?.message || e);
      return editMessageText(
        chatId,
        messageId,
        "❌ Не удалось проверить оплату.\nПопробуй снова через несколько секунд.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Проверить ещё раз", callback_data: `pay_check:${paymentId}` }],
              [{ text: "⬅️ К подписке", callback_data: "menu_sub" }],
            ],
          },
        }
      );
    }
  }
  if (["buy_7", "buy_30", "buy_180", "buy_365"].includes(data)) {
    const plan = getTariffByAction(data);
    if (!plan) return;
    const username = await resolveBotUsername();

    try {
      const payment = await createYooPayment({ userId, plan, username });
      return editMessageText(
        chatId,
        messageId,
        "💳 <b>Оплата тарифа</b>\n\n" +
          `Тариф: <b>${plan.title}</b>\n` +
          `Стоимость: <b>${plan.price} ₽</b>\n\n` +
          "Нажми «Оплатить», затем вернись и нажми «Я оплатил».",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Оплатить", url: payment.confirmation.confirmation_url }],
              [{ text: "✅ Я оплатил", callback_data: `pay_check:${payment.id}` }],
              [{ text: "⬅️ К подписке", callback_data: "menu_sub" }],
            ],
          },
        }
      );
    } catch (e) {
      console.error("create payment error:", e?.response?.data || e?.message || e);
      return editMessageText(
        chatId,
        messageId,
        "❌ Не удалось создать оплату.\nПроверь настройки YooKassa и попробуй снова.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Обновить", callback_data: "menu_sub" }],
              [{ text: "⬅️ К подписке", callback_data: "menu_sub" }],
            ],
          },
        }
      );
    }
  }
  if (data === "onboarding_restart") {
    setSession(userId, { awaitingInput: false });
    await setOnboardingCompleted(userId, false, query.from?.username || null);
    return renderOnboarding(chatId, userId, 1, messageId);
  }
  if (data === "help_secretary") {
    return editMessageText(
      chatId,
      messageId,
      "📋 <b>Секретарские команды</b>\n\n• ответь вежливо\n• ответь коротко\n• ответь по делу\n• откажи вежливо\n• скажи, что занят",
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅ Назад", callback_data: "help_how" }]] },
      }
    );
  }
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const text = message.text?.trim();
  if (!chatId || !userId || !text) return;
  await ensureUserAndHydrateSession(userId, message.from?.username || null);

  await ensureReplyKeyboardRemoved(chatId, userId);

  if (text.startsWith("/")) {
    await handleCommand(message, text);
    return;
  }

  if (message.chat.type !== "private") return;

  const s = getSession(userId);
  if (!s.awaitingInput) return;

  await sendDraftWithDelay({ chatId, userId, incomingText: text });
}

async function processUpdate(update) {
  try {
    if (update?.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }
    if (update?.message) {
      await handleMessage(update.message);
      return;
    }
  } catch (err) {
    console.error("update handler error:", err?.response?.data || err?.message || err);
  }
}

async function startPolling() {
  let offset = 0;

  try {
    await tg("deleteWebhook", { drop_pending_updates: false });
    console.log("Telegram mode: polling (webhook disabled)");
  } catch (e) {
    console.error("deleteWebhook error:", e?.response?.data || e?.message || e);
  }

  while (true) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      if (Array.isArray(updates) && updates.length) {
        for (const upd of updates) {
          offset = Number(upd.update_id) + 1;
          await processUpdate(upd);
        }
      }
    } catch (e) {
      console.error("polling error:", e?.response?.data || e?.message || e);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post(`/webhook/${TELEGRAM_WEBHOOK_SECRET}`, async (req, res) => {
  res.status(200).json({ ok: true });

  const update = req.body;
  await processUpdate(update);
});

app.listen(PORT, async () => {
  await resolveBotUsername();
  if (TELEGRAM_MODE === "webhook") {
    await ensureWebhook();
    console.log("Telegram mode: webhook");
  } else {
    startPolling().catch((e) => {
      console.error("startPolling fatal:", e?.message || e);
    });
  }
  console.log(`Server listening on port ${PORT}`);
  console.log(`Webhook endpoint: /webhook/${TELEGRAM_WEBHOOK_SECRET}`);
});

async function shutdown(signal) {
  try {
    console.log(`Received ${signal}, disconnecting prisma...`);
    await prisma.$disconnect();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
