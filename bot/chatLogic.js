import { prisma } from "../db/prisma.js";
import { aiService } from "../services/aiService.js";

const FREE_LIMIT = 20;
const shownHints = new Set();

// Вспомогательные функции для DM автоответчика
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const getDmConfig = async (userId) => {
  try {
    return await prisma.dmAutoConfig.findUnique({
      where: { userTelegramId: String(userId) },
    });
  } catch {
    return null;
  }
};

const upsertDmChat = async ({ userTelegramId, chatTelegramId, title }) => {
  try {
    return await prisma.dmChat.upsert({
      where: { userTelegramId_chatTelegramId: { userTelegramId: String(userTelegramId), chatTelegramId: String(chatTelegramId) } },
      update: { title, enabled: true, lastSeenAt: new Date() },
      create: { userTelegramId: String(userTelegramId), chatTelegramId: String(chatTelegramId), title, enabled: true, lastSeenAt: new Date() },
    });
  } catch {
    return null;
  }
};

const createDmJob = async ({ userTelegramId, chatTelegramId, incomingText, delaySeconds }) => {
  try {
    return await prisma.dmReplyJob.create({
      data: {
        userTelegramId: String(userTelegramId),
        chatTelegramId: String(chatTelegramId),
        incomingText,
        runAt: new Date(Date.now() + delaySeconds * 1000),
        status: "pending",
      },
    });
  } catch {
    return null;
  }
};

// Маппинг команд → промпт и заголовок ответа
const secretCommands = {
  "ответь вежливо": {
    prompt: (msg) => `Переформулируй сообщение в вежливом и корректном тоне.\n\nСообщение:\n"${msg}"\n\nОтвет должен быть готовым к отправке.`,
    header: "💬 *Вежливый вариант ответа:*",
  },
  "ответь коротко": {
    prompt: (msg) => `Сгенерируй короткий ответ (1-2 предложения) на сообщение:\n"${msg}"\n\nТолько текст ответа, без пояснений.`,
    header: "✍️ *Короткий вариант ответа:*",
  },
  "ответь по делу": {
    prompt: (msg) => `Напиши ответ по делу (2-4 предложения), без воды и лишних эмоций.\nИсходное сообщение:\n"${msg}"\n\nТолько текст ответа, без пояснений.`,
    header: "✅ *Ответ по делу:*",
  },
  "ответь строго": {
    prompt: (msg) => `Сформулируй строгий, официальный ответ (1–2 предложения), без эмоций.\nИсходное сообщение:\n"${msg}"\n\nТолько текст ответа.`,
    header: "📎 *Строгий ответ:*",
  },
  "ответь с юмором": {
    prompt: (msg) => `Напиши дружелюбный ответ с лёгким юмором (1–3 предложения).\nЮмор должен быть уместным и ненавязчивым.\n\nИсходное сообщение:\n"${msg}"\n\nТолько текст ответа.`,
    header: "😄 *Ответ с юмором:*",
  },
  "откажи вежливо": {
    prompt: (msg) => `Сформулируй вежливый отказ.\nТон спокойный, уважительный, без резкости.\n1–3 предложения, без лишних объяснений.\n\nИсходное сообщение:\n"${msg}"\n\nТолько текст ответа.`,
    header: "🙏 *Вежливый отказ:*",
  },
  "перепиши мягче": {
    prompt: (msg) => `Перепиши текст так, чтобы он звучал мягче и дружелюбнее.\nСмысл сохранить, без лишней воды.\n\nТекст:\n"${msg}"\n\nТолько переписанный вариант.`,
    header: "🫶 *Мягче:*",
  },
  "скажи что занят": {
    prompt: (msg) => `Сформулируй короткий автоответ, что я сейчас занят и отвечу позже.\nТон: вежливо, спокойно, без лишних деталей.\n1–2 предложения.${msg ? `\nКонтекст: мне написали сообщение "${msg}".` : ""}\n\nТолько текст ответа.`,
    header: "⏳ *Я занят — вариант ответа:*",
  },
};

