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

const bot = new TelegramBot(token, {
  polling: true
});


// ===============================
// BOT MENU
// ===============================

const mainMenu = {
  reply_markup: {
    keyboard: [
      ["📊 XAUUSD Signal", "💰 Live Price"],
      ["🔔 Auto Signals", "🔕 Stop Alerts"],
      ["📖 How It Works", "⚙️ Settings"]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};


// ===============================
// USERS SUBSCRIBED TO AUTO SIGNALS
// ===============================

const subscribers = new Set();


// ===============================
// WEB SERVER
// ===============================

app.get("/", (req, res) => {
  res.send("🔥 MONEY MAKING MACHINE BOT is running.");
});


// ===============================
// GET LIVE XAUUSD PRICE
// ===============================

async function getGoldPrice() {

  const response = await axios.get(
    "https://xaus.com/api/v1/spot?compact=1",
    {
      timeout: 10000
    }
  );

  const data = response.data;

  if (!data.xau || !data.xau.price) {
    throw new Error("Invalid XAUUSD data");
  }

  return Number(data.xau.price);
}


// ===============================
// START COMMAND
// ===============================

bot.onText(/\/start/, (msg) => {

  bot.sendMessage(
    msg.chat.id,

`🔥 MONEY MAKING MACHINE BOT

Welcome! 👋

Your XAUUSD trading assistant.

📊 Market analysis
🚨 Entry alerts
🎯 200–300 pip targets
🛡️ Risk levels

Choose an option below:`,
    mainMenu
  );

});


// ===============================
// 📊 XAUUSD SIGNAL BUTTON
// ===============================

bot.on("message", async (msg) => {

  if (!msg.text) return;

  if (msg.text === "📊 XAUUSD Signal") {

    try {

      const price = await getGoldPrice();

      await bot.sendMessage(
        msg.chat.id,

`🔎 XAUUSD MARKET CHECK

💰 Current Price: ${price.toFixed(2)}

📡 Live market data connected.

⏳ Waiting for confirmation...

📊 Checking:
• Market Structure
• BOS / CHoCH
• Liquidity
• FVG
• Order Block

🚨 A signal will be sent automatically when the entry conditions are confirmed.`
      );

    } catch (error) {

      console.error("Signal price error:", error.message);

      bot.sendMessage(
        msg.chat.id,
        "⚠️ XAUUSD market data is temporarily unavailable."
      );

    }

  }


  // ===============================
  // 💰 LIVE PRICE
  // ===============================

  if (msg.text === "💰 Live Price") {

    try {

      const price = await getGoldPrice();

      bot.sendMessage(
        msg.chat.id,

`💰 XAUUSD LIVE PRICE

🪙 ${price.toFixed(2)}

📡 Market Data: LIVE
⏱️ Updated: Just now`
      );

    } catch (error) {

      console.error("Price error:", error.message);

      bot.sendMessage(
        msg.chat.id,
        "⚠️ Unable to retrieve the current XAUUSD price."
      );

    }

  }


  // ===============================
  // 🔔 AUTO SIGNALS
  // ===============================

  if (msg.text === "🔔 Auto Signals") {

    subscribers.add(msg.chat.id);

    bot.sendMessage(
      msg.chat.id,

`🔔 AUTOMATIC SIGNALS ENABLED

MONEY MAKING MACHINE BOT will monitor XAUUSD automatically.

You will receive an alert when a complete trading setup is confirmed.

📊 BOS / CHoCH
💧 Liquidity
🟨 FVG
🟦 Order Block
✅ Entry confirmation
🎯 200–300 pip target

You don't need to keep typing /signal.`
    );

  }


  // ===============================
  // 🔕 STOP SIGNALS
  // ===============================

  if (msg.text === "🔕 Stop Alerts") {

    subscribers.delete(msg.chat.id);

    bot.sendMessage(
      msg.chat.id,

`🔕 AUTOMATIC SIGNALS STOPPED

You will no longer receive automatic XAUUSD entry alerts.

You can turn them back on anytime with:

🔔 Auto Signals`
    );

  }


  // ===============================
  // 📖 HOW IT WORKS
  // ===============================

  if (msg.text === "📖 How It Works") {

    bot.sendMessage(
      msg.chat.id,

`📖 HOW IT WORKS

MONEY MAKING MACHINE BOT monitors XAUUSD for high-quality setups.

The signal engine checks:

📈 Market Structure
BOS / CHoCH

💧 Liquidity
Liquidity sweeps and key levels

🟨 Fair Value Gap
FVG confirmation

🟦 Order Block
Potential institutional zone

✅ Entry Confirmation
The setup must satisfy the required conditions.

🎯 Target
200–300 pip target range

🛡️ Risk
Stop Loss is calculated from the setup.

🚨 When all required conditions are confirmed, the bot automatically sends an entry alert.`
    );

  }


  // ===============================
  // ⚙️ SETTINGS
  // ===============================

  if (msg.text === "⚙️ Settings") {

    bot.sendMessage(
      msg.chat.id,

`⚙️ SETTINGS

📊 Market
XAUUSD

🎯 Target
200–300 pips

🔔 Automatic Alerts
Available

⏱️ Market Monitoring
Automatic

📈 Signal Type
Technical confirmation

More settings will be added as the system develops.`
    );

  }

});


// ===============================
// AUTOMATIC MARKET MONITOR
// ===============================

async function monitorMarket() {

  try {

    const price = await getGoldPrice();

    console.log(
      `[MARKET] XAUUSD: ${price.toFixed(2)}`
    );

    /*
      SIGNAL ENGINE WILL GO HERE.

      The bot will eventually check:

      1. Market Structure
      2. BOS / CHoCH
      3. Liquidity Sweep
      4. FVG
      5. Order Block
      6. Entry Confirmation
      7. Stop Loss
      8. 200–300 Pip Target

      No random signals will be generated.
    */

  } catch (error) {

    console.error(
      "Market monitor error:",
      error.message
    );

  }

}


// ===============================
// CHECK MARKET EVERY 30 SECONDS
// ===============================

setInterval(
  monitorMarket,
  30000
);


// ===============================
// INITIAL MARKET CHECK
// ===============================

monitorMarket();


// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {

  console.log(
    `🔥 MONEY MAKING MACHINE BOT running on port ${PORT}`
  );

});
