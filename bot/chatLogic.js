import { prisma } from "../db/prisma.js";
import { aiService } from "../services/aiService.js";


const FREE_LIMIT = 20; // <-- сколько бесплатных ответов

// Памятка для групп: показываем 1 раз за запуск процесса, чтобы не спамить
const shownGroupHintChats = new Set();
// Контролы режима группы: показываем 1 раз, чтобы было понятно, что можно выключить
const shownGroupControlsChats = new Set();

// ============================
//  ЛИЧКА: автоответчик (DM)
// ============================
// Чтобы не создавать 100 задач подряд на один и тот же чат (анти-спам)
const dmLastJobAt = new Map(); // key: `${userId}:${chatId}` -> timestamp

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

async function getDmAutoConfigSafe(userTelegramId) {
  // Если моделей в Prisma ещё нет — не ломаем бота
  try {
    return await prisma.dmAutoConfig.findUnique({
      where: { userTelegramId: String(userTelegramId) },
    });
  } catch {
    return null;
  }
}

async function upsertDmChatSafe({ userTelegramId, chatTelegramId, title = null }) {
  try {
    return await prisma.dmChat.upsert({
      where: {
        userTelegramId_chatTelegramId: {
          userTelegramId: String(userTelegramId),
          chatTelegramId: String(chatTelegramId),
        },
      },
      update: {
        title,
        enabled: true,
        lastSeenAt: new Date(),
      },
      create: {
        userTelegramId: String(userTelegramId),
        chatTelegramId: String(chatTelegramId),
        title,
        enabled: true,
        lastSeenAt: new Date(),
      },
    });
  } catch {
    return null;
  }
}

async function createDmReplyJobSafe({
  userTelegramId,
  chatTelegramId,
  incomingText,
  delaySeconds,
}) {
  const runAt = new Date(Date.now() + delaySeconds * 1000);

  try {
    return await prisma.dmReplyJob.create({
      data: {
        userTelegramId: String(userTelegramId),
        chatTelegramId: String(chatTelegramId),
        incomingText: String(incomingText || ""),
        runAt,
        status: "pending",
      },
    });
  } catch {
    return null;
  }
}

