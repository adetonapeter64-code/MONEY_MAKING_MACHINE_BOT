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


// ================================================================
// CANDLE BUILDER
// ================================================================
// The free price API only returns the CURRENT spot price, not a
// history of candles. So this bot builds its own candle history by
// sampling the live price every 30 seconds and grouping those ticks
// into 5-minute candles (10 ticks per candle).
//
// IMPORTANT: because history has to be built from scratch, the
// signal engine needs a couple of hours of uptime before it has
// enough candles to find real market structure. It will not (and
// should not) fire signals the moment it starts up.
// ================================================================

const TICKS_PER_CANDLE = 10; // 10 x 30s = 5 minutes per candle
const MAX_CANDLES = 300;     // keep roughly the last 25 hours

let currentTicks = [];
let candles = []; // { open, high, low, close, time }

function addTick(price) {
  currentTicks.push(price);

  if (currentTicks.length >= TICKS_PER_CANDLE) {
    const open = currentTicks[0];
    const close = currentTicks[currentTicks.length - 1];
    const high = Math.max(...currentTicks);
    const low = Math.min(...currentTicks);

    candles.push({ open, high, low, close, time: Date.now() });
    if (candles.length > MAX_CANDLES) candles.shift();

    currentTicks = [];

    // A candle just closed - re-run the signal engine
    analyzeMarket();
  }
}


// ================================================================
// SWING HIGH / LOW DETECTION (fractals)
// ================================================================
// A candle counts as a swing high if its high is greater than the
// `lookback` candles immediately before AND after it. Same idea,
// inverted, for swing lows. This is the standard way to find the
// "structure points" that BOS/CHoCH are measured against.
// ================================================================

function findSwings(lookback = 2) {
  const swings = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];

    const isHigh = slice.every(s => s.high <= c.high);
    const isLow = slice.every(s => s.low >= c.low);

    if (isHigh) swings.push({ index: i, price: c.high, type: "high" });
    if (isLow) swings.push({ index: i, price: c.low, type: "low" });
  }

  return swings;
}


// ================================================================
// FAIR VALUE GAP (FVG) DETECTION
// ================================================================
// Bullish FVG: candle[i-2]'s high sits below candle[i]'s low - an
// unfilled gap left behind by an impulsive move up.
// Bearish FVG: candle[i-2]'s low sits above candle[i]'s high.
// ================================================================

function findFVG(startIndex, direction) {
  for (let i = startIndex; i >= 2 && i >= startIndex - 5; i--) {
    const c1 = candles[i - 2];
    const c3 = candles[i];

    if (direction === "bullish" && c1.high < c3.low) {
      return { top: c3.low, bottom: c1.high, index: i };
    }
    if (direction === "bearish" && c1.low > c3.high) {
      return { top: c1.low, bottom: c3.high, index: i };
    }
  }
  return null;
}


// ================================================================
// ORDER BLOCK DETECTION
// ================================================================
// The last opposite-colored candle right before the impulsive move
// that broke structure - the classic ICT "order block" zone.
// ================================================================

function findOrderBlock(breakIndex, direction) {
  for (let i = breakIndex; i >= 0 && i >= breakIndex - 6; i--) {
    const c = candles[i];
    const isBearishCandle = c.close < c.open;
    const isBullishCandle = c.close > c.open;

    if (direction === "bullish" && isBearishCandle) {
      return { top: c.high, bottom: c.low, index: i };
    }
    if (direction === "bearish" && isBullishCandle) {
      return { top: c.high, bottom: c.low, index: i };
    }
  }
  return null;
}


// ================================================================
// SIGNAL ENGINE STATE
// ================================================================

let pendingSetup = null; // { direction, label, fvg, orderBlock, breakLevel, createdAt }
let lastSignalTime = 0;
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // don't spam - 30 min minimum between signals
const SETUP_EXPIRY_MS = 3 * 60 * 60 * 1000; // drop an unconfirmed setup after 3 hours

const PIP_SIZE = 0.1; // XAUUSD convention used here: 1 "pip" = $0.10 move
const TP_PIPS_MIN = 200;
const TP_PIPS_MAX = 300;


// ================================================================
// MAIN ANALYSIS - runs every time a new 5-minute candle closes
// ================================================================

