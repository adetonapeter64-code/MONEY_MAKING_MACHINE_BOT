
"use strict";

require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

app.use(express.json());

const EMOJI = {
  bot: "🤖",
  gold: "🪙",
  target: "🎯",
  scan: "🔎",
  rocket: "🚀",
  warning: "⚠️",
  check: "✅"
};

// Central message helper: every bot message starts with an emoji.
function formatMessage(message) {
  return `🤖 BOT.XAU SNIPER ENTRY\n\n${message}`;
}

let bot = null;
let botReady = false;

if (TOKEN) {
  bot = new TelegramBot(TOKEN, { polling: true });
  botReady = true;

  bot.onText(/^\/start$/, async (msg) => {
    const welcome = formatMessage(
      "👋 Welcome to your XAUUSD Sniper Entry Bot!\n\n" +
      "🪙 Market: XAUUSD (GOLD) only\n" +
      "🎯 Strategy: BOS, CHOCH, liquidity, order blocks and FVG\n\n" +
      "📋 Commands:\n" +
      "/status - Check bot status\n" +
      "/analyze - Check market-data connection\n" +
      "/help - Show available commands\n\n" +
      "⏳ Automatic signal generation will be enabled after the strategy is configured."
    );

    await bot.sendMessage(msg.chat.id, welcome);
  });

  bot.onText(/^\/help$/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      formatMessage(
        "📋 Available commands\n\n" +
        "🔹 /start — Welcome message\n" +
        "🔹 /status — Bot and configuration status\n" +
        "🔹 /analyze — Check market-data availability\n" +
        "🔹 /help — Show these instructions\n\n" +
        "🛡️ No trade is recommended until the strategy confirms a valid setup."
      )
    );
  });

  bot.onText(/^\/status$/, async (msg) => {
    const marketReady = Boolean(process.env.TWELVE_DATA_KEY);

    await bot.sendMessage(
      msg.chat.id,
      formatMessage(
        `${EMOJI.check} Telegram connection: Active\n` +
        `${marketReady ? "✅" : "⚠️"} Market-data API key: ${marketReady ? "Configured" : "Not configured"}\n` +
        "🪙 Market: XAUUSD only\n" +
        "🎯 Sniper strategy: Setup pending\n" +
        "📡 Automatic signals: Not enabled yet"
      )
    );
  });

  bot.onText(/^\/analyze$/, async (msg) => {
    const key = process.env.TWELVE_DATA_KEY;

    if (!key) {
      await bot.sendMessage(
        msg.chat.id,
        formatMessage(
          "⚠️ Market-data API key is missing.\n\n" +
          "🔐 Add TWELVE_DATA_KEY to your hosting environment before analyzing gold."
        )
      );
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      formatMessage(
        "🔎 Market-data key detected.\n" +
        "⏳ Live XAUUSD retrieval and sniper confirmations will be added next.\n\n" +
        "⚠️ This is not a BUY or SELL signal."
      )
    );
  });

  bot.on("polling_error", (error) => {
    console.error("Telegram polling error:", error.message);
  });

  bot.on("message", (msg) => {
    if (msg.text && !msg.text.startsWith("/")) {
      bot.sendMessage(
        msg.chat.id,
        formatMessage("👋 Message received! Send /help to see available commands.")
      ).catch((error) => console.error("Reply error:", error.message));
    }
  });
} else {
  console.error("⚠️ TELEGRAM_BOT_TOKEN is missing.");
}

app.get("/", (_req, res) => {
  res.status(200).send(
    "🤖 BOT.XAU Sniper Entry Bot is running. 🪙 XAUUSD only."
  );
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    telegramConfigured: botReady,
    marketDataConfigured: Boolean(process.env.TWELVE_DATA_KEY),
    strategyReady: false,
    automaticSignalsEnabled: false
  });
});

app.listen(PORT, () => {
  console.log(`🚀 BOT.XAU server listening on port ${PORT}`);
});
