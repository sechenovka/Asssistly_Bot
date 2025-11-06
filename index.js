// index.js (ESM)
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';

const PORT = Number(process.env.PORT || 4010);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is missing in .env');
  process.exit(1);
}
if (!TELEGRAM_WEBHOOK_SECRET) {
  console.error('❌ TELEGRAM_WEBHOOK_SECRET is missing in .env');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const app = express();
app.use(express.json());

// init openai client only if key present
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post(`/webhook/${TELEGRAM_WEBHOOK_SECRET}`, async (req, res) => {
  res.status(200).json({ ok: true }); // отвечаем Telegram быстро
  try {
    const update = req.body;
    console.log('➡️  Incoming update:', update.update_id ?? '(no id)');

    const message = update.message;
    if (!message || !message.text || !message.chat) {
      console.log('ℹ️  Not a text message — ignoring');
      return;
    }

    const chatId = message.chat.id;
    const userText = message.text.trim();
    console.log(`📨 from chat ${chatId}:`, userText.slice(0, 300));

    let replyText = '';

    // если есть ключ — используем OpenAI
    if (openai) {
      try {
        const resp = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: 'system', content: 'Ты дружелюбный Telegram-бот помощник по имени Данька.' },
            { role: 'user', content: userText },
          ],
          max_tokens: 600,
        });
        replyText = resp.choices?.[0]?.message?.content?.trim() ?? 'Извини, пустой ответ от ИИ.';
      } catch (err) {
        console.error('❌ OpenAI error:', err?.message || err);
        replyText = 'Извини, не смог обратиться к ИИ — попробуй позже.';
      }
    } else {
      // демо-режим (имитация интеллекта)
      const lower = userText.toLowerCase();
      if (lower.includes('привет')) replyText = 'Привет, я Данька 🤖! Чем помочь?';
      else if (lower.includes('как дела')) replyText = 'Всё отлично — бот на месте и готов помогать!';
      else if (lower.includes('кто ты')) replyText = 'Я бот-помощник, созданный Даней.';
      else replyText = `Интересно — ты сказал: "${userText}"`;
    }

    // отправляем ответ в Telegram
    try {
      const sendResp = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: replyText,
      });
      if (!sendResp.data?.ok) {
        console.error('❌ Telegram sendMessage failed:', sendResp.data);
      } else {
        console.log('✅ Replied to chat', chatId);
      }
    } catch (err) {
      console.error('❌ Error sending message to Telegram:', err?.response?.data || err.message);
    }
  } catch (err) {
    console.error('🔥 Handler unexpected error:', err);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🔒 Webhook endpoint: /webhook/${TELEGRAM_WEBHOOK_SECRET}`);
});