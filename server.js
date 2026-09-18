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

async function getGoldPrice() {
  const response = await axios.get(
    "https://xaus.com/api/v1/spot?compact=1",
    { timeout: 10000 }
  );

  const data = response.data;

  if (!data.xau || !data.xau.price) {
    throw new Error("Invalid XAUUSD data");
  }

  return {
    price: Number(data.xau.price),
    status: data.data_state?.status || "unknown",
    updated: data.updated_at
  };
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🔥 MONEY MAKING MACHINE BOT

📊 XAUUSD Trading Signals

Commands:

/signal - Check XAUUSD
/price - Current gold price

🎯 Target range: 200–300 pips`
  );
});

bot.onText(/\/price/, async (msg) => {
  try {
    const gold = await getGoldPrice();

    bot.sendMessage(
      msg.chat.id,
      `🪙 XAUUSD LIVE PRICE

💰 Price: ${gold.price.toFixed(2)}
📡 Data: ${gold.status}
🕐 Updated: ${gold.updated}`
    );
  } catch (error) {
    console.error(error.message);

    bot.sendMessage(
      msg.chat.id,
      "⚠️ Unable to retrieve the current XAUUSD price right now."
    );
  }
});

bot.onText(/\/signal/, async (msg) => {
  try {
    const gold = await getGoldPrice();

    bot.sendMessage(
      msg.chat.id,
      `🔎 XAUUSD MARKET CHECK

💰 Current price: ${gold.price.toFixed(2)}

📡 Live market data connected.

⚠️ Signal engine is not active yet.

Next stage:
📈 Market structure
📊 BOS / CHoCH
🟨 FVG
🟦 Order Block
🎯 200–300 pip target

We will only generate a signal when the conditions are met.`
    );
  } catch (error) {
    console.error(error.message);

    bot.sendMessage(
      msg.chat.id,
      "⚠️ XAUUSD market data is temporarily unavailable."
    );
  }
});

app.listen(PORT, () => {
  console.log(`MONEY MAKING MACHINE BOT running on port ${PORT}`);
});
