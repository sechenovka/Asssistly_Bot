import { createDmDraftsModule } from "./dmDrafts.js";
import { prisma } from "../../db/prisma.js";
import { userService } from "../../services/userService.js";
import { chatService } from "../../services/chatService.js";
import { paymentService } from "../../services/paymentService.js";

const ADMIN_ID = 1441173568;
const STYLE_NAMES = {
  default: "Обычный",
  business: "Деловой",
  cute: "Милый",
  strict: "Строгий",
  humor: "С юмором",
};

// Helper to get style label (with emoji for some styles)
function getStyleLabel(styleKey, hasSub = true) {
  if (!hasSub) return "Обычный";

  const map = {
    default: "Обычный",
    business: "Деловой",
    cute: "Милый 😊",
    strict: "Строгий",
    humor: "Юмор 😄",
  };
  return map[styleKey] || map.default;
}

let adminWaitingForUser = false; // ждём ли ID от админа
let adminReplyChat = null;       // в какой чат потом слать ответ

export function registerHandlers(bot) {
  // ============================
  //  HARD BLOCK: бот НИКОГДА не пишет в группы/каналы.
  //  Любая попытка bot.sendMessage() в chatId < 0 будет тихо проигнорирована.
  // ============================
  const __origSendMessage = bot.sendMessage.bind(bot);
  bot.__origSendMessage = __origSendMessage;

  bot.sendMessage = async (chatId, text, opts = {}) => {
    try {
      // Telegram: группы/супергруппы/каналы имеют отрицательный chatId
      if (typeof chatId === "number" && chatId < 0) return;
      if (typeof chatId === "string" && String(chatId).startsWith("-")) return;
      return await __origSendMessage(chatId, text, opts);
    } catch (e) {
      // не роняем бота из-за ошибок отправки
      console.error("sendMessage error:", e);
      return;
    }
  };
  // ЖЁСТКАЯ ЗАЩИТА: helper для отправки ТОЛЬКО в личку (обходит group-block)
  function sendToUserOnly(bot, userId, text, opts = {}) {
    const sender = bot.__origSendMessage ? bot.__origSendMessage : bot.sendMessage;
    return sender(userId, text, opts);
  }

  // ============================
  //   USERNAME CACHE (for group mentions like @username)
  //   Telegram "mention" entities do not include userId.
  //   We cache username -> userId from messages we observe.
  // ============================
  const usernameToId = new Map();
  function cacheUsername(from) {
    try {
      const uname = from?.username ? String(from.username).toLowerCase() : null;
      const uid = from?.id;
      if (!uname || !uid) return;
      usernameToId.set(uname, Number(uid));
    } catch {}
  }

  function extractMentionedUserId(msg, text) {
    try {
      const rawText = String(text || "");

      // 1) Telegram entities (most reliable)
      const entities = msg?.entities || msg?.caption_entities || [];
      if (entities?.length) {
        for (const ent of entities) {
          // Direct user mention (Telegram provides the user)
          if (ent?.type === "text_mention" && ent?.user?.id) {
            return Number(ent.user.id);
          }

          // @username mention (no userId in Telegram update) -> use cache
          if (
            ent?.type === "mention" &&
            typeof ent?.offset === "number" &&
            typeof ent?.length === "number"
          ) {
            const chunk = rawText.slice(ent.offset, ent.offset + ent.length);
            const uname = chunk.startsWith("@") ? chunk.slice(1).toLowerCase() : chunk.toLowerCase();
            const cached = usernameToId.get(uname);
            if (cached) return Number(cached);
          }
        }
      }

      // 2) Fallback: some clients don't send entities for @username
      // (or offsets can be off with emojis). Try a simple regex.
      const m = rawText.match(/(^|\s)@([a-zA-Z0-9_]{3,32})\b/);
      if (m && m[2]) {
        const uname = String(m[2]).toLowerCase();
        const cached = usernameToId.get(uname);
        if (cached) return Number(cached);
      }
    } catch {}

    return null;
  }
  //const dmDrafts = createDmDraftsModule();
  // ============================
  //     DM Auto-reply (MVP, in-memory)
  //     ВАЖНО: бот НЕ может писать в чужие личные чаты пользователя.
  //     Здесь это работает как «черновики ответов» в личке с ботом.
  // ============================
  const dmAutoState = new Map();

  // ============================
  //   QUICK FLOW: "Подготовить ответ" (продающая версия)
  //   Пользователь нажимает кнопку → присылает текст собеседника → получает готовый ответ.
  // ============================
  const quickReplyState = new Map();

  function getQuickState(userId) {
    const key = String(userId);
    if (!quickReplyState.has(key)) {
      quickReplyState.set(key, {
        awaiting: false,
        delaySec: 10,
        lastIncomingText: null,
        lastVariantId: null,
        lastDraft: null,
        pendingToken: null,
        pendingTimer: null,
        quickStyle: null,
        quickMode: "normal",
        lastSource: null,
        lastGroupChatId: null,
        appendToLast: false,
      });
    }
    return quickReplyState.get(key);
  }

  function setQuickState(userId, patch) {
    const s = getQuickState(userId);
    Object.assign(s, patch);
    quickReplyState.set(String(userId), s);
    return s;
  }

  // Cancel any pending QUICK draft for a user (clears timer and token)
  function cancelPendingQuickDraft(userId) {
    const s = getQuickState(userId);
    if (s?.pendingTimer) {
      try {
        clearTimeout(s.pendingTimer);
      } catch {}
    }
    setQuickState(userId, { pendingTimer: null, pendingToken: null });
  }

  function quickReplyKeyboard(userId, isSub = false) {
    const s = getQuickState(userId);

    const selectedMode = s?.quickMode || "normal";
    const selectedDelay = Number(s?.delaySec || 10);

    const modeBtn = (key, label) => {
      const mark = selectedMode === key ? "✅ " : "";
      return { text: `${mark}${label}`, callback_data: `quick_mode_${key}` };
    };

    const delayBtn = (sec) => {
      const mark = selectedDelay === sec ? "✅ " : "";
      return { text: `${mark}⏱ ${sec} сек`, callback_data: `quick_delay_${sec}` };
    };

    const modeRow1 = [
      modeBtn("normal", "🧠 Обычный"),
      modeBtn("short", "⚡ Коротко"),
    ];

    const modeRow2 = isSub
  ? [
      modeBtn("polite", "🤝 Вежливо"),
      modeBtn("tothepoint", "🎯 По делу"),
    ]
  : [
      { text: "🔒 Вежливо", callback_data: "menu_sub" },
      { text: "🔒 По делу", callback_data: "menu_sub" },
    ];

const modeRow3 = isSub
  ? [
      modeBtn("refuse", "🙅 Отказать"),
      modeBtn("busy", "⏳ Занят"),
    ]
  : [
      { text: "🔒 Отказать", callback_data: "menu_sub" },
      { text: "🔒 Занят", callback_data: "menu_sub" },
    ];
    const keyboard = [
      modeRow1,
      modeRow2,
      ...(modeRow3.length ? [modeRow3] : []),
      [delayBtn(10), delayBtn(20)],
      ...(!isSub
        ? [[{ text: "🎁 Пробная 0 ₽ — открыть все режимы", callback_data: "buy_trial" }]]
        : []),
      ...(s?.lastIncomingText
        ? [[{ text: "⚡ Ответить на последнее сообщение", callback_data: "quick_use_last" }]]
        : []),
      [{ text: "⬅ Назад", callback_data: "menu_home" }],
    ];

    // Ensure the top CTA row label remains "✍️ Подготовить ответ" if present (for DM main menu)
    // (No change to main menu here)
    return { inline_keyboard: keyboard };
  }

  async function sendQuickDraft({ bot, chatId, userId, incomingText }) {
    // UX: подтверждение ожидания
    await bot.sendMessage(
      chatId,
      `⏳ Думаю над ответом…\nПришлю вариант через ${getQuickState(userId)?.delaySec || 10} сек.`
    );

    const prevState = getQuickState(userId);

    const u = await prisma.user.findUnique({ where: { telegramId: String(userId) } });
    const quickStyle = getQuickState(userId)?.quickStyle;
    const styleLabel = getStyleLabel(quickStyle || u?.style, hasActiveSub(u));

    const prev = getQuickState(userId);
    const quickMode = prev?.quickMode || "normal";
    const built = buildDraftReply(incomingText, styleLabel, prev.lastVariantId, quickMode);

    setQuickState(userId, {
      awaiting: false,
      lastIncomingText: incomingText,
      lastVariantId: built.variantId,
      lastDraft: built.draft,
      lastSource: prevState?.lastSource || null,
      lastGroupChatId: prevState?.lastGroupChatId || null,
    });

    const isSub = hasActiveSub(u);

    const messageText =
      "📝 <b>Готовый ответ:</b>\n\n" +
      fmtCode(built.draft) +
      "\n\n<i>(Скопируй и отправь собеседнику)</i>" +
      (!isSub
        ? "\n\n<b>Хочешь ещё сильнее?</b>\n" +
          "Подписка открывает режимы: <b>Вежливо</b>, <b>По делу</b>, <b>Отказать</b>, <b>Занят</b> и даёт <b>ещё варианты</b>.\n" +
          (prevState?.lastSource === "group"
            ? (() => {
                const gs = getGroupHintState(userId);
                const left = Math.max(0, GROUP_FREE_HINT_LIMIT - Number(gs.used || 0));
                return `\n🧾 Бесплатно для групп осталось сегодня: <b>${left} из ${GROUP_FREE_HINT_LIMIT}</b>.\n`;
              })()
            : "") +
          "Можно начать с пробной — 0 ₽."
        : "");

    return bot.sendMessage(chatId, messageText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 Скопировать", callback_data: "quick_copy" }],

          ...(isSub
            ? [[{ text: "🔄 Ещё вариант", callback_data: "quick_reply_regen" }]]
            : []),

          ...(!isSub
            ? [
                [{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }],
                [{ text: "✨ Что даёт подписка", callback_data: "sub_benefits" }],
              ]
            : []),

          [
            { text: "✍️ Подготовить ещё", callback_data: "quick_reply_start" },
            { text: "🏠 Главное меню", callback_data: "menu_home" },
          ],
        ],
      },
    });
  }

  const DM_FREE_LIMIT = 5; // бесплатно — 5 черновиков (потом просим подписку)

  // Бесплатно — лимит подсказок для группы (в день)
  const GROUP_FREE_HINT_LIMIT = 3;
  const groupHintState = new Map();

  function getGroupHintState(userId) {
    const key = String(userId);
    if (!groupHintState.has(key)) {
      groupHintState.set(key, {
        used: 0,
        usedDay: todayKey(),
      });
    }

    const s = groupHintState.get(key);
    const tk = todayKey();
    if (s.usedDay !== tk) {
      s.usedDay = tk;
      s.used = 0;
      groupHintState.set(key, s);
    }

    return groupHintState.get(key);
  }

  function incGroupHintUsed(userId) {
    const s = getGroupHintState(userId);
    s.used = Number(s.used || 0) + 1;
    groupHintState.set(String(userId), s);
    return s;
  }

  function todayKey() {
    // YYYY-MM-DD
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function getDmState(userId) {
    const key = String(userId);
    if (!dmAutoState.has(key)) {
      dmAutoState.set(key, {
        enabled: false,
        delaySec: 10,
        used: 0,
        usedDay: todayKey(),
        lastIncomingText: null,
        lastDraft: null,
        lastStyleLabel: null,
        lastVariantId: null,
        pendingToken: null,
        pendingTimer: null,
      });
    }

    // ежедневный сброс счётчика
    const s = dmAutoState.get(key);
    const tk = todayKey();
    if (s.usedDay !== tk) {
      s.usedDay = tk;
      s.used = 0;
      dmAutoState.set(key, s);
    }

    return dmAutoState.get(key);
  }

  function setDmState(userId, patch) {
    const s = getDmState(userId);
    Object.assign(s, patch);
    dmAutoState.set(String(userId), s);
    return s;
  }

  // Cancel any pending DM auto-reply draft for a user (clears timer and token)
  function cancelPendingDmDraft(userId) {
    const s = getDmState(userId);
    if (s?.pendingTimer) {
      try {
        clearTimeout(s.pendingTimer);
      } catch {}
    }
    setDmState(userId, { pendingTimer: null, pendingToken: null });
  }

  // 🔧 Делаем состояние черновиков доступным из других файлов/хендлеров.
  // Важно: если где-то ещё есть bot.on('message') (например, chatLogic.js),
  // то return внутри этого файла НЕ остановит другой хендлер.
  // Поэтому другие хендлеры должны уметь проверить, включены ли черновики.
  bot.getDmDraftState = (uid) => getDmState(uid);
  // 🔧 Делаем состояние quick-flow доступным из других файлов/хендлеров.
  bot.getQuickState = (uid) => getQuickState(uid);
  bot.isQuickAwaiting = (uid) => {
    const s = getQuickState(uid);
    return !!s?.awaiting;
  };

  function renderDmAutoMenuText({ state, styleLabel, isSub }) {
  const enabled = state.enabled ? "✅ включён" : "❌ выключен";
  const delay = state.delaySec;

  const remaining = Math.max(0, DM_FREE_LIMIT - Number(state.used || 0));

  const quotaLine = isSub
    ? "♾️ Лимит: *без ограничений* (подписка активна)"
    : `🧾 Осталось сегодня: *${remaining} из ${DM_FREE_LIMIT}* черновиков`;

  const ctaLine = isSub
    ? ""
    : "\n\n🚀 Хочешь *без лимита* и доступ ко всем функциям? Нажми «💳 Оформить подписку».";

  return (
    "📩 *Черновики ответов (личные сообщения)*\n\n" +
    "⚠️ Telegram-бот *не может* автоматически отвечать за вас в чужих личных чатах.\n" +
    "Зато я могу делать *черновики ответов* здесь — вы копируете и отправляете сами.\n\n" +
    `Статус: *${enabled}*\n` +
    `⏱ Задержка: *${delay} сек*\n` +
    `${quotaLine}\n` +
    `🎨 Стиль: *${styleLabel}*\n\n` +
    "Как пользоваться:\n" +
    "1) Включи режим\n" +
    "2) Пришли сюда сообщение собеседника\n" +
    "3) Я подожду задержку и пришлю черновик\n" +
    ctaLine
  );
}

  function dmAutoMenuKeyboard(state, isSub) {
    const rows = [
      [
        {
          text: state.enabled ? "🔕 Выключить" : "🔔 Включить",
          callback_data: "dm_auto_toggle",
        },
      ],
      [
        { text: "⏱ 10 сек", callback_data: "dm_auto_delay_10" },
        { text: "⏱ 20 сек", callback_data: "dm_auto_delay_20" },
      ],
      [
        { text: "✍️ Подготовить ответ", callback_data: "quick_reply_start" },
      ],
      // назад именно в настройки, а не в главное меню
      [{ text: "⬅ Назад", callback_data: "menu_settings" }],
    ];

    return { inline_keyboard: rows };
  }

  function buildDraftReply(text, styleName = "Обычный", prevVariantId = null, modeKey = "normal") {
    // MVP: быстрые «человеческие» шаблоны. Возвращаем {draft, variantId}
    const t = String(text || "").trim();
    const short = t.length > 220 ? t.slice(0, 220) + "…" : t;

    if (!short) {
      return { draft: "Понял. Что именно нужно ответить?", variantId: "empty" };
    }

    // Нормализуем стиль
    const s = String(styleName || "Обычный");

    // Наборы вариантов по режиму + стилю
    const modePools = {
      normal: {
        business: [
          "Спасибо за сообщение. Уточните, пожалуйста, детали — и я вернусь с ответом.",
          "Благодарю! Подскажите, пожалуйста, что именно вы ожидаете в итоге?",
          "Принято. Дайте, пожалуйста, чуть больше контекста, чтобы я ответил точнее.",
          "Понял. Могу уточнить пару деталей, чтобы не ошибиться?",
        ],
        strict: [
          "Принято. Уточните конкретику, чтобы я мог дать точный ответ.",
          "Понял. Нужны детали (сроки/условия), чтобы ответ был корректным.",
          "Зафиксировал. Уточните, пожалуйста, ключевые параметры.",
          "Понял. Без уточнений дать точный ответ не получится — напишите детали.",
        ],
        cute: [
          "Понял 😊 Сейчас подумаю и отвечу.",
          "Окей 😊 Дай мне минутку — и я вернусь с ответом.",
          "Понял! 😊 Сейчас соберусь с мыслями и отвечу.",
          "Окей 😊 Уточни, пожалуйста, пару деталей — и я отвечу точнее.",
        ],
        humor: [
          "Окей 😄 Сейчас подумаю — и отвечу так, будто я всё знал заранее!",
          "Понял 😄 Сейчас соберу мысли в кучу и отвечу по-человечески.",
          "Окей 😄 Дай секунду — и будет ответ без лишней воды!",
          "Понял 😄 Уточни детали — и я выдам ответ, как будто это было легко!",
        ],
        default: [
          "Понял. Сейчас подумаю и отвечу.",
          "Окей, принял. Уточни, пожалуйста, детали — и отвечу точнее.",
          "Понял тебя. Сейчас сформулирую ответ.",
          "Принято. Можешь уточнить, что именно важно в этом вопросе?",
        ],
      },

      polite: {
        business: ["Благодарю за сообщение. Подскажите, пожалуйста, пару уточнений?"],
        strict: ["Принято. Пожалуйста, уточните детали для корректного ответа."],
        cute: ["Спасибо тебе 😊 Уточни, пожалуйста, пару деталей — и я отвечу точнее."],
        humor: ["Спасибо 😄 Уточни пару деталей — и я выдам вежливый ответ!"],
        default: ["Спасибо! Уточни, пожалуйста, детали — и я отвечу точнее."],
      },

      tothepoint: {
        business: ["Принято. Напишите, пожалуйста: сроки, формат и ожидаемый результат."],
        strict: ["Ок. Нужны сроки и конкретика — без этого ответ будет неточным."],
        cute: ["Окей 😊 Скажи коротко: что именно нужно и к какому сроку?"],
        humor: ["Ок 😄 Давай по фактам: что нужно и к какому сроку?"],
        default: ["Ок. Уточни: что нужно сделать и к какому сроку?"],
      },

      short: {
        business: ["Спасибо! Уточните детали, пожалуйста."],
        strict: ["Уточните детали."],
        cute: ["Окей 😊 Уточни детали."],
        humor: ["Ок 😄 Уточни детали."],
        default: ["Понял. Уточни детали, пожалуйста."],
      },

      refuse: {
        business: ["Спасибо за предложение. К сожалению, сейчас не смогу — у меня другие приоритеты."],
        strict: ["Сейчас не смогу. Отвечу позже, если будет актуально."],
        cute: ["Спасибо 😊 Но сейчас не смогу — правда. Надеюсь, ты поймёшь."],
        humor: ["Спасибо 😄 Но сейчас пас — у меня и так квестов хватает."],
        default: [
          "Спасибо, но сейчас не смогу. Давай вернёмся к этому позже.",
          "Благодарю, но сейчас не получится. Спасибо за понимание.",
        ],
      },

      soften: {
        business: ["Я бы предложил(а) уточнить несколько моментов, чтобы избежать недопонимания."],
        strict: ["Уточните детали, чтобы избежать ошибок."],
        cute: ["Можно чуть мягче 😊 Уточни, пожалуйста, детали — и я отвечу точнее."],
        humor: ["Давай мягче 😄 Уточни вводные — и сделаем красиво."],
        default: [
          "Давай уточним детали, чтобы всё было понятно — и я отвечу точнее.",
          "Чтобы ответить корректно, уточни, пожалуйста, пару моментов.",
        ],
      },

      busy: {
        business: ["Сейчас на встрече. Вернусь с ответом чуть позже."],
        strict: ["Сейчас занят(а). Отвечу позже."],
        cute: ["Я сейчас занят(а) 😊 Отвечу чуть позже!"],
        humor: ["Сейчас в режиме «занят» 😄 Отвечу чуть позже."],
        default: ["Сейчас занят(а). Отвечу чуть позже."],
      },
    };

    // Выбираем ключ пула
    let key = "default";
    if (s.includes("Делов")) key = "business";
    else if (s.includes("Строг")) key = "strict";
    else if (s.includes("Мил")) key = "cute";
    else if (s.includes("Юмор") || s.includes("С юмором")) key = "humor";

    const normalizedMode = String(modeKey || "normal");
    const modeSafe = modePools[normalizedMode] ? normalizedMode : "normal";
    const pool = modePools[modeSafe][key] || modePools[modeSafe].default || modePools.normal.default;

    // Выбираем вариант, стараясь не повторять предыдущий
    const ids = pool.map((_, i) => `${key}:${i}`);
    let pickIndex = Math.floor(Math.random() * pool.length);

    if (prevVariantId && pool.length > 1) {
      // до 5 попыток выбрать другой
      for (let i = 0; i < 5; i++) {
        const candidate = Math.floor(Math.random() * pool.length);
        if (ids[candidate] !== prevVariantId) {
          pickIndex = candidate;
          break;
        }
      }
    }

    const base = pool[pickIndex];

    // Лёгкая персонализация: если сообщение похоже на вопрос — предлагаем уточнить
    const looksLikeQuestion = /\?|как\b|почему\b|когда\b|где\b|что\b|сколько\b/i.test(short);
    const addOn = looksLikeQuestion
      ? " Если уточнишь пару деталей, отвечу точнее."
      : "";

    return {
      draft: base + addOn,
      variantId: ids[pickIndex],
    };
  }

  async function renderDmAutoScreen(bot, msg, userId) {
    const user = await prisma.user.findUnique({
      where: { telegramId: String(userId) },
    });

    const isSub = hasActiveSub(user);
    const styleLabel = getStyleLabel(user?.style, isSub);

    const state = getDmState(userId);

    const text = renderDmAutoMenuText({ state, styleLabel, isSub });

    try {
      return await bot.editMessageText(text, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: dmAutoMenuKeyboard(state, isSub),
      });
    } catch (e) {
      const desc = e?.response?.body?.description || e?.message || "";
      if (String(desc).includes("message is not modified")) {
        // Ничего не поменялось — просто молча выходим, чтобы не ронять процесс
        return;
      }
      throw e;
    }
  }
  // ============================
  //     helper: main menu + onboarding
  // ============================
  function getChatMode(chat) {
    const type = chat?.type;
    if (type === "private") return { key: "dm", label: "Личные сообщения" };
    if (type === "group" || type === "supergroup") return { key: "group", label: "Группы" };
    return { key: "other", label: "Чаты" };
  }

  // --- helper: bot username (env + Telegram fallback) ---
  let BOT_USERNAME_CACHE = null;
  let BOT_ID_CACHE = null;

  // на случай, если .env не подхватился — берём username у Telegram
  bot
    .getMe()
    .then((me) => {
      if (me?.username) BOT_USERNAME_CACHE = String(me.username).trim();
      if (me?.id) BOT_ID_CACHE = Number(me.id);
    })
    .catch(() => {});

  function getBotUsername() {
    const u = (
      process.env.BOT_USERNAME ||
      process.env.BOT_USER ||
      process.env.TG_BOT_USERNAME ||
      ""
    ).trim();

    return u || BOT_USERNAME_CACHE || "";
  }

  // --- helper: escape text for Telegram HTML parse_mode ---
  function escapeHtml(input = "") {
    return String(input)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtCode(input = "") {
    // Telegram HTML <code> can be picky; keep it single-line and not too long.
    const raw = String(input ?? "");
    const compact = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ⏎ ");
    const clipped = compact.length > 600 ? compact.slice(0, 600) + "…" : compact;
    const t = escapeHtml(clipped);
    return `<code>${t}</code>`;
  }

  function mainMenuKeyboard(modeKey = "dm") {
    // В личке — продающее меню (быстрое действие + подписка)
    if (modeKey === "dm") {
  return {
    inline_keyboard: [
      [{ text: "✍️ Подготовить ответ", callback_data: "quick_reply_start" }],
      [{ text: "👥 Группы", callback_data: "connect_chat" }],
      [{ text: "⚙️ Настройки", callback_data: "menu_settings" }],
    ],
  };
}

    // В группах — минимум (чтобы не мешать всем).
    return {
      inline_keyboard: [
        [{ text: "👥 Настройки группы", callback_data: "group_settings" }],
        [{ text: "➕ Подключить группу", callback_data: "connect_chat" }],
        [{ text: "💳 Подписка", callback_data: "menu_sub" }],
        [{ text: "❓ Помощь", callback_data: "help_how" }],
      ],
    };
  }

  // === SUBSCRIPTION UI HELPERS ===
  function hasActiveSub(user) {
    if (!user?.subscriptionTil) return false;
    const til = new Date(user.subscriptionTil);
    return til > new Date();
  }

  // ============================
  //  AUTO-ENABLE GROUP FOR SUBSCRIBER (no /start needed)
  //  When a subscriber adds the bot to a group, we auto-enable this group
  //  for that subscriber so they can immediately receive DM hints.
  // ============================
  bot.on("my_chat_member", async (upd) => {
    try {
      const chat = upd?.chat;
      if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

      const newMember = upd?.new_chat_member;
      const oldMember = upd?.old_chat_member;
      const botUser = newMember?.user;

      // we only care when THIS bot was added / re-added
      const botId = BOT_ID_CACHE;
      if (!botId || !botUser?.id || Number(botUser.id) !== Number(botId)) return;

      const newStatus = String(newMember?.status || "");
      const oldStatus = String(oldMember?.status || "");

      // If the bot was removed from the group — remove it from users' connected lists
      // so it doesn't keep showing up in "➕ Подключить группу".
      const becameInactive =
        (newStatus === "left" || newStatus === "kicked") &&
        (oldStatus === "member" || oldStatus === "administrator" || oldStatus === "restricted");

      if (becameInactive) {
        try {
          await prisma.chatLink.deleteMany({
            where: { telegramChatId: String(chat.id) },
          });
        } catch {}

        // Nothing else to do — do NOT spam the group.
        return;
      }

      // Added or promoted to member/admin from left/kicked
      const becameActive =
        (newStatus === "member" || newStatus === "administrator") &&
        (oldStatus === "left" || oldStatus === "kicked" || oldStatus === "restricted");

      if (!becameActive) return;

      // who added the bot
      const inviterId = upd?.from?.id;
      if (!inviterId) return;

      // only auto-enable for active subscribers
      const user = await prisma.user.findUnique({
        where: { telegramId: String(inviterId) },
      });
      if (!hasActiveSub(user)) return;

      // upsert chat link as enabled for this subscriber
      await prisma.chatLink.upsert({
        where: {
          telegramChatId_userTelegramId: {
            telegramChatId: String(chat.id),
            userTelegramId: String(inviterId),
          },
        },
        update: {
          enabled: true,
          title: chat.title || chat.username || null,
          type: chat.type,
        },
        create: {
          telegramChatId: String(chat.id),
          userTelegramId: String(inviterId),
          title: chat.title || chat.username || null,
          type: chat.type,
          enabled: true,
        },
      });

      try {
        await chatService.enableChat(chat.id, inviterId);
      } catch {}

      // confirm in DM (do not spam the group)
      const groupTitle = chat.title || "группе";
      await bot.sendMessage(
        inviterId,
        `✅ Я включился в группе «${groupTitle}».\n\nТеперь я буду присылать тебе подсказки в личку, когда в этой группе кто-то ответит (reply) на твоё сообщение.`
      );
    } catch (e) {
      console.error("my_chat_member auto-enable error:", e);
    }
  });

  // Проверяет, есть ли у пользователя включённые (enabled) групповые чаты
  async function hasEnabledGroupChats(userId) {
    const cnt = await prisma.chatLink.count({
      where: {
        userTelegramId: String(userId),
        enabled: true,
        NOT: { type: "private" },
      },
    });
    return cnt > 0;
  }

  function homeKeyboard(modeKey = "dm", user, showConnectHint = false) {
    const base = mainMenuKeyboard(modeKey);

    // Если автоответ ещё нигде не включён — делаем кнопку подключения заметнее,
    // но НЕ дублируем «Почему бот не отвечает?» (она уже есть в меню).
    if (modeKey === "dm" && showConnectHint) {
      // находим строку с кнопкой подключения чата
      const idx = base.inline_keyboard.findIndex(
        (row) => Array.isArray(row) && row.some((b) => b?.callback_data === "connect_chat")
      );

      if (idx !== -1) {
        const row = base.inline_keyboard[idx];

        // меняем текст на более понятный
        for (const b of row) {
          if (b?.callback_data === "connect_chat") {
            b.text = "➕ Подключить первый чат";
          }
        }

        // поднимаем эту строку вверх (после кнопки преимуществ, которая добавится ниже)
        base.inline_keyboard.splice(idx, 1);
        base.inline_keyboard.unshift(row);
      }
    }

    return base;
  }

  function subCtaBlock(user) {
    if (hasActiveSub(user)) return "";
    return "\n\n✨ _Подписка открывает все возможности бота!_";
  }

  function formatSubStatus(user) {
    // Не показываем «ошибочный»/негативный статус новичку.
    // Если подписки никогда не было — это просто бесплатный режим.
    if (!user?.subscriptionTil) return "🆓 бесплатный режим";

    const til = new Date(user.subscriptionTil);
    const now = new Date();

    if (Number.isNaN(til.getTime())) return "🆓 бесплатный режим";

    // Если срок прошёл — тоже без «крестиков», мягко.
    if (til < now) return `⏳ истекла ${til.toLocaleDateString()}`;

    return `✅ активна до ${til.toLocaleDateString()}`;
  }

  async function renderHomeScreen({ bot, chatId, messageId = null, userId, chat, variant = "home" }) {
    const mode = getChatMode(chat);

    const user = await prisma.user.findUnique({
      where: { telegramId: String(userId) },
    });

    const currentStyle = getStyleLabel(user?.style, hasActiveSub(user));
    const sub = formatSubStatus(user);

    const hasEnabledChats = await hasEnabledGroupChats(userId);
    const showConnectHint = !hasEnabledChats;

    let text;

    if (variant === "post_onboarding") {
      text =
        "✅ *Готово!* Давай настроим бота за 30 секунд\n\n" +
        "1) Нажми *➕ Добавить чат*\n" +
        "2) Включи там ✅ напротив нужной группы\n" +
        "3) (по желанию) Выбери стиль общения\n\n" +
        `📍 *Режим:* ${mode.label}\n` +
        `💳 *Режим:* ${sub}\n` +
        `🎨 *Стиль:* ${currentStyle}` +
        (showConnectHint
          ? "\n\n⚠️ _Автоответ ещё не включён ни в одной группе._\nОткрой *➕ Добавить чат* и включи ✅ напротив нужной группы."
          : "") +
        subCtaBlock(user);
    } else {
      text =
        "🤖 *Готовые ответы для твоих чатов — за 10 секунд*\n\n" +
        "Ты вставляешь сообщение — я предлагаю вариант ответа. Ты копируешь и отправляешь его сам.\n\n" +
        "*Что сделать сейчас:*\n" +
        "1) Нажми *✍️ Подготовить ответ*\n" +
        "2) Выбери режим (обычный / коротко)\n" +
        "3) Нажми *✍️ Ввести текст* и пришли сообщение\n\n" +
        "Пример:\n" +
        "«Можно созвониться завтра?» →\n" +
        "«Да, давай после 16:00. Напиши, какое время тебе удобно»\n\n" +
        `🆓 Бесплатно: *${DM_FREE_LIMIT}* черновиков/день в личке и *${GROUP_FREE_HINT_LIMIT}* подсказки/день для групп.\n` +
        "🎁 Хочешь все режимы? Можно начать с *пробной подписки за 0 ₽*.\n\n" +
        "👇 Нажми кнопку ниже и попробуй.";
    }

    const options = {
      chat_id: chatId,
      parse_mode: "Markdown",
      reply_markup: homeKeyboard(mode.key, user, showConnectHint),
    };

    if (messageId) {
      return bot.editMessageText(text, { ...options, message_id: messageId });
    }

    return bot.sendMessage(chatId, text, options);
  }

  async function showOnboarding(bot, chatId, step = 1, messageId = null) {
    let text = "";
    let keyboard = null;

    if (step === 1) {
      text =
        "Привет! Я Данька — твой ИИ-секретарь 🤖\n\n" +
        "Я помогаю:\n" +
        "• отвечать за тебя в чатах\n" +
        "• писать в нужном стиле\n" +
        "• экономить время на переписке";
      keyboard = {
        inline_keyboard: [
          [{ text: "🚀 Начать", callback_data: "onb_next_2" }],
          [{ text: "Пропустить", callback_data: "onb_skip" }],
        ],
      };
    }

    if (step === 2) {
      text =
        "Как это работает 👇\n\n" +
        "1️⃣ Ты подключаешь чат\n" +
        "2️⃣ Выбираешь стиль общения\n" +
        "3️⃣ Я помогаю отвечать\n\n" +
        "📌 Важно:\n" +
        "• В *личке* я отвечаю на твои сообщения сразу.\n" +
        "• В *группах* я отвечаю только там, где включён автоответ (через «➕ Подключить чат»).\n\n" +
        "Автоответ можно включать и выключать в любой момент.";
      keyboard = {
        inline_keyboard: [
          [{ text: "⬅ Назад", callback_data: "onb_1" }],
          [{ text: "➡️ Дальше", callback_data: "onb_next_3" }],
        ],
      };
    }

    if (step === 3) {
      text =
        "Первый шаг — подключить чат 💬\n\n" +
        "✅ Добавь меня в нужный чат и напиши там любое сообщение.\n" +
        "После этого открой «➕ Добавить чат» и включи автоответ.\n\n" +
        "🔎 Если чат не появился в списке — нажми «🔄 Обновить».";
      keyboard = {
        inline_keyboard: [
          [{ text: "➕ Добавить чат", callback_data: "connect_chat" }],
          [
            { text: "💳 Подписка", callback_data: "menu_sub" },
            { text: "🏠 Главное меню", callback_data: "onb_done" },
          ],
        ],
      };
    }

    // если есть messageId — редактируем, иначе шлём новое
    if (messageId) {
      return bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    }

    return bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  }

  // ============================
  //     helper: connect chat screen
  // ============================
  async function renderConnectChat(bot, msg, userId) {
    const userTelegramId = String(userId);

    // показываем только группы/супергруппы — личка всегда доступна и не требует «подключения»
    const chats = await prisma.chatLink.findMany({
      where: {
        userTelegramId,
        NOT: { type: "private" },
      },
      take: 50,
    });

    const username = getBotUsername();
    const mention = username ? `@${username}` : "бота";

    let text =
      `➕ *Подключить группу*\n\n` +
      `Выберите группу, для которой бот будет присылать тебе подсказки в личные сообщения.\n\n` +
      `✅ — подсказки *включены* → я слежу за ответами в этой группе\n` +
      `❌ — подсказки *выключены* → я игнорирую эту группу\n\n` +
      `💡 В группах я *не пишу* в чат — подсказки приходят *тебе в личные сообщения*.\n` +
`Триггер: кто-то отвечает *reply на твоё сообщение* (и я включён в этой группе).\n` +
      `Нажмите на чат, чтобы переключить статус.\n\n` +
      `Если группы нет в списке — бот ещё *не видел* сообщений из неё.\n` +
      `Сделайте так: добавьте меня в группу и напишите там любое сообщение (или упомяните ${mention}), затем нажмите «🔄 Обновить».\n\n`;

    if (!chats.length) {
      text +=
        `Список пока пуст.\n\n` +
        `1) Добавь бота в нужную группу\n` +
        `2) Напиши там любое сообщение (можно с упоминанием бота)\n` +
        `3) Вернись сюда и нажми «🔄 Обновить»\n\n`;
    }

    text += `ℹ️ Подсказки приходят только из групп, где они включены.\n`;

    const keyboard = [];

    for (const c of chats) {
      const title = c.title || (c.type === "private" ? "Личный чат" : "Чат");
      const status = c.enabled ? "✅" : "❌";
      const label = c.enabled ? "подсказки включены" : "подсказки выключены";

      keyboard.push([
        {
          text: `${status} ${title} · ${label}`,
          callback_data: `chat_toggle:${c.telegramChatId}`,
        },
      ]);
    }

    keyboard.push([
  { text: "🔄 Обновить", callback_data: "connect_refresh" },
  { text: "❓ Помощь", callback_data: "help_how" },
]);

    keyboard.push([{ text: "⬅ Назад", callback_data: "menu_home" }]);

    const replyMarkup = { inline_keyboard: keyboard };

    try {
      return await bot.editMessageText(text, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
    } catch (e) {
      const desc = e?.response?.body?.description || e?.message || "";

      // Telegram иногда возвращает 400 "message is not modified" если контент/кнопки не изменились
      if (String(desc).includes("message is not modified")) {
        try {
          // на всякий случай пробуем обновить только клавиатуру
          await bot.editMessageReplyMarkup(replyMarkup, {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
          });
        } catch {}

        // ничего менять не нужно — список уже актуален
        return;
      }

      throw e;
    }
  }

  // ============================
  //     helper: рендер логов
  // ============================
  async function renderLogsPage(bot, msg, userId, page = 1) {
    const PAGE_SIZE = 5;

    const total = await prisma.messageLog.count({
      where: { user: { telegramId: String(userId) } },
    });

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page < 1) page = 1;
    if (page > pages) page = pages;

    const logs = await prisma.messageLog.findMany({
      where: { user: { telegramId: String(userId) } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });

    let text = `🧾 <b>Логи — страница ${page}/${pages}:</b>\n\n`;

    if (logs.length === 0) {
      text += "История пуста.";
    } else {
      for (const log of logs) {
        const incoming = (log.incomingText || "").toString();
        const reply = (log.replyText || "").toString();

        text += `👤 <b>Ты:</b> ${fmtCode(incoming)}\n`;
        text += `🤖 <b>Данька:</b> ${fmtCode(reply)}\n\n`;
      }
    }

    const keyboard = [];

    const navRow = [];
    if (page > 1) {
      navRow.push({ text: "⬅ Назад", callback_data: `logs_page_${page - 1}` });
    }
    if (page < pages) {
      navRow.push({ text: "Вперёд ➡", callback_data: `logs_page_${page + 1}` });
    }
    if (navRow.length) keyboard.push(navRow);

    keyboard.push([{ text: "🏠 Главное меню", callback_data: "menu_home" }]);

    try {
      return await bot.editMessageText(text, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (e) {
      // Fallback: если HTML/разметка ломается — показываем безопасную версию без parse_mode
      const plain = text
        .replace(/<\/?b>/g, "")
        .replace(/<\/?code>/g, "")
        .replace(/<\/?i>/g, "")
        .replace(/<\/?u>/g, "")
        .replace(/<[^>]+>/g, "");

      return bot.sendMessage(msg.chat.id, plain, {
        reply_markup: { inline_keyboard: keyboard },
      });
    }
  }

  // ============================
  //           /start
  // ============================
  bot.onText(/\/start/, async (msg) => {
    await userService.register(msg);

    // достаём юзера, чтобы узнать его стиль
    const user = await prisma.user.findUnique({
      where: { telegramId: String(msg.from.id) },
    });

    const mode = getChatMode(msg.chat);

    // ❌ В группах /start — НИЧЕГО не пишем
    if (mode.key === "group") {
      // максимум — тихо регистрируем пользователя
      return;
    }

  // ✅ Если онбординг ещё не проходили — показываем шаг 1 (только в личке)
  if (!user?.onboardingCompleted) {
    return showOnboarding(bot, msg.chat.id, 1);
  }

  // ✅ После /start в личке показываем главное меню (как на скрине)
  // Пользователь сам выбирает: «Подготовить ответ» / «Группы» / «Настройки»
  return renderHomeScreen({
    bot,
    chatId: msg.chat.id,
    userId: msg.from.id,
    chat: msg.chat,
    variant: "home",
  });
});

// ============================
//     /onboarding (reset)
// ============================
bot.onText(/\/(onboarding|reset_onboarding)/, async (msg) => {
  // онбординг имеет смысл показывать только в личке
  if (msg.chat?.type !== "private") {
    return bot.sendMessage(
      msg.chat.id,
      "ℹ️ Онбординг доступен в личных сообщениях с ботом. Откройте личку и выполните /onboarding"
    );
  }

  // помечаем, что онбординг нужно пройти заново
  await prisma.user.update({
    where: { telegramId: String(msg.from.id) },
    data: { onboardingCompleted: false },
  });

  return showOnboarding(bot, msg.chat.id, 1);
});

  // ============================
  //           /status
  // ============================
  bot.onText(/\/status/, async (msg) => {
    const userId = msg.from.id;

    const user = await prisma.user.findUnique({
      where: { telegramId: String(userId) },
    });

    if (!user) {
      return bot.sendMessage(
        msg.chat.id,
        "❌ Ты ещё не зарегистрирован. Нажми /start"
      );
    }

    const totalMessages = await prisma.messageLog.count({
      where: { user: { telegramId: String(userId) } },
    });

    const subText = user.subscriptionTil
      ? `✔️ *Активна до:* ${new Date(
          user.subscriptionTil
        ).toLocaleDateString()}`
      : "❌ *Нет активной подписки*";

    const styleNames = {
      default: "Обычный",
      business: "Деловой",
      cute: "Милый 😊",
      strict: "Строгий",
      humor: "Юмор 😄",
    };

    const style = styleNames[user?.style] || "Обычный";

    const text =
      `📊 *Твой профиль*\n\n` +
      `🆔 *Telegram ID:* \`${user.telegramId}\`\n` +
      `📅 *Создан:* ${new Date(user.createdAt).toLocaleString()}\n\n` +
      `💳 *Подписка:*\n${subText}\n\n` +
      `🎭 *Стиль секретаря:* ${style}\n` +
      `💬 *Всего сообщений с ИИ:* ${totalMessages}`;

    return bot.sendMessage(msg.chat.id, text, {
      parse_mode: "Markdown",
    });
  });

    // ============================
  //           /help
  // ============================
  // ============================
  //   GROUP SILENT ASSIST (STEP 4)
  //   Бот НИЧЕГО не пишет в группе.
  //   Он перехватывает сообщения, адресованные пользователю,
  //   и предлагает подготовить ответ в ЛИЧКЕ.
  // ============================
  bot.on("message", async (msg) => {
    // ГЛОБАЛЬНЫЙ ЗАПРЕТ НА ПИСЬМО В ГРУППЫ
    if (msg.chat?.type === "group" || msg.chat?.type === "supergroup") {
      // ❌ БОТ НИКОГДА НЕ ПИШЕТ В ГРУППЫ
      // логика разрешена, отправка сообщений — нет

      // cache usernames for @username mentions
      cacheUsername(msg.from);
      // also cache the replied user's username (helps resolve @mentions later)
      cacheUsername(msg.reply_to_message?.from);

      // В группе текст может быть в msg.text или msg.caption (если это медиа)
      const incomingText = String(msg.text || msg.caption || "").trim();
      if (!incomingText) return;

      // ВАЖНО:
      // В группе мы должны понять, КОМУ адресовано сообщение.
      // 1) Надёжно: reply на сообщение пользователя
      // 2) Также: упоминание пользователя (@username или text_mention)
      let targetUserId = msg.reply_to_message?.from?.id || null;

      // не реагируем на reply самому боту
      if (msg.reply_to_message?.from?.is_bot) return;

      // если не reply — пробуем найти упомянутого пользователя
      if (!targetUserId) {
        targetUserId = extractMentionedUserId(msg, incomingText);
      }

      // если не нашли получателя — ничего не делаем
      if (!targetUserId) return;

      const qs = getQuickState(targetUserId);

      // Проверяем: включён ли бот в этой группе для target-пользователя
      const enabled = await chatService.isChatEnabled(msg.chat.id, targetUserId);

      // Если не включено — один раз (с кулдауном) подскажем в личке, что нужно включить
      // и не будем ничего писать в группу.
      if (!enabled) {
        try {
          // throttle: не чаще 1 раза в 12 часов на пользователя+группу
          if (!bot.__groupEnableHints) bot.__groupEnableHints = new Map();
          const key = `${targetUserId}:${msg.chat.id}`;
          const prevTs = bot.__groupEnableHints.get(key) || 0;
          const now = Date.now();
          if (now - prevTs > 12 * 60 * 60 * 1000) {
            bot.__groupEnableHints.set(key, now);
            const groupTitle = msg.chat.title || msg.chat.username || "эта группа";
            await sendToUserOnly(
              bot,
              targetUserId,
              `⚠️ Я вижу, что тебе отвечают в группе «${escapeHtml(groupTitle)}», но подсказки там *выключены* для тебя.\n\nОткрой «👥 Группы» и включи эту группу — тогда я буду присылать подсказки в личку.`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "👥 Открыть группы", callback_data: "connect_chat" }],
                    [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
                  ],
                },
              }
            );
          }
        } catch {}
        return;
      }

      // Не триггерим на сообщения самого target (он и так знает, что он написал)
      if (msg.from?.id === targetUserId) return;

      // Не спамим повторно одним и тем же сообщением
      if (qs.lastIncomingText === incomingText && qs.lastGroupChatId === String(msg.chat.id)) return;

      // Пытаемся дать ссылку на сообщение (работает для супергрупп/каналов с публичной историей)
      let msgLink = "";
      try {
        // Для супергрупп ссылка формата t.me/c/<internal_id>/<message_id>
        // internal_id = abs(chat.id) без префикса -100
        const chatIdNum = Number(msg.chat.id);
        if (!Number.isNaN(chatIdNum) && String(chatIdNum).startsWith("-100")) {
          const internalId = String(chatIdNum).replace("-100", "");
          msgLink = `\n\n🔗 <a href=\"https://t.me/c/${internalId}/${msg.message_id}\">Открыть сообщение</a>`;
        }
      } catch {}

      const groupTitle = msg.chat.title || msg.chat.username || "Группа";
      const fromName =
        [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
        msg.from?.username ||
        "Участник";

      const header =
        "💬 <b>В группе ответили тебе</b>\n\n" +
        `👥 <b>${escapeHtml(groupTitle)}</b>\n` +
        `👤 От: <b>${escapeHtml(fromName)}</b>\n\n`;

      const body = `Сообщение:\n${fmtCode(incomingText)}`;

      const footer =
        "\n\nХочешь подготовить ответ?" +
        msgLink;

      const helper =
        "\n\n<i>Выбери действие ниже:\n" +
        "• «Сделать ответ» — получишь готовый текст\n" +
        "• «Игнорировать» — больше не буду напоминать</i>";

      // Отправляем ТОЛЬКО в личку targetUserId
      await sendToUserOnly(bot, targetUserId, header + body + footer + helper, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚡ Сделать ответ", callback_data: "quick_use_last" }],
            [{ text: "➕ Добавить детали", callback_data: "quick_add_details" }],
            [{ text: "✍️ Другой текст", callback_data: "quick_reply_start" }],
            [{ text: "❌ Игнорировать", callback_data: "ignore_group_msg" }],
          ],
        },
      });

      // сохраняем последнее входящее (для анти-спама)
      setQuickState(targetUserId, {
        lastIncomingText: incomingText,
        awaiting: false,
        lastSource: "group",
        lastGroupChatId: String(msg.chat.id),
      });
      return;
    }
    // Если не группа — остальная логика (если нужна)
  });
  bot.onText(/\/help/, async (msg) => {
  const text =
    "🆘 *Помощь*\n\n" +
    "Доступные команды:\n" +
    "• /start — главное меню\n" +
    "• /status — твой статус и подписка\n" +
    "• /profile — профиль (то же, что /status)\n" +
    "• /help — эта справка\n" +
    "• /onboarding — пройти онбординг заново\n\n" +
    "Основное управление — через кнопки в меню.";

  return bot.sendMessage(msg.chat.id, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Секретарские команды", callback_data: "help_secretary" }],
      ],
    },
  });
});

    // ============================
  //           /profile
  //    (то же, что /status)
  // ============================
  bot.onText(/\/profile/, async (msg) => {
    const userId = msg.from.id;

    const user = await prisma.user.findUnique({
      where: { telegramId: String(userId) },
    });

    if (!user) {
      return bot.sendMessage(
        msg.chat.id,
        "❌ Ты ещё не зарегистрирован. Нажми /start"
      );
    }

    const totalMessages = await prisma.messageLog.count({
      where: { user: { telegramId: String(userId) } },
    });

    const subText = user.subscriptionTil
      ? `✔️ *Активна до:* ${new Date(
          user.subscriptionTil
        ).toLocaleDateString()}`
      : "❌ *Нет активной подписки*";

    const styleNames = {
      default: "Обычный",
      business: "Деловой",
      cute: "Милый 😊",
      strict: "Строгий",
      humor: "Юмор 😄",
    };

    const style = styleNames[user.style] || "Обычный";

    const text =
      `📊 *Твой профиль*\n\n` +
      `🆔 *Telegram ID:* \`${user.telegramId}\`\n` +
      `📅 *Создан:* ${new Date(user.createdAt).toLocaleString()}\n\n` +
      `💳 *Подписка:*\n${subText}\n\n` +
      `🎭 *Стиль секретаря:* ${style}\n` +
      `💬 *Всего сообщений с ИИ:* ${totalMessages}`;

    return bot.sendMessage(msg.chat.id, text, {
      parse_mode: "Markdown",
    });
  });

  // ============================
  //           /admin
  // ============================
  bot.onText(/\/admin/, async (msg) => {
    if (msg.from.id !== ADMIN_ID) {
      return bot.sendMessage(msg.chat.id, "❌ У вас нет доступа.");
    }

    return bot.sendMessage(
      msg.chat.id,
      "🛠 *Админ-панель*\nВыберите действие:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📊 Общая статистика", callback_data: "admin_stats" }],
            [{ text: "👥 Все пользователи", callback_data: "admin_users" }],
            [{ text: "🔥 Топ активных", callback_data: "admin_top" }],
            [{ text: "💳 Подписки", callback_data: "admin_subs" }],
            [{ text: "💰 Выручка", callback_data: "admin_money" }],
            [{ text: "⛔ Бан / Разбан", callback_data: "admin_ban_menu" }],
            [{ text: "🔍 Найти пользователя", callback_data: "admin_find_user" }],
          ],
        },
      }
    );
  });

  // ============================
  //       ЕДИНЫЙ CALLBACK_QUERY
  // ============================
  bot.on("callback_query", async (query) => {
    //if (await dmDrafts.handleCallback({ bot, query })) return;
    const msg = query.message;
    let data = query.data;
    const userId = query.from.id;
    console.log("CALLBACK DATA:", data);
    const safeAnswer = async (opts) => {
      try {
        await bot.answerCallbackQuery(query.id, opts);
      } catch (e) {
        // Telegram returns 400 when query is too old; ignore to avoid crashing
        const desc = e?.response?.body?.description || e?.message || "";
        if (!String(desc).includes("query is too old") && !String(desc).includes("QUERY_ID_INVALID")) {
          throw e;
        }
      }
    };

      // ❌ Игнорировать подсказку из группы (уведомление в личке)
      if (data === "ignore_group_msg") {
        await bot.answerCallbackQuery(query.id, { text: "Ок" });
        try {
          return bot.editMessageText(
            "✅ Ок, игнорирую.\n\nЕсли захочешь — нажми «✍️ Подготовить ответ» в главном меню.",
            {
              chat_id: msg.chat.id,
              message_id: msg.message_id,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu_home" }]] },
            }
          );
        } catch {
          return;
        }
      }

    try {
      // --- защита админки ---
      if (data.startsWith("admin_") && userId !== ADMIN_ID) {
        await bot.answerCallbackQuery(query.id, {
          text: "Нет доступа",
          show_alert: true,
        });
        return;
      }

      if (data === "quick_add_details") {
  // работает только в личке
  if (msg.chat?.type !== "private") {
    await safeAnswer({ text: "Открой личку с ботом", show_alert: true });
    return;
  }

  const s = getQuickState(userId);
  if (!s.lastIncomingText) {
    await safeAnswer();
    return bot.sendMessage(
      msg.chat.id,
      "❗️Не нашёл исходный текст. Нажми «✍️ Ввести текст» и пришли сообщение, на которое нужно ответить.",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✍️ Ввести текст", callback_data: "quick_input" }],
            [{ text: "⬅ Назад", callback_data: "quick_reply_start" }],
          ],
        },
      }
    );
  }

  cancelPendingQuickDraft(userId);
  setQuickState(userId, { awaiting: true, appendToLast: true });

  await safeAnswer();

  return bot.sendMessage(
    msg.chat.id,
    "➕ <b>Добавь детали</b>\n\n" +
      "Напиши одним сообщением уточнение, которое нужно учесть в ответе.\n" +
      "Например: сроки, формат, бюджет, что важно подчеркнуть, какой тон.\n\n" +
      "Я добавлю это к исходному сообщению и подготовлю ответ.",
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

      // ============================
      //   QUICK FLOW: "Подготовить ответ"
      // ============================
      if (data === "quick_input") {
        // работает только в личке
        if (msg.chat?.type !== "private") {
          await bot.answerCallbackQuery(query.id, {
            text: "Эта функция доступна в личных сообщениях",
            show_alert: true,
          });
          return;
        }

        // сбрасываем возможные предыдущие таймеры
        cancelPendingQuickDraft(userId);

        // переводим пользователя в режим ожидания текста
        setQuickState(userId, { awaiting: true, lastSource: "manual", lastGroupChatId: null });

        // закрываем «часики» у кнопки
        await safeAnswer();

        // отправляем ОТДЕЛЬНЫЙ экран-инструкцию (не редактируем старое меню)
        return bot.sendMessage(
          msg.chat.id,
          "✍️ <b>Ввести текст</b>\n\n" +
            "Пришли сюда <b>одно сообщение</b> — текст, на который ты хочешь ответить.\n\n" +
            "Это может быть:\n" +
            "• сообщение из личного чата\n" +
            "• сообщение из рабочей группы\n" +
            "• любой текст, на который нужно ответить\n\n" +
            "Я подожду выбранную задержку\n" +
            "и пришлю <b>готовый вариант ответа</b>.\n\n" +
            "⚠️ <i>Я ничего никуда не отправляю сам —\n" +
            "ты просто копируешь текст и отправляешь его.</i>",
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

      // ⚡ Быстрый ответ на последнее сообщение (обычно пришло из группы)
if (data === "quick_use_last") {
  // работает только в личке
  if (msg.chat?.type !== "private") {
    await bot.answerCallbackQuery(query.id, {
      text: "Эта функция доступна в личных сообщениях",
      show_alert: true,
    });
    return;
  }

  await safeAnswer();

  const s = getQuickState(userId);
  if (!s.lastIncomingText) {
    return bot.sendMessage(
      msg.chat.id,
      "❗️Не нашёл текста для ответа.\n\nНажми «✍️ Ввести текст» и пришли сообщение, на которое нужно ответить.",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✍️ Ввести текст", callback_data: "quick_input" }],
            [{ text: "⬅ Назад", callback_data: "quick_reply_start" }],
          ],
        },
      }
    );
  }

  const u = await prisma.user.findUnique({ where: { telegramId: String(userId) } });
  const isSub = hasActiveSub(u);

  // Лимит бесплатных подсказок для групп
  if (!isSub && s.lastSource === "group") {
    const gs = getGroupHintState(userId);
    if (Number(gs.used || 0) >= GROUP_FREE_HINT_LIMIT) {
      return bot.sendMessage(
        msg.chat.id,
        "🧾 *Лимит подсказок для групп исчерпан*\n\n" +
          `Сегодня бесплатно доступно: *${GROUP_FREE_HINT_LIMIT}* подсказки.\n` +
          "Подключи подписку — будет больше режимов и без лимита.",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🎁 Пробная 0 ₽", callback_data: "buy_trial" }],
              [{ text: "💳 Оформить подписку", callback_data: "menu_sub" }],
              [{ text: "✨ Что даёт подписка", callback_data: "sub_benefits" }],
            ],
          },
        }
      );
    }

    // Засчитываем использование подсказки только когда реально генерируем ответ
    incGroupHintUsed(userId);
  }

  return sendQuickDraft({
    bot,
    chatId: msg.chat.id,
    userId,
    incomingText: s.lastIncomingText,
  });
}

