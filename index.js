import "dotenv/config";
import express from "express";
import axios from "axios";
import OpenAI from "openai";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

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
  ADMIN_ID = "",
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
if (!ADMIN_IDS.length) ADMIN_IDS.push("1441173568");

const STATE_FILE = path.resolve(process.cwd(), "data", "bot-state.json");
const app = express().use(express.json());

let prisma;
try { prisma = new PrismaClient(); } catch { prisma = null; }

const MODES = {
  normal:   { label: "Обычный",   prompt: "Пиши естественный ответ как человек. 1-2 предложения." },
  short:    { label: "Коротко",  prompt: "Пиши очень кратко: 1 предложение, по сути." },
  polite:   { label: "Вежливо",  prompt: "Пиши максимально вежливо, но коротко." },
  tothepoint:{ label: "По делу", prompt: "Пиши строго по делу, факты, без воды." },
  refuse:   { label: "Отказать", prompt: "Сформулируй мягкий и корректный отказ." },
  busy:     { label: "Занят",    prompt: "Сформулируй, что занят и вернёшься позже." },
};

const STYLES = {
  business:  { label:"💼 Деловой",     inst:"Деловой стиль: профессионально, без сленга." },
  polite:    { label:"🤝 Вежливый",   inst:"Вежливый стиль: уважительно, мягко." },
  friendly:  { label:"🙂 Дружелюбный",inst:"Дружелюбный стиль: тепло, естественно." },
  casual:    { label:"🧢 Неформальный",inst:"Неформальный стиль: разговорно, просто." },
  short:     { label:"⚡ Кратко",      inst:"Кратко: 1-2 предложения, только суть." },
  formal:    { label:"🏛 Официальный", inst:"Официальный стиль: строго, нейтрально." },
  neutral:   { label:"⚖️ Нейтральный", inst:"Нейтральный стиль: спокойно, без эмоций." },
};

/** @type {Map<string, any>} */
const sessions = new Map();
/** @type {Map<string, any>} */
const pendingPayments = new Map();
/** @type {Map<string, number>} */
const usernameToId = new Map();
const processedGroupSignals = new Set();

// --- Helpers ---
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const isGroupChatId = id => String(id).startsWith("-");
const cacheUsername = from => from?.username && usernameToId.set(from.username.toLowerCase(), from.id);

const getSession = uid => {
  const key = String(uid);
  if (!sessions.has(key)) sessions.set(key, {
    mode: "normal", transformMode: "neutral", delaySec: 10,
    awaitingInput: false, awaitingTransformInput: false,
    lastIncomingText: "", lastDraft: "", lastTransformInput: "", lastTransformText: "",
    subscriptionUntil: null, trialUsed: false,
  });
  return sessions.get(key);
};

// --- State file fallback ---
const readState = async () => {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { return { users: {} }; }
};
const writeState = async data => {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2));
};

const fallbackUser = async (uid, uname) => {
  const id = String(uid);
  const state = await readState();
  state.users[id] = state.users[id] || { telegramId: id, username: uname, subscriptionTil: null, trialUsed: false, groups: {} };
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
  return user;
};

const isPremium = s => s.subscriptionUntil && new Date(s.subscriptionUntil) > new Date();

// --- Telegram API ---
const tg = async (method, payload) => {
  const res = await axios.post(`${TELEGRAM_API}/${method}`, payload);
  if (!res.data?.ok) throw new Error(`TG API ${method} failed`);
  return res.data.result;
};

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

// --- OpenAI ---
const aiGenerate = async (prompt, system, temp=0.5, maxTokens=180) => {
  if (!openai) return "";
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL, temperature: temp, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
  });
  return res.choices[0]?.message?.content?.trim() || "";
};

const createDraft = async (text, mode) => {
  const src = String(text).trim();
  if (!src) return "Уточните, что ответить.";
  const sys = `Ты помощник, генерируешь готовый ответ. ${MODES[mode]?.prompt || MODES.normal.prompt}`;
  const draft = await aiGenerate(src, sys, 0.5, 180);
  return draft || (mode==="short"?"Понял, отвечу позже.":"Принято, уточню детали.");
};

