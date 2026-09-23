const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 3000;
const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

const bot = new TelegramBot(token, {
  polling: true
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* =========================================================
   BOT SETTINGS
========================================================= */

const BOT_NAME = "MONEY MAKING MACHINE BOT";
const SYMBOL = "XAUUSD";

const PIP_SIZE = 0.1;

const TP_PIPS_MIN = 200;
const TP_PIPS_MAX = 300;

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
const SETUP_EXPIRY_MS = 3 * 60 * 60 * 1000;

const TICKS_PER_CANDLE = 10;
const MAX_CANDLES = 300;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

/* =========================================================
   DATA
========================================================= */

const subscribers = new Map();

const signalHistory = [];
const MAX_SIGNAL_HISTORY = 100;

const botStartedAt = Date.now();

let candles = [];
let currentTicks = [];

let pendingSetup = null;
let lastSignalTime = 0;

/* =========================================================
   TELEGRAM MENU
========================================================= */

const mainMenu = {
  reply_markup: {
    keyboard: [
      ["📊 XAUUSD Signal", "💰 Live Price"],
      ["🔕 Stop Alerts"],
      ["📖 How It Works", "⚙️ Settings"]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

/* =========================================================
   FORMATTERS
========================================================= */

function formatPrice(price) {
  return Number(price).toFixed(2);
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos"
  });
}

/* =========================================================
   GOLD PRICE
========================================================= */

async function getGoldPrice() {
  try {
    const response = await axios.get(
      "https://xaus.com/api/v1/spot?compact=1",
      {
        timeout: 10000
      }
    );

    const data = response.data;

    if (!data || !data.xau || !data.xau.price) {
      throw new Error("Invalid XAUUSD data");
    }

    const price = Number(data.xau.price);

    if (!Number.isFinite(price)) {
      throw new Error("Invalid XAUUSD price");
    }

    return price;
  } catch (error) {
    throw new Error(`XAUUSD price error: ${error.message}`);
  }
}

/* =========================================================
   CANDLE BUILDER
========================================================= */

function addTick(price) {
  currentTicks.push(price);

  if (currentTicks.length >= TICKS_PER_CANDLE) {
    const open = currentTicks[0];
    const close = currentTicks[currentTicks.length - 1];

    const high = Math.max(...currentTicks);
    const low = Math.min(...currentTicks);

    const candle = {
      open,
      high,
      low,
      close,
      time: Date.now()
    };

    candles.push(candle);

    if (candles.length > MAX_CANDLES) {
      candles.shift();
    }

    currentTicks = [];

    analyzeMarket();
  }
}

/* =========================================================
   CANDLE HELPERS
========================================================= */

function isBullish(candle) {
  return candle.close > candle.open;
}

function isBearish(candle) {
  return candle.close < candle.open;
}

function bodySize(candle) {
  return Math.abs(candle.close - candle.open);
}

function candleRange(candle) {
  return candle.high - candle.low;
}

function getRecentCandles(count = 20) {
  return candles.slice(-count);
}

/* =========================================================
   SWING DETECTION
========================================================= */

function findSwingHigh(index, strength = 2) {
  if (
    index < strength ||
    index >= candles.length - strength
  ) {
    return false;
  }

  const candle = candles[index];

  for (let i = 1; i <= strength; i++) {
    if (
      candle.high <= candles[index - i].high ||
      candle.high <= candles[index + i].high
    ) {
      return false;
    }
  }

  return true;
}

function findSwingLow(index, strength = 2) {
  if (
    index < strength ||
    index >= candles.length - strength
  ) {
    return false;
  }

  const candle = candles[index];

  for (let i = 1; i <= strength; i++) {
    if (
      candle.low >= candles[index - i].low ||
      candle.low >= candles[index + i].low
    ) {
      return false;
    }
  }

  return true;
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function getStructure() {
  if (candles.length < 15) {
    return null;
  }

  const highs = [];
  const lows = [];

  const start = Math.max(2, candles.length - 40);
  const end = candles.length - 2;

  for (let i = start; i <= end; i++) {
    if (findSwingHigh(i, 2)) {
      highs.push({
        price: candles[i].high,
        index: i,
        time: candles[i].time
      });
    }

    if (findSwingLow(i, 2)) {
      lows.push({
        price: candles[i].low,
        index: i,
        time: candles[i].time
      });
    }
  }

  if (highs.length < 2 || lows.length < 2) {
    return null;
  }

  const previousHigh = highs[highs.length - 2];
  const latestHigh = highs[highs.length - 1];

  const previousLow = lows[lows.length - 2];
  const latestLow = lows[lows.length - 1];

  let trend = "RANGE";

  if (
    latestHigh.price > previousHigh.price &&
    latestLow.price > previousLow.price
  ) {
    trend = "BULLISH";
  }

  if (
    latestHigh.price < previousHigh.price &&
    latestLow.price < previousLow.price
  ) {
    trend = "BEARISH";
  }

  return {
    trend,
    previousHigh,
    latestHigh,
    previousLow,
    latestLow
  };
}

/* =========================================================
   LIQUIDITY
========================================================= */

function detectLiquidity() {
  if (candles.length < 10) {
    return null;
  }

  const recent = getRecentCandles(10);

  const high = Math.max(...recent.map(c => c.high));
  const low = Math.min(...recent.map(c => c.low));

  const last = candles[candles.length - 1];

  if (last.high >= high) {
    return {
      type: "BUY_SIDE_LIQUIDITY",
      price: high
    };
  }

  if (last.low <= low) {
    return {
      type: "SELL_SIDE_LIQUIDITY",
      price: low
    };
  }

  return null;
}

/* =========================================================
   FVG DETECTION
========================================================= */

function detectFVG() {
  if (candles.length < 3) {
    return null;
  }

  const a = candles[candles.length - 3];
  const b = candles[candles.length - 2];
  const c = candles[candles.length - 1];

  // Bullish FVG
  if (c.low > a.high) {
    return {
      type: "BULLISH",
      low: a.high,
      high: c.low,
      middle: b
    };
  }

  // Bearish FVG
  if (c.high < a.low) {
    return {
      type: "BEARISH",
      low: c.high,
      high: a.low,
      middle: b
    };
  }

  return null;
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function detectOrderBlock(direction) {
  if (candles.length < 5) {
    return null;
  }

  for (let i = candles.length - 2; i >= Math.max(0, candles.length - 10); i--) {
    const candle = candles[i];

    if (direction === "BUY" && isBearish(candle)) {
      return {
        type: "BULLISH_ORDER_BLOCK",
        high: candle.high,
        low: candle.low,
        index: i
      };
    }

    if (direction === "SELL" && isBullish(candle)) {
      return {
        type: "BEARISH_ORDER_BLOCK",
        high: candle.high,
        low: candle.low,
        index: i
      };
    }
  }

  return null;
}

/* =========================================================
   BREAK OF STRUCTURE
========================================================= */

function detectStructureBreak(structure) {
  if (!structure || candles.length < 2) {
    return null;
  }

  const last = candles[candles.length - 1];

  if (
    last.close > structure.latestHigh.price
  ) {
    return {
      type: "BOS",
      direction: "BUY",
      price: last.close
    };
  }

  if (
    last.close < structure.latestLow.price
  ) {
    return {
      type: "BOS",
      direction: "SELL",
      price: last.close
    };
  }

  return null;
}

/* =========================================================
   CHOCH DETECTION
========================================================= */

function detectCHoCH(structure) {
  if (!structure || candles.length < 2) {
    return null;
  }

  const last = candles[candles.length - 1];

  if (
    structure.trend === "BEARISH" &&
    last.close > structure.latestHigh.price
  ) {
    return {
      type: "CHoCH",
      direction: "BUY",
      price: last.close
    };
  }

  if (
    structure.trend === "BULLISH" &&
    last.close < structure.latestLow.price
  ) {
    return {
      type: "CHoCH",
      direction: "SELL",
      price: last.close
    };
  }

  return null;
}

/* =========================================================
   CONFIRMATION CANDLE
========================================================= */

function confirmationCandle(direction) {
  if (candles.length < 2) {
    return false;
  }

  const candle = candles[candles.length - 1];

  const range = candleRange(candle);

  if (range <= 0) {
    return false;
  }

  const body = bodySize(candle);

  // Require meaningful candle body
  if (body / range < 0.45) {
    return false;
  }

  if (direction === "BUY" && isBullish(candle)) {
    return true;
  }

  if (direction === "SELL" && isBearish(candle)) {
    return true;
  }

  return false;
}

/* =========================================================
   RETEST CHECK
========================================================= */

function priceInsideZone(price, low, high) {
  return price >= low && price <= high;
}

function retestConfirmed(direction, orderBlock, fvg) {
  if (!orderBlock && !fvg) {
    return false;
  }

  const price = candles[candles.length - 1].close;

  if (orderBlock) {
    if (
      priceInsideZone(
        price,
        orderBlock.low,
        orderBlock.high
      )
    ) {
      return true;
    }
  }

  if (fvg) {
    if (
      priceInsideZone(
        price,
        fvg.low,
        fvg.high
      )
    ) {
      return true;
    }
  }

  return false;
}

/* =========================================================
   STOP LOSS / TAKE PROFIT
========================================================= */

function calculateTargets(direction, entry) {
  const tpPips =
    TP_PIPS_MIN +
    Math.floor(
      Math.random() *
      (TP_PIPS_MAX - TP_PIPS_MIN + 1)
    );

  const tpDistance = tpPips * PIP_SIZE;

  const stopDistance = Math.max(
    80 * PIP_SIZE,
    tpDistance * 0.5
  );

  let stopLoss;
  let takeProfit;

  if (direction === "BUY") {
    stopLoss = entry - stopDistance;
    takeProfit = entry + tpDistance;
  } else {
    stopLoss = entry + stopDistance;
    takeProfit = entry - tpDistance;
  }

  return {
    stopLoss: Number(stopLoss.toFixed(2)),
    takeProfit: Number(takeProfit.toFixed(2)),
    tpPips
  };
}

/* =========================================================
   ANALYZE MARKET
========================================================= */

function analyzeMarket() {
  if (candles.length < 20) {
    return;
  }

  // Don't create another setup while one is waiting
  if (pendingSetup) {
    if (
      Date.now() - pendingSetup.createdAt >
      SETUP_EXPIRY_MS
    ) {
      console.log("⌛ Pending setup expired");
      pendingSetup = null;
    } else {
      checkPendingSetup();
      return;
    }
  }

  // Prevent signals too close together
  if (
    Date.now() - lastSignalTime <
    SIGNAL_COOLDOWN_MS
  ) {
    return;
  }

  const structure = getStructure();

  if (!structure) {
    return;
  }

  const bos = detectStructureBreak(structure);
  const choch = detectCHoCH(structure);

  const structureBreak = choch || bos;

  if (!structureBreak) {
    return;
  }

  const direction = structureBreak.direction;

  const liquidity = detectLiquidity();

  const fvg = detectFVG();

  const orderBlock =
    detectOrderBlock(direction);

  if (!fvg && !orderBlock) {
    return;
  }

  const setup = {
    direction,
    structure:
      structureBreak.type,
    structurePrice:
      structureBreak.price,
    liquidity,
    fvg,
    orderBlock,
    createdAt: Date.now()
  };

  pendingSetup = setup;

  console.log(
    `🧠 SETUP DETECTED: ${direction} ${structureBreak.type}`
  );

  checkPendingSetup();
}

/* =========================================================
   CHECK PENDING SETUP
========================================================= */

function checkPendingSetup() {
  if (!pendingSetup) {
    return;
  }

  const direction =
    pendingSetup.direction;

  const last =
    candles[candles.length - 1];

  if (!last) {
    return;
  }

  const price = last.close;

  let retest = false;

  if (pendingSetup.orderBlock) {
    retest = priceInsideZone(
      price,
      pendingSetup.orderBlock.low,
      pendingSetup.orderBlock.high
    );
  }

  if (
    !retest &&
    pendingSetup.fvg
  ) {
    retest = priceInsideZone(
      price,
      pendingSetup.fvg.low,
      pendingSetup.fvg.high
    );
  }

  if (!retest) {
    return;
  }

  if (
    !confirmationCandle(direction)
  ) {
    return;
  }

  fireSignal(
    direction,
    pendingSetup
  );

  pendingSetup = null;
}

/* =========================================================
   SIGNAL CREATION
========================================================= */

function fireSignal(
  direction,
  setup
) {
  const entry =
    candles[candles.length - 1].close;

  const targets =
    calculateTargets(
      direction,
      entry
    );

  const signal = {
    id:
      `XAU-${Date.now()}`,

    symbol: SYMBOL,

    direction,

    entryPrice:
      Number(entry.toFixed(2)),

    stopLoss:
      targets.stopLoss,

    takeProfit:
      targets.takeProfit,

    targetPips:
      targets.tpPips,

    structure:
      setup.structure,

    liquidity:
      setup.liquidity
        ? setup.liquidity.type
        : "Confirmed",

    fvg:
      setup.fvg
        ? setup.fvg.type
        : "Confirmed",

    orderBlock:
      setup.orderBlock
        ? setup.orderBlock.type
        : "Confirmed",

    status: "OPEN",

    createdAt: Date.now(),

    closedAt: null
  };

  signalHistory.unshift(signal);

  if (
    signalHistory.length >
    MAX_SIGNAL_HISTORY
  ) {
    signalHistory.pop();
  }

  lastSignalTime = Date.now();

  console.log(
    `🚨 NEW ${direction} SIGNAL @ ${entry}`
  );

  broadcastSignal(signal);
}

/* =========================================================
   SIGNAL MESSAGE
========================================================= */

function buildSignalMessage(signal) {
  const emoji =
    signal.direction === "BUY"
      ? "🟢 BUY"
      : "🔴 SELL";

  return `
🚨 ${SYMBOL} SIGNAL

${emoji}

💰 Entry: ${formatPrice(signal.entryPrice)}

🛡️ Stop Loss:
${formatPrice(signal.stopLoss)}

🎯 Take Profit:
${formatPrice(signal.takeProfit)}

📏 Target:
~${signal.targetPips} pips

📊 Confirmed By:
• Market Structure (${signal.structure})
• Liquidity
• Fair Value Gap
• Order Block
• Retest
• Confirmation Candle

🆔 Signal:
${signal.id}

⚠️ Manage your own risk.
`;
}

/* =========================================================
   BROADCAST SIGNAL
========================================================= */

async function broadcastSignal(signal) {
  const message =
    buildSignalMessage(signal);

  for (
    const chatId of subscribers.keys()
  ) {
    try {
      await bot.sendMessage(
        chatId,
        message,
        mainMenu
      );
    } catch (error) {
      console.error(
        `Telegram signal error for ${chatId}:`,
        error.message
      );
    }
  }
}

/* =========================================================
   CHECK OPEN SIGNALS
========================================================= */

async function checkOpenSignals(
  currentPrice
) {
  const openSignals =
    signalHistory.filter(
      signal =>
        signal.status === "OPEN"
    );

  for (
    const signal of openSignals
  ) {
    let result = null;

    if (
      signal.direction === "BUY"
    ) {
      if (
        currentPrice <=
        signal.stopLoss
      ) {
        result = "LOSS";
      } else if (
        currentPrice >=
        signal.takeProfit
      ) {
        result = "WIN";
      }
    }

    if (
      signal.direction === "SELL"
    ) {
      if (
        currentPrice >=
        signal.stopLoss
      ) {
        result = "LOSS";
      } else if (
        currentPrice <=
        signal.takeProfit
      ) {
        result = "WIN";
      }
    }

    if (!result) {
      continue;
    }

    signal.status = result;
    signal.closedAt = Date.now();
    signal.closePrice =
      Number(currentPrice.toFixed(2));

    await broadcastResult(
      signal
    );
  }
}

/* =========================================================
   RESULT MESSAGE
========================================================= */

async function broadcastResult(
  signal
) {
  let message;

  if (
    signal.status === "WIN"
  ) {
    message = `
🏆 XAUUSD SIGNAL RESULT

🟢 ${signal.direction}

✅ RESULT: WIN

💰 Entry:
${formatPrice(signal.entryPrice)}

🎯 Target:
${formatPrice(signal.takeProfit)}

📍 Closed:
${formatPrice(signal.closePrice)}

📏 Target:
~${signal.targetPips} pips

🆔 ${signal.id}
`;
  } else {
    message = `
🔴 XAUUSD SIGNAL RESULT

${signal.direction === "BUY"
      ? "🟢 BUY"
      : "🔴 SELL"}

❌ RESULT: LOSS

💰 Entry:
${formatPrice(signal.entryPrice)}

🛡️ Stop Loss:
${formatPrice(signal.stopLoss)}

📍 Closed:
${formatPrice(signal.closePrice)}

🆔 ${signal.id}
`;
  }

  for (
    const chatId of subscribers.keys()
  ) {
    try {
      await bot.sendMessage(
        chatId,
        message,
        mainMenu
      );
    } catch (error) {
      console.error(
        `Telegram result error for ${chatId}:`,
        error.message
      );
    }
  }
}

/* =========================================================
   START COMMAND
   AUTOMATICALLY SUBSCRIBES USER
========================================================= */

bot.onText(
  /\/start/,
  async msg => {
    const existing =
      subscribers.get(
        msg.chat.id
      );

    subscribers.set(
      msg.chat.id,
      {
        username:
          msg.from.username || null,

        firstName:
          msg.from.first_name ||
          "Unknown",

        joinedAt:
          existing
            ? existing.joinedAt
            : Date.now()
      }
    );

    try {
      await bot.sendMessage(
        msg.chat.id,
`
🔥 ${BOT_NAME}

Welcome! 👋

Your XAUUSD trading assistant is now ACTIVE.

🤖 Automatic Monitoring: ON
🚨 Automatic Signals: ON

The bot will continuously monitor XAUUSD and automatically send a signal when all required conditions are confirmed.

📊 Market Structure
💧 Liquidity
🟨 Fair Value Gap
🟦 Order Block
🔄 Retest
✅ Confirmation Candle
🎯 200–300 pip target

You do NOT need to activate anything manually.

Use 🔕 Stop Alerts anytime to stop automatic signals.
`,
        mainMenu
      );
    } catch (error) {
      console.error(
        "Start message error:",
        error.message
      );
    }
  }
);

/* =========================================================
   TELEGRAM MESSAGE HANDLER
========================================================= */

bot.on(
  "message",
  async msg => {
    if (!msg.text) {
      return;
    }

    if (
      msg.text.startsWith("/")
    ) {
      return;
    }

    const chatId =
      msg.chat.id;

    /* -----------------------------------------
       XAUUSD SIGNAL
    ----------------------------------------- */

    if (
      msg.text ===
      "📊 XAUUSD Signal"
    ) {
      try {
        const price =
          await getGoldPrice();

        const active =
          subscribers.has(chatId);

        await bot.sendMessage(
          chatId,
`
📊 XAUUSD STATUS

💰 Current Price:
${formatPrice(price)}

🤖 Automatic Monitoring:
${active ? "🟢 ACTIVE" : "🔴 STOPPED"}

🚨 Automatic Signals:
${active ? "🟢 ON" : "🔴 OFF"}

The bot is waiting for a fully confirmed setup.
`,
          mainMenu
        );
      } catch (error) {
        await bot.sendMessage(
          chatId,
          "⚠️ XAUUSD market data is temporarily unavailable.",
          mainMenu
        );
      }

      return;
    }

    /* -----------------------------------------
       LIVE PRICE
    ----------------------------------------- */

    if (
      msg.text ===
      "💰 Live Price"
    ) {
      try {
        const price =
          await getGoldPrice();

        await bot.sendMessage(
          chatId,
`
💰 XAUUSD LIVE PRICE

${formatPrice(price)}

🟢 Market data connected
`,
          mainMenu
        );
      } catch (error) {
        await bot.sendMessage(
          chatId,
          "⚠️ Unable to retrieve XAUUSD price right now.",
          mainMenu
        );
      }

      return;
    }

    /* -----------------------------------------
       STOP ALERTS
    ----------------------------------------- */

    if (
      msg.text ===
      "🔕 Stop Alerts"
    ) {
      subscribers.delete(
        chatId
      );

      await bot.sendMessage(
        chatId,
`
🔕 AUTOMATIC SIGNALS STOPPED

You will no longer receive automatic XAUUSD signals.

To activate automatic signals again, simply send:

/start
`
      );

      return;
    }

    /* -----------------------------------------
       HOW IT WORKS
    ----------------------------------------- */

    if (
      msg.text ===
      "📖 How It Works"
    ) {
      await bot.sendMessage(
        chatId,
`
📖 HOW IT WORKS

The bot continuously monitors XAUUSD.

A signal is only generated after checking:

1️⃣ Market Structure
2️⃣ BOS / CHoCH
3️⃣ Liquidity
4️⃣ Fair Value Gap
5️⃣ Order Block
6️⃣ Retest
7️⃣ Confirmation Candle

After confirmation:

🚨 BUY or SELL signal
💰 Entry price
🛡️ Stop Loss
🎯 Take Profit
📏 200–300 pip target

After the trade reaches TP or SL, the bot automatically sends:

🏆 WIN

or

🔴 LOSS
`,
        mainMenu
      );

      return;
    }

    /* -----------------------------------------
       SETTINGS
    ----------------------------------------- */

    if (
      msg.text ===
      "⚙️ Settings"
    ) {
      await bot.sendMessage(
        chatId,
`
⚙️ SETTINGS

📊 Pair:
XAUUSD

🤖 Automatic Monitoring:
ON

🚨 Automatic Signals:
${subscribers.has(chatId)
          ? "ON"
          : "OFF"}

🎯 Target:
200–300 pips

📡 Signal Engine:
Market Structure
BOS / CHoCH
Liquidity
FVG
Order Block
Retest
Confirmation
`,
        mainMenu
      );

      return;
    }
  }
);

/* =========================================================
   ADMIN DASHBOARD
========================================================= */

app.get(
  "/admin",
  (req, res) => {
    const auth =
      req.headers.authorization;

    if (!auth) {
      res.setHeader(
        "WWW-Authenticate",
        'Basic realm="Admin"'
      );

      return res
        .status(401)
        .send("Authentication required");
    }

    const encoded =
      auth.split(" ")[1] || "";

    let decoded = "";

    try {
      decoded =
        Buffer.from(
          encoded,
          "base64"
        ).toString("utf8");
    } catch {
      return res
        .status(401)
        .send("Invalid authentication");
    }

    const separator =
      decoded.indexOf(":");

    const username =
      decoded.slice(
        0,
        separator
      );

    const password =
      decoded.slice(
        separator + 1
      );

    if (
      username !== ADMIN_USER ||
      password !== ADMIN_PASSWORD
    ) {
      return res
        .status(401)
        .send("Invalid credentials");
    }

    const totalSignals =
      signalHistory.length;

    const wins =
      signalHistory.filter(
        s => s.status === "WIN"
      ).length;

    const losses =
      signalHistory.filter(
        s => s.status === "LOSS"
      ).length;

    const closed =
      wins + losses;

    const winRate =
      closed > 0
        ? ((wins / closed) * 100).toFixed(1)
        : "0.0";

    const openSignals =
      signalHistory.filter(
        s => s.status === "OPEN"
      ).length;

    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>${BOT_NAME} Admin</title>

<style>
body{
  font-family:Arial,sans-serif;
  background:#07111f;
  color:#fff;
  padding:20px;
}

h1{
  margin-bottom:25px;
}

.grid{
  display:grid;
  grid-template-columns:
  repeat(auto-fit,minmax(180px,1fr));
  gap:15px;
}

.card{
  background:#111d2e;
  border-radius:14px;
  padding:20px;
}

.value{
  font-size:30px;
  font-weight:bold;
  margin-top:10px;
}

.green{
  color:#20d47b;
}

.red{
  color:#ff4d5a;
}

table{
  width:100%;
  margin-top:25px;
  border-collapse:collapse;
  background:#111d2e;
}

th,td{
  padding:12px;
  border-bottom:1px solid #26364c;
  text-align:left;
}

</style>
</head>

<body>

<h1>🔥 ${BOT_NAME}</h1>

<div class="grid">

<div class="card">
Subscribers
<div class="value">
${subscribers.size}
</div>
</div>

<div class="card">
Total Signals
<div class="value">
${totalSignals}
</div>
</div>

<div class="card">
Open Signals
<div class="value">
${openSignals}
</div>
</div>

<div class="card">
Wins
<div class="value green">
${wins}
</div>
</div>

<div class="card">
Losses
<div class="value red">
${losses}
</div>
</div>

<div class="card">
Win Rate
<div class="value">
${winRate}%
</div>
</div>

</div>

<h2>Recent Signals</h2>

<table>

<tr>
<th>Symbol</th>
<th>Direction</th>
<th>Entry</th>
<th>SL</th>
<th>TP</th>
<th>Status</th>
</tr>

${signalHistory
  .slice(0, 30)
  .map(
    signal => `
<tr>
<td>${signal.symbol}</td>
<td>${signal.direction}</td>
<td>${formatPrice(signal.entryPrice)}</td>
<td>${formatPrice(signal.stopLoss)}</td>
<td>${formatPrice(signal.takeProfit)}</td>
<td>${signal.status}</td>
</tr>
`
  )
  .join("")}

</table>

</body>
</html>
`);
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      status: "online",
      bot: BOT_NAME,
      symbol: SYMBOL,
      automaticSignals: true,
      subscribers:
        subscribers.size,
      candles:
        candles.length,
      pendingSetup:
        !!pendingSetup,
      uptime:
        Math.floor(
          (Date.now() -
            botStartedAt) /
            1000
        )
    });
  }
);

/* =========================================================
   MARKET MONITOR
========================================================= */

async function monitorMarket() {
  try {
    const price =
      await getGoldPrice();

    console.log(
      `[MARKET] ${SYMBOL}: ${price.toFixed(2)} | ticks: ${currentTicks.length + 1}/${TICKS_PER_CANDLE} | candles: ${candles.length} | subscribers: ${subscribers.size}`
    );

    addTick(price);

    await checkOpenSignals(
      price
    );
  } catch (error) {
    console.error(
      "Market monitor error:",
      error.message
    );
  }
}

/* =========================================================
   START MONITOR
========================================================= */

setInterval(
  monitorMarket,
  30000
);

monitorMarket();

/* =========================================================
   TELEGRAM ERROR HANDLING
========================================================= */

bot.on(
  "polling_error",
  error => {
    console.error(
      "Telegram polling error:",
      error.message
    );
  }
);

/* =========================================================
   SERVER START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `🔥 ${BOT_NAME} running on port ${PORT}`
    );

    console.log(
      `📊 Symbol: ${SYMBOL}`
    );

    console.log(
      `🤖 Automatic signals: ON`
    );

    console.log(
      `🔕 Stop Alerts: available`
    );
  }
);