// ⚙️ Настройки (в личке)
if (data === "menu_settings") {
  await bot.answerCallbackQuery(query.id);

  // Настройки показываем только в личке
  if (msg.chat?.type !== "private") {
    return bot.sendMessage(
      msg.chat.id,
      "⚙️ Настройки доступны в личных сообщениях. Открой личку с ботом и нажми «⚙️ Настройки»."
    );
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: String(userId) },
  });

  const isSub = hasActiveSub(user);
  const currentStyle = getStyleLabel(user?.style, isSub);
  const sub = formatSubStatus(user);

  const text =
    "⚙️ *Настройки*\n\n" +
    "Здесь ты управляешь ботом: подпиской, подсказками для групп и справкой.\n\n" +
    `💳 *Подписка:* ${sub}\n` +
    `🎨 *Стиль:* ${currentStyle}`;

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Подписка", callback_data: "menu_sub" }],
        [{ text: "👥 Группы (подсказки)", callback_data: "connect_chat" }],
        [{ text: "❓ Помощь", callback_data: "help_how" }],
        [{ text: "🔄 Пройти онбординг заново", callback_data: "onboarding_restart" }],
        [{ text: "⬅ Назад", callback_data: "menu_home" }],
      ],
    },
  });
}

      if (data === "quick_reply_start") {
        await safeAnswer();

        // работает только в личке
        if (msg.chat?.type !== "private") {
          await bot.answerCallbackQuery(query.id, {
            text: "Эта функция доступна в личных сообщениях",
            show_alert: true,
          });
          return;
        }

        const user = await prisma.user.findUnique({
          where: { telegramId: String(userId) },
        });
        const isSub = hasActiveSub(user);

        cancelPendingQuickDraft(userId);
        setQuickState(userId, { awaiting: true, lastSource: "manual", lastGroupChatId: null });

        try {
          const text =
            "✍️ *Подготовить ответ*\n\n" +
            "Пришли сюда *одно сообщение* — текст, на который ты хочешь ответить.\n" +
            "Я предложу готовый вариант, а ты его скопируешь и отправишь сам.\n\n" +
            "Как это работает:\n" +
            "1️⃣ Ты вставляешь сообщение собеседника\n" +
            "2️⃣ Я предлагаю готовый текст ответа\n" +
            "3️⃣ Ты копируешь и отправляешь его\n\n" +
            "⏱ *Задержка* — это пауза перед ответом.\n" +
            "Она делает переписку более естественной, будто отвечаешь ты сам, а не бот.\n\n" +
            "👇 Отправь сообщение в чат прямо сейчас.\n" +
            "Если ты пришёл из группы — нажми *⚡ Ответить на последнее сообщение*.";

          return await bot.editMessageText(text, {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: quickReplyKeyboard(userId, isSub),
          });
        } catch (e) {
          const desc = e?.response?.body?.description || e?.message || "";
          if (String(desc).includes("message is not modified")) {
            // если текст тот же — просто обновим клавиатуру
            try {
              await bot.editMessageReplyMarkup(quickReplyKeyboard(userId, isSub), {
                chat_id: msg.chat.id,
                message_id: msg.message_id,
              });
            } catch {}
            return;
          }
          throw e;
        }
      }

      if (data === "quick_delay_10" || data === "quick_delay_20") {
        const delaySec = data === "quick_delay_10" ? 10 : 20;
        const s = getQuickState(userId);

        setQuickState(userId, { delaySec });

        // покажем понятный тост и обновим только клавиатуру
        await bot.answerCallbackQuery(query.id, { text: `⏱ Задержка: ${delaySec} сек` });

        const user = await prisma.user.findUnique({
          where: { telegramId: String(userId) },
        });
        const isSub = hasActiveSub(user);

        try {
          return await bot.editMessageReplyMarkup(
            quickReplyKeyboard(userId, isSub),
            {
              chat_id: msg.chat.id,
              message_id: msg.message_id,
            }
          );
        } catch {
          return;
        }
      }

      if (data.startsWith("quick_style_")) {
        await bot.answerCallbackQuery(query.id);

        const style = data.replace("quick_style_", "");
        const allowed = ["default", "business", "cute", "strict", "humor"];
        if (!allowed.includes(style)) return;

        // сохраняем стиль ТОЛЬКО для quick-flow
        setQuickState(userId, { quickStyle: style });

        const user = await prisma.user.findUnique({
          where: { telegramId: String(userId) },
        });
        const isSub = hasActiveSub(user);
        await bot.answerCallbackQuery(query.id, { text: `🎨 Стиль: ${getStyleLabel(style, isSub)}` });

        try {
          return await bot.editMessageReplyMarkup(
            quickReplyKeyboard(userId, isSub),
            {
              chat_id: msg.chat.id,
              message_id: msg.message_id,
            }
          );
        } catch {
          return;
        }
      }

      if (data.startsWith("quick_mode_")) {
        await bot.answerCallbackQuery(query.id);

        const mode = data.replace("quick_mode_", "");
        const allowed = ["normal", "polite", "tothepoint", "short", "refuse", "soften", "busy"];
        if (!allowed.includes(mode)) return;

        const user = await prisma.user.findUnique({
          where: { telegramId: String(userId) },
        });
        const isSub = hasActiveSub(user);

        // paywall: всё кроме short/normal — по подписке
        if (!isSub && mode !== "short" && mode !== "normal") {
          return bot.editMessageText(
            "🔒 *Режимы ответа доступны по подписке*\n\n" +
              "С подпиской ты сможешь:\n" +
              "• ⚡ отвечать по делу\n" +
              "• 🤝 формулировать вежливо\n" +
              "• 🙅 делать корректный отказ\n" +
              "• 🧊 смягчать формулировки\n" +
              "• ⏳ ставить автоответ «занят»\n\n" +
              "Оформи подписку и продолжай 👇",
            {
              chat_id: msg.chat.id,
              message_id: msg.message_id,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "💳 Оформить подписку", callback_data: "menu_sub" }],
                  [{ text: "⬅ Назад", callback_data: "quick_reply_start" }],
                ],
              },
            }
          );
        }

        setQuickState(userId, { quickMode: mode });
        await bot.answerCallbackQuery(query.id, { text: "✅ Режим обновлён" });

        try {
          return await bot.editMessageReplyMarkup(quickReplyKeyboard(userId, isSub), {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
          });
        } catch {
          return;
        }
      }


      // --- QUICK COPY handler (moved here, see regen handler below) ---
      if (data === "quick_copy") {
        await bot.answerCallbackQuery(query.id);

        const s = getQuickState(userId);
        if (!s.lastDraft) {
          return bot.answerCallbackQuery(query.id, {
            text: "Черновика ещё нет. Нажми «Подготовить ответ» и пришли текст.",
            show_alert: true,
          });
        }

        // Получаем подписку пользователя для inline_keyboard
        const u = await prisma.user.findUnique({ where: { telegramId: String(userId) } });
        const isSub = hasActiveSub(u);

        // Telegram не даёт «скопировать» программно — просто отправляем текст ещё раз,
        // чтобы его удобно было выделить и скопировать.
        return bot.sendMessage(
          msg.chat.id,
          "📋 <b>Текст для копирования:</b>\n\n" + fmtCode(s.lastDraft),
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  ...(isSub
                    ? [{ text: "🔄 Ещё вариант", callback_data: "quick_reply_regen" }]
                    : [{ text: "🔒 Ещё варианты", callback_data: "menu_sub" }]),
                  { text: "✍️ Подготовить ещё", callback_data: "quick_reply_start" },
                ],
                [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
              ],
            },
          }
        );
      }

      if (data === "quick_reply_regen") {
        await bot.answerCallbackQuery(query.id);

        const user = await prisma.user.findUnique({
          where: { telegramId: String(userId) },
        });

        // 🔒 Paywall: ещё варианты только по подписке
        if (!hasActiveSub(user)) {
          return bot.editMessageText(
            "🔒 *Ещё варианты доступны по подписке*\n\n" +
              "С подпиской ты сможешь:\n" +
              "• 🔄 получать неограниченное число вариантов\n" +
              "• 🎨 выбирать стиль ответа\n" +
              "• ♾️ пользоваться без лимитов\n\n" +
              "Оформи подписку и продолжай 👇",
            {
              chat_id: msg.chat.id,
              message_id: msg.message_id,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "💳 Оформить подписку", callback_data: "menu_sub" }],
                  [{ text: "⬅ Назад", callback_data: "menu_home" }],
                ],
              },
            }
          );
        }

        const s = getQuickState(userId);
        if (!s.lastIncomingText) {
          return bot.answerCallbackQuery(query.id, {
            text: "Сначала нажми «Ввести текст» и пришли сообщение.",
            show_alert: true,
          });
        }

        return sendQuickDraft({
          bot,
          chatId: msg.chat.id,
          userId,
          incomingText: s.lastIncomingText,
        });
      }

      // ============================
      //   DM AUTO MENU (черновики)
      // ============================
      if (data === "dm_auto_menu") {
        await bot.answerCallbackQuery(query.id);
        return renderDmAutoScreen(bot, msg, userId);
      }

      if (data === "dm_auto_toggle") {
        const state = getDmState(userId);
        const next = setDmState(userId, { enabled: !state.enabled });
        if (!next.enabled) {
          cancelPendingDmDraft(userId);
        }
        await bot.answerCallbackQuery(query.id, {
          text: next.enabled ? "🔔 Автоответчик включён" : "🔕 Автоответчик выключен",
        });
        return renderDmAutoScreen(bot, msg, userId);
      }

      if (data === "dm_auto_delay_10" || data === "dm_auto_delay_20") {
        const delaySec = data === "dm_auto_delay_10" ? 10 : 20;
        const state = getDmState(userId);

        // Если значение уже такое же — просто уведомляем
        if (Number(state.delaySec) === delaySec) {
          await bot.answerCallbackQuery(query.id, { text: "Уже стоит ✅" });
          return;
        }

        setDmState(userId, { delaySec });

        await bot.answerCallbackQuery(query.id, {
          text: `⏱ Задержка: ${delaySec} сек`,
        });

        return renderDmAutoScreen(bot, msg, userId);
      }

      // ===== GROUP MODE (для сообщений "Режим группы") =====
      if (data === "group_mode_off") {
        await bot.answerCallbackQuery(query.id, { text: "Ок, отключаю в этом чате" });

        // ✅ сохраняем в chatLink (источник правды)
        await prisma.chatLink.upsert({
          where: {
            telegramChatId_userTelegramId: {
              telegramChatId: String(msg.chat.id),
              userTelegramId: String(userId),
            },
          },
          update: {
            enabled: false,
            title: msg.chat.title || msg.chat.username || msg.chat.first_name || null,
            type: msg.chat.type,
          },
          create: {
            telegramChatId: String(msg.chat.id),
            userTelegramId: String(userId),
            title: msg.chat.title || msg.chat.username || msg.chat.first_name || null,
            type: msg.chat.type,
            enabled: false,
          },
        });

        // выключаем автоответ в этом чате (на случай, если chatService используется где-то ещё)
        try {
          await chatService.disableChat(msg.chat.id, userId);
        } catch {}

        // ❌ НИЧЕГО не пишем в группу
        // ✅ Уведомляем пользователя в ЛС
        await bot.sendMessage(
          userId,
          "🔕 Я отключён в этой группе.\n\n" +
          "Я больше не буду присылать подсказки из неё."
        );
        return;
      }

      if (data === "group_mode_on") {
        await bot.answerCallbackQuery(query.id, { text: "Ок, включаю в этом чате" });

        // ✅ сохраняем в chatLink (источник правды)
        await prisma.chatLink.upsert({
          where: {
            telegramChatId_userTelegramId: {
              telegramChatId: String(msg.chat.id),
              userTelegramId: String(userId),
            },
          },
          update: {
            enabled: true,
            title: msg.chat.title || msg.chat.username || msg.chat.first_name || null,
            type: msg.chat.type,
          },
          create: {
            telegramChatId: String(msg.chat.id),
            userTelegramId: String(userId),
            title: msg.chat.title || msg.chat.username || msg.chat.first_name || null,
            type: msg.chat.type,
            enabled: true,
          },
        });

        // включаем автоответ в этом чате (на случай, если chatService используется где-то ещё)
        try {
          await chatService.enableChat(msg.chat.id, userId);
        } catch {}

        // ❌ НИЧЕГО не пишем в группу
        // ✅ Уведомляем пользователя в ЛС
        await bot.sendMessage(
          userId,
          "✅ Я включился в этой группе.\n\n" +
          "Теперь я буду присылать тебе подсказки в личные сообщения, " +
          "когда в этой группе кто-то ответит тебе reply."
        );
        return;
      }

      // ====== GROUP SETTINGS SCREEN ======
      if (data === "group_settings") {
        await bot.answerCallbackQuery(query.id);

        const enabled = await chatService.isChatEnabled(msg.chat.id, userId);

        const username = getBotUsername();
        const mention = username ? `@${username}` : "бот";
        const dmUrl = username ? `https://t.me/${username}` : null;

        // ❌ НЕ отправляем в группу, только в личку
        await bot.sendMessage(
          userId,
          [
            "👥 Я обнаружил группу.\n",
            "Я не пишу в группы.\n",
            "Все подсказки будут приходить тебе в личные сообщения.",
            "",
            `Статус: ${enabled ? "✅ включены" : "🚫 выключены"}`,
            enabled ? "✅ Я буду присылать тебе подсказки в личку" : "❌ Я не присылаю подсказки из этой группы",
            "",
            "Триггер:",
            "• кто-то отвечает reply на твоё сообщение (и я включён в этой группе)",
            "",
            "Чек-лист настройки:",
            "1) Добавь меня в группу",
            "2) Включи подсказки для этой группы (кнопка ниже)",
            "3) Напиши сообщение в группе — когда тебе ответят reply, я пришлю подсказку в личку",
            "",
            "ℹ️ Я *не пишу* в группу, чтобы не засорять чат. Подсказки приходят только тебе в личные сообщения.",
          ].join("\n")
        );
        return;
      }
  // ============================
  //        ЖЁСТКАЯ ЗАЩИТА: запрет любых сообщений в группы
  // ============================
  function safeSend(bot, chatId, userId, text, opts = {}) {
    // если это группа — шлём ТОЛЬКО в личку
    if (String(chatId).startsWith("-")) {
      return bot.sendMessage(userId, text, opts);
    }
    return bot.sendMessage(chatId, text, opts);
  }
      // ℹ️ Правила ответа в группе
      if (data === "group_rules") {
        await bot.answerCallbackQuery(query.id);

        const username = getBotUsername();
        const mention = username ? `@${username}` : "бот";

        const text =
  "👥 *Как приходят подсказки в группе*\n\n" +
  "Подсказка приходит *в личку*, когда:\n" +
  "• тебе ответили *reply на твоё сообщение*\n" +
  "• и я *включён* в этой группе\n\n" +
  "Я *не пишу* в группу сам — так чат остаётся чистым.";

        return bot.editMessageText(text, {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "👥 Настройки группы", callback_data: "group_settings" }],
              [{ text: "➕ Подключить группу", callback_data: "connect_chat" }],
              [{ text: "⬅ Назад", callback_data: "group_settings" }],
            ],
          },
        });
      }

      // 💡 Как получать подсказки (в группе)
      if (data === "group_hint_help") {
        await bot.answerCallbackQuery(query.id);

        const username = getBotUsername();
        const mention = username ? `@${username}` : "бот";

        const text =
  "💡 *Как получить подсказку ответа*\n\n" +
  "1) Напиши сообщение в группе\n" +
  "2) Дождись, когда тебе ответят *reply*\n" +
  "3) Я пришлю подсказку *в личные сообщения*\n\n" +
  "В личке ты увидишь кнопки: «Сделать ответ», «Другой текст», «Скопировать».\n\n" +
  `🧾 Бесплатно доступно: *${GROUP_FREE_HINT_LIMIT}* подсказки в день.\n` +
  "Остальные режимы и безлимит — по подписке.";

        return bot.editMessageText(text, {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "👥 Настройки группы", callback_data: "group_settings" }],
              [{ text: "⬅ Назад", callback_data: "group_settings" }],
            ],
          },
        });
      }
      // ✅ ПРОВЕРКА ОПЛАТЫ (кнопка "Я оплатил")
