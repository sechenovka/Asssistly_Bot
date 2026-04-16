import "dotenv/config";
import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import pkg from '@prisma/client';
const { PrismaClient } = pkg;

// === Конфигурация ===
const {
  PORT = 4010,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  TELEGRAM_MODE = "polling",
  PUBLIC_URL = "",
  YOOKASSA_SHOP_ID = "",
  YOOKASSA_SECRET_KEY = "",
  ADMIN_IDS: envAdmin = "",
  ADMIN_ID = "1441173568",
  BOT_USERNAME = "",
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_WEBHOOK_SECRET) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const YOOKASSA_API = "https://api.yookassa.ru/v3";
const TRIAL_DAYS = 3;
const ADMIN_IDS = [...new Set([...envAdmin.split(","), ADMIN_ID].map(s => s.trim()).filter(Boolean))];
 
const STATE_FILE = path.resolve(process.cwd(), "data", "bot-state.json");
const app = express().use(express.json());

let prisma;
try { prisma = new PrismaClient(); } catch { prisma = null; }

// === Стили и режимы ===
const MODES = {
  normal:   { label: "Обычный",   prompt: "Пиши естественно, 1-2 предложения." },
  short:    { label: "Коротко",  prompt: "Очень кратко: 1 предложение." },
  polite:   { label: "Вежливо",  prompt: "Вежливо и уважительно." },
  tothepoint:{ label: "По делу", prompt: "Строго по делу, факты." },
  refuse:   { label: "Отказать", prompt: "Мягкий и корректный отказ." },
  busy:     { label: "Занят",    prompt: "Коротко, что занят и вернёшься позже." },
  cute:     { label: "Милый",    prompt: "Милый и дружелюбный тон." },
  humor:    { label: "С юмором", prompt: "Лёгкий юмор, непринуждённо." },
};

const STYLES = {
  business:  { label:"💼 Деловой",     inst:"Деловой стиль." },
  polite:    { label:"🤝 Вежливый",   inst:"Вежливый стиль." },
  friendly:  { label:"🙂 Дружелюбный",inst:"Дружелюбный стиль." },
  casual:    { label:"🧢 Неформальный",inst:"Неформальный стиль." },
  short:     { label:"⚡ Кратко",      inst:"Кратко, 1-2 предложения." },
  formal:    { label:"🏛 Официальный", inst:"Официальный стиль." },
  neutral:   { label:"⚖️ Нейтральный", inst:"Нейтральный стиль." },
  cute:      { label:"😊 Милый",       inst:"Милый, тёплый стиль." },
  humor:     { label:"😄 С юмором",    inst:"С юмором, легко." },
};

// === Хранилища ===
const sessions = new Map();               // quick reply, transform, dm drafts
const pendingPayments = new Map();

const usernameToId = new Map();
const processedGroupSignals = new Set();
const groupHintState = new Map();
const DM_FREE_LIMIT = 5;
const GROUP_FREE_HINT_LIMIT = 3;
let adminWaitingForUser = false, adminReplyChat = null;

// === Утилиты ===
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const isGroupChatId = id => String(id).startsWith("-");
const todayKey = () => new Date().toISOString().slice(0,10);
const isAdmin = uid => ADMIN_IDS.includes(String(uid));
const cacheUsername = from => from?.username && usernameToId.set(from.username.toLowerCase(), from.id);
const hasActiveSub = u => u?.subscriptionTil && new Date(u.subscriptionTil) > new Date();

const getSession = uid => {
  const key = String(uid);
  if (!sessions.has(key)) sessions.set(key, {
    mode: "normal", transformMode: "neutral", delaySec: 10,
    awaitingInput: false, awaitingTransformInput: false, awaitingDmDraft: false,
    lastIncomingText: "", lastDraft: "", lastTransformInput: "", lastTransformText: "",
    subscriptionUntil: null, trialUsed: false, quickStyle: null,
    pendingTimer: null, pendingToken: null,
    dmEnabled: false, dmUsed: 0, dmUsedDay: todayKey(),
  });
  return sessions.get(key);
};