const paraphrase = async (text, style) => {
  const src = String(text).trim();
  if (!src) return "";
  const inst = STYLES[style]?.inst || STYLES.neutral.inst;
  const sys = `Ты редактор. Перефразируй текст в заданном стиле. Только итоговый текст. ${inst}`;
  const out = await aiGenerate(src, sys, 0.8, 320);
  return out || src;
};

// --- Keyboard builders ---
const homeKb = uid => {
  const s = getSession(uid);
  const rows = [
    [{ text: "✍️ Подготовить ответ", callback_data: "quick_start" }],
    [{ text: "🪄 Перефразировать", callback_data: "style_start" }],
    [{ text: "💳 Подписка", callback_data: "menu_sub" }],
    [{ text: "⚙️ Настройки", callback_data: "menu_settings" }],
  
  ];
  if (!isPremium(s) && !s.trialUsed) rows.push([{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }]);
  return { inline_keyboard: rows };
};

const quickKb = uid => {
  const s = getSession(uid);
  const premium = isPremium(s);
  const btn = (key, label) => {
    const locked = !premium && !["normal","short"].includes(key);
    return {
      text: `${s.mode===key?"✅ ":""}${locked?"🔒 ":""}${label}`,
      callback_data: locked ? "menu_sub" : `mode_${key}`,
    };
  };
  return { inline_keyboard: [
    [btn("normal","🧠 Обычный"), btn("short","⚡ Коротко")],
    [btn("polite","🤝 Вежливо"), btn("tothepoint","🎯 По делу")],
    [btn("refuse","🙅 Отказать"), btn("busy","⏳ Занят")],
    [{ text: `${s.delaySec===10?"✅ ":""}⏱ 10 сек`, callback_data:"delay_10" },
     { text: `${s.delaySec===20?"✅ ":""}⏱ 20 сек`, callback_data:"delay_20" }],
    [{ text: "✍️ Ввести текст", callback_data: "quick_input" }],
    ...(s.lastIncomingText ? [[{ text: "⚡ Ответить на последнее", callback_data: "quick_use_last" }]] : []),
    [{ text: "⬅ Назад", callback_data: "menu_home" }],
  ]};
};

const styleKb = uid => {
  const s = getSession(uid);
  const premium = isPremium(s);
  const btn = (key, label) => {
    const locked = !premium && !["neutral","polite"].includes(key);
    return {
      text: `${s.transformMode===key?"✅ ":""}${locked?"🔒 ":""}${label}`,
      callback_data: locked ? "menu_sub" : `style_${key}`,
    };
  };
  return { inline_keyboard: [
    [btn("business","💼 Деловой"), btn("polite","🤝 Вежливый")],
    [btn("friendly","🙂 Дружелюбный"), btn("casual","🧢 Неформальный")],
    [btn("short","⚡ Кратко"), btn("formal","🏛 Официальный")],
    [btn("neutral","⚖️ Нейтральный")],
    [{ text: "✍️ Ввести текст", callback_data: "style_input" }],
    ...(s.lastTransformInput ? [[{ text: "🔁 Обработать последнее", callback_data: "style_use_last" }]] : []),
    [{ text: "⬅ Назад", callback_data: "menu_home" }],
  ]};
};

const subKb = uid => ({
  inline_keyboard: [
    ...(!getSession(uid).trialUsed ? [[{ text: "🎁 Пробная — 0 ₽", callback_data: "buy_trial" }]] : []),
    [{ text: "Неделя — 150 ₽", callback_data: "buy_7" }],
    [{ text: "Месяц — 450 ₽", callback_data: "buy_30" }],
    [{ text: "Полгода — 1990 ₽", callback_data: "buy_180" }],
    [{ text: "Год — 3184 ₽", callback_data: "buy_365" }],
    [{ text: "⬅️ Назад", callback_data: "menu_home" }],
  ],
});