if (typeof data === "string" && data.startsWith("pay_check:")) {
  const paymentId = data.replace("pay_check:", "").trim();

  await bot.answerCallbackQuery(query.id, {
    text: "🔄 Проверяю оплату...",
  });

  try {
    const result = await paymentService.applyPaidPayment({ paymentId });

    // ❌ ещё не оплачено — ОБНОВЛЯЕМ это же сообщение, чтобы пользователь точно увидел
    if (!result.applied) {
      await bot.editMessageText(
        `⏳ *Оплата ещё не завершена*\n` +
          `Статус: \`${result.status || "pending"}\`\n\n` +
          `Если вы только что оплатили — подождите 10–30 секунд и нажмите «Проверить ещё раз».`,
        {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Проверить ещё раз", callback_data: `pay_check:${paymentId}` }],
              [{ text: "⬅ Назад", callback_data: "menu_sub" }],
            ],
          },
        }
      );

      // закрываем «часики» на кнопке
      return bot.answerCallbackQuery(query.id);
    }

    // ✅ успешно — обновляем ЭТО ЖЕ сообщение
    return bot.editMessageText(
      `✅ *Оплата прошла!*\n\n` +
        `Подписка активна до: *${new Date(result.subscriptionTil).toLocaleDateString()}*`,
      {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ К подписке", callback_data: "menu_sub" }],
            [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
          ],
        },
      }
    );
  } catch (e) {
    console.error("pay_check error:", e);
    return bot.sendMessage(
      msg.chat.id,
      "❌ Ошибка проверки оплаты. Попробуйте позже."
    );
  }
}