const cancelPending = uid => {
  const s = getSession(uid);
  if (s.pendingTimer) clearTimeout(s.pendingTimer);
  s.pendingTimer = s.pendingToken = null;
};

// === Файловое состояние (fallback) ===
const readState = async () => { try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { return { users: {} }; } };
const writeState = async data => { await fs.mkdir(path.dirname(STATE_FILE), { recursive: true }); await fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2)); };
const fallbackUser = async (uid, uname) => {
  const id = String(uid);
  const state = await readState();
  state.users[id] = state.users[id] || { telegramId: id, username: uname, subscriptionTil: null, trialUsed: false, groups: {}, onboardingCompleted: false };
  if (uname) state.users[id].username = uname;
  await writeState(state);
  return state.users[id];
};

const ensureUser = async (uid, uname) => {
  const id = String(uid);
  try {
    return await prisma.user.upsert({ where: { telegramId: id }, update: { username: uname }, create: { telegramId: id, username: uname } });
  } catch { return fallbackUser(uid, uname); }
};

const hydrateSession = async (uid, uname) => {
  const user = await ensureUser(uid, uname);
  const s = getSession(uid);
  s.subscriptionUntil = user.subscriptionTil?.toISOString?.() || null;
  s.trialUsed = !!user.trialUsed;
  s.dmEnabled = !!user.dmAutoEnabled;
  return user;
};

// === Telegram API ===
const tg = async (method, payload) => (await axios.post(`${TELEGRAM_API}/${method}`, payload)).data.result;
const sendMessage = async (chatId, text, extra = {}) => {
  if (isGroupChatId(chatId)) return null;
  try { return await tg("sendMessage", { chat_id: chatId, text, ...extra }); } catch (e) {
    if (extra.parse_mode && /parse entities/.test(e.message)) {
      delete extra.parse_mode;
      return tg("sendMessage", { chat_id: chatId, text: text.replace(/<[^>]*>/g, ""), ...extra });
    }
    throw e;
  }
};

const editMessage = async (chatId, msgId, text, extra = {}) => {
  if (isGroupChatId(chatId)) return null;
  try { return await tg("editMessageText", { chat_id: chatId, message_id: msgId, text, ...extra }); } catch (e) {
    if (!/message is not modified/.test(e.message)) throw e;
  }
};

const answerCb = (id, extra) => tg("answerCallbackQuery", { callback_query_id: id, ...extra }).catch(()=>{});

// === OpenAI ===
const aiGenerate = async (prompt, system, temp=0.5, maxTokens=180) => {
  if (!openai) return "";
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL, temperature: temp, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
  });
  return res.choices[0]?.message?.content?.trim() || "";
};

// === Генерация черновиков ===
const buildDraftReply = (text, style, prevVariantId, modeKey = "normal") => {
  const t = String(text).slice(0,220).trim();
  const pools = {
    normal: { default: ["Понял, сейчас подумаю.", "Окей, уточни детали — отвечу точнее."] },
    short: { default: ["Понял. Уточни детали."] },
    polite: { default: ["Благодарю, уточните, пожалуйста."] },
    tothepoint: { default: ["Принято. Нужны сроки и конкретика."] },
    refuse: { default: ["Спасибо, но сейчас не смогу."] },
    busy: { default: ["Сейчас занят, отвечу позже."] },
    cute: { default: ["Окей 😊 Дай минутку — отвечу."] },
    humor: { default: ["Ок 😄 Сейчас соберу мысли и отвечу."] },
  };
  const pool = pools[modeKey]?.default || pools.normal.default;
  const idx = prevVariantId && pool.length>1 ? (Number(prevVariantId)+1)%pool.length : Math.floor(Math.random()*pool.length);
  return { draft: pool[idx], variantId: String(idx) };
};

const createDraft = async (text, mode) => {
  const sys = MODES[mode]?.prompt || MODES.normal.prompt;
  return await aiGenerate(text, `Ты помощник. ${sys}`, 0.5, 180) || buildDraftReply(text, "", null, mode).draft;
};

const paraphrase = async (text, style) => {

  const inst = STYLES[style]?.inst || STYLES.neutral.inst;
  return await aiGenerate(text, `Ты редактор. Перефразируй текст. ${inst}`, 0.8, 320) || text;
};

