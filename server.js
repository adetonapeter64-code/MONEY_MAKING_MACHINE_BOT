const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

app.get("/", (req, res) => {
  res.send("MONEY MAKING MACHINE BOT is running.");
});

// Users who want automatic signals
const subscribers = new Set();

// Prevent duplicate alerts
let lastSignal = null;

async function getGoldPrice() {
  const response = await axios.get(
    "https://xaus.com/api/v1/spot?compact=1",
    { timeout: 10000 }
  );

  const data = response.data;

  if (!data.xau || !data.xau.price) {
    throw new Error("Invalid XAUUSD data");
  }

  return Number(data.xau.price);
}

// START
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🔥 MONEY MAKING MACHINE BOT

📊 XAUUSD Trading Signals

Use:

/signal - Check market
/price - Current XAUUSD price
/auto - Enable automatic signals
/stop - Stop automatic signals

🎯 Target: 200–300 pips`
  );
});

// PRICE
bot.onText(/\/price/, async (msg) => {
  try {
    const price = await getGoldPrice();

    bot.sendMessage(
      msg.chat.id,
      `🪙 XAUUSD LIVE PRICE

💰 ${price.toFixed(2)}

📡 Live market data connected.`
    );
  } catch (error) {
    bot.sendMessage(
      msg.chat.id,
      "⚠️ Unable to retrieve XAUUSD price."
    );
  }
});

// ENABLE AUTO SIGNALS
bot.onText(/\/auto/, (msg) => {
  subscribers.add(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    `🔔 AUTOMATIC SIGNALS ENABLED

I will monitor XAUUSD automatically.

You will be notified when a complete entry setup is confirmed.

📊 BOS / CHoCH
🟨 FVG
🟦 Order Block
🎯 200–300 pip target`
  );
});

// STOP AUTO SIGNALS
bot.onText(/\/stop/, (msg) => {
  subscribers.delete(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    "🔕 Automatic XAUUSD signals have been stopped."
  );
});

// MANUAL MARKET CHECK
bot.onText(/\/signal/, async (msg) => {
  try {
    const price = await getGoldPrice();

    bot.sendMessage(
      msg.chat.id,
      `🔎 XAUUSD MARKET CHECK

💰 Current price: ${price.toFixed(2)}

📡 Live market data connected.

⏳ Waiting for confirmation...`
    );
  } catch (error) {
    bot.sendMessage(
      msg.chat.id,
      "⚠️ Market data temporarily unavailable."
    );
  }
});

// AUTOMATIC MARKET MONITOR
async function monitorMarket() {
  try {
    const price = await getGoldPrice();

    console.log(
      `[MARKET] XAUUSD: ${price.toFixed(2)}`
    );

    // Signal engine will be connected here next.
    // No signal is generated until confirmation rules are met.

  } catch (error) {
    console.error(
      "Market monitor error:",
      error.message
    );
  }
}

// Check every 30 seconds
setInterval(monitorMarket, 30000);

// Initial check
monitorMarket();

app.listen(PORT, () => {
  console.log(
    "MONEY MAKING MACHINE BOT running on port " + PORT
  );
});