// Перезапуск онбординга из главного меню
if (data === "onboarding_restart") {
  // работает только в личке
  if (msg.chat?.type !== "private") {
    await bot.answerCallbackQuery(query.id, {
      text: "Онбординг доступен в личных сообщениях",
      show_alert: true,
    });
    return;
  }

  await prisma.user.update({
    where: { telegramId: String(userId) },
    data: { onboardingCompleted: false },
  });

  await bot.answerCallbackQuery(query.id);
  return showOnboarding(bot, msg.chat.id, 1, msg.message_id);
}

// ===== ONBOARDING =====
if (data === "onb_1") {
  await bot.answerCallbackQuery(query.id);
  return showOnboarding(bot, msg.chat.id, 1, msg.message_id);
}

if (data === "onb_next_2") {
  await bot.answerCallbackQuery(query.id);
  return showOnboarding(bot, msg.chat.id, 2, msg.message_id);
}

if (data === "onb_next_3") {
  await bot.answerCallbackQuery(query.id);
  return showOnboarding(bot, msg.chat.id, 3, msg.message_id);
}

if (data === "onb_skip" || data === "onb_done") {
  await prisma.user.update({
    where: { telegramId: String(userId) },
    data: { onboardingCompleted: true },
  });

  await bot.answerCallbackQuery(query.id);

  // После онбординга показываем понятный чеклист «что дальше»
  return renderHomeScreen({
  bot,
  chatId: msg.chat.id,
  messageId: msg.message_id,
  userId,
  chat: msg.chat,
  variant: "home",
});
}