// === Клавиатуры ===
const homeKb = uid => ({ inline_keyboard: [
  [{ text: "✍️ Подготовить ответ", callback_data: "quick_start" }],
  [{ text: "🪄 Перефразировать", callback_data: "style_start" }],
  [{ text: "👥 Группы", callback_data: "connect_chat" }],
  [{ text: "⚙️ Настройки", callback_data: "menu_settings" }],
  ...(!getSession(uid).trialUsed && !hasActiveSub({subscriptionTil: getSession(uid).subscriptionUntil}) ? [[{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }]] : []),
]});

const quickKb = uid => {
  const s = getSession(uid), premium = hasActiveSub({subscriptionTil: s.subscriptionUntil});
  const btn = (key, label) => ({
    text: `${s.mode===key?"✅ ":""}${!premium&&!["normal","short"].includes(key)?"🔒 ":""}${label}`,
    callback_data: !premium&&!["normal","short"].includes(key)?"menu_sub":`mode_${key}`,
  });
  return { inline_keyboard: [
    [btn("normal","🧠 Обычный"), btn("short","⚡ Коротко")],
    [btn("polite","🤝 Вежливо"), btn("tothepoint","🎯 По делу")],
    [btn("refuse","🙅 Отказать"), btn("busy","⏳ Занят")],
    [btn("cute","😊 Милый"), btn("humor","😄 С юмором")],
    [{ text: `${s.delaySec===10?"✅ ":""}⏱ 10 сек`, callback_data:"delay_10" }, { text: `${s.delaySec===20?"✅ ":""}⏱ 20 сек`, callback_data:"delay_20" }],
    [{ text: "✍️ Ввести текст", callback_data: "quick_input" }],
    ...(s.lastIncomingText ? [[{ text: "⚡ Ответить на последнее", callback_data: "quick_use_last" }]] : []),
    [{ text: "⬅ Назад", callback_data: "menu_home" }],
  ]};
};

const styleKb = uid => {
  const s = getSession(uid), premium = hasActiveSub({subscriptionTil: s.subscriptionUntil});
  const btn = (key, label) => ({
    text: `${s.transformMode===key?"✅ ":""}${!premium&&!["neutral","polite"].includes(key)?"🔒 ":""}${label}`,
    callback_data: !premium&&!["neutral","polite"].includes(key)?"menu_sub":`style_${key}`,
  });
  return { inline_keyboard: [
    [btn("business","💼 Деловой"), btn("polite","🤝 Вежливый")],
    [btn("friendly","🙂 Дружелюбный"), btn("casual","🧢 Неформальный")],
    [btn("short","⚡ Кратко"), btn("formal","🏛 Официальный")],
    [btn("neutral","⚖️ Нейтральный"), btn("cute","😊 Милый")],
    [btn("humor","😄 С юмором")],
    [{ text: "✍️ Ввести текст", callback_data: "style_input" }],
    ...(s.lastTransformInput ? [[{ text: "🔁 Обработать последнее", callback_data: "style_use_last" }]] : []),
    [{ text: "⬅ Назад", callback_data: "menu_home" }],
  ]};
};

