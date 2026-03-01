import { prisma } from "../../db/prisma.js";

// DM Drafts = черновики ответов в личке с ботом.
// Важно: бот НЕ может отправлять сообщения за пользователя в чужих личных чатах.

export function createDmDraftsModule() {
  const DM_FREE_LIMIT = 5;
  const stateMap = new Map();

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function hasActiveSub(user) {
    if (!user?.subscriptionTil) return false;
    return new Date(user.subscriptionTil) > new Date();
  }

  function getStyleLabel(styleKey) {
    const map = {
      default: "Обычный",
      business: "Деловой",
      cute: "Милый 😊",
      strict: "Строгий",
      humor: "Юмор 😄",
    };
    return map[String(styleKey || "default")] || map.default;
  }

  function getState(userId) {
    const key = String(userId);
    if (!stateMap.has(key)) {
      stateMap.set(key, {
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

    const s = stateMap.get(key);
    const tk = todayKey();
    if (s.usedDay !== tk) {
      s.usedDay = tk;
      s.used = 0;
    }
    return s;
  }

  function setState(userId, patch) {
    const s = getState(userId);
    Object.assign(s, patch);
    stateMap.set(String(userId), s);
    return s;
  }

  function cancelPending(userId) {
    const s = getState(userId);
    if (s.pendingTimer) {
      try { clearTimeout(s.pendingTimer); } catch {}
    }
    setState(userId, { pendingTimer: null, pendingToken: null });
  }

  function escapeHtml(input = "") {
    return String(input)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtCode(input = "") {
    const raw = String(input ?? "");
    const compact = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ⏎ ");
    const clipped = compact.length > 1200 ? compact.slice(0, 1200) + "…" : compact;
    return `<code>${escapeHtml(clipped)}</code>`;
  }

  function buildDraftReply(text, styleLabel = "Обычный", prevVariantId = null) {
    const t = String(text || "").trim();
    if (!t) return { draft: "Понял. Что именно нужно ответить?", variantId: "empty" };

    const pools = {
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
    };

    let key = "default";
    if (styleLabel.includes("Делов")) key = "business";
    else if (styleLabel.includes("Строг")) key = "strict";
    else if (styleLabel.includes("Мил")) key = "cute";
    else if (styleLabel.includes("Юмор") || styleLabel.includes("С юмором")) key = "humor";

    const pool = pools[key] || pools.default;
    const ids = pool.map((_, i) => `${key}:${i}`);

    let pick = Math.floor(Math.random() * pool.length);
    if (prevVariantId && pool.length > 1) {
      for (let i = 0; i < 5; i++) {
        const c = Math.floor(Math.random() * pool.length);
        if (ids[c] !== prevVariantId) { pick = c; break; }
      }
    }

    const short = t.length > 220 ? t.slice(0, 220) + "…" : t;
    const looksLikeQuestion = /\?|как\b|почему\b|когда\b|где\b|что\b|сколько\b/i.test(short);
    const addOn = looksLikeQuestion ? " Если уточнишь пару деталей, отвечу точнее." : "";

    return { draft: pool[pick] + addOn, variantId: ids[pick] };
  }

  async function renderScreen(bot, msg, userId) {
    const user = await prisma.user.findUnique({ where: { telegramId: String(userId) } });
    const isSub = hasActiveSub(user);
    const s = getState(userId);

    const remaining = Math.max(0, DM_FREE_LIMIT - Number(s.used || 0));
    const quotaLine = isSub
      ? "♾️ Лимит: *без ограничений* (подписка активна)"
      : `🧾 Осталось сегодня: *${remaining} из ${DM_FREE_LIMIT}* черновиков`;

    const text =
      "📩 *Автоответчик в личке (черновики)*\n\n" +
      "⚠️ Telegram-бот *не может* автоматически отвечать за вас в чужих личных чатах.\n" +
      "Зато я могу делать *черновики ответов* здесь — вы копируете и отправляете сами.\n\n" +
      `Статус: *${s.enabled ? "✅ включён" : "❌ выключен"}*\n` +
      `⏱ Задержка: *${s.delaySec} сек*\n` +
      `${quotaLine}\n` +
      `🎨 Стиль: *${getStyleLabel(user?.style)}*\n\n` +
      "Как пользоваться:\n" +
      "1) Включи режим\n" +
      "2) Пришли сюда сообщение собеседника\n" +
      "3) Я подожду задержку и пришлю черновик\n";

    const rows = [
      [{ text: s.enabled ? "🔕 Выключить" : "🔔 Включить", callback_data: "dm_auto_toggle" }],
      [
        { text: "⏱ 10 сек", callback_data: "dm_auto_delay_10" },
        { text: "⏱ 20 сек", callback_data: "dm_auto_delay_20" },
      ],
      [
        { text: "📋 Показать черновик", callback_data: "dm_draft_copy" },
        { text: "🔄 Ещё вариант", callback_data: "dm_draft_regen" },
      ],
      [{ text: "⬅ Назад", callback_data: "menu_home" }],
    ];

    try {
      return await bot.editMessageText(text, {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
    } catch (e) {
      const desc = e?.response?.body?.description || e?.message || "";
      if (String(desc).includes("message is not modified")) return;
      throw e;
    }
  }

  async function handleCallback({ bot, query }) {
    const data = query.data;
    const msg = query.message;
    const userId = query.from.id;

    if (typeof data !== "string") return false;

    if (data === "dm_auto_menu") {
      await bot.answerCallbackQuery(query.id);
      await renderScreen(bot, msg, userId);
      return true;
    }

    if (data === "dm_auto_toggle") {
      const s = getState(userId);
      const next = setState(userId, { enabled: !s.enabled });
      if (!next.enabled) cancelPending(userId);
      await bot.answerCallbackQuery(query.id, { text: next.enabled ? "🔔 Включено" : "🔕 Выключено" });
      await renderScreen(bot, msg, userId);
      return true;
    }

    if (data === "dm_auto_delay_10" || data === "dm_auto_delay_20") {
      const delaySec = data === "dm_auto_delay_10" ? 10 : 20;
      const s = getState(userId);
      if (Number(s.delaySec) === delaySec) {
        await bot.answerCallbackQuery(query.id, { text: "Уже стоит ✅" });
        return true;
      }
      setState(userId, { delaySec });
      await bot.answerCallbackQuery(query.id, { text: `⏱ ${delaySec} сек` });
      await renderScreen(bot, msg, userId);
      return true;
    }

    if (data === "dm_draft_copy") {
      const s = getState(userId);
      if (!s.lastDraft) {
        await bot.answerCallbackQuery(query.id, { text: "Черновика ещё нет", show_alert: true });
        return true;
      }
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(msg.chat.id, "📝 <b>Черновик ответа (копируй):</b>\n\n" + fmtCode(s.lastDraft), {
        parse_mode: "HTML",
      });
      return true;
    }

    if (data === "dm_draft_regen") {
      const s = getState(userId);
      if (!s.lastIncomingText) {
        await bot.answerCallbackQuery(query.id, { text: "Нет исходного сообщения", show_alert: true });
        return true;
      }

      const u = await prisma.user.findUnique({ where: { telegramId: String(userId) } });
      const isSub = hasActiveSub(u);
      if (!isSub && s.used >= DM_FREE_LIMIT) {
        await bot.answerCallbackQuery(query.id, { text: "Лимит исчерпан", show_alert: true });
        return true;
      }
      if (!isSub) setState(userId, { used: s.used + 1 });

      const styleLabel = s.lastStyleLabel || getStyleLabel(u?.style);
      const built = buildDraftReply(s.lastIncomingText, styleLabel, s.lastVariantId);

      setState(userId, { lastDraft: built.draft, lastVariantId: built.variantId, lastStyleLabel: styleLabel });
      cancelPending(userId);

      await bot.answerCallbackQuery(query.id, { text: "🔄 Готово" });
      await bot.sendMessage(
        msg.chat.id,
        "📝 <b>Ещё вариант:</b>\n\n" + fmtCode(built.draft) + "\n\n<i>(Скопируй и отправь собеседнику)</i>",
        { parse_mode: "HTML" }
      );
      return true;
    }

    return false;
  }

  // ВАЖНО: возвращаем true, чтобы index.js НЕ продолжал обычную логику ответа ИИ
  async function handleMessage({ bot, msg }) {
    if (!msg?.chat || msg.chat.type !== "private") return false;
    if (!msg.text) return false;

    const userId = msg.from?.id;
    if (!userId) return false;

    const s = getState(userId);
    if (!s.enabled) return false;
    if (msg.text.startsWith("/")) return false;

    cancelPending(userId);

    const u = await prisma.user.findUnique({ where: { telegramId: String(userId) } });
    const isSub = hasActiveSub(u);

    if (!isSub && s.used >= DM_FREE_LIMIT) {
      await bot.sendMessage(msg.chat.id, `🧾 *Лимит черновиков исчерпан* (${DM_FREE_LIMIT}/день).`, {
        parse_mode: "Markdown",
      });
      return true;
    }

    if (!isSub) setState(userId, { used: s.used + 1 });

    await bot.sendMessage(msg.chat.id, `⏳ Ок, через *${s.delaySec} сек* пришлю черновик ответа.`, {
      parse_mode: "Markdown",
    });

    const incomingText = msg.text;
    setState(userId, { lastIncomingText: incomingText });

    const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setState(userId, { pendingToken: token });

    const styleLabel = getStyleLabel(u?.style);
    const delayMs = Math.max(1, Number(s.delaySec) || 10) * 1000;

    const timer = setTimeout(async () => {
      try {
        const now = getState(userId);
        if (!now.enabled) return;
        if (now.pendingToken !== token) return;

        const built = buildDraftReply(incomingText, styleLabel, now.lastVariantId);

        setState(userId, {
          lastDraft: built.draft,
          lastVariantId: built.variantId,
          lastStyleLabel: styleLabel,
          pendingToken: null,
          pendingTimer: null,
        });

        await bot.sendMessage(
          msg.chat.id,
          "📝 <b>Черновик ответа:</b>\n\n" + fmtCode(built.draft) + "\n\n<i>(Скопируй и отправь собеседнику)</i>",
          { parse_mode: "HTML" }
        );
      } catch (e) {
        console.error("dmDrafts timer error:", e);
      }
    }, delayMs);

    setState(userId, { pendingTimer: timer });
    return true;
  }

  return {
    DM_FREE_LIMIT,
    getState,
    renderScreen,
    handleCallback,
    handleMessage,
  };
}