function analyzeMarket() {
  if (candles.length < 20) return; // not enough history yet

  const swings = findSwings(2);
  if (swings.length < 4) return;

  const swingHighs = swings.filter(s => s.type === "high");
  const swingLows = swings.filter(s => s.type === "low");

  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1];
  const prevLow = swingLows[swingLows.length - 2];

  if (!lastHigh || !prevHigh || !lastLow || !prevLow) return;

  // Current structure/trend based on the last two swing points
  const structureBullish = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
  const structureBearish = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

  const latestClose = candles[candles.length - 1].close;
  const latestIndex = candles.length - 1;

  const brokeAboveHigh = latestClose > lastHigh.price;
  const brokeBelowLow = latestClose < lastLow.price;

  // Bullish break: BOS if structure was already bullish, CHoCH if it
  // was bearish (a break like this signals a possible reversal).
  if (brokeAboveHigh && !pendingSetup) {
    const fvg = findFVG(latestIndex, "bullish");
    if (fvg) {
      const ob = findOrderBlock(fvg.index, "bullish");
      pendingSetup = {
        direction: "bullish",
        label: structureBullish ? "BOS" : "CHoCH",
        fvg,
        orderBlock: ob,
        structureLow: lastLow.price,
        createdAt: Date.now()
      };
      console.log(`[SETUP] Bullish ${pendingSetup.label} detected @ ${latestClose}`);
    }
  }

  if (brokeBelowLow && !pendingSetup) {
    const fvg = findFVG(latestIndex, "bearish");
    if (fvg) {
      const ob = findOrderBlock(fvg.index, "bearish");
      pendingSetup = {
        direction: "bearish",
        label: structureBearish ? "BOS" : "CHoCH",
        fvg,
        orderBlock: ob,
        structureHigh: lastHigh.price,
        createdAt: Date.now()
      };
      console.log(`[SETUP] Bearish ${pendingSetup.label} detected @ ${latestClose}`);
    }
  }

  // If a setup is pending, watch for price retracing back into the
  // FVG / order block zone with a confirming candle before firing.
  if (pendingSetup) {

    if (Date.now() - pendingSetup.createdAt > SETUP_EXPIRY_MS) {
      console.log("[SETUP] Expired without confirmation");
      pendingSetup = null;
      return;
    }

    const zoneTop = pendingSetup.orderBlock ? pendingSetup.orderBlock.top : pendingSetup.fvg.top;
    const zoneBottom = pendingSetup.orderBlock ? pendingSetup.orderBlock.bottom : pendingSetup.fvg.bottom;

    const priceInZone = latestClose <= zoneTop && latestClose >= zoneBottom;

    if (priceInZone) {
      const confirmCandle = candles[candles.length - 1];
      const bullishConfirm = pendingSetup.direction === "bullish" && confirmCandle.close > confirmCandle.open;
      const bearishConfirm = pendingSetup.direction === "bearish" && confirmCandle.close < confirmCandle.open;

      if (bullishConfirm || bearishConfirm) {
        fireSignal(pendingSetup, latestClose);
        pendingSetup = null;
      }
    }
  }
}


// ================================================================
// FIRE SIGNAL - broadcast the confirmed entry to all subscribers
// ================================================================

function fireSignal(setup, entryPrice) {

  if (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS) {
    console.log("[SIGNAL] Skipped - cooldown active");
    return;
  }
  lastSignalTime = Date.now();

  const direction = setup.direction === "bullish" ? "BUY" : "SELL";
  const emoji = setup.direction === "bullish" ? "🟢" : "🔴";

  const tpDistance = ((TP_PIPS_MIN + TP_PIPS_MAX) / 2) * PIP_SIZE; // midpoint of 200-300 pip range

  let stopLoss, takeProfit;

  if (setup.direction === "bullish") {
    stopLoss = (setup.orderBlock ? setup.orderBlock.bottom : setup.structureLow) - 1;
    takeProfit = entryPrice + tpDistance;
  } else {
    stopLoss = (setup.orderBlock ? setup.orderBlock.top : setup.structureHigh) + 1;
    takeProfit = entryPrice - tpDistance;
  }

  const message =
`🚨 XAUUSD SIGNAL - ${setup.label}

${emoji} ${direction} @ ${entryPrice.toFixed(2)}

🛡️ Stop Loss: ${stopLoss.toFixed(2)}
🎯 Take Profit: ${takeProfit.toFixed(2)}
📏 Target: ~${TP_PIPS_MIN}-${TP_PIPS_MAX} pips

📊 Confirmed by:
• Market Structure (${setup.label})
• Fair Value Gap
• Order Block retest + confirmation candle

⚠️ Always manage your own risk. This is not financial advice.`;

  console.log(`[SIGNAL FIRED] ${direction} @ ${entryPrice}`);

  for (const chatId of subscribers) {
    bot.sendMessage(chatId, message).catch(err => {
      console.error(`Failed to send signal to ${chatId}:`, err.message);
    });
  }
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
      const status = pendingSetup
        ? `👀 Watching a ${pendingSetup.label} ${pendingSetup.direction.toUpperCase()} setup - waiting for retest confirmation.`
        : candles.length < 20
          ? `⏳ Still building candle history (${candles.length}/20 candles). Give the bot a bit more uptime.`
          : `🔎 No active setup right now - scanning every 5 minutes.`;

      await bot.sendMessage(
        msg.chat.id,

`🔎 XAUUSD MARKET CHECK

💰 Current Price: ${price.toFixed(2)}

📡 Live market data connected.

${status}

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

You don't need to keep typing /signal.

Note: the bot builds its own candle history from live prices, so the first real setups may take a couple of hours to appear after each restart.`
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
Swing highs/lows used as structure points

🟨 Fair Value Gap
FVG confirmation

🟦 Order Block
Potential institutional zone

✅ Entry Confirmation
Price must retest the FVG/order block zone with a confirming candle

🎯 Target
200–300 pip target range

🛡️ Risk
Stop Loss is calculated from the order block / structure point

🚨 When all required conditions are confirmed, the bot automatically sends an entry alert to everyone with Auto Signals on.

⏳ The bot builds its price history live, so it needs some uptime after each restart before it has enough candles to analyze.`
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
Automatic (5-minute candles built from live price)

📈 Signal Type
Technical confirmation (BOS/CHoCH + FVG + Order Block)

📉 Candles collected
${candles.length}

More settings will be added as the system develops.`
    );

  }

});


// ===============================
// AUTOMATIC MARKET MONITOR
// Runs every 30 seconds: fetches the live price and feeds it into
// the candle builder, which in turn triggers the signal engine
// whenever a new 5-minute candle closes.
// ===============================

async function monitorMarket() {

  try {

    const price = await getGoldPrice();

    console.log(
      `[MARKET] XAUUSD: ${price.toFixed(2)} | ticks: ${currentTicks.length + 1}/${TICKS_PER_CANDLE} | candles: ${candles.length}`
    );

    addTick(price);

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