// === Логика отправки черновика ===
const sendDraft = async (bot, chatId, uid, incoming, isGroup = false) => {
  const s = getSession(uid);
  const u = await ensureUser(uid);
  const isSub = hasActiveSub(u);
  
  if (!isSub && isGroup) {
    const gs = groupHintState.get(uid) || { used: 0, usedDay: todayKey() };
    if (gs.usedDay !== todayKey()) { gs.used = 0; gs.usedDay = todayKey(); }
    if (gs.used >= GROUP_FREE_HINT_LIMIT) {
      return sendMessage(chatId, `🧾 Лимит подсказок для групп исчерпан (${GROUP_FREE_HINT_LIMIT}/день). Оформи подписку.`);
    }
    gs.used++;
    groupHintState.set(uid, gs);
  }

  if (s.dmEnabled && !isSub) {
    if (s.dmUsedDay !== todayKey()) { s.dmUsed = 0; s.dmUsedDay = todayKey(); }
    if (s.dmUsed >= DM_FREE_LIMIT) {
      return sendMessage(chatId, `🧾 Лимит черновиков исчерпан (${DM_FREE_LIMIT}/день).`);
    }
    s.dmUsed++;
  }

  await sendMessage(chatId, `⏳ Думаю… пришлю через ${s.delaySec} сек.`);
  cancelPending(uid);
  const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  s.pendingToken = token;
  s.lastIncomingText = incoming;

  s.pendingTimer = setTimeout(async () => {
    if (s.pendingToken !== token) return;
    const draft = await createDraft(incoming, s.mode);
    s.lastDraft = draft;
    s.pendingTimer = s.pendingToken = null;

    const msg = `📝 <b>Готовый ответ:</b>\n\n${escapeHtml(draft)}\n\n<i>(Скопируй и отправь)</i>` +
      (isSub ? "" : `\n\n<b>Хочешь ещё варианты?</b> Подписка открывает все режимы.`);

    await sendMessage(chatId, msg, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [{ text: "📋 Скопировать", callback_data: "copy_draft" }],
        ...(isSub ? [[{ text: "🔄 Ещё вариант", callback_data: "regen_draft" }]] : []),
        ...(!isSub ? [[{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }]] : []),
        [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
      ]}
    });
    // Логируем
    await prisma.messageLog.create({ data: {
      user: { connect: { telegramId: String(uid) } },
      incomingText: incoming, replyText: draft, chatTelegramId: String(chatId),
    }}).catch(()=>{});
  }, s.delaySec * 1000);
};

// === Групповые подсказки ===
const notifyGroup = async (bot, targetId, msg, text) => {
  const key = `${msg.chat.id}:${msg.message_id}:${targetId}`;
  if (processedGroupSignals.has(key)) return;
  processedGroupSignals.add(key);
  const s = getSession(targetId);
  if (!hasActiveSub({subscriptionTil: s.subscriptionUntil}) && s.trialUsed) return;
  s.lastIncomingText = text;
  await sendMessage(targetId,
    `💬 <b>В группе "${escapeHtml(msg.chat.title||'Группа')}" вам вопрос:</b>\n${escapeHtml(text)}\n\nПодготовить ответ?`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "✅ Подготовить", callback_data: "group_prepare" }],
      [{ text: "🚫 Не надо", callback_data: "group_ignore" }],
    ]}}
  );
};