// ℹ️ Режимы: чем отличается личка от групп
if (data === "mode_info") {
  await bot.answerCallbackQuery(query.id);

  const username = (process.env.BOT_USERNAME || "").trim();
  const mention = username ? `@${username}` : "бот";

  const text =
    "ℹ️ *Как я работаю в разных местах*\n\n" +
    "*В личных сообщениях:*\n" +
    "• Ты пишешь — я отвечаю сразу.\n" +
    "• Здесь удобнее настраивать стиль и подписку.\n\n" +
    "*В группах:*\n" +
    "• Я отвечаю только в тех чатах, где ты включил автоответ через «➕ Подключить чат».\n" +
    "• Если в группе много людей — лучше включать автоответ точечно, чтобы я не мешал.\n\n" +
    `Подсказка: если хочешь, чтобы люди понимали, что я — помощник, просто упоминай меня как ${mention}.`;

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Подключить чат", callback_data: "connect_chat" }],
        [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
      ],
    },
  });
}

// ℹ️ Как это работает — короткая справка
if (data === "how_it_works") {
  await bot.answerCallbackQuery(query.id);

  const username = (process.env.BOT_USERNAME || "").trim();
  const mention = username ? `@${username}` : "бот";
    const text =
    "ℹ️ *Как это работает*\n\n" +
    "*В личке:*\n" +
    "• ты присылаешь текст — я готовлю вариант ответа\n" +
    "• ты копируешь и отправляешь сам (я ничего не отправляю вместо тебя)\n" +
    "• здесь удобно выбрать стиль и задержку ответа\n\n" +
    "*В группах:*\n" +
    "• я *не пишу* в группу, чтобы не засорять чат\n" +
    "• я слежу за сообщениями и присылаю подсказку *тебе в личные сообщения*\n" +
    "• триггер: кто-то ответил *reply на твоё сообщение* (и я включён в этой группе)\n\n" +
    "*Как включить в группе:*\n" +
    "1) добавь меня в группу\n" +
    "2) если у тебя есть подписка — я включусь сам автоматически\n" +
    "3) без подписки — включение через ` ➕ Подключить группу` в личке\n\n" +
    `Подсказка: для подсказки достаточно reply на твоё сообщение.`;

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Подключить группу", callback_data: "connect_chat" }],
        [{ text: "💳 Подписка", callback_data: "menu_sub" }],
        [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
      ],
    },
  });
}

