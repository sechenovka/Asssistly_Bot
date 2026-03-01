import TelegramBot from "node-telegram-bot-api";
import { registerHandlers } from "./handlers/index.js";

export const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: false, // работаем через webhook
});

console.log("🤖 Bot initialized");

// Подключаем все обработчики
registerHandlers(bot);