// === Обработчики callback ===
const handleCallback = async (bot, query) => {
  const { data, message, from } = query;
  const chatId = message.chat.id, msgId = message.message_id, uid = from.id;
  await hydrateSession(uid, from.username);
  const s = getSession(uid);
  const isSub = hasActiveSub({subscriptionTil: s.subscriptionUntil});
  await answerCb(query.id);

  const actions = {
    menu_home: () => editMessage(chatId, msgId, "🤖 Главное меню", { parse_mode:"HTML", reply_markup: homeKb(uid) }),
    quick_start: () => editMessage(chatId, msgId, "✍️ <b>Подготовить ответ</b>\n\nВыбери режим и введи текст.", { parse_mode:"HTML", reply_markup: quickKb(uid) }),
    style_start: () => editMessage(chatId, msgId, "🪄 <b>Перефразировать</b>\n\nВыбери стиль.", { parse_mode:"HTML", reply_markup: styleKb(uid) }),
    menu_settings: () => editMessage(chatId, msgId, "⚙️ Настройки", { parse_mode:"HTML", reply_markup: { inline_keyboard: [
      [{ text: "👥 Группы", callback_data: "groups" }], [{ text: "📩 Автоответчик (ЛС)", callback_data: "dm_auto_menu" }],
      [{ text: "🔄 Онбординг", callback_data: "onboarding" }], [{ text: "📜 Логи", callback_data: "menu_logs" }],
      [{ text: "⬅ Назад", callback_data: "menu_home" }]
    ]}}),
    dm_auto_menu: async () => {
      s.dmEnabled = !s.dmEnabled;
      await prisma.user.update({ where: { telegramId: String(uid) }, data: { dmAutoEnabled: s.dmEnabled } }).catch(()=>{});
      editMessage(chatId, msgId, `📩 Автоответчик ${s.dmEnabled?'включён':'выключен'}.`, { reply_markup: homeKb(uid) });
    },
    menu_sub: () => editMessage(chatId, msgId, `💳 Подписка\nСтатус: ${isSub?`активна до ${s.subscriptionUntil?.slice(0,10)}`:"нет"}`, { parse_mode:"HTML", reply_markup: subKb(uid) }),
    buy_trial: async () => {
      if (s.trialUsed) return editMessage(chatId, msgId, "Пробная уже использована.");
      const until = new Date(); until.setDate(until.getDate()+TRIAL_DAYS);
      s.subscriptionUntil = until.toISOString(); s.trialUsed = true;
      await prisma.user.update({ where:{telegramId:String(uid)}, data:{subscriptionTil:until, trialUsed:true} }).catch(()=>{});
      editMessage(chatId, msgId, `🎁 Пробная активирована до ${until.toISOString().slice(0,10)}`, { reply_markup: homeKb(uid) });
    },
    quick_input: () => { s.awaitingInput = true; sendMessage(chatId, "Пришли сообщение для ответа."); },
    style_input: () => { s.awaitingTransformInput = true; sendMessage(chatId, "Пришли текст для перефразирования."); },
    quick_use_last: () => s.lastIncomingText && sendDraft(bot, chatId, uid, s.lastIncomingText),
    style_use_last: () => s.lastTransformInput && processStyle(bot, chatId, uid, s.lastTransformInput),
    copy_draft: () => sendMessage(chatId, `📋 ${escapeHtml(s.lastDraft)}`, { parse_mode:"HTML" }),
    regen_draft: () => s.lastIncomingText && sendDraft(bot, chatId, uid, s.lastIncomingText),
    group_prepare: () => s.lastIncomingText && sendDraft(bot, chatId, uid, s.lastIncomingText, true),
    group_ignore: () => editMessage(chatId, msgId, "Ок, игнорирую."),
    groups: async () => {
      const groups = Object.values((await fallbackUser(uid)).groups||{});
      const kb = groups.map(g => ([{ text: `${g.enabled?'✅':'❌'} ${g.title}`, callback_data: `toggle_${g.id}` }]));
      kb.push([{ text: "⬅ Назад", callback_data: "menu_settings" }]);
      editMessage(chatId, msgId, "👥 Группы", { reply_markup:{inline_keyboard:kb} });
    },
    menu_logs: async () => {
      const logs = await prisma.messageLog.findMany({ where: { user: { telegramId: String(uid) } }, orderBy: { createdAt: "desc" }, take: 5 });
      const text = logs.map(l => `📥 ${l.incomingText}\n📤 ${l.replyText}`).join("\n\n") || "Нет логов.";
      editMessage(chatId, msgId, text, { reply_markup: { inline_keyboard: [[{ text: "⬅ Назад", callback_data: "menu_settings" }]] } });
    },
    onboarding: async () => {
      await prisma.user.update({ where:{telegramId:String(uid)}, data:{onboardingCompleted:false} }).catch(()=>{});
      editMessage(chatId, msgId, "Добро пожаловать! Я помогу с ответами.", { reply_markup:{inline_keyboard:[[{text:"🚀 Начать", callback_data:"onb_step2"}]]} });
    },
    onb_step2: () => editMessage(chatId, msgId, "1) Нажми «Подготовить ответ»\n2) Выбери режим\n3) Отправь текст", { reply_markup:{inline_keyboard:[[{text:"Готово", callback_data:"onb_done"}]]} }),
    onb_done: async () => { await prisma.user.update({ where:{telegramId:String(uid)}, data:{onboardingCompleted:true} }).catch(()=>{}); actions.menu_home(); },
  };

  if (actions[data]) return actions[data]();
  if (data.startsWith("mode_")) { s.mode = data.slice(5); return editMessage(chatId, msgId, "✍️ Режим обновлён", { reply_markup: quickKb(uid) }); }
  if (data.startsWith("style_")) { s.transformMode = data.slice(6); return editMessage(chatId, msgId, "🪄 Стиль обновлён", { reply_markup: styleKb(uid) }); }
  if (data.startsWith("delay_")) { s.delaySec = parseInt(data.slice(6)); return editMessage(chatId, msgId, "⏱ Задержка обновлена", { reply_markup: quickKb(uid) }); }
  if (data.startsWith("toggle_")) {
    const gid = data.slice(7);
    const state = await readState();
    const grp = state.users[uid]?.groups?.[gid];
    if (grp) grp.enabled = !grp.enabled; else state.users[uid].groups[gid] = { id:gid, enabled:true };
    await writeState(state);
    return actions.groups();
  }
  if (data.startsWith("buy_") && data !== "buy_trial") {
    const days = {7:150,30:450,180:1990,365:3184}[data.slice(4)] || 30;
    const payment = await axios.post(`${YOOKASSA_API}/payments`, {
      amount:{value:days, currency:"RUB"}, capture:true,
      confirmation:{type:"redirect", return_url:`https://t.me/${from.username||""}`},
      description:`Подписка ${days} дн.`, metadata:{user_id:String(uid)},
    }, { headers:{ Authorization: `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}` }}).catch(()=>null);
    if (!payment?.data?.confirmation?.confirmation_url) return sendMessage(chatId, "Ошибка создания платежа.");
    pendingPayments.set(payment.data.id, { uid, days });
    return editMessage(chatId, msgId, `💳 Оплатите ${days}₽`, { reply_markup:{inline_keyboard:[
      [{ text: "Оплатить", url: payment.data.confirmation.confirmation_url }],
      [{ text: "✅ Я оплатил", callback_data: `check_${payment.data.id}` }],
    ]}});
  }
  if (data.startsWith("check_")) {
    const pid = data.slice(6);
    const payment = await axios.get(`${YOOKASSA_API}/payments/${pid}`, {
      headers:{ Authorization: `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}` }
    }).catch(()=>null);
    if (payment?.data?.status !== "succeeded") return answerCb(query.id, { text:"Оплата не завершена", show_alert:true });
    const pending = pendingPayments.get(pid);
    if (pending) {
      const until = new Date(); until.setDate(until.getDate()+pending.days);
      s.subscriptionUntil = until.toISOString();
      await prisma.user.update({ where:{telegramId:String(uid)}, data:{subscriptionTil:until} }).catch(()=>{});
      pendingPayments.delete(pid);
      return editMessage(chatId, msgId, `✅ Подписка активирована до ${until.toISOString().slice(0,10)}`, { reply_markup: homeKb(uid) });
    }
  }
  // Админка
  if (data === "admin_find_user") {
    if (!isAdmin(uid)) return;
    adminWaitingForUser = true; adminReplyChat = chatId;
    return sendMessage(chatId, "Введите Telegram ID пользователя:");
  }
};

