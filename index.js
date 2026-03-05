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
const ADMIN_FALLBACK_ID = "1441173568";
const ADMIN_IDS = String(process.env.ADMIN_IDS || process.env.ADMIN_ID || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
if (!ADMIN_IDS.length) {
  ADMIN_IDS.push(ADMIN_FALLBACK_ID);
  console.warn(
    `[admin] ADMIN_ID(S) не задан в .env, включен fallback admin id: ${ADMIN_FALLBACK_ID}`
  );
}
let prisma = null;
try {
  prisma = new PrismaClient();
} catch (e) {
  console.warn("[prisma] disabled at startup:", e?.message || e);
}
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

/** @typedef {"business"|"polite"|"friendly"|"casual"|"short"|"formal"|"neutral"} ParaphraseStyle */
const PARAPHRASE_STYLE = Object.freeze({
  BUSINESS: "business",
  POLITE: "polite",
  FRIENDLY: "friendly",
  CASUAL: "casual",
  SHORT: "short",
  FORMAL: "formal",
  NEUTRAL: "neutral",
});

const STYLE_MODES = {
  [PARAPHRASE_STYLE.BUSINESS]: {
    label: "💼 Деловой",
    instruction:
      [
        "Стиль: business (деловой).",
        "Тон: профессиональный, уверенный, конструктивный.",
        "Лексика: без сленга, без эмоциональных междометий, без фамильярности.",
        "Синтаксис: четкие формулировки, логичная структура, акцент на действии/результате.",
        "Обязательно заметно перефразируй текст (не дословно).",
      ].join(" "),
  },
  [PARAPHRASE_STYLE.POLITE]: {
    label: "🤝 Вежливый",
    instruction:
      [
        "Стиль: polite (вежливый).",
        "Тон: уважительный, мягкий, аккуратный.",
        "Лексика: корректные формулировки, допустимы слова 'пожалуйста', 'буду признателен(на)'.",
        "Синтаксис: плавные и тактичные обороты, без давления.",
        "Обязательно заметно перефразируй текст (не дословно).",
      ].join(" "),
  },
  [PARAPHRASE_STYLE.FRIENDLY]: {
    label: "🙂 Дружелюбный",
    instruction:
      [
        "Стиль: friendly (дружелюбный).",
        "Тон: теплый, живой, естественный, как в комфортном личном общении.",
        "Лексика: простая, человечная, без канцелярита.",
        "Синтаксис: легко читаемые фразы, допустим разговорный ритм.",
        "Обязательно заметно перефразируй текст (не дословно).",
      ].join(" "),
  },
  [PARAPHRASE_STYLE.CASUAL]: {
    label: "🧢 Неформальный",
    instruction:
      [
        "Стиль: casual (неформальный).",
        "Тон: разговорный, простой, без официоза.",
        "Лексика: бытовая и короткая, но без грубости.",
        "Синтаксис: компактные естественные фразы, можно чуть проще по конструкции.",
        "Обязательно заметно перефразируй текст (не дословно).",
      ].join(" "),
  },
  [PARAPHRASE_STYLE.SHORT]: {
    label: "⚡ Кратко",
    instruction:
      [
        "Стиль: short (кратко).",
        "Тон: нейтрально-деловой, по сути.",
        "Длина: 1-2 коротких предложения.",
        "Смысл: сжать формулировку, но не терять факты (имена, даты, время, числа, ссылки, условия).",
        "Обязательно заметно перефразируй текст (не дословно).",
      ].join(" "),
  },
  [PARAPHRASE_STYLE.FORMAL]: {
    label: "🏛 Официальный",
    instruction:
      [
        "Стиль: formal (официальный).",
        "Тон: строго официальный, нейтральный, выдержанный.",
        "Лексика: деловая/официальная, без разговорных слов.",
        "Синтаксис: аккуратные завершенные формулировки, возможно более книжные конструкции.",
        "Обязательно заметно перефразируй текст (не дословно).",
      ].join(" "),
  },
  [PARAPHRASE_STYLE.NEUTRAL]: {
    label: "⚖️ Нейтральный",
    instruction:
      [
        "Стиль: neutral (нейтральный).",
        "Тон: спокойный, ровный, без оценочных эмоций.",
        "Лексика: понятная и универсальная.",
        "Синтаксис: чистые, естественные формулировки без канцелярита.",
        "Обязательно заметно перефразируй текст (не дословно).",
      ].join(" "),
  },
};

const sessions = new Map();
const replyKeyboardRemovedUsers = new Set();
const pendingPayments = new Map();
const usernameToId = new Map();
const processedGroupSignals = new Set();
let botUsernameCache = (process.env.TELEGRAM_BOT_USERNAME || "").trim();
let prismaTelegramSchemaReady = Boolean(prisma);
let prismaFallbackLogged = false;

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
      groups: {},
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
  if (!state.users[tg].groups || typeof state.users[tg].groups !== "object") {
    state.users[tg].groups = {};
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
      groups: {},
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
      groups: {},
      createdAt: new Date().toISOString(),
    };
  } else {
    if (username) state.users[tg].username = username;
    state.users[tg].trialUsed = true;
  }
  await writeStateFile(state);
}

