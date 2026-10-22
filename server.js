
"use strict";

require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.TWELVE_DATA_KEY;

const SYMBOL = "XAU/USD";
const SCAN_INTERVAL_MS = 60_000;
const WAT = "Africa/Lagos";

app.use(express.json());

let bot = null;
let botReady = false;
let scanning = false;
let lastScanAt = null;
let lastScanMessage = "⏳ First market scan has not completed.";
let currentSignal = null;
const signalHistory = [];
const seenSetups = new Set();

function formatMessage(message) {
  return `🤖 BOT.XAU SNIPER ENTRY\n\n${message}`;
}

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🔍 Scan Gold" }, { text: "🎯 Signal" }],
        [{ text: "📊 Market Analysis" }, { text: "📈 Signal History" }],
        [{ text: "🟢 Bot Status" }, { text: "ℹ️ Help" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  };
}

function sendMenu(chatId, message) {
  return bot.sendMessage(chatId, formatMessage(message), mainKeyboard());
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: WAT,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestamp)) + " WAT (UTC+1)";
}

async function getCandles(interval = "5min", outputsize = 100) {
  if (!API_KEY) throw new Error("TWELVE_DATA_KEY is missing.");

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("format", "JSON");

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Market data HTTP ${response.status}`);

  const data = await response.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || "No candle data returned.");
  }

  return data.values
    .map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();
}

function analyzeCandles(candles) {
  if (candles.length < 30) {
    return { ok: false, reason: "Not enough candles for confirmation." };
  }

  // Exclude the newest candle in case it is still forming.
  const closed = candles.slice(0, -1);
  const last = closed[closed.length - 1];
  const previous = closed[closed.length - 2];
  const lookback = closed.slice(-22, -2);

  const swingHigh = Math.max(...lookback.map(c => c.high));
  const swingLow = Math.min(...lookback.map(c => c.low));

  const bullishBOS = last.close > swingHigh && previous.close <= swingHigh;
  const bearishBOS = last.close < swingLow && previous.close >= swingLow;

  // Liquidity sweep: price takes a recent extreme, then closes back inside.
  const recent = closed.slice(-8, -1);
  const priorHigh = Math.max(...recent.map(c => c.high));
  const priorLow = Math.min(...recent.map(c => c.low));

  const bullishSweep =
    last.low < priorLow && last.close > priorLow && last.close > last.open;

  const bearishSweep =
    last.high > priorHigh && last.close < priorHigh && last.close < last.open;

  // Three-candle fair value gap.
  const a = closed[closed.length - 3];
  const bullishFVG = last.low > a.high;
  const bearishFVG = last.high < a.low;

  // A basic structure-change proxy; not a complete institutional CHOCH model.
  const bullishCHOCH = last.close > previous.high;
  const bearishCHOCH = last.close < previous.low;

  let direction = null;
  let confirmations = [];

  if (bullishBOS && bullishSweep && bullishFVG && bullishCHOCH) {
    direction = "BUY 🟢";
    confirmations = ["BOS", "CHOCH proxy", "Liquidity sweep", "Bullish FVG"];
  } else if (bearishBOS && bearishSweep && bearishFVG && bearishCHOCH) {
    direction = "SELL 🔴";
    confirmations = ["BOS", "CHOCH proxy", "Liquidity sweep", "Bearish FVG"];
  }

  if (!direction) {
    return {
      ok: false,
      reason: "No setup met all confirmation rules.",
      price: last.close,
      candleTime: last.time
    };
  }

  // Nearest recent range is used as a simple structural stop reference.
  const entry = last.close;
  const recentLows = closed.slice(-6).map(c => c.low);
  const recentHighs = closed.slice(-6).map(c => c.high);

  let stopLoss = direction.startsWith("BUY")
    ? Math.min(...recentLows)
    : Math.max(...recentHighs);

  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    return { ok: false, reason: "Invalid stop-loss distance." };
  }

  // Minimum 1:2 illustrative target. This does not guarantee the target is reached.
  const takeProfit = direction.startsWith("BUY")
    ? entry + risk * 2
    : entry - risk * 2;

  const decimals = 3;
  const key = `${direction}|${last.time}|${entry.toFixed(decimals)}`;

  return {
    ok: true,
    direction,
    entry,
    stopLoss,
    takeProfit,
    riskReward: "1:2",
    confirmations,
    candleTime: last.time,
    setupKey: key,
    status: "ACTIVE"
  };
}

async function scanMarket() {
  if (scanning) return { ok: false, reason: "A scan is already running." };

  scanning = true;

  try {
    const candles = await getCandles("5min", 100);
    const result = analyzeCandles(candles);
    lastScanAt = Date.now();

    if (!result.ok) {
      lastScanMessage = `⏳ ${result.reason}`;
      return result;
    }

    if (seenSetups.has(result.setupKey)) {
      lastScanMessage = "🔎 Setup already reported; waiting for a new setup.";
      return { ok: false, reason: lastScanMessage };
    }

    seenSetups.add(result.setupKey);

    const signal = {
      ...result,
      sentAt: Date.now(),
      symbol: SYMBOL
    };

    currentSignal = signal;
    signalHistory.unshift(signal);

    if (signalHistory.length > 50) signalHistory.pop();

    lastScanMessage = "✅ A new confirmed-rule setup was detected.";

    // Send only to a configured target chat, if one was supplied.
    const targetChat = process.env.TELEGRAM_CHAT_ID;

    if (targetChat && bot) {
      await bot.sendMessage(
        targetChat,
        formatMessage(signalText(signal)),
        mainKeyboard()
      );
    }

    return { ok: true, signal };
  } catch (error) {
    lastScanAt = Date.now();
    lastScanMessage = `⚠️ Scan failed: ${error.message}`;
    console.error(lastScanMessage);
    return { ok: false, reason: lastScanMessage };
  } finally {
    scanning = false;
  }
}

function signalText(signal) {
  return (
    "🎯 CURRENT XAUUSD SIGNAL\n\n" +
    `🪙 Pair: ${signal.symbol}\n` +
    `📈 Direction: ${signal.direction}\n` +
    `💰 Entry: ${signal.entry.toFixed(3)}\n` +
    `🛑 Stop Loss: ${signal.stopLoss.toFixed(3)}\n` +
    `🏆 Take Profit: ${signal.takeProfit.toFixed(3)}\n` +
    `⚖️ Risk/Reward: ${signal.riskReward}\n` +
    `🔍 Confirmation: ${signal.confirmations.join(" + ")}\n` +
    `🕯️ Candle time: ${signal.candleTime}\n` +
    `🕒 Time sent: ${formatTime(signal.sentAt)}\n` +
    "⚠️ Rule-based setup, not a guarantee of profit."
  );
}

function currentSignalText() {
  if (!currentSignal) {
    return (
      "🎯 CURRENT XAUUSD SIGNAL\n\n" +
      "⚠️ No confirmed signal is available right now.\n" +
      `🔎 Last scan: ${lastScanAt ? formatTime(lastScanAt) : "Not scanned yet"}\n` +
      `📊 Scanner: ${lastScanMessage}`
    );
  }

  return signalText(currentSignal);
}

async function handleButton(msg) {
  const chatId = msg.chat.id;
  const choice = msg.text;

  try {
    switch (choice) {
      case "🔍 Scan Gold": {
        await sendMenu(chatId, "🔎 Scanning XAUUSD for a potential setup...\n⏳ Please wait.");
        const result = await scanMarket();

        if (result.ok) {
          await sendMenu(chatId, signalText(result.signal));
        } else {
          await sendMenu(chatId, `🔎 SCAN RESULT\n\n${result.reason}\n\n🛡️ No new signal was issued.`);
        }
        break;
      }

      case "🎯 Signal":
        await sendMenu(chatId, currentSignalText());
        break;

      case "📊 Market Analysis": {
        await sendMenu(
          chatId,
          "📊 MARKET ANALYSIS\n\n" +
          `🪙 Symbol: ${SYMBOL}\n` +
          `🔑 API key: ${API_KEY ? "Configured ✅" : "Missing ⚠️"}\n` +
          `🕒 Last scan: ${lastScanAt ? formatTime(lastScanAt) : "Not scanned yet"}\n` +
          `📈 Latest result: ${lastScanMessage}\n\n` +
          "🧠 Rules check 5-minute candles for structure breakout, sweep and FVG alignment.\n" +
          "⚠️ This is a simplified rule-based strategy, not a complete discretionary SMC analysis."
        );
        break;
      }

      case "📈 Signal History": {
        if (!signalHistory.length) {
          await sendMenu(chatId, "📈 SIGNAL HISTORY\n\n📭 No signals have been generated during this process lifetime.");
          break;
        }

        const lines = signalHistory.slice(0, 10).map((s, i) =>
          `${i + 1}. ${s.direction}\n` +
          `💰 Entry: ${s.entry.toFixed(3)}\n` +
          `🕒 Sent: ${formatTime(s.sentAt)}`
        );

        await sendMenu(chatId, "📈 SIGNAL HISTORY\n\n" + lines.join("\n\n"));
        break;
      }

      case "🟢 Bot Status":
        await sendMenu(
          chatId,
          "🟢 BOT STATUS\n\n" +
          `🤖 Telegram: ${botReady ? "Connected" : "Not configured"}\n` +
          `🔑 Market API: ${API_KEY ? "Configured" : "Missing"}\n` +
          `🪙 Market: ${SYMBOL}\n` +
          `🔎 Scanner: ${scanning ? "Running" : "Idle"}\n` +
          `🎯 Current signal: ${currentSignal ? "Available" : "None"}\n` +
          `🕒 Last scan: ${lastScanAt ? formatTime(lastScanAt) : "Not scanned yet"}`
        );
        break;

      case "ℹ️ Help":
        await sendMenu(
          chatId,
          "ℹ️ BOT.XAU MENU HELP\n\n" +
          "🔍 Scan Gold — run a market scan\n" +
          "🎯 Signal — view the latest signal and sent time\n" +
          "📊 Market Analysis — inspect scan status\n" +
          "📈 Signal History — view recent generated signals\n" +
          "🟢 Bot Status — check connections"
        );
        break;

      default:
        await sendMenu(chatId, "👋 Please choose an option using the buttons below.");
    }
  } catch (error) {
    console.error("⚠️ Telegram handler error:", error.message);
    await bot.sendMessage(chatId, formatMessage("⚠️ Request failed. Please try again.")).catch(() => {});
  }
}

if (TOKEN) {
  bot = new TelegramBot(TOKEN, { polling: true });
  botReady = true;

  bot.onText(/^\/start$/, async (msg) => {
    await sendMenu(
      msg.chat.id,
      "👋 Welcome to BOT.XAU Sniper Entry!\n\n" +
      "🪙 Market: XAUUSD Gold only\n" +
      "🎯 Use the buttons below to request a scan or view the latest signal.\n" +
      "⚠️ Signals are rule-based suggestions, not guaranteed outcomes."
    );
  });

  bot.on("message", async (msg) => {
    if (msg.text && !msg.text.startsWith("/")) {
      await handleButton(msg);
    }
  });

  bot.on("polling_error", (error) => {
    console.error("⚠️ Telegram polling error:", error.message);
  });
} else {
  console.error("⚠️ TELEGRAM_BOT_TOKEN is missing.");
}

// Background scanning runs automatically, not only when a button is pressed.
if (API_KEY) {
  setTimeout(async () => {
    await scanMarket();
    setInterval(() => {
      scanMarket().catch(err => console.error("⚠️ Background scan error:", err.message));
    }, SCAN_INTERVAL_MS);
  }, 5000);
}

app.get("/", (_req, res) => {
  res.status(200).send("🤖 BOT.XAU is running. 🪙 XAUUSD only.");
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    telegramConfigured: botReady,
    marketDataConfigured: Boolean(API_KEY),
    scanning,
    lastScanAt,
    currentSignalAvailable: Boolean(currentSignal),
    strategyReady: Boolean(API_KEY),
    automaticSignalsEnabled: Boolean(API_KEY)
  });
});

app.listen(PORT, () => {
  console.log(`🚀 BOT.XAU server listening on port ${PORT}`);
});