// ℹ️ Помощь: как это работает + почему бот не отвечает
if (data === "help_how") {
  await bot.answerCallbackQuery(query.id);

  const username = (process.env.BOT_USERNAME || "").trim();
  const mention = username ? `@${username}` : "бот";
  const text =
  "ℹ️ *Помощь*\n\n" +
  "*Как я работаю:*\n" +
  "• В *личных сообщениях* ты вставляешь текст — я готовлю вариант ответа\n" +
  "• Ты копируешь и отправляешь сам (я ничего не отправляю вместо тебя)\n\n" +
  "*В группах:*\n" +
  "• Я *не пишу* сообщения в группу — подсказки приходят *тебе в личные сообщения*\n" +
  "• Триггер: кто-то ответил *reply на твоё сообщение* (и я включён в этой группе)" +
  "1) ✅ *Я выключен в этой группе*\n" +
  "• Открой `➕ Добавить чат` и включи ✅ напротив нужной группы\n\n" +
  "2) 📋 *Группы нет в списке*\n" +
  `• • Добавь меня в группу и напиши там любое сообщение` +
  "• Потом нажми \🔄 Обновить``" +
  "3) 🧩 *Пока никто не ответил тебе reply*\n" +
  "• Я не спамлю и пишу только когда реально нужно\n\n" +
  "*Совет:*\n" +
  "• Для быстрых ответов используй `✍️ Подготовить ответ` в чате с ботом.";

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Подключить группу", callback_data: "connect_chat" }],
        [{ text: "👥 Настройки группы", callback_data: "group_settings" }],
        [{ text: "✍️ Подготовить ответ", callback_data: "quick_reply_start" }],
        [{ text: "⬅ Назад", callback_data: "menu_home" }],
      ],
    },
  });
}

// ✨ Преимущества подписки
if (data === "sub_benefits") {
  await bot.answerCallbackQuery(query.id);

  const user = await prisma.user.findUnique({
    where: { telegramId: String(userId) },
  });

  const isActive = hasActiveSub(user);

  const text =
    "✨ *Преимущества подписки*\n\n" +
    "*Бесплатно:*\n" +
    "• подготовка ответов в личке (кнопка «Подготовить ответ»)\n" +
    "• черновики ответов в личных сообщениях: *" + DM_FREE_LIMIT + "* в день\n" +
    "• подсказки для групп: *" + GROUP_FREE_HINT_LIMIT + "* в день (приходят в личные сообщения)\n\n" +
    "*С подпиской:*\n" +
    "• автоответчик-черновики в личных сообщениях: *без лимита*\n" +
    "• выбор стиля общения (деловой / строгий / милый / юмор) + дополнительные режимы ответа\n" +
    "• история диалогов (логи)\n\n" +
    (isActive
      ? "✅ *Подписка уже активна.*\n"
      : "Нажми «Оформить подписку», чтобы выбрать тариф.");

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Оформить подписку", callback_data: "menu_sub" }],
        [{ text: "❓ Помощь", callback_data: "help_how" }],
        [{ text: "➕ Добавить чат", callback_data: "connect_chat" }],
        [{ text: "⬅ Назад", callback_data: "menu_sub" }],
      ],
    },
  });
}


// Подключить чат — список чатов пользователя + переключатель автоответа
if (data === "connect_chat" || data === "connect_refresh") {
  await bot.answerCallbackQuery(query.id);
  return renderConnectChat(bot, msg, userId);
}

// ❓ Почему бот не отвечает? — мини-справка по подключению чатов
if (data === "connect_help") {
  await bot.answerCallbackQuery(query.id);

  const username = (process.env.BOT_USERNAME || "").trim();
  const mention = username ? `@${username}` : "бот";

    const text =
    "❓ *Почему я могу не прислать подсказку*\n\n" +
    "Подсказка в личку приходит, когда:\n" +
    "• тебе ответили *reply на твоё сообщение* в группе\n" +
    "• и я *включён* в этой группе\n\n" +
    "Если подсказки нет, проверь:\n" +
    "1) *Я выключен в этой группе*\n" +
    "• Открой `➕ Подключить группу` и включи ✅ напротив нужной группы\n\n" +
    "2) *Группа не появилась в списке*\n" +
    "• Добавь меня в группу и отправь там любое сообщение (или упомяни меня)\n" +
    "• Потом нажми `🔄 Обновить`\n\n" +
    "3) *Пока никто не ответил тебе reply*\n" +
    "• Я не спамлю и пишу только когда реально нужно.";

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
  inline_keyboard: [
    [{ text: "➕ Подключить группу", callback_data: "connect_chat" }],
    [{ text: "🔄 Обновить список", callback_data: "connect_refresh" }],
    [{ text: "❓ Помощь", callback_data: "help_how" }],
    [{ text: "⬅ Назад", callback_data: "menu_home" }],
  ],
},
  });
}

