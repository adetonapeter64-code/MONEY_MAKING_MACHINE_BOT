const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

app.get("/", (req, res) => {
  res.send("XAUUSD Trading Signals Bot is running.");
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🔥 XAUUSD TRADING SIGNALS

Welcome.

I will provide:
📊 XAUUSD market signals
🎯 200–300 pip targets
📈 BUY / SELL setups
🛑 Entry, SL & TP

Use /signal to request the latest setup.`
  );
});

bot.onText(/\/signal/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🔎 Analyzing XAUUSD market...\n\nSignal engine is being configured. 🚀"
  );
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