// --- Handlers ---
const sendDraft = async (chatId, uid, incoming) => {
  const s = getSession(uid);
  await sendMessage(chatId, `⏳ Думаю… пришлю через ${s.delaySec} сек.`);
  setTimeout(async () => {
    const draft = await createDraft(incoming, s.mode);
    s.lastDraft = draft; s.lastIncomingText = incoming;
    await sendMessage(chatId, `📝 <b>Готовый ответ:</b>\n\n${escapeHtml(draft)}\n\n<i>(Скопируй и отправь)</i>`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [
        [{ text: "📋 Скопировать", callback_data: "copy_draft" }],
        [{ text: "🔄 Ещё вариант", callback_data: "regen_draft" }],
        ...(!isPremium(s)&&!s.trialUsed?[[{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }]]:[]),
        [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
      ]},
    });
  }, s.delaySec * 1000);
};

const processStyle = async (chatId, uid, text) => {
  const s = getSession(uid);
  await sendMessage(chatId, "🪄 Перефразирую…");
  const result = await paraphrase(text, s.transformMode);
  s.lastTransformInput = text; s.lastTransformText = result;
  await sendMessage(chatId, `📝 <b>Перефразированный текст:</b>\n\n${escapeHtml(result)}\n\n<i>Стиль: ${STYLES[s.transformMode].label}</i>`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: "📋 Скопировать", callback_data: "copy_style" }],
      [{ text: "🔄 Ещё вариант", callback_data: "regen_style" }],
      [{ text: "🎨 Другой стиль", callback_data: "style_start" }],
      [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
    ]},
  });
};

// --- Group signal ---
const notifyGroup = async (targetId, msg, text) => {
  const key = `${msg.chat.id}:${msg.message_id}:${targetId}`;
  if (processedGroupSignals.has(key)) return;
  processedGroupSignals.add(key);
  const s = getSession(targetId);
  if (!isPremium(s)) return;
  s.lastIncomingText = text;
  await sendMessage(targetId,
    `💬 <b>В группе "${escapeHtml(msg.chat.title||'Группа')}" вам вопрос:</b>\n<code>${escapeHtml(text)}</code>\n\nПодготовить ответ?`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "✅ Подготовить", callback_data: "group_prepare" }],
      [{ text: "🚫 Не надо", callback_data: "group_ignore" }],
    ]}}
  );
};