// Тумблер автоответа для выбранного чата
if (typeof data === "string" && data.startsWith("chat_toggle:")) {
  const chatId = data.replace("chat_toggle:", "").trim();

  // Берём текущий статус
  const link = await prisma.chatLink.findUnique({
    where: {
      telegramChatId_userTelegramId: {
        telegramChatId: String(chatId),
        userTelegramId: String(userId),
      },
    },
  });

  if (!link) {
    await bot.answerCallbackQuery(query.id, {
      text: "Чат не найден. Нажмите «Обновить».",
      show_alert: true,
    });
    return renderConnectChat(bot, msg, userId);
  }

  const nextEnabled = !link.enabled;

  // Обновляем в БД (и в chatService, если он используется для логики автоответа)
  await prisma.chatLink.update({
    where: {
      telegramChatId_userTelegramId: {
        telegramChatId: String(chatId),
        userTelegramId: String(userId),
      },
    },
    data: { enabled: nextEnabled },
  });

  try {
    if (nextEnabled) {
      await chatService.enableChat(Number(chatId), userId);
    } else {
      await chatService.disableChat(Number(chatId), userId);
    }
  } catch (e) {
    // если chatService завязан на другую таблицу — не ломаем UX
  }

  await bot.answerCallbackQuery(query.id, {
    text: nextEnabled ? "✅ Автоответ включён" : "❌ Автоответ выключен",
  });

  return renderConnectChat(bot, msg, userId);
}

// ✅ ОПЛАТА / BUY_* (YooKassa)
if (typeof data === "string" && data.startsWith("buy_")) {
  const plan = data.replace("buy_", ""); // trial / 7 / 30 / 180 / 365
  const userTelegramId = String(userId);

  // вернём после оплаты (можно на бота)
  const returnUrl =
    (`https://t.me/${process.env.BOT_USERNAME || ""}`.trim() || "https://t.me/");

  try {
    const result = await paymentService.createPayment({
      userTelegramId,
      plan,
      returnUrl,
    });

    // ✅ ПРОБНАЯ — активируем сразу и обновляем экран
    if (result.type === "trial") {
      const until = new Date();
      until.setDate(until.getDate() + result.tariff.days);

      await prisma.user.update({
        where: { telegramId: userTelegramId },
        data: { subscriptionTil: until },
      });

      await bot.answerCallbackQuery(query.id, { text: "✅ Пробная активирована!" });

      return bot.editMessageText(
        `🎁 *Пробная подписка активирована!*\n` +
          `Действует до: *${until.toLocaleDateString()}*`,
        {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅ Назад", callback_data: "menu_sub" }],
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        }
      );
    }

    // ⬇️ ШАГ 1 — экран оплаты (для платных тарифов)

await bot.answerCallbackQuery(query.id);

return bot.sendMessage(
  msg.chat.id,
  `💳 *Тариф:* ${result.tariff.title}\n` +
  `💰 *Сумма:* ${result.tariff.price} ₽\n\n` +
  `Нажмите кнопку ниже, чтобы оплатить, затем подтвердите оплату.`,
  {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "💳 Оплатить",
            url: result.confirmationUrl,
          },
        ],
        [
          {
            text: "✅ Я оплатил",
            callback_data: `pay_check:${result.paymentId}`,
          },
        ],
        [
          {
            text: "⬅ Назад",
            callback_data: "menu_sub",
          },
        ],
      ],
    },
  }
);

  } catch (e) {
    console.error("buy_ error:", e);

    try {
      await bot.answerCallbackQuery(query.id, {
        text: "Ошибка создания оплаты",
        show_alert: true,
      });
    } catch {}
  }
}


      // ============================
      //         БЛОК АДМИНКИ
      // ============================

      if (data === "admin_users") {
        const users = await prisma.user.findMany();

        let text = "👥 *Пользователи:*\n\n";
        users.forEach((u) => {
          text += `• ${u.telegramId} — ${
            u.subscriptionTil ? "✔️ подписка" : "❌ нет подписки"
          }\n`;
        });

        return bot.editMessageText(text, {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        });
      }

      if (data === "help_secretary") {
  const text =
    "📋 *Секретарские команды*\n\n" +
    "Как пользоваться:\n" +
    "1) Отправь/получи сообщение\n" +
    "2) Напиши команду ниже\n" +
    "3) Я подготовлю готовый текст\n\n" +
    "Команды:\n" +
    "• `ответь вежливо` — корректно и вежливо\n" +
    "• `ответь коротко` — 1–2 предложения\n" +
    "• `ответь по делу` — без воды\n" +
    "• `ответь строго` — официально\n" +
    "• `ответь с юмором` — легко и дружелюбно\n" +
    "• `откажи вежливо` — корректный отказ\n" +
    "• `перепиши мягче` — смягчить формулировку\n" +
    "• `скажи что занят` — автоответ «отвечу позже»\n";

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "⬅ Назад в /help", callback_data: "help_back" }],
        [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
      ],
    },
  });
}

if (data === "help_back") {
  const text =
    "🆘 *Помощь*\n\n" +
    "Доступные команды:\n" +
    "• /start — главное меню\n" +
    "• /status — твой статус и подписка\n" +
    "• /profile — профиль\n" +
    "• /help — эта справка\n";

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Секретарские команды", callback_data: "help_secretary" }],
      ],
    },
  });
}

      if (data === "admin_stats") {
        const totalUsers = await prisma.user.count();
        const totalLogs = await prisma.messageLog.count();

        return bot.editMessageText(
          `📊 *Статистика:*\n\n👥 Пользователей: *${totalUsers}*\n💬 Сообщений: *${totalLogs}*`,
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
              ],
            },
          }
        );
      }
      
      if (data === "admin_find_user") {
  await bot.editMessageText(
    "🔎 Введите *Telegram ID* или *@username* пользователя:",
    {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: "Markdown",
    }
  );

  // помечаем, что в этом чате (админском) ждём ввод юзера
  adminWaitingForUser = true;
  adminReplyChat = msg.chat.id;

  return;
}

      if (data === "admin_top") {
        return bot.editMessageText("🔥 Топ активных — отчёты будут позже!", {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        });
      }

      if (data === "admin_subs") {
        return bot.editMessageText("💳 Подписки — отчёты будут позже!", {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        });
      }

      if (data === "admin_money") {
        return bot.editMessageText("💰 Выручка — отчёты будут позже!", {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        });
      }

      if (data === "admin_ban_menu") {
        return bot.editMessageText(
          "⛔ Функция бана будет добавлена позже",
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
              ],
            },
          }
        );
      }

      // =============== ADMIN: GIVE SUB (выдача подписки) ===============
if (data.startsWith("admin_givesub_")) {
  const userDbId = Number(data.replace("admin_givesub_", ""));

  const user = await prisma.user.findUnique({
    where: { id: userDbId }
  });

  if (!user) {
    return bot.editMessageText("❌ Пользователь не найден.", {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  }

  // выдаём подписку на 30 дней
  const until = new Date();
  until.setDate(until.getDate() + 30);

  await prisma.user.update({
    where: { id: userDbId },
    data: { subscriptionTil: until }
  });

  return bot.editMessageText(
    `🎉 *Подписка успешно выдана!*\n\n` +
    `👤 Пользователь: ${user.telegramId}\n` +
    `📅 Активна до: *${until.toLocaleDateString()}*`,
    {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 Главное меню", callback_data: "menu_home" }]
        ]
      }
    }
  );
}
if (data.startsWith("admin_extend30_")) {
  const userDbId = Number(data.replace("admin_extend30_", ""));

  const user = await prisma.user.findUnique({ where: { id: userDbId }});
  if (!user) {
    return bot.editMessageText("❌ Пользователь не найден.", {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  }

  const until = user.subscriptionTil ? new Date(user.subscriptionTil) : new Date();
  until.setDate(until.getDate() + 30);

  await prisma.user.update({
    where: { id: userDbId },
    data: { subscriptionTil: until }
  });

  return bot.editMessageText(
    `🎉 Подписка продлена на *30 дней!*\n` +
    `Новая дата: *${until.toLocaleDateString()}*`,
    {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu_home" }]]
      }
    }
  );
}
if (data.startsWith("admin_extend90_")) {
  const userDbId = Number(data.replace("admin_extend90_", ""));

  const user = await prisma.user.findUnique({ where: { id: userDbId }});
  if (!user) {
    return bot.editMessageText("❌ Пользователь не найден.", {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  }

  const until = user.subscriptionTil ? new Date(user.subscriptionTil) : new Date();
  until.setDate(until.getDate() + 90);

  await prisma.user.update({
    where: { id: userDbId },
    data: { subscriptionTil: until }
  });

  return bot.editMessageText(
    `🎉 Подписка продлена на *90 дней!*\n` +
    `Новая дата: *${until.toLocaleDateString()}*`,
    {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu_home" }]]
      }
    }
  );
}
if (data.startsWith("admin_extend365_")) {
  const userDbId = Number(data.replace("admin_extend365_", ""));

  const user = await prisma.user.findUnique({ where: { id: userDbId }});
  if (!user) {
    return bot.editMessageText("❌ Пользователь не найден.", {
      chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  }

  const until = user.subscriptionTil ? new Date(user.subscriptionTil) : new Date();
  until.setFullYear(until.getFullYear() + 1);

  await prisma.user.update({
    where: { id: userDbId },
    data: { subscriptionTil: until }
  });

  return bot.editMessageText(
    `🎉 Подписка продлена на *365 дней!* 🎉\n` +
    `Новая дата: *${until.toLocaleDateString()}*`,
    {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu_home" }]]
      }
    }
  );
}


      // ============================
      //       МЕНЮ ПОЛЬЗОВАТЕЛЯ
      // ============================

            // ---- STATUS (расширенный профиль) ----
      if (data === "menu_status") {
        const user = await prisma.user.findUnique({
          where: { telegramId: String(userId) },
        });

        if (!user) {
          return bot.editMessageText("❌ Пользователь не найден в базе.", {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
              ],
            },
          });
        }

        const totalMessages = await prisma.messageLog.count({
          where: { user: { telegramId: String(userId) } },
        });

        const subText = `*Режим:* ${formatSubStatus(user)}`;

        const style = getStyleLabel(user?.style, hasActiveSub(user));

        const text =
          `📊 *Профиль пользователя*\n\n` +
          `🆔 *Telegram ID:* \`${user.telegramId}\`\n` +
          `📅 *Создан:* ${new Date(user.createdAt).toLocaleString()}\n\n` +
          `💳 ${subText}\n\n` +
          `🎭 *Стиль секретаря:* ${style}\n` +
          `💬 *Всего сообщений с ИИ:* ${totalMessages}`;

        return bot.editMessageText(text, {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        });
      }

      // ---- SUBSCRIPTION MENU ----
if (data === "menu_sub") {
  const user = await prisma.user.findUnique({
    where: { telegramId: String(userId) },
  });

  const active = user.subscriptionTil
    ? `✔️ Активна до ${new Date(user.subscriptionTil).toLocaleDateString()}`
    : "❌ Нет активной подписки";

  const text =
    `💳 *Подписка на ИИ-секретаря*\n\n` +
    `Что даёт подписка:\n` +
    `• ♾️ черновики автоответчика в личке (без лимита)\n` +
    `• 🎭 стили общения\n` +
    `• 💬 личный промпт\n` +
    `• 🧾 логи сообщений\n\n` +
    `Бесплатно доступно:\n` +
    `• базовые ответы\n` +
    `• автоответчик-черновики: ${DM_FREE_LIMIT}/день\n\n` +
    `Статус: ${active}\n\n` +
    `Выберите тариф ниже:`;

  return bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✨ Преимущества", callback_data: "sub_benefits" }],
        [{ text: "🎁 Пробная — 0 ₽", callback_data: "buy_trial" }],
        [{ text: "Неделя — 150 ₽", callback_data: "buy_7" }],
        [{ text: "Месяц — 450 ₽", callback_data: "buy_30" }],
        [{ text: "Полгода — 1990 ₽", callback_data: "buy_180" }],
        [{ text: "Год — 3184 ₽", callback_data: "buy_365" }],
        [{ text: "⬅ Назад", callback_data: "menu_home" }],
      ],
    },
  });
}

      if (data === "auto_on") {
        await chatService.enableChat(msg.chat.id, userId);
        return bot.editMessageText("🤖 Автоответ включён ✔️", {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Выключить",
                  callback_data: "auto_off",
                },
              ],
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        });
      }

      if (data === "auto_off") {
        await chatService.disableChat(msg.chat.id, userId);
        return bot.editMessageText("🤖 Автоответ выключен ❌", {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Включить",
                  callback_data: "auto_on",
                },
              ],
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        });
      }

      // ---- LOGS (первый заход) ----
      if (data === "menu_logs") {
        return renderLogsPage(bot, msg, userId, 1);
      }
      if (data === "menu_settings") {
        const user = await prisma.user.findUnique({
          where: { telegramId: String(userId) },
        });

        const currentStyle = STYLE_NAMES[user?.style] || STYLE_NAMES.default;

        const username = getBotUsername();
        const addToGroupUrl = username ? `https://t.me/${username}?startgroup=true` : null;

        return bot.editMessageText(
  `⚙️ *Настройки*\n\n` +
    `Здесь ты управляешь своим ИИ-секретарём.\n` +
    `Он помогает быстрее отвечать в переписках и писать в нужном стиле.\n\n` +
    `🎨 Текущий стиль: *${currentStyle}*`,
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📩 Автоответчик (ЛС)", callback_data: "dm_auto_menu" }],
                [{ text: "➕ Добавить чат", callback_data: "connect_chat" }],
                [{ text: "✨ Преимущества подписки", callback_data: "sub_benefits" }],
                [{ text: "💳 Подписка", callback_data: "menu_sub" }],
                [{ text: "🔁 Пройти онбординг заново", callback_data: "onboarding_restart" }],
                ...(addToGroupUrl ? [[{ text: "👥 Добавить в группу", url: addToGroupUrl }]] : []),
                [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
                [{ text: "❓ Помощь", callback_data: "help_how" }],
              ],
            },
          }
        );
      }

      // ---- LOGS (страницы) ----
      if (data.startsWith("logs_page_")) {
        const page = Number(data.replace("logs_page_", ""));
        return renderLogsPage(bot, msg, userId, page || 1);
      }