async function fallbackUpsertGroupForUser(userId, chat) {
  const tg = String(userId);
  const state = await readStateFile();
  if (!state.users[tg]) {
    state.users[tg] = {
      telegramId: tg,
      username: null,
      subscriptionTil: null,
      onboardingCompleted: false,
      trialUsed: false,
      groups: {},
      createdAt: new Date().toISOString(),
    };
  }
  if (!state.users[tg].groups || typeof state.users[tg].groups !== "object") {
    state.users[tg].groups = {};
  }

  const groupId = String(chat?.id);
  const prev = state.users[tg].groups[groupId] || {};
  state.users[tg].groups[groupId] = {
    id: groupId,
    title: chat?.title || chat?.username || "Группа",
    type: chat?.type || "group",
    enabled: typeof prev.enabled === "boolean" ? prev.enabled : true,
    lastSeenAt: new Date().toISOString(),
  };

  await writeStateFile(state);
  return state.users[tg].groups[groupId];
}

async function getUserGroups(userId) {
  const user = await fallbackUpsertUser(userId, null);
  const groupsObj = user?.groups && typeof user.groups === "object" ? user.groups : {};
  return Object.values(groupsObj).sort((a, b) => {
    const ta = new Date(a?.lastSeenAt || 0).getTime();
    const tb = new Date(b?.lastSeenAt || 0).getTime();
    return tb - ta;
  });
}

async function setGroupEnabledForUser(userId, groupId, enabled) {
  const tg = String(userId);
  const gid = String(groupId);
  const state = await readStateFile();
  if (!state.users[tg]) {
    state.users[tg] = {
      telegramId: tg,
      username: null,
      subscriptionTil: null,
      onboardingCompleted: false,
      trialUsed: false,
      groups: {},
      createdAt: new Date().toISOString(),
    };
  }
  if (!state.users[tg].groups || typeof state.users[tg].groups !== "object") {
    state.users[tg].groups = {};
  }
  const prev = state.users[tg].groups[gid] || { id: gid, title: "Группа", type: "group" };
  state.users[tg].groups[gid] = {
    ...prev,
    enabled: Boolean(enabled),
    lastSeenAt: new Date().toISOString(),
  };
  await writeStateFile(state);
  return state.users[tg].groups[gid];
}