// --- Main update processor ---
const handleCallback = async query => {
  const { data, message, from } = query;
  const chatId = message.chat.id, msgId = message.message_id, uid = from.id;
  await hydrateSession(uid, from.username);
  const s = getSession(uid);
  await answerCb(query.id);

  const actions = {
    menu_home: () => editMessage(chatId, msgId, "🤖 Главное меню", { parse_mode:"HTML", reply_markup: homeKb(uid) }),
    quick_start: () => editMessage(chatId, msgId, "✍️ <b>Подготовить ответ</b>\n\nВыбери режим и введи текст.", { parse_mode:"HTML", reply_markup: quickKb(uid) }),
    style_start: () => editMessage(chatId, msgId, "🪄 <b>Перефразировать текст</b>\n\nВыбери стиль и введи текст.", { parse_mode:"HTML", reply_markup: styleKb(uid) }),
    menu_settings: () => editMessage(chatId, msgId, "⚙️ Настройки", { parse_mode:"HTML", reply_markup: { inline_keyboard: [
      [{ text: "👥 Группы", callback_data: "groups" }],
      [{ text: "❓ Помощь", callback_data: "help" }],
      [{ text: "🔄 Онбординг", callback_data: "onboarding" }],
      [{ text: "⬅ Назад", callback_data: "menu_home" }],
    ]}}),
    menu_sub: () => editMessage(chatId, msgId, `💳 Подписка\nСтатус: ${isPremium(s)?`активна до ${s.subscriptionUntil?.slice(0,10)}`:"нет"}`, { parse_mode:"HTML", reply_markup: subKb(uid) }),
    buy_trial: async () => {
      if (s.trialUsed) return editMessage(chatId, msgId, "Пробная уже использована.", { reply_markup: subKb(uid) });
      const until = new Date(); until.setDate(until.getDate()+TRIAL_DAYS);
      s.subscriptionUntil = until.toISOString(); s.trialUsed = true;
      await prisma?.user.update({ where:{telegramId:String(uid)}, data:{subscriptionTil:until} }).catch(()=>{});
      await editMessage(chatId, msgId, `🎁 Пробная активирована до ${until.toISOString().slice(0,10)}`, { reply_markup: homeKb(uid) });
    },
    quick_input: () => { s.awaitingInput = true; sendMessage(chatId, "Пришли сообщение для ответа.", { reply_markup:{inline_keyboard:[[{text:"⬅ Назад", callback_data:"quick_start"}]]} }); },
    style_input: () => { s.awaitingTransformInput = true; sendMessage(chatId, "Пришли текст для перефразирования."); },
    quick_use_last: () => s.lastIncomingText && sendDraft(chatId, uid, s.lastIncomingText),
    style_use_last: () => s.lastTransformInput && processStyle(chatId, uid, s.lastTransformInput),
    copy_draft: () => sendMessage(chatId, `📋 ${escapeHtml(s.lastDraft)}`, { parse_mode:"HTML" }),
    copy_style: () => sendMessage(chatId, `📋 ${escapeHtml(s.lastTransformText)}`, { parse_mode:"HTML" }),
    regen_draft: () => s.lastIncomingText && sendDraft(chatId, uid, s.lastIncomingText),
    regen_style: () => s.lastTransformInput && processStyle(chatId, uid, s.lastTransformInput),
    group_prepare: () => s.lastIncomingText && sendDraft(chatId, uid, s.lastIncomingText),
    group_ignore: () => editMessage(chatId, msgId, "Ок, игнорирую."),
    groups: async () => {
      const user = await fallbackUser(uid);
      const groups = Object.values(user.groups || {});
      const kb = groups.map(g => ([{ text: `${g.enabled?'✅':'❌'} ${g.title}`, callback_data: `toggle_${g.id}` }]));
      kb.push([{ text: "⬅ Назад", callback_data: "menu_settings" }]);
      await editMessage(chatId, msgId, "👥 Группы (вкл/выкл подсказки)", { reply_markup:{inline_keyboard:kb} });
    },
    help: () => editMessage(chatId, msgId, "🆘 Помощь:\n/start, /status, /help", { reply_markup:{inline_keyboard:[[{text:"⬅ Назад", callback_data:"menu_settings"}]]} }),
    onboarding: async () => {
      await editMessage(chatId, msgId, "Добро пожаловать! Я помогу с ответами.", { reply_markup:{inline_keyboard:[[{text:"🚀 Начать", callback_data:"onb_step2"}]]} });
    },
    onb_step2: () => editMessage(chatId, msgId, "1) Нажми «Подготовить ответ»\n2) Выбери режим\n3) Отправь текст", { reply_markup:{inline_keyboard:[[{text:"Дальше", callback_data:"onb_done"}]]} }),
    onb_done: async () => { await prisma?.user.update({ where:{telegramId:String(uid)}, data:{onboardingCompleted:true} }).catch(()=>{}); return actions.menu_home(); },
  };

  if (actions[data]) return actions[data]();
  if (data.startsWith("mode_")) {
    const mode = data.slice(5);
    if (!MODES[mode]) return;
    if (!isPremium(s) && !["normal","short"].includes(mode)) return answerCb(query.id, { text:"Требуется подписка", show_alert:true });
    s.mode = mode;
    return editMessage(chatId, msgId, "✍️ <b>Подготовить ответ</b>", { parse_mode:"HTML", reply_markup: quickKb(uid) });
  }
  if (data.startsWith("style_")) {
    const style = data.slice(6);
    if (!STYLES[style]) return;
    if (!isPremium(s) && !["neutral","polite"].includes(style)) return answerCb(query.id, { text:"Требуется подписка", show_alert:true });
    s.transformMode = style;
    return editMessage(chatId, msgId, "🪄 <b>Перефразировать</b>", { parse_mode:"HTML", reply_markup: styleKb(uid) });
  }
  if (data.startsWith("delay_")) {
    s.delaySec = parseInt(data.slice(6));
    return editMessage(chatId, msgId, "✍️ <b>Подготовить ответ</b>", { parse_mode:"HTML", reply_markup: quickKb(uid) });
  }
  if (data.startsWith("toggle_")) {
    const gid = data.slice(7);
    const state = await readState();
    const grp = state.users[uid]?.groups?.[gid];
    if (grp) grp.enabled = !grp.enabled; else state.users[uid].groups[gid] = { id:gid, enabled:true };
    await writeState(state);
    return actions.groups();
  }
  // YooKassa payments
  if (data.startsWith("buy_")) {
    const plan = {7:150,30:450,180:1990,365:3184}[data.slice(4)] || 150;
    const payment = await axios.post(`${YOOKASSA_API}/payments`, {
      amount:{value:plan, currency:"RUB"}, capture:true,
      confirmation:{type:"redirect", return_url:`https://t.me/${from.username||""}`},
      description:`Подписка ${data.slice(4)} дн.`,
      metadata:{user_id:String(uid)},
    }, { headers:{ Authorization: `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}` }}).catch(()=>null);
    if (!payment?.data?.confirmation?.confirmation_url) return sendMessage(chatId, "Ошибка создания платежа.");
    pendingPayments.set(payment.data.id, { uid, days:parseInt(data.slice(4)) });
    return editMessage(chatId, msgId, `💳 Оплатите ${plan}₽`, { reply_markup:{inline_keyboard:[
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
      await prisma?.user.update({ where:{telegramId:String(uid)}, data:{subscriptionTil:until} }).catch(()=>{});
      pendingPayments.delete(pid);
      return editMessage(chatId, msgId, `✅ Подписка активирована до ${until.toISOString().slice(0,10)}`, { reply_markup: homeKb(uid) });
    }
  }
};

const handleMessage = async msg => {
  const chatId = msg.chat.id, uid = msg.from.id, text = msg.text?.trim();
  if (!uid) return;
  cacheUsername(msg.from);
  if (msg.chat.type !== "private") {
    // Group handling
    if (!text) return;
    const target = msg.reply_to_message?.from?.id || (msg.entities?.find(e=>e.type==="mention")?.user?.id);
    if (!target || target === uid) return;
    await hydrateSession(target);
    const user = await fallbackUser(target);
    const enabled = user.groups?.[String(chatId)]?.enabled !== false;
    if (enabled) await notifyGroup(target, msg, text);
    return;
  }
  // Private
  await hydrateSession(uid, msg.from.username);
  if (text?.startsWith("/")) {
    if (text === "/start") return sendMessage(chatId, "Главное меню", { reply_markup: homeKb(uid) });
    if (text === "/status") return sendMessage(chatId, `Статус: ${isPremium(getSession(uid))?"премиум":"бесплатно"}`);
    return;
  }
  const s = getSession(uid);
  if (s.awaitingInput) { s.awaitingInput = false; return sendDraft(chatId, uid, text); }
  if (s.awaitingTransformInput) { s.awaitingTransformInput = false; return processStyle(chatId, uid, text); }
};

// --- Server & polling ---
app.post(`/webhook/${TELEGRAM_WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);
  const upd = req.body;
  if (upd.callback_query) await handleCallback(upd.callback_query);
  if (upd.message) await handleMessage(upd.message);
});

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
          if (upd.callback_query) await handleCallback(upd.callback_query);
          if (upd.message) await handleMessage(upd.message);
        }
      } catch (e) { await new Promise(r=>setTimeout(r,1000)); }
    }
  }
  console.log(`Listening on ${PORT}`);
});