if (data === "menu_style") {
  const user = await prisma.user.findUnique({
    where: { telegramId: String(userId) },
  });

  const STYLE_NAMES = {
    default: "Обычный",
    business: "Деловой",
    cute: "Милый 😊",
    strict: "Строгий",
    humor: "Юмор 😄",
  };

  const currentStyle =
    STYLE_NAMES[user?.style] || STYLE_NAMES.default;

  return bot.editMessageText(
    `🎭 *Выбор стиля секретаря*\n\nТекущий стиль: *${currentStyle}*\nВыберите новый:`,
    {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "💼 Деловой", callback_data: "set_style_business" },
            { text: "😊 Милый", callback_data: "set_style_cute" },
          ],
          [
            { text: "⚖ Строгий", callback_data: "set_style_strict" },
            { text: "😄 Юмор", callback_data: "set_style_humor" },
          ],
          [{ text: "🔁 Обычный", callback_data: "set_style_default" }],
          [{ text: "⬅ Назад", callback_data: "menu_settings" }],
        ],
      },
    }
  );
}



// ---- STYLE SELECT ----
if (data.startsWith("set_style_")) {
  const style = data.replace("set_style_", "");

  const allowed = ["default", "business", "cute", "strict", "humor"];
  if (!allowed.includes(style)) {
    await bot.answerCallbackQuery(query.id, {
      text: "Неизвестный стиль",
      show_alert: true,
    });
    return;
  }

  await prisma.user.update({
    where: { telegramId: String(userId) },
    data: { style },
  });

  const newStyleName = STYLE_NAMES[style] || "Обычный";

  return bot.editMessageText(
    `🎨 *Стиль обновлён!*\n` +
      `Новый стиль: *${newStyleName}*`,
    {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "⬅ Назад", callback_data: "menu_style" }],
          [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
        ],
      },
    }
  );
}

// ---- HOME ----
if (data === "menu_home") {
  await bot.answerCallbackQuery(query.id);
  return renderHomeScreen({
    bot,
    chatId: msg.chat.id,
    messageId: msg.message_id,
    userId,
    chat: msg.chat,
    variant: "home",
  });
}

// (дубликат menu_home убран — оставляем один обработчик выше)

      await bot.answerCallbackQuery(query.id);
    } catch (e) {
      console.error("callback_query error:", e);
      try {
        await bot.answerCallbackQuery(query.id, {
          text: "Ошибка обработки кнопки",
          show_alert: false,
        });
      } catch {}
    }
  }); // END callback_query

  // ============================
  //     PROMPT INPUT HANDLER
  // ============================
  // === ADMIN: обработка введённого ID ===


// ============================
//     MESSAGE HANDLER
//  (admin input + chat capture + prompt input)
// ============================
bot.on("message", async (msg) => {
  //if (await dmDrafts.handleMessage({ bot, msg })) return;
  try {
    if (!msg?.from || !msg?.chat) return;

    // ✅ STOP: если включён режим черновиков в личке — обычный AI-ответ НЕ отправляем
    // (иначе получится: черновик + ответ ИИ)
    // ⚠️ Но если пользователь сейчас в режиме "Подготовить ответ" (quick flow) — НЕ блокируем.
    if (
      msg?.chat?.type === "private" &&
      typeof msg.text === "string" &&
      !msg.text.startsWith("/") &&
      typeof bot.getDmDraftState === "function" &&
      bot.getDmDraftState(msg.from.id)?.enabled
    ) {
      const qs = getQuickState(msg.from.id);
      if (!qs?.awaiting) return;
    }

    const fromId = msg.from.id;
    const chatId = String(msg.chat.id);
    const userTelegramId = String(fromId);

    // ✅ 1) Всегда сохраняем чат, где бот видел пользователя
    // Это нужно, чтобы «➕ Подключить чат» показывал актуальный список.
    await prisma.chatLink.upsert({
      where: {
        telegramChatId_userTelegramId: {
          telegramChatId: chatId,
          userTelegramId,
        },
      },
      update: {
        title: msg.chat.title || msg.chat.username || msg.chat.first_name || null,
        type: msg.chat.type,
      },
      create: {
        telegramChatId: chatId,
        userTelegramId,
        title: msg.chat.title || msg.chat.username || msg.chat.first_name || null,
        type: msg.chat.type,
        enabled: false,
      },
    });

    // текстовые сообщения только дальше
    if (!msg.text) return;

    // ✅ QUICK FLOW: ждём введённый текст для «Подготовить ответ» (в личке)
if (msg.chat.type === "private") {
  const qs = getQuickState(fromId);

  if (qs.awaiting && msg.text && !msg.text.startsWith("/")) {
    cancelPendingQuickDraft(fromId);

    setQuickState(fromId, { awaiting: false, lastIncomingText: msg.text });

    const delayMs = Math.max(1, Number(qs.delaySec || 10)) * 1000;
    const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setQuickState(fromId, { pendingToken: token });

    const t = setTimeout(async () => {
      const cur = getQuickState(fromId);
      if (!cur.pendingToken || cur.pendingToken !== token) return;

      try {
        await sendQuickDraft({
          bot,
          chatId: msg.chat.id,
          userId: fromId,
          incomingText: msg.text,
        });
      } finally {
        setQuickState(fromId, { pendingToken: null, pendingTimer: null });
      }
    }, delayMs);

    setQuickState(fromId, { pendingTimer: t });

    return; // перехватили — дальше не идём
  }
}

    // ✅ QUICK FLOW: если пользователь нажал "Подготовить ответ" — перехватываем следующее сообщение
    // Работает только в личке и только для обычного текста (не команды).
    if (msg.chat.type === "private" && typeof msg.text === "string" && !msg.text.startsWith("/")) {
      const qs = getQuickState(fromId);

      if (qs.awaiting) {
        // Мы ждём текст от пользователя для быстрого ответа
        setQuickState(fromId, { awaiting: false });

        // Если был запланирован предыдущий quick-черновик — отменяем
        cancelPendingQuickDraft(fromId);

        const incomingText = msg.text;
        setQuickState(fromId, { lastIncomingText: incomingText });

        const delaySec = Number(qs.delaySec || 10);
        const delayMs = Math.max(1, delaySec) * 1000;

        // Небольшое уведомление
        await bot.sendMessage(
          msg.chat.id,
          `⏳ Ок, через *${delaySec} сек* подготовлю готовый ответ.`,
          { parse_mode: "Markdown" }
        );

        const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const t = setTimeout(async () => {
          const cur = getQuickState(fromId);
          if (cur.pendingToken && cur.pendingToken !== token) return;

          try {
            await sendQuickDraft({
              bot,
              chatId: msg.chat.id,
              userId: fromId,
              incomingText,
            });
          } catch (e) {
            console.error("quick flow draft error:", e);
          } finally {
            setQuickState(fromId, { pendingTimer: null, pendingToken: null });
          }
        }, delayMs);

        setQuickState(fromId, { pendingTimer: t, pendingToken: token });

        // ✅ quick-flow перехватил сообщение — дальше обычная логика не должна отрабатывать
        return;
      }
    }
    if (msg.chat.type === "private" && !msg.text.startsWith("/")) {
      const qs = getQuickState(fromId);
      if (qs.awaiting) {
        const incomingText = msg.text;

        // снимаем ожидание сразу, чтобы не ловить дубли
        setQuickState(fromId, { awaiting: false });

        // отменяем предыдущий таймер, чтобы не присылать пачку ответов
        cancelPendingQuickDraft(fromId);

        const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        setQuickState(fromId, { pendingToken: token, lastIncomingText: incomingText });

        const delayMs = Math.max(1, Number(getQuickState(fromId).delaySec || 10)) * 1000;

        // небольшое уведомление
        await bot.sendMessage(
          msg.chat.id,
          `⏳ Ок, через *${Math.max(1, Number(getQuickState(fromId).delaySec || 10))} сек* пришлю готовый ответ.`,
          { parse_mode: "Markdown" }
        );

        const t = setTimeout(async () => {
          const cur = getQuickState(fromId);
          if (!cur.pendingToken || cur.pendingToken !== token) return;

          try {
            // сбрасываем pending до отправки
            setQuickState(fromId, { pendingToken: null, pendingTimer: null });
            await sendQuickDraft({ bot, chatId: msg.chat.id, userId: fromId, incomingText });
          } catch (e) {
            console.error("quick draft error:", e);
          }
        }, delayMs);

        setQuickState(fromId, { pendingTimer: t });
        return;
      }
    }

    // ✅ 2) Админ: ждём введённый Telegram ID
    if (adminWaitingForUser && fromId === ADMIN_ID) {
      adminWaitingForUser = false;

      const id = msg.text.trim();
      const user = await prisma.user.findUnique({ where: { telegramId: id } });

      if (!user) {
        return bot.sendMessage(adminReplyChat || msg.chat.id, "❌ Пользователь не найден.");
      }

      return bot.sendMessage(
        adminReplyChat || msg.chat.id,
        `👤 *Пользователь найден:* \n\n` +
          `🆔 ID: ${user.telegramId}\n` +
          `📅 Создан: ${user.createdAt.toLocaleString()}\n` +
          `💳 Подписка: ${user.subscriptionTil ? "✔️ Активна" : "❌ Нет"}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📜 Логи", callback_data: `admin_logs_${user.id}` }],
              [{ text: "➕ Продлить на 30 дней", callback_data: `admin_extend30_${user.id}` }],
              [{ text: "➕ Продлить на 90 дней", callback_data: `admin_extend90_${user.id}` }],
              [{ text: "➕ Продлить на 365 дней", callback_data: `admin_extend365_${user.id}` }],
              [{ text: "💳 Выдать подписку", callback_data: `admin_givesub_${user.id}` }],
              [{ text: "⛔ Бан / Разбан", callback_data: `admin_ban_${user.id}` }],
              [{ text: "🏠 Главное меню", callback_data: "menu_home" }],
            ],
          },
        }
      );
    }

    // ✅ 3) Ввод промпта (в ЛС)
    const uid = fromId;
    if (promptService.awaitingPrompt[uid] && !msg.text.startsWith("/")) {
      await promptService.updatePrompt(uid, msg.text);
      promptService.awaitingPrompt[uid] = false;
      return bot.sendMessage(msg.chat.id, "Промпт сохранён ✅");
    }

    // ✅ 4) DM автоответчик (черновики): работает только в личке с ботом
    if (msg.chat.type === "private") {
      const state = getDmState(fromId);

      if (state.enabled && msg.text && !msg.text.startsWith("/")) {
        // Если пользователь прислал новый текст до того, как мы выдали черновик —
        // отменяем предыдущий таймер, чтобы не слать пачку черновиков подряд.
        cancelPendingDmDraft(fromId);

        const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        setDmState(fromId, { pendingToken: token });

        // стиль — как в статусе
        const u = await prisma.user.findUnique({
          where: { telegramId: String(fromId) },
        });

        const styleNames = {
          default: "Обычный",
          business: "Деловой",
          cute: "Милый 😊",
          strict: "Строгий",
          humor: "Юмор 😄",
        };

        const styleLabel = styleNames[u?.style] || "Обычный";
        const isSub = hasActiveSub(u);

        // лимит для бесплатной версии
        if (!isSub && state.used >= DM_FREE_LIMIT) {
          await bot.sendMessage(
            msg.chat.id,
            "🧾 *Лимит черновиков исчерпан*\n\n" +
              `Сегодня доступно: *${DM_FREE_LIMIT}* черновиков.\n` +
              "Подключи подписку — будет больше возможностей и без лимита.",
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✨ Преимущества подписки", callback_data: "sub_benefits" }],
                  [{ text: "💳 Оформить подписку", callback_data: "menu_sub" }],
                ],
              },
            }
          );
          return;
        }

        // увеличиваем счётчик только если реально будем делать черновик
        if (!isSub) {
          setDmState(fromId, { used: state.used + 1 });
        }

        // маленькое уведомление, что «ждём»
        await bot.sendMessage(
          msg.chat.id,
          `⏳ Ок, через *${state.delaySec} сек* пришлю черновик ответа.`,
          { parse_mode: "Markdown" }
        );

        const incomingText = msg.text;
        // сохраняем текст, для которого делаем черновик
        setDmState(fromId, { lastIncomingText: incomingText });
        const delayMs = Math.max(1, Number(state.delaySec || 10)) * 1000;

        const draftTimer = setTimeout(async () => {
          const current = getDmState(fromId);
          if (!current.pendingToken || current.pendingToken !== token) return;
          try {
            const latest = getDmState(fromId);

            // если режим выключили или уже запланирован другой черновик — ничего не делаем
            if (!latest.enabled) return;
            if (latest.pendingToken !== token) return;

            const built = buildDraftReply(incomingText, styleLabel, latest.lastVariantId);
            const draft = built.draft;

            setDmState(fromId, {
              lastDraft: draft,
              lastStyleLabel: styleLabel,
              lastVariantId: built.variantId,
              pendingTimer: null,
              pendingToken: null,
            });

            setQuickState(fromId, {
              lastIncomingText: incomingText,
              lastVariantId: built.variantId,
              lastDraft: draft,
            });

            await bot.sendMessage(
              msg.chat.id,
              "📝 <b>Черновик ответа:</b>\n\n" +
                fmtCode(draft) +
                "\n\n<i>(Скопируй и отправь собеседнику)</i>",
              {
                parse_mode: "HTML",
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "📄 Показать черновик", callback_data: "quick_show_last" },
                      { text: "🔄 Ещё вариант", callback_data: "quick_reply_regen" },
                    ],
                    [{ text: "⚙️ Настройки автоответчика", callback_data: "dm_auto_menu" }],
                  ],
                },
              }
            );
          } catch (e) {
            console.error("dm auto draft error:", e);
          }
        }, delayMs);

        // сохраним таймер, чтобы можно было отменять
        setDmState(fromId, { pendingTimer: draftTimer });

// ✅ ВАЖНО: режим черновиков перехватывает сообщение — дальше обычный ИИ-ответ НЕ делаем
return;
      }
    }

    // (Важно) Логику ответов ИИ мы НЕ трогаем здесь,
    // чтобы не сломать то, что уже работает.
  } catch (e) {
    console.error("message handler error:", e);
  }
});
}