const processStyle = async (bot, chatId, uid, text) => {
  const s = getSession(uid);
  await sendMessage(chatId, "🪄 Перефразирую…");
  const result = await paraphrase(text, s.transformMode);
  s.lastTransformInput = text; s.lastTransformText = result;
  await sendMessage(chatId, `📝 <b>Результат:</b>\n\n${escapeHtml(result)}`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "📋 Скопировать", callback_data: "copy_style" }], [{ text: "🏠 Главное меню", callback_data: "menu_home" }]] }
  });
};

// === Обработка сообщений ===
const handleMessage = async (bot, msg) => {
  const chatId = msg.chat.id, uid = msg.from.id, text = msg.text?.trim();
  if (!uid) return;
  cacheUsername(msg.from);
  
  // Сохраняем чат в список
  await prisma.chatLink.upsert({
    where: { telegramChatId_userTelegramId: { telegramChatId: String(chatId), userTelegramId: String(uid) } },
    update: { title: msg.chat.title || msg.chat.username || null, type: msg.chat.type },
    create: { telegramChatId: String(chatId), userTelegramId: String(uid), title: msg.chat.title || msg.chat.username || null, type: msg.chat.type, enabled: false },
  }).catch(()=>{});

  if (msg.chat.type !== "private") {

    if (!text) return;
    const target = msg.reply_to_message?.from?.id || (msg.entities?.find(e=>e.type==="mention")?.user?.id);
    if (!target || target === uid) return;
    await hydrateSession(target);
    const user = await fallbackUser(target);
    const enabled = user.groups?.[String(chatId)]?.enabled !== false;
    if (enabled) await notifyGroup(bot, target, msg, text);
    return;
  }

  await hydrateSession(uid, msg.from.username);
  if (text?.startsWith("/")) {
    if (text === "/start") return sendMessage(chatId, "Главное меню", { reply_markup: homeKb(uid) });
    if (text === "/status") return sendMessage(chatId, `Статус: ${hasActiveSub({subscriptionTil: getSession(uid).subscriptionUntil})?"премиум":"бесплатно"}`);
    if (text === "/admin" && isAdmin(uid)) return sendMessage(chatId, "Админ-панель", { reply_markup: { inline_keyboard: [[{ text: "🔍 Найти пользователя", callback_data: "admin_find_user" }]] } });
    return;
  }

  const s = getSession(uid);
  if (adminWaitingForUser && isAdmin(uid)) {
    adminWaitingForUser = false;
    const found = await prisma.user.findUnique({ where: { telegramId: text } });
    if (!found) return sendMessage(chatId, "Пользователь не найден.");
    return sendMessage(chatId, `👤 ${found.telegramId}\nПодписка: ${found.subscriptionTil||"нет"}`, {
      reply_markup: { inline_keyboard: [[{ text: "➕ Продлить на 30 дней", callback_data: `admin_extend30_${found.id}` }]] }
    });
  }
  if (s.awaitingInput) { s.awaitingInput = false; return sendDraft(bot, chatId, uid, text); }
  if (s.awaitingTransformInput) { s.awaitingTransformInput = false; return processStyle(bot, chatId, uid, text); }
  if (s.dmEnabled) return sendDraft(bot, chatId, uid, text);
};