export const chatLogic = {
  
  async setGroupMode({ chatId, userId, enabled, chatType = null, chatTitle = null }) {
    const data = { telegramChatId: String(chatId), userTelegramId: String(userId) };
    const update = { enabled: Boolean(enabled) };
    if (chatTitle) update.title = chatTitle;
    if (chatType) update.type = chatType;

    try {
      await prisma.chatLink.upsert({
        where: { telegramChatId_userTelegramId: data },
        update,
        create: { ...data, ...update },
      });
    } catch {}

    shownHints.delete(chatId);
    shownHints.delete(chatId + ":off");
    shownHints.delete(chatId + ":controls");
    return { ...data, enabled };
  },
  
  getGroupModeText({ enabled, botUsername }) {
    const name = botUsername ? `@${botUsername}` : "бота";
    return enabled
      ? `✅ *Режим группы включён.*\n\nЯ отвечаю только когда меня вызывают:\n• reply на моё сообщение\n• упоминание ${name}\n• команда /команда@бот\n\nЕсли нужно — можно выключить меня в этой группе.`
      : `🔕 *Я выключен в этой группе.*\n\nЧтобы включить — нажмите кнопку ниже.\nПосле включения я отвечаю только когда меня вызывают (reply / ${name} / команда).`;
  },

  async handleIncomingMessage(bot, message) {
    const { from, chat, text: rawText } = message;
    if (from?.is_bot) return;

    const userId = String(from.id);
    const chatId = String(chat.id);
    const chatType = chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    const botUsername = (process.env.BOT_USERNAME || "").replace(/^@/, "");
    const text = rawText?.trim() || "";

    // Игнорируем, если включён режим черновиков в ЛС
    if (!isGroup && !text.startsWith("/")) {
      const draftEnabled = bot?.getDmDraftState?.(from.id)?.enabled;
      if (draftEnabled || (await getDmConfig(userId))?.enabled) return;
    }

    // Определяем, вызван ли бот в группе
    const replyToBot = message.reply_to_message?.from?.is_bot &&
      (!botUsername || message.reply_to_message.from.username?.toLowerCase() === botUsername.toLowerCase());
    const mentioned = botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
    const isCommand = text.startsWith("/") && (!isGroup || text.toLowerCase().includes(`@${botUsername.toLowerCase()}`));
    const invoked = isGroup ? (replyToBot || mentioned || isCommand) : true;

    // Чистим текст от упоминания
    if (isGroup && mentioned) {
      message.text = text.replace(new RegExp(`@${botUsername}\\b`, "ig"), "").trim();
    }

    // Групповой режим: проверка включения и подсказки
    if (isGroup) {
      const link = await prisma.chatLink.findUnique({
        where: { telegramChatId_userTelegramId: { telegramChatId: chatId, userTelegramId: userId } },
        select: { enabled: true },
      });
      const enabled = link?.enabled ?? false;

      if (!enabled) {
        if (!shownHints.has(chatId + ":off")) {
          shownHints.add(chatId + ":off");
          await bot.sendMessage(chatId, this.getGroupModeText({ enabled: false, botUsername }), {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔔 Включить меня здесь", callback_data: "group_mode_on" }]] },
          }).catch(() => {});
        }
        return;
      }

      if (!invoked) {
        if (!shownHints.has(chatId)) {
          shownHints.add(chatId);
          await bot.sendMessage(chatId, `👥 *Я в режиме группы.*\n\nЧтобы я ответил — вызовите меня:\n• reply на моё сообщение\n• или упомяните *@${botUsername || "бот"}*\n• или используйте команду /...\n\nВ личке можно писать просто сообщением 🙂\n\n⚙️ Подсказка: режим группы можно выключить кнопкой ниже.`, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔕 Отключить меня здесь", callback_data: "group_mode_off" }, { text: "👥 Настройки группы", callback_data: "group_settings" }]] },
          }).catch(() => {});
        }
        return;
      }
    }

    // DM автоответчик
    if (!isGroup && !text.startsWith("/")) {
      const cfg = await getDmConfig(userId);
      if (cfg?.enabled) {
        const delay = clamp(cfg.delaySeconds ?? 10, 10, 20);
        const maxDialogs = (await prisma.user.findUnique({ where: { telegramId: userId }, select: { subscriptionTil: true } }))?.subscriptionTil > new Date() ? 20 : 5;
        const count = await prisma.dmChat.count({ where: { userTelegramId: userId, enabled: true } }).catch(() => 0);
        if (count >= maxDialogs) {
          await bot.sendMessage(chatId, `⚠️ Лимит подключённых диалогов: *${maxDialogs}*\n\nОтключите один диалог или оформите подписку.`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "💳 Подписка", callback_data: "menu_sub" }]] } }).catch(() => {});
          return;
        }

        await upsertDmChat({ userTelegramId: userId, chatTelegramId: chatId, title: chat.title || chat.username || chat.first_name });
        const job = await createDmJob({ userTelegramId: userId, chatTelegramId: chatId, incomingText: text, delaySeconds: delay });

        await bot.sendMessage(chatId, `⏳ Ок, через *${delay} сек* пришлю черновик ответа.`, { parse_mode: "Markdown" }).catch(() => {});

        if (!job) {
          setTimeout(async () => {
            try {
              const draft = await aiService.generateReply(userId, `Сделай черновик ответа на сообщение собеседника. Ответ должен быть готов к копированию и отправке, без пояснений.\n\nСообщение собеседника:\n"${text}"`, { mode: "dm_draft" });
              await bot.sendMessage(chatId, `📝 *Черновик ответа:*\n\n${draft}\n\n_(Скопируй и отправь собеседнику)_`, { parse_mode: "Markdown" });
            } catch {}
          }, delay * 1000);
        }
        return;
      }
    }

    // Обработка секретарских команд
    const lowerText = text.toLowerCase();
    if (lowerText === "список команд") {
      return bot.sendMessage(chatId, "📌 *Секретарские команды:*\n\n• ответь вежливо\n• ответь коротко\n• ответь по делу\n• ответь строго\n• ответь с юмором\n• откажи вежливо\n• перепиши мягче\n• скажи что занят\n\nНапиши любую команду — и я подготовлю готовый текст ответа.", { parse_mode: "Markdown" });
    }

    const cmd = secretCommands[lowerText];
    if (cmd) {
      const last = await prisma.messageLog.findFirst({ where: { user: { telegramId: userId } }, orderBy: { createdAt: "desc" } });
      const lastMsg = last?.incomingText || "";
      if (!lastMsg && lowerText !== "скажи что занят") {
        return bot.sendMessage(chatId, "❌ Не нашёл сообщение, к которому нужно ответить.");
      }
      const reply = await aiService.generateReply(userId, cmd.prompt(lastMsg), { mode: "private" });
      return bot.sendMessage(chatId, `${cmd.header}\n\n${reply}`, { parse_mode: "Markdown" });
    }

    // Основная логика ответа
    const aiMeta = { chatType, chatTitle: chat.title || chat.username || chat.first_name, botUsername, isGroup, invokedByReply: replyToBot, invokedByMention: mentioned, invokedByCommand: isCommand, mode: isGroup ? "group" : "private" };

    const user = await prisma.user.findUnique({ where: { telegramId: userId } });
    const activeSub = user?.subscriptionTil && new Date(user.subscriptionTil) > new Date();

    if (!activeSub) {
      const used = await prisma.messageLog.count({ where: { user: { telegramId: userId } } });
      if (used >= FREE_LIMIT) {
        return bot.sendMessage(chatId, `❌ Бесплатные ответы закончились (${FREE_LIMIT}/${FREE_LIMIT}).\n\n💳 Чтобы продолжить — оформите подписку:`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "💳 Подписка", callback_data: "menu_sub" }]] } });
      }
      if (used === 15 || used === 19) {
        await bot.sendMessage(chatId, `⚠️ Осталось бесплатных ответов: ${FREE_LIMIT - used}`, { parse_mode: "Markdown" });
      }
    }

    const aiReply = await aiService.generateReply(userId, text, aiMeta);
    await bot.sendMessage(chatId, aiReply);

    if (isGroup && !shownHints.has(chatId + ":controls")) {
      shownHints.add(chatId + ":controls");
      await bot.sendMessage(chatId, this.getGroupModeText({ enabled: true, botUsername }), { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔕 Отключить меня здесь", callback_data: "group_mode_off" }, { text: "👥 Настройки группы", callback_data: "group_settings" }]] } }).catch(() => {});
    }

    await prisma.messageLog.create({
      data: {
        user: { connect: { telegramId: userId } },
        incomingText: text,
        replyText: aiReply,
        chatTelegramId: chatId,
      },
    });
  },
};