async function isGroupEnabledForUser(userId, groupId) {
  const groups = await getUserGroups(userId);
  const row = groups.find((g) => String(g.id) === String(groupId));
  if (!row) return true;
  return Boolean(row.enabled);
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
      transformMode: PARAPHRASE_STYLE.NEUTRAL,
      delaySec: 10,
      awaitingInput: false,
      awaitingTransformInput: false,
      lastIncomingText: "",
      lastDraft: "",
      lastTransformInput: "",
      lastTransformText: "",
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

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function cacheUsername(from) {
  try {
    const uname = from?.username ? String(from.username).toLowerCase() : null;
    const uid = from?.id;
    if (!uname || !uid) return;
    usernameToId.set(uname, Number(uid));
  } catch {}
}

function extractMentionedUserId(message, text) {
  const raw = String(text || "");
  try {
    const entities = message?.entities || message?.caption_entities || [];
    for (const ent of entities) {
      if (ent?.type === "text_mention" && ent?.user?.id) {
        return Number(ent.user.id);
      }
      if (
        ent?.type === "mention" &&
        typeof ent?.offset === "number" &&
        typeof ent?.length === "number"
      ) {
        const chunk = raw.slice(ent.offset, ent.offset + ent.length);
        const uname = chunk.startsWith("@") ? chunk.slice(1).toLowerCase() : chunk.toLowerCase();
        const id = usernameToId.get(uname);
        if (id) return Number(id);
      }
    }
  } catch {}

  const rx = raw.match(/(^|\s)@([a-zA-Z0-9_]{3,32})\b/);
  if (rx?.[2]) {
    const id = usernameToId.get(String(rx[2]).toLowerCase());
    if (id) return Number(id);
  }
  return null;
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
        if (!prismaFallbackLogged) {
          prismaFallbackLogged = true;
          console.warn("[prisma] telegramId schema mismatch, switched to file-state fallback");
        }
        const user = await fallbackUpsertUser(userId, uname);
        setSession(userId, {
          subscriptionUntil: user?.subscriptionTil ? new Date(user.subscriptionTil).toISOString() : null,
          trialUsed: Boolean(user?.trialUsed),
        });
        return user;
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

function isGroupChatId(chatId) {
  if (typeof chatId === "number") return chatId < 0;
  if (typeof chatId === "string") return chatId.startsWith("-");
  return false;
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
  // Бот ничего не пишет в группы/каналы.
  if (isGroupChatId(chatId)) return null;
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}

async function editMessageText(chatId, messageId, text, extra = {}) {
  // Бот ничего не редактирует/не пишет в группы/каналы.
  if (isGroupChatId(chatId)) return null;
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
    [{ text: "🪄 Перефразировать текст", callback_data: "style_text_start" }],
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
    "Две функции:\n" +
    "• <b>Подготовить ответ</b> — когда тебе задали вопрос, а ты хочешь быстро отправить готовый ответ.\n" +
    "• <b>Перефразировать текст</b> — когда нужно переписать любое сообщение под нужный стиль.\n\n" +
    "<b>Что сделать сейчас:</b>\n" +
    "1) Нажми ✍️ <b>Подготовить ответ</b>\n" +
    "2) Или выбери 🪄 <b>Перефразировать текст</b>\n" +
    "3) Выбери режим и отправь текст\n" +
    "4) Скопируй готовый вариант\n\n" +
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

function styleToolKeyboard(userId) {
  const s = getSession(userId);
  const premium = isPremium(s);

  const modeButton = (key, label) => {
    const mark = s.transformMode === key ? "✅ " : "";
    const locked = !premium && ![PARAPHRASE_STYLE.NEUTRAL, PARAPHRASE_STYLE.POLITE].includes(key);
    return {
      text: locked ? `🔒 ${label}` : `${mark}${label}`,
      callback_data: locked ? "menu_sub" : `style_mode_${key}`,
    };
  };

  return {
    inline_keyboard: [
      [
        modeButton(PARAPHRASE_STYLE.BUSINESS, "💼 Деловой"),
        modeButton(PARAPHRASE_STYLE.POLITE, "🤝 Вежливый"),
      ],
      [
        modeButton(PARAPHRASE_STYLE.FRIENDLY, "🙂 Дружелюбный"),
        modeButton(PARAPHRASE_STYLE.CASUAL, "🧢 Неформальный"),
      ],
      [
        modeButton(PARAPHRASE_STYLE.SHORT, "⚡ Кратко"),
        modeButton(PARAPHRASE_STYLE.FORMAL, "🏛 Официальный"),
      ],
      [modeButton(PARAPHRASE_STYLE.NEUTRAL, "⚖️ Нейтральный")],
      [{ text: "✍️ Ввести текст", callback_data: "style_input" }],
      ...(s.lastTransformInput
        ? [[{ text: "🔁 Обработать последнее", callback_data: "style_use_last" }]]
        : []),
      [{ text: "⬅ Назад", callback_data: "menu_home" }],
    ],
  };
}

function styleResultKeyboard(userId) {
  const s = getSession(userId);
  return {
    inline_keyboard: [
      [{ text: "📋 Скопировать", callback_data: "style_copy" }],
      [{ text: "🔄 Еще вариант", callback_data: "style_regen" }],
      [{ text: "🎨 Другой стиль", callback_data: "style_text_start" }],
      ...(!isPremium(s) && !s.trialUsed
        ? [
            [{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }],
            [{ text: "✨ Что дает подписка", callback_data: "sub_benefits" }],
          ]
        : []),
      [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
    ],
  };
}

function buildStyleStartText() {
  return (
    "🪄 <b>Перефразировать текст</b>\n\n" +
    "Это отдельная функция ИИ-редактора.\n" +
    "Она <b>не отвечает</b> на твой текст, а только переписывает его в выбранном стиле.\n\n" +
    "Стили для перефраза:\n" +
    "• 💼 Деловой\n" +
    "• 🤝 Вежливый\n" +
    "• 🙂 Дружелюбный\n" +
    "• 🧢 Неформальный\n" +
    "• ⚡ Кратко\n" +
    "• 🏛 Официальный\n" +
    "• ⚖️ Нейтральный\n\n" +
    "👇 Выбери стиль и нажми «Ввести текст»."
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
    "Если бот не отвечает:\n" +
    "1) Нажми /start ещё раз\n" +
    "2) Подожди 10-20 секунд и отправь сообщение повторно\n" +
    "3) Перезапусти Telegram и открой чат с ботом заново\n" +
    "4) Если проблема осталась — напиши в поддержку @assistly_support_bot и приложи скрин\n\n" +
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

function sanitizeParaphraseOutput(text = "") {
  let out = String(text || "").trim();
  out = out.replace(/^["'«»]+|["'«»]+$/g, "").trim();

  // Убираем служебные фразы модели, оставляем только сам переписанный текст.
  const prefixes = [
    /^вот\s+(?:перефразированный|переписанный)\s+(?:вариант|текст)\s*:\s*/i,
    /^перефразированный\s+текст\s*:\s*/i,
    /^переписанный\s+текст\s*:\s*/i,
    /^вариант\s*:\s*/i,
    /^ответ\s*:\s*/i,
  ];
  for (const rx of prefixes) out = out.replace(rx, "");

  return out.trim();
}

/**
 * paraphraseStatement(...)
 * Перефразирует исходное утверждение под выбранный стиль.
 * Ничего не объясняет и не отвечает по сути сообщения.
 *
 * @param {string} incomingText
 * @param {ParaphraseStyle|string} style
 * @returns {Promise<string>}
 */
async function paraphraseStatement(incomingText, style) {
  const src = String(incomingText || "").trim();
  if (!src) return "";

  /** @type {ParaphraseStyle} */
  const safeStyle = STYLE_MODES[String(style || "").toLowerCase()]
    ? String(style || "").toLowerCase()
    : PARAPHRASE_STYLE.NEUTRAL;
  const styleInstruction = STYLE_MODES[safeStyle].instruction;

  const fallbackParaphrase = () => {
    const normalizeSpaces = (s) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .replace(/\s*([,!.?;:])/g, "$1")
        .trim();
    const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

    const toSentences = (s) => {
      const t = normalizeSpaces(s);
      if (!t) return [];
      const arr = t.split(/(?<=[.!?])\s+/).filter(Boolean);
      return arr.length ? arr : [t];
    };

    const applyReplacements = (text, pairs) => {
      let out = ` ${text} `;
      for (const [rx, val] of pairs) out = out.replace(rx, val);
      return normalizeSpaces(out);
    };

    const basePairs = [
      [/\bа вообще вот\b/gi, ""],
      [/\bа вообще\b/gi, ""],
      [/\bвообще вот\b/gi, ""],
      [/\bпотому что\b/gi, "так как"],
      [/\bсозвон\b/gi, "звонок"],
      [/\bдавай\b/gi, "предлагаю"],
      [/\bнапиши\b/gi, "сообщи"],
      [/\bкто-?нибудь\b/gi, "кто-то"],
      [/\bпо нему\b/gi, "по этому проекту"],
    ];
    const businessPairs = [
      [/\bпривет\b/gi, "Здравствуйте"],
      [/\bсообщи\b/gi, "сообщите"],
      [/\bудобнее\b/gi, "удобно"],
      [/\bкто-то работает\b/gi, "ведется работа"],
    ];
    const politePairs = [
      [/\bпривет\b/gi, "Здравствуйте"],
      [/\bнапиши\b/gi, "подскажите, пожалуйста"],
      [/\bсообщи\b/gi, "сообщите, пожалуйста"],
    ];
    const friendlyPairs = [
      [/\bздравствуйте\b/gi, "Привет"],
      [/\bсообщите\b/gi, "напиши"],
    ];
    const casualPairs = [
      [/\bпредлагаю\b/gi, "давай"],
      [/\bне получится\b/gi, "не выйдет"],
      [/\bсообщите\b/gi, "напиши"],
    ];
    const formalPairs = [
      [/\bпривет\b/gi, "Здравствуйте"],
      [/\bдавай\b/gi, "предлагаю"],
      [/\bнапиши\b/gi, "прошу сообщить"],
      [/\bсообщи\b/gi, "прошу сообщить"],
      [/\bтебе\b/gi, "вам"],
    ];
    const neutralPairs = [
      [/\bдавай\b/gi, "предлагаю"],
      [/\bнапиши\b/gi, "сообщи"],
    ];

    const sentences = toSentences(src);
    let out = applyReplacements(src, basePairs);

    if (safeStyle === PARAPHRASE_STYLE.BUSINESS) {
      out = applyReplacements(out, businessPairs);
      if (/\?$/.test(out)) {
        const core = out.replace(/\?+$/, "").trim();
        out = `Подскажите, ${lowerFirst(core)}?`;
      }
    } else if (safeStyle === PARAPHRASE_STYLE.POLITE) {
      out = applyReplacements(out, politePairs);
      if (/\?$/.test(out)) {
        const core = out.replace(/\?+$/, "").trim();
        out = `Подскажите, пожалуйста, ${lowerFirst(core)}?`;
      }
    } else if (safeStyle === PARAPHRASE_STYLE.FRIENDLY) {
      out = applyReplacements(out, friendlyPairs);
      if (/\?$/.test(out) && !/^слушай/i.test(out)) out = `Слушай, ${lowerFirst(out)}`;
    } else if (safeStyle === PARAPHRASE_STYLE.CASUAL) {
      out = applyReplacements(out, casualPairs);
      if (/\?$/.test(out) && !/^слушай/i.test(out)) out = `Слушай, ${lowerFirst(out)}`;
    } else if (safeStyle === PARAPHRASE_STYLE.FORMAL) {
      out = applyReplacements(out, formalPairs);
      if (/\?$/.test(out)) {
        const core = out.replace(/\?+$/, "").trim();
        out = `Прошу уточнить, ${lowerFirst(core)}.`;
      }
    } else if (safeStyle === PARAPHRASE_STYLE.NEUTRAL) {
      out = applyReplacements(out, neutralPairs);
    } else if (safeStyle === PARAPHRASE_STYLE.SHORT) {
      // Кратко, но без потери ключевых фактов: берем до 2 предложений и ужимаем лексику.
      const firstTwo = sentences.slice(0, 2).join(" ");
      out = applyReplacements(firstTwo, basePairs);
      out = out.replace(/\b(пожалуйста|прошу)\b/gi, "").replace(/\s+/g, " ").trim();
      if (out.length > 170) out = `${out.slice(0, 167).trim()}...`;
    }

    // Если вдруг почти не изменилось — делаем минимальную гарантированную перестройку.
    if (normalizeSpaces(out).toLowerCase() === normalizeSpaces(src).toLowerCase()) {
      out = applyReplacements(src, [
        [/\bа вообще вот\b/gi, ""],
        [/\bпотому что\b/gi, "так как"],
        [/\bдавай\b/gi, "предлагаю"],
        [/\bнапиши\b/gi, "сообщи"],
        [/\bкто-?нибудь\b/gi, "кто-то"],
      ]);
    }

    return out;
  };

  if (!openai) return fallbackParaphrase();

  try {
    const rewriteRules = [
      "Ты редактор уровня senior copywriter.",
      "Задача: ПЕРЕФРАЗИРОВАТЬ исходный текст под заданный стиль.",
      "Запрещено: отвечать на текст, советовать, спорить, анализировать, добавлять новые факты, удалять важные факты.",
      "Обязательно: сохранить все факты, числа, даты, имена, ссылки, смысл и язык исходника.",
      "Обязательно: выдать заметно перефразированный вариант, не копию оригинала.",
      "Верни только итоговый текст без кавычек, без префиксов и без пояснений.",
    ].join(" ");

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.8,
      max_tokens: 320,
      messages: [
        {
          role: "system",
          content: rewriteRules,
        },
        { role: "system", content: styleInstruction },
        {
          role: "user",
          content: [
            `Стиль: ${safeStyle}`,
            "Сделай переписывание в стиле выше.",
            "Не давай ответ по смыслу сообщения. Только переформулируй исходник.",
            "",
            "Исходный текст:",
            src,
          ].join("\n"),
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || "";
    const clean = sanitizeParaphraseOutput(raw);
    if (!clean) return fallbackParaphrase();

    // Не допускаем 1-в-1 копию исходника: форсим стиль через fallback.
    const norm = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    if (norm(clean) === norm(src)) return fallbackParaphrase();
    return clean;
  } catch (e) {
    console.error("paraphraseStatement fallback:", e?.message || e);
    return fallbackParaphrase();
  }
}

// Backward compatibility with existing call sites.
async function createStyledText(incomingText, mode) {
  return paraphraseStatement(incomingText, mode);
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

async function processStyledText({ chatId, userId, incomingText }) {
  const s = getSession(userId);
  await sendMessage(chatId, "🪄 Перефразирую текст под выбранный стиль...", { parse_mode: "HTML" });

  try {
    const result = await createStyledText(incomingText, s.transformMode);
    setSession(userId, {
      lastTransformInput: incomingText,
      lastTransformText: result,
      awaitingTransformInput: false,
      awaitingInput: false,
    });

    await sendMessage(
      chatId,
        "📝 <b>Перефразированный текст:</b>\n\n" +
        `${escapeHtml(result)}\n\n` +
        `<i>Стиль: ${escapeHtml(STYLE_MODES[s.transformMode]?.label || STYLE_MODES.business.label)}</i>\n\n` +
        "<i>(Скопируй и используй)</i>",
      {
        parse_mode: "HTML",
        reply_markup: styleResultKeyboard(userId),
      }
    );
  } catch (err) {
    console.error("style generation error:", err?.message || err);
    await sendMessage(chatId, "Не получилось перефразировать текст. Попробуй еще раз.", {
      reply_markup: { inline_keyboard: [[{ text: "🪄 Перефразировать текст", callback_data: "style_text_start" }]] },
    });
  }
}

async function notifyGroupQuestionToUser({ targetUserId, sourceMsg, incomingText }) {
  const key = `${sourceMsg?.chat?.id}:${sourceMsg?.message_id}:${targetUserId}`;
  if (processedGroupSignals.has(key)) return;
  processedGroupSignals.add(key);

  const groupTitle = sourceMsg?.chat?.title || sourceMsg?.chat?.username || "Группа";
  const fromName =
    [sourceMsg?.from?.first_name, sourceMsg?.from?.last_name].filter(Boolean).join(" ") ||
    sourceMsg?.from?.username ||
    "Участник";

  const body =
    "💬 <b>В группе тебе задали вопрос</b>\n\n" +
    `👥 <b>${escapeHtml(groupTitle)}</b>\n` +
    `👤 От: <b>${escapeHtml(fromName)}</b>\n\n` +
    `Сообщение:\n<code>${escapeHtml(incomingText)}</code>\n\n` +
    "Подготовить ответ на это сообщение?";

  setSession(targetUserId, {
    lastIncomingText: incomingText,
    lastSource: "group",
    lastGroupChatId: String(sourceMsg?.chat?.id || ""),
    awaitingInput: false,
  });

  await sendMessage(targetUserId, body, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Подготовить ответ", callback_data: "group_prepare_reply" }],
        [{ text: "🚫 Не надо", callback_data: "group_no_need" }],
        [{ text: "🙈 Игнорировать", callback_data: "group_ignore" }],
      ],
    },
  });
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
  setSession(userId, { awaitingInput: true, awaitingTransformInput: false });
  return editMessageText(chatId, messageId, buildQuickStartText(), {
    parse_mode: "HTML",
    reply_markup: quickReplyKeyboard(userId),
  });
}

async function renderStyleTool(chatId, userId, messageId) {
  setSession(userId, { awaitingInput: false, awaitingTransformInput: true });
  return editMessageText(chatId, messageId, buildStyleStartText(), {
    parse_mode: "HTML",
    reply_markup: styleToolKeyboard(userId),
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

async function renderConnect(chatId, userId, messageId) {
  const groups = await getUserGroups(userId);
  let text =
    "👥 <b>Группы (подсказки)</b>\n\n" +
    "Бот не отправляет сообщения в группы от твоего имени.\n" +
    "Он подготавливает черновики в личке, а ты отправляешь их сам.\n\n";

  if (!groups.length) {
    text +=
      "Пока нет групп в списке.\n\n" +
      "Что сделать:\n" +
      "1) Добавь бота в нужную группу\n" +
      "2) Напиши в группе хотя бы одно сообщение\n" +
      "3) Вернись сюда и нажми «Обновить»";
  } else {
    text += "Выбери группу ниже, чтобы включить или выключить подсказки:";
  }

  const keyboard = [];
  for (const g of groups) {
    const mark = g.enabled ? "✅" : "❌";
    keyboard.push([
      {
        text: `${mark} ${g.title || "Группа"}`,
        callback_data: `group_toggle:${g.id}`,
      },
    ]);
  }
  keyboard.push([{ text: "🔄 Обновить", callback_data: "connect_refresh" }]);
  keyboard.push([{ text: "⬅ Назад", callback_data: "menu_settings" }]);

  return editMessageText(chatId, messageId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
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

  // Команды обрабатываем только в личке.
  if (message.chat?.type !== "private") return;

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
  if (cmd === "/admin") {
    if (!isAdmin(userId)) {
      return sendMessage(
        chatId,
        `⛔ Нет доступа.\nТвой Telegram ID: <code>${escapeHtml(String(userId))}</code>`,
        { parse_mode: "HTML" }
      );
    }

    const state = await readStateFile();
    const users = Object.values(state?.users || {});
    const now = Date.now();

    const total = users.length;
    const withSub = users.filter((u) => {
      const dt = new Date(u?.subscriptionTil || 0).getTime();
      return Number.isFinite(dt) && dt > now;
    }).length;
    const withTrial = users.filter((u) => Boolean(u?.trialUsed)).length;

    const rows = users
      .slice(0, 25)
      .map((u) => {
        const uname = u?.username ? `@${u.username}` : "без username";
        const subOk = (() => {
          const dt = new Date(u?.subscriptionTil || 0).getTime();
          return Number.isFinite(dt) && dt > now;
        })();
        return `• ${u.telegramId} (${uname}) ${subOk ? "✅ sub" : "🆓"}`;
      })
      .join("\n");

    const textOut =
      "🛠 <b>Админ-панель</b>\n\n" +
      `👥 Пользователей: <b>${total}</b>\n` +
      `💳 Активных подписок: <b>${withSub}</b>\n` +
      `🎁 Использовали trial: <b>${withTrial}</b>\n\n` +
      (rows ? "<b>Последние пользователи:</b>\n" + rows : "Пока нет пользователей.");

    return sendMessage(chatId, textOut, { parse_mode: "HTML" });
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

  if (data === "group_prepare_reply") {
    const s = getSession(userId);
    if (!s.lastIncomingText) {
      return editMessageText(
        chatId,
        messageId,
        "Не нашёл исходное сообщение. Пришли текст вручную через «Подготовить ответ».",
        {
          reply_markup: { inline_keyboard: [[{ text: "✍️ Подготовить ответ", callback_data: "quick_reply_start" }]] },
        }
      );
    }
    return sendDraftWithDelay({ chatId, userId, incomingText: s.lastIncomingText });
  }

  if (data === "group_no_need") {
    return editMessageText(chatId, messageId, "Ок, не готовлю ответ на это сообщение.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu_home" }]] },
    });
  }

  if (data === "group_ignore") {
    setSession(userId, { lastIncomingText: "" });
    return editMessageText(chatId, messageId, "Принято. Игнорирую это сообщение.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu_home" }]] },
    });
  }

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
  if (data === "style_text_start") return renderStyleTool(chatId, userId, messageId);
  if (data === "quick_input") {
    setSession(userId, { awaitingInput: true, awaitingTransformInput: false });
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

  if (data === "style_input") {
    setSession(userId, { awaitingTransformInput: true, awaitingInput: false });
    return sendMessage(
      chatId,
      "🎨 <b>Ввести текст</b>\n\nПришли текст, который нужно обработать под выбранный стиль.",
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅ Назад", callback_data: "style_text_start" }],
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

  if (data === "style_copy") {
    const s = getSession(userId);
    if (!s.lastTransformText) {
      return answerCallbackQuery(query.id, { text: "Текста еще нет", show_alert: true });
    }
    return sendMessage(chatId, "📋 <b>Текст для копирования:</b>\n\n" + escapeHtml(s.lastTransformText), {
      parse_mode: "HTML",
      reply_markup: styleResultKeyboard(userId),
    });
  }

  if (data === "quick_reply_regen") {
    const s = getSession(userId);
    if (!s.lastIncomingText) {
      return answerCallbackQuery(query.id, { text: "Сначала пришли текст", show_alert: true });
    }
    return sendDraftWithDelay({ chatId, userId, incomingText: s.lastIncomingText });
  }

  if (data === "style_regen") {
    const s = getSession(userId);
    if (!s.lastTransformInput) {
      return answerCallbackQuery(query.id, { text: "Сначала пришли текст", show_alert: true });
    }
    return processStyledText({ chatId, userId, incomingText: s.lastTransformInput });
  }

  if (data === "style_use_last") {
    const s = getSession(userId);
    if (!s.lastTransformInput) {
      return sendMessage(chatId, "Нет последнего текста. Нажми «✍️ Ввести текст».", {
        reply_markup: { inline_keyboard: [[{ text: "✍️ Ввести текст", callback_data: "style_input" }]] },
      });
    }
    return processStyledText({ chatId, userId, incomingText: s.lastTransformInput });
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

  if (data.startsWith("style_mode_")) {
    const nextMode = data.replace("style_mode_", "");
    const s = getSession(userId);
    if (!STYLE_MODES[nextMode]) return;

    if (
      !isPremium(s) &&
      ![PARAPHRASE_STYLE.NEUTRAL, PARAPHRASE_STYLE.POLITE].includes(nextMode)
    ) {
      return editMessageText(
        chatId,
        messageId,
        "🔒 <b>Режимы доступны по подписке</b>\n\nОткрой пробную подписку за 0 ₽, чтобы включить расширенные стили.",
        { parse_mode: "HTML", reply_markup: subKeyboard(userId) }
      );
    }

    setSession(userId, { transformMode: nextMode });
    await answerCallbackQuery(query.id, { text: `Стиль: ${STYLE_MODES[nextMode].label}` });
    return editMessageText(chatId, messageId, buildStyleStartText(), {
      parse_mode: "HTML",
      reply_markup: styleToolKeyboard(userId),
    });
  }

  if (data === "menu_settings") return renderSettings(chatId, userId, messageId);
  if (data === "help_how") return renderHelp(chatId, messageId);
  if (data === "connect_chat" || data === "connect_refresh") return renderConnect(chatId, userId, messageId);
  if (data.startsWith("group_toggle:")) {
    const groupId = data.replace("group_toggle:", "").trim();
    const groups = await getUserGroups(userId);
    const row = groups.find((g) => String(g.id) === String(groupId));
    const nextEnabled = row ? !Boolean(row.enabled) : true;
    await setGroupEnabledForUser(userId, groupId, nextEnabled);
    await answerCallbackQuery(query.id, { text: nextEnabled ? "✅ Включено" : "❌ Выключено" });
    return renderConnect(chatId, userId, messageId);
  }
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
  if (!chatId || !userId) return;

  // ============================
  // GROUP SILENT ASSIST
  // Ничего не пишем в группу, только сигналим в личку адресату.
  // ============================
  if (message.chat?.type === "group" || message.chat?.type === "supergroup") {
    const incomingText = String(message.text || message.caption || "").trim();
    if (!incomingText) return;

    cacheUsername(message.from);
    cacheUsername(message.reply_to_message?.from);

    // Сохраняем группу для автора сообщения (чтобы видел у себя список групп).
    await fallbackUpsertGroupForUser(message.from.id, message.chat);

    let targetUserId = null;
    if (message.reply_to_message?.from?.id && !message.reply_to_message?.from?.is_bot) {
      targetUserId = Number(message.reply_to_message.from.id);
    }
    if (!targetUserId) {
      targetUserId = extractMentionedUserId(message, incomingText);
    }
    if (!targetUserId) return;
    if (Number(targetUserId) === Number(message.from?.id)) return;

    await ensureUserAndHydrateSession(targetUserId, message.reply_to_message?.from?.username || null);
    await fallbackUpsertGroupForUser(targetUserId, message.chat);

    const enabledForTarget = await isGroupEnabledForUser(targetUserId, message.chat.id);
    if (!enabledForTarget) return;

    const targetState = getSession(targetUserId);

    // По продуктовой логике — фича для подписки/пробной.
    if (!isPremium(targetState)) return;

    await notifyGroupQuestionToUser({
      targetUserId,
      sourceMsg: message,
      incomingText,
    });
    return;
  }

  if (!text) return;
  await ensureUserAndHydrateSession(userId, message.from?.username || null);

  if (message.chat?.type === "private") {
    await ensureReplyKeyboardRemoved(chatId, userId);
  }

  if (text.startsWith("/")) {
    await handleCommand(message, text);
    return;
  }

  if (message.chat.type !== "private") return;

  const s = getSession(userId);
  if (s.awaitingInput) {
    await sendDraftWithDelay({ chatId, userId, incomingText: text });
    return;
  }
  if (s.awaitingTransformInput) {
    await processStyledText({ chatId, userId, incomingText: text });
    return;
  }
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