// === Админ-продление ===
const handleAdminExtend = async (bot, query) => {
  const { data, message, from } = query;
  if (!isAdmin(from.id)) return;
  const uid = data.split("_")[2];
  const days = data.includes("extend30") ? 30 : data.includes("extend90") ? 90 : 365;
  const user = await prisma.user.findUnique({ where: { id: Number(uid) } });
  if (!user) return answerCb(query.id, { text: "Пользователь не найден" });
  const until = new Date(user.subscriptionTil || Date.now());
  until.setDate(until.getDate() + days);
  await prisma.user.update({ where: { id: Number(uid) }, data: { subscriptionTil: until } });
  editMessage(message.chat.id, message.message_id, `✅ Подписка продлена на ${days} дней до ${until.toLocaleDateString()}`);
};

// === Сервер ===
app.post(`/webhook/${TELEGRAM_WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);
  const upd = req.body;
  if (upd.callback_query) {
    if (upd.callback_query.data.startsWith("admin_extend")) await handleAdminExtend(bot, upd.callback_query);
    else await handleCallback(bot, upd.callback_query);
  }
  if (upd.message) await handleMessage(bot, upd.message);
});

// === Запуск ===
const bot = { sendMessage, editMessage, answerCb, __origSendMessage: sendMessage };
bot.__origSendMessage = sendMessage;

app.listen(PORT, async () => {
  if (TELEGRAM_MODE === "webhook" && PUBLIC_URL) {
    await tg("setWebhook", { url: `${PUBLIC_URL}/webhook/${TELEGRAM_WEBHOOK_SECRET}` });
    console.log("Webhook set");
  } else {
    console.log("Polling mode");
    let offset = 0;
    while (true) {
      try {
        const updates = await tg("getUpdates", { offset, timeout: 30 });
        for (const upd of updates) {
          offset = upd.update_id + 1;
          if (upd.callback_query) {
            if (upd.callback_query.data.startsWith("admin_extend")) await handleAdminExtend(bot, upd.callback_query);
            else await handleCallback(bot, upd.callback_query);
          }
          if (upd.message) await handleMessage(bot, upd.message);
        }
      } catch (e) { await new Promise(r=>setTimeout(r,1000)); }
    }
  }
  console.log(`Listening on ${PORT}`);
});