export const chatLogic = {
  /**
   * Включить/выключить бота в конкретной группе для конкретного пользователя.
   * Единый источник правды: prisma.chatLink.
   */
  async setGroupMode({ chatId, userId, enabled, chatType = null, chatTitle = null }) {
    const chatIdStr = String(chatId);
    const userIdStr = String(userId);

    // chatLink (upsert)
    try {
      await prisma.chatLink.upsert({
        where: {
          telegramChatId_userTelegramId: {
            telegramChatId: chatIdStr,
            userTelegramId: userIdStr,
          },
        },
        update: {
          enabled: Boolean(enabled),
          // поддерживаем актуальные данные о чате, если передали
          ...(chatTitle ? { title: chatTitle } : {}),
          ...(chatType ? { type: chatType } : {}),
        },
        create: {
          telegramChatId: chatIdStr,
          userTelegramId: userIdStr,
          enabled: Boolean(enabled),
          title: chatTitle,
          type: chatType,
        },
      });
    } catch {}

    // Сбросим подсказки для этого чата, чтобы после переключения UX не залипал
    try {
      shownGroupHintChats.delete(chatIdStr);
      shownGroupHintChats.delete(chatIdStr + ":off");
      shownGroupControlsChats.delete(chatIdStr + ":controls");
    } catch {}

    return { chatId: chatIdStr, userId: userIdStr, enabled: Boolean(enabled) };
  },

  /**
   * Текст для UX, чтобы одинаково объяснять режимы.
   */
  getGroupModeText({ enabled, botUsername }) {
    const name = botUsername ? `@${botUsername}` : "бота";
    if (!enabled) {
      return (
        `🔕 *Я выключен в этой группе.*\n\n` +
        `Чтобы включить — нажмите кнопку ниже.\n` +
        `После включения я отвечаю только когда меня вызывают (reply / ${name} / команда).`
      );
    }
    return (
      `✅ *Режим группы включён.*\n\n` +
      `Я отвечаю только когда меня вызывают:\n` +
      `• reply на моё сообщение\n` +
      `• упоминание ${name}\n` +
      `• команда /команда@бот\n\n` +
      `Если нужно — можно выключить меня в этой группе.`
    );
  },
  async handleIncomingMessage(bot, message) {
    
    // Не отвечаем на сообщения ботов (в т.ч. самого себя), чтобы не ловить циклы
    if (message?.from?.is_bot) return;

    // ✅ ЖЁСТКИЙ STOP (ЛИЧКА): если включены «черновики» из handlers/index.js,
    // то chatLogic НЕ должен отправлять обычные ИИ-ответы.
    // Важно: return в другом файле не останавливает этот хендлер, поэтому стоп делаем здесь.
    const rawTextEarly = String(message?.text || "");
    const isCommandEarly = rawTextEarly.trim().startsWith("/");

    if (message?.chat?.type === "private" && !isCommandEarly) {
      const draftState = bot?.getDmDraftState?.(message?.from?.id);

      // Если включён режим черновиков — полностью игнорируем обычные сообщения,
      // чтобы не было: "черновик" + "обычный ответ ИИ".
      if (draftState?.enabled) return;

      // fallback: если включено через dmAutoConfig (если модель существует)
      const cfgEarly = await getDmAutoConfigSafe(message?.from?.id);
      if (cfgEarly?.enabled) return;
    }

    // ✅ Отличаем ЛС и группы
    const chatType = message.chat?.type; // private | group | supergroup
    const chatTitle =
      message.chat?.title || message.chat?.username || message.chat?.first_name || null;

    const botUsernameRaw = process.env.BOT_USERNAME || "";
    const botUsername = botUsernameRaw.replace(/^@/, "");

    const isGroup = chatType === "group" || chatType === "supergroup";

    // ✅ Переключатель «включен ли бот в этой группе»
    // По умолчанию: ВЫКЛЮЧЕН в группах (чтобы не спамить). Включается пользователем.
    let groupEnabled = false;
    if (isGroup) {
      const chatIdStr = String(message.chat.id);
      const userIdStr = String(message.from.id);

      // Читаем настройки только из chatLink
      try {
        const row2 = await prisma.chatLink.findUnique({
          where: {
            telegramChatId_userTelegramId: {
              telegramChatId: chatIdStr,
              userTelegramId: userIdStr,
            },
          },
          select: { enabled: true },
        });
        if (row2 && typeof row2.enabled === "boolean") {
          groupEnabled = row2.enabled;
        }
      } catch {}
    }

    // В группах отвечаем ТОЛЬКО если:
    // 1) реплай на СООБЩЕНИЕ ИМЕННО ЭТОГО БОТА
    // 2) есть упоминание @botusername
    // 3) команда /...
    const replyFrom = message.reply_to_message?.from;
    // Reply считается вызовом только если ответили на сообщение этого бота
    const invokedByReply = (() => {
      if (!replyFrom) return false;
      if (!replyFrom.is_bot) return false;

      // Если знаем username бота — сверяем
      if (botUsername) {
        return String(replyFrom.username || "").toLowerCase() === botUsername.toLowerCase();
      }

      // Если username не задан — считаем reply на любого бота как вызов
      return true;
    })();
    const rawText = String(message.text || "");
    const startsWithSlash = rawText.trim().startsWith("/");

    // В группах считаем командой ТОЛЬКО команды, адресованные этому боту (/cmd@bot)
    const invokedByCommand = isGroup
      ? Boolean(startsWithSlash && botUsername && rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`))
      : Boolean(startsWithSlash);

    const invokedByMention = botUsername
      ? rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`)
      : false;

    // Если мы вызываемся в группе через @mention — убираем упоминание из текста, чтобы ИИ не путался
    if (isGroup && invokedByMention && typeof message.text === "string" && botUsername) {
      message.text = message.text.replace(new RegExp(`@${botUsername}\\b`, "ig"), "").trim();
    }

    // Если бот в этой группе выключен — молчим, но один раз покажем как включить
    if (isGroup && !groupEnabled) {
      const key = String(message.chat.id) + ":off";
      if (!shownGroupHintChats.has(key)) {
        shownGroupHintChats.add(key);
        try {
          await bot.sendMessage(
            message.chat.id,
            chatLogic.getGroupModeText({ enabled: false, botUsername }),
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🔔 Включить меня здесь",
                      callback_data: "group_mode_on",
                    },
                  ],
                ],
              },
            }
          );
        } catch {}
      }
      return;
    }

    // Если в группе не вызвали — не отвечаем по теме, но один раз подскажем как вызвать
    if (isGroup && !(invokedByReply || invokedByMention || invokedByCommand)) {
      const key = String(message.chat.id);
      if (!shownGroupHintChats.has(key)) {
        shownGroupHintChats.add(key);
        try {
          await bot.sendMessage(
            message.chat.id,
            `👥 *Я в режиме группы.*\n\n` +
              `Чтобы я ответил — вызовите меня:\n` +
              `• reply на моё сообщение\n` +
              `• или упомяните *@${botUsername || "бот"}*\n` +
              `• или используйте команду /...\n\n` +
              `В личке можно писать просто сообщением 🙂\n\n` +
              `⚙️ Подсказка: режим группы можно выключить кнопкой ниже.`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🔕 Отключить меня здесь",
                      callback_data: "group_mode_off",
                    },
                    {
                      text: "👥 Настройки группы",
                      callback_data: "group_settings",
                    },
                  ],
                ],
              },
            }
          );
        } catch {}
      }
      return;
    }

    // meta для aiService: чтобы он менял тон/правила в ЛС и группах
    const aiMeta = {
      chatType,
      chatTitle,
      botUsername,
      isGroup,
      invokedByReply,
      invokedByMention,
      invokedByCommand,
      // чтобы aiService мог слегка менять стиль/краткость
      mode: isGroup ? "group" : "private",
    };

    try {
      const userId = message.from.id;
      const text = message.text;
      const chatId = message.chat.id;

      if (!text) return;

      // ============================
      //  ЛИЧКА: автоответчик (DM)
      // ============================
      // Тут мы НЕ отвечаем сразу, а ставим задачу «ответить позже».
      // Важно: Telegram-бот НЕ может отвечать "за пользователя" в чужих личных диалогах.
      // Этот автоответчик — про задержанный ответ бота в ЛС с ботом.
      if (chatType === "private" && !isGroup) {
        const cleanText = String(text || "").trim();

        // Не автоотвечаем на команды
        if (!cleanText.startsWith("/")) {
          const cfg = await getDmAutoConfigSafe(userId);

          // По умолчанию выключено
          if (cfg?.enabled) {
            // 10–20 секунд (как вы выбрали в UX)
            const delaySeconds = clamp(Number(cfg.delaySeconds ?? 10), 10, 20);

            // анти-спам: не чаще 1 задачи на чат раз в 5 секунд
            const dmKey = `${String(userId)}:${String(chatId)}`;
            const lastAt = dmLastJobAt.get(dmKey) || 0;
            if (Date.now() - lastAt < 5000) {
              return; // молчим
            }
            dmLastJobAt.set(dmKey, Date.now());

            // лимит диалогов (если таблицы есть)
            // 5 диалогов без подписки, больше — с подпиской (можно будет вынести в конфиг)
            let maxDialogs = 5;
            try {
              const userRow = await prisma.user.findUnique({
                where: { telegramId: String(userId) },
                select: { subscriptionTil: true },
              });
              const now2 = new Date();
              const activeSub2 =
                userRow?.subscriptionTil && new Date(userRow.subscriptionTil) > now2;
              if (activeSub2) maxDialogs = 20;
            } catch {}

            // если dmChat модель существует — проверяем сколько включённых диалогов
            try {
              const enabledCount = await prisma.dmChat.count({
                where: { userTelegramId: String(userId), enabled: true },
              });
              if (enabledCount >= maxDialogs) {
                try {
                  await bot.sendMessage(
                    chatId,
                    `⚠️ Лимит подключённых диалогов: *${maxDialogs}*\n\n` +
                      `Отключите один диалог или оформите подписку, чтобы увеличить лимит.`,
                    {
                      parse_mode: "Markdown",
                      reply_markup: {
                        inline_keyboard: [[{ text: "💳 Подписка", callback_data: "menu_sub" }]],
                      },
                    }
                  );
                } catch {}
                return;
              }
            } catch {
              // если модели нет — просто продолжаем
            }

            // фиксируем чат как "подключённый" (если модель есть)
            await upsertDmChatSafe({
              userTelegramId: userId,
              chatTelegramId: chatId,
              title: chatTitle,
            });

            // создаём задачу в очереди (если модель есть)
            const job = await createDmReplyJobSafe({
              userTelegramId: userId,
              chatTelegramId: chatId,
              incomingText: cleanText,
              delaySeconds,
            });

            // Подсказка пользователю (показываем всегда, когда режим включён)
            try {
              await bot.sendMessage(
                chatId,
                `⏳ Ок, через *${delaySeconds} сек* пришлю черновик ответа.`,
                { parse_mode: "Markdown" }
              );
            } catch {}

            // Если очередь/таблица ещё не заведена — делаем fallback через setTimeout,
            // НО обычный AI-ответ НЕ отправляем (иначе будет два сообщения).
            if (!job) {
              setTimeout(async () => {
                try {
                  const prompt =
                    `Сделай черновик ответа на сообщение собеседника. ` +
                    `Ответ должен быть готов к копированию и отправке, без пояснений.` +
                    `\n\nСообщение собеседника:\n"${cleanText}"`;

                  const draft = await aiService.generateReply(userId, prompt, {
                    ...aiMeta,
                    mode: "dm_draft",
                  });

                  await bot.sendMessage(
                    chatId,
                    `📝 *Черновик ответа:*\n\n${draft}\n\n_(Скопируй и отправь собеседнику)_`,
                    { parse_mode: "Markdown" }
                  );
                } catch (e) {
                  console.error("dm draft fallback error:", e);
                }
              }, delaySeconds * 1000);

              return; // критично: НЕ идём дальше к обычному AI-ответу
            }

            // Если job создался — дальше ответ отправит воркер/cron по таблице dmReplyJob.
            return;
          }
        }
      }

      // ====== СЕКРЕТАРСКАЯ КОМАНДА: "ответь вежливо" ======
if (text.toLowerCase() === "ответь вежливо") {
  const last = await prisma.messageLog.findFirst({
    where: {
      user: { telegramId: String(userId) }
    },
    orderBy: { createdAt: "desc" }
  });

  if (!last) {
    return bot.sendMessage(
      chatId,
      "❌ Не нашёл сообщение, к которому нужно ответить."
    );
  }

  const politePrompt =
    `Переформулируй сообщение в вежливом и корректном тоне.\n\n` +
    `Сообщение:\n"${last.incomingText}"\n\n` +
    `Ответ должен быть готовым к отправке.`;

  const politeReply = await aiService.generateReply(userId, politePrompt, aiMeta);

  return bot.sendMessage(
    chatId,
    `💬 *Вежливый вариант ответа:*\n\n${politeReply}`,
    { parse_mode: "Markdown" }
  );
}

// пример: пользователь пишет "ответь коротко"
if (text.toLowerCase().includes("ответь коротко")) {
  const last = await prisma.messageLog.findFirst({
    where: { user: { telegramId: String(userId) } },
    orderBy: { createdAt: "desc" },
  });

  const lastIncoming = last?.incomingText || "";

  const prompt =
    `Сгенерируй короткий ответ (1-2 предложения) на сообщение:\n` +
    `"${lastIncoming}"\n\n` +
    `Только текст ответа, без пояснений.`;

  const aiReply = await aiService.generateReply(userId, prompt, aiMeta);

  return bot.sendMessage(chatId, `✍️ *Короткий вариант ответа:*\n\n"${aiReply}"`, {
    parse_mode: "Markdown",
  });
}

if (text.trim().toLowerCase() === "ответь по делу") {
  const last = await prisma.messageLog.findFirst({
    where: { user: { telegramId: String(userId) } },
    orderBy: { createdAt: "desc" },
  });

  const lastIncoming = last?.incomingText || "";

  const prompt =
    `Напиши ответ по делу (2-4 предложения), без воды и лишних эмоций.\n` +
    `Исходное сообщение:\n"${lastIncoming}"\n\n` +
    `Только текст ответа, без пояснений.`;

  const aiReply = await aiService.generateReply(userId, prompt, aiMeta);

  return bot.sendMessage(chatId, `✅ *Ответ по делу:*\n\n"${aiReply}"`, {
    parse_mode: "Markdown",
  });
}

if (text.trim().toLowerCase() === "ответь строго") {
  const last = await prisma.messageLog.findFirst({
    where: { user: { telegramId: String(userId) } },
    orderBy: { createdAt: "desc" },
  });

  const lastIncoming = last?.incomingText || "";

  const prompt =
    `Сформулируй строгий, официальный ответ (1–2 предложения), без эмоций.\n` +
    `Исходное сообщение:\n"${lastIncoming}"\n\n` +
    `Только текст ответа.`;

  const aiReply = await aiService.generateReply(userId, prompt, aiMeta);

  return bot.sendMessage(chatId, `📎 *Строгий ответ:*\n\n"${aiReply}"`, {
    parse_mode: "Markdown",
  });
}

if (text.trim().toLowerCase() === "ответь с юмором") {
  const last = await prisma.messageLog.findFirst({
    where: { user: { telegramId: String(userId) } },
    orderBy: { createdAt: "desc" },
  });

  const lastIncoming = last?.incomingText || "";

  const prompt =
    `Напиши дружелюбный ответ с лёгким юмором (1–3 предложения).\n` +
    `Юмор должен быть уместным и ненавязчивым.\n\n` +
    `Исходное сообщение:\n"${lastIncoming}"\n\n` +
    `Только текст ответа.`;

  const aiReply = await aiService.generateReply(userId, prompt, aiMeta);

  return bot.sendMessage(chatId, `😄 *Ответ с юмором:*\n\n"${aiReply}"`, {
    parse_mode: "Markdown",
  });
}

if (text.trim().toLowerCase() === "откажи вежливо") {
  const last = await prisma.messageLog.findFirst({
    where: { user: { telegramId: String(userId) } },
    orderBy: { createdAt: "desc" },
  });

  const lastIncoming = last?.incomingText || "";

  const prompt =
    `Сформулируй вежливый отказ.\n` +
    `Тон спокойный, уважительный, без резкости.\n` +
    `1–3 предложения, без лишних объяснений.\n\n` +
    `Исходное сообщение:\n"${lastIncoming}"\n\n` +
    `Только текст ответа.`;

  const aiReply = await aiService.generateReply(userId, prompt, aiMeta);

  return bot.sendMessage(chatId, `🙏 *Вежливый отказ:*\n\n"${aiReply}"`, {
    parse_mode: "Markdown",
  });
}

if (text.trim().toLowerCase() === "перепиши мягче") {
  const last = await prisma.messageLog.findFirst({
    where: { user: { telegramId: String(userId) } },
    orderBy: { createdAt: "desc" },
  });

  const lastIncoming = last?.incomingText || "";

  if (!lastIncoming) {
    return bot.sendMessage(chatId, "❌ Не нашёл текст, который нужно переписать.");
  }

  const prompt =
    `Перепиши текст так, чтобы он звучал мягче и дружелюбнее.\n` +
    `Смысл сохранить, без лишней воды.\n\n` +
    `Текст:\n"${lastIncoming}"\n\n` +
    `Только переписанный вариант.`;

  const aiReply = await aiService.generateReply(userId, prompt, aiMeta);

  return bot.sendMessage(chatId, `🫶 *Мягче:*\n\n"${aiReply}"`, {
    parse_mode: "Markdown",
  });
}

if (text.trim().toLowerCase() === "скажи что занят") {
  const last = await prisma.messageLog.findFirst({
    where: { user: { telegramId: String(userId) } },
    orderBy: { createdAt: "desc" },
  });

  const lastIncoming = last?.incomingText || "";

  const prompt =
    `Сформулируй короткий автоответ, что я сейчас занят и отвечу позже.\n` +
    `Тон: вежливо, спокойно, без лишних деталей.\n` +
    `1–2 предложения.\n` +
    (lastIncoming
      ? `\nКонтекст: мне написали сообщение "${lastIncoming}".`
      : "") +
    `\n\nТолько текст ответа.`;

  const aiReply = await aiService.generateReply(userId, prompt, aiMeta);

  return bot.sendMessage(chatId, `⏳ *Я занят — вариант ответа:*\n\n"${aiReply}"`, {
    parse_mode: "Markdown",
  });
}

if (text.trim().toLowerCase() === "список команд") {
  const commandsText =
    "📌 *Секретарские команды:*\n\n" +
    "• `ответь вежливо` — вежливый вариант ответа\n" +
    "• `ответь коротко` — 1–2 предложения\n" +
    "• `ответь по делу` — конкретно, без воды\n" +
    "• `ответь строго` — официально и сухо\n" +
    "• `ответь с юмором` — лёгко и дружелюбно\n" +
    "• `откажи вежливо` — корректный отказ\n" +
    "• `перепиши мягче` — смягчить формулировку\n" +
    "• `скажи что занят` — автоответ “занят, отвечу позже”\n\n" +
    "Напиши любую команду — и я подготовлю готовый текст ответа.";

  return bot.sendMessage(chatId, commandsText, {
    parse_mode: "Markdown",
  });
}

      // ==== 1) Достаём юзера ====
      const user = await prisma.user.findUnique({
        where: { telegramId: String(userId) },
      });

      const now = new Date();
      const activeSub =
        user?.subscriptionTil && new Date(user.subscriptionTil) > now;

      // ==== 2) Бесплатный лимит, если подписки нет ====
      if (!activeSub) {
        const used = await prisma.messageLog.count({
          where: { user: { telegramId: String(userId) } },
        });

        // предупреждения
        if (used === 15 || used === 19) {
          await bot.sendMessage(
            chatId,
            `⚠️ Осталось бесплатных ответов: ${FREE_LIMIT - used}`,
            { parse_mode: "Markdown" }
          );
        }

        // лимит закончился
        if (used >= FREE_LIMIT) {
          return bot.sendMessage(
            chatId,
            `❌ Бесплатные ответы закончились (${FREE_LIMIT}/${FREE_LIMIT}).\n\n` +
              `💳 Чтобы продолжить — оформите подписку:`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "💳 Подписка", callback_data: "menu_sub" }],
                ],
              },
            }
          );
        }
      }

      // NOTE: если включён DM-автоответчик — мы уже сделали `return` выше после постановки задачи.
      // До этого места доходит только обычный режим (ответ сразу).
      // ==== 3) Генерируем ответ ИИ ====
      const aiReply = await aiService.generateReply(userId, text, aiMeta);
      await bot.sendMessage(chatId, aiReply);

      // 👥 UX: в группах один раз показываем, что «режим группы» включён и его можно выключить
      if (isGroup) {
        const key = String(chatId) + ":controls";
        if (!shownGroupControlsChats.has(key)) {
          shownGroupControlsChats.add(key);
          try {
            await bot.sendMessage(
              chatId,
              chatLogic.getGroupModeText({ enabled: true, botUsername }),
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "🔕 Отключить меня здесь", callback_data: "group_mode_off" },
                      { text: "👥 Настройки группы", callback_data: "group_settings" },
                    ],
                  ],
                },
              }
            );
          } catch {}
        }
      }

      // ==== 4) Сохраняем лог ====
      await prisma.messageLog.create({
        data: {
          user: { connect: { telegramId: String(userId) } },
          incomingText: text,
          replyText: aiReply,
          chatTelegramId: String(chatId),
        },
      });
    } catch (err) {
      console.error("❌ Ошибка в chatLogic:", err);
    }
  },
};