
const express = require("express");

const app = express();
app.get("/", (_req, res) => res.send("XAUUSD Signal Bot is running."));
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "XAUUSD 5M Signal Bot",
  time: new Date().toISOString()
}));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOL = process.env.MARKET_SYMBOL || "XAU/USD";
const SCAN_MS = 5 * 60 * 1000;
const RISK_REWARD = 2;
const MAX_SIGNALS_PER_DAY = 4;

if (!TOKEN || !API_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TWELVE_DATA_API_KEY");
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;
let chatId = process.env.TELEGRAM_CHAT_ID || "";
let scanning = false;
let lastSignalKey = "";
let lastScanTime = 0;
let signalsToday = 0;
let dayKey = new Date().toISOString().slice(0, 10);
const openSignals = [];
const stats = { wins: 0, losses: 0, expired: 0 };

async function telegram(method, body = {}) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

async function send(text) {
  if (!chatId) {
    console.log("No Telegram chat registered yet. Send /start to the bot.");
    return;
  }
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

async function candles(interval, size = 100) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(size));
  url.searchParams.set("apikey", API_KEY);
  url.searchParams.set("format", "JSON");

  const r = await fetch(url);
  const data = await r.json();

  if (!r.ok || !Array.isArray(data.values)) {
    throw new Error(data.message || data.code || "Price API returned no candles");
  }

  return data.values.map(v => ({
    time: v.datetime,
    open: Number(v.open),
    high: Number(v.high),
    low: Number(v.low),
    close: Number(v.close)
  })).reverse();
}

function bias(c) {
  if (c.length < 30) return "NEUTRAL";
  const a = c[c.length - 2];
  const old = c[c.length - 8];
  const highs = c.slice(-12, -2).map(x => x.high);
  const lows = c.slice(-12, -2).map(x => x.low);
  const rising = a.close > old.close &&
    Math.max(...highs.slice(-4)) > Math.max(...highs.slice(0, 4)) &&
    Math.min(...lows.slice(-4)) > Math.min(...lows.slice(0, 4));
  const falling = a.close < old.close &&
    Math.max(...highs.slice(-4)) < Math.max(...highs.slice(0, 4)) &&
    Math.min(...lows.slice(-4)) < Math.min(...lows.slice(0, 4));
  if (rising) return "BULLISH";
  if (falling) return "BEARISH";
  return "NEUTRAL";
}

function findSetup(c5, c15, trend) {
  if (trend === "NEUTRAL" || c5.length < 30 || c15.length < 20) return null;

  // Use closed candles only; exclude the currently forming candle.
  const m5 = c5.slice(0, -1);
  const m15 = c15.slice(0, -1);
  const last = m5[m5.length - 1];
  const prev = m5[m5.length - 2];
  const recent15 = m15.slice(-12, -1);
  const recent5 = m5.slice(-12, -1);

  if (!last || !prev) return null;

  if (trend === "BULLISH") {
    const swept = Math.min(...recent15.map(c => c.low));
    const sweepConfirmed = prev.low < swept && prev.close > swept;
    const swingHigh = Math.max(...recent5.slice(0, -2).map(c => c.high));
    const bos = last.close > swingHigh && last.close > last.open;

    // Three-candle bullish FVG: newer candle low above older candle high.
    const gap = m5.slice(-8, -2).some((c, i, arr) => {
      const newer = arr[i + 2];
      return newer && newer.low > c.high;
    });

    if (sweepConfirmed && bos && gap) {
      const entry = last.close;
      const sl = Math.min(prev.low, last.low) - 0.2;
      const risk = entry - sl;
      if (risk <= 0 || risk > entry * 0.003) return null;
      return {
        side: "BUY", entry, sl,
        tp1: entry + risk * RISK_REWARD,
        tp2: entry + risk * 3,
        time: last.time
      };
    }
  }

  if (trend === "BEARISH") {
    const swept = Math.max(...recent15.map(c => c.high));
    const sweepConfirmed = prev.high > swept && prev.close < swept;
    const swingLow = Math.min(...recent5.slice(0, -2).map(c => c.low));
    const bos = last.close < swingLow && last.close < last.open;

    const gap = m5.slice(-8, -2).some((c, i, arr) => {
      const newer = arr[i + 2];
      return newer && newer.high < c.low;
    });

    if (sweepConfirmed && bos && gap) {
      const entry = last.close;
      const sl = Math.max(prev.high, last.high) + 0.2;
      const risk = sl - entry;
      if (risk <= 0 || risk > entry * 0.003) return null;
      return {
        side: "SELL", entry, sl,
        tp1: entry - risk * RISK_REWARD,
        tp2: entry - risk * 3,
        time: last.time
      };
    }
  }
  return null;
}

function fmt(n) {
  return Number(n).toFixed(2);
}

async function checkResults(latest) {
  const bar = latest[latest.length - 2];
  if (!bar) return;

  for (let i = openSignals.length - 1; i >= 0; i--) {
    const s = openSignals[i];
    if (bar.time <= s.time) continue;

    const hitSL = s.side === "BUY"
      ? bar.low <= s.sl : bar.high >= s.sl;
    const hitTP = s.side === "BUY"
      ? bar.high >= s.tp1 : bar.low <= s.tp1;

    // If both are touched in one candle, assume SL first (conservative).
    if (hitSL) {
      stats.losses++;
      openSignals.splice(i, 1);
      await send(`🔴 LOSS — XAUUSD ${s.side}\nEntry: ${fmt(s.entry)}\nSL: ${fmt(s.sl)}\nTP1: ${fmt(s.tp1)}\nReason: stop loss reached (conservative candle rule).`);
    } else if (hitTP) {
      stats.wins++;
      openSignals.splice(i, 1);
      await send(`🏆 WIN — XAUUSD ${s.side}\nEntry: ${fmt(s.entry)}\nTP1: ${fmt(s.tp1)} reached.\nSL: ${fmt(s.sl)}`);
    } else if (Date.now() - s.createdAt > 12 * 60 * 60 * 1000) {
      stats.expired++;
      openSignals.splice(i, 1);
      await send(`⌛ EXPIRED — XAUUSD ${s.side}\nNo TP1 or SL was recorded within 12 hours.`);
    }
  }
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    if (new Date().toISOString().slice(0, 10) !== dayKey) {
      dayKey = new Date().toISOString().slice(0, 10);
      signalsToday = 0;
    }

    const [h1, m15, m5] = await Promise.all([
      candles("1h", 60),
      candles("15min", 60),
      candles("5min", 100)
    ]);

    await checkResults(m5);
    const trend = bias(h1);
    const setup = findSetup(m5, m15, trend);
    lastScanTime = Date.now();

    if (!setup) {
      console.log(new Date().toISOString(), "No confirmed setup; trend:", trend);
      return;
    }

    const key = `${setup.side}-${setup.time}`;
    if (key === lastSignalKey) return;
    if (signalsToday >= MAX_SIGNALS_PER_DAY) return;
    if (openSignals.length >= 1) return;

    lastSignalKey = key;
    signalsToday++;
    setup.createdAt = Date.now();
    openSignals.push(setup);

    await send(
      `${setup.side === "BUY" ? "🟢 BUY" : "🔴 SELL"} SIGNAL — XAUUSD\n\n` +
      `Strategy: 1H trend + 15M sweep + 5M structure/FVG\n` +
      `Entry: ${fmt(setup.entry)}\n` +
      `Stop Loss: ${fmt(setup.sl)}\n` +
      `TP1 (1:2): ${fmt(setup.tp1)}\n` +
      `TP2 (1:3): ${fmt(setup.tp2)}\n` +
      `Trend: ${trend}\n` +
      `Signal candle: ${setup.time}\n\n` +
      `Paper signal only. Verify price and spread with your broker before trading.`
    );
  } catch (e) {
    console.error("Scan error:", e.message);
    if (/no candles|symbol|api key|apikey/i.test(e.message)) {
      await send(`⚠️ Market data error: ${e.message}\nCheck MARKET_SYMBOL and your Twelve Data plan/key.`);
    }
  } finally {
    scanning = false;
  }
}

async function pollTelegram() {
  try {
    const updates = await telegram("getUpdates", {
      offset,
      timeout: 5,
      allowed_updates: ["message"]
    });

    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || !msg.text) continue;
      const id = String(msg.chat.id);

      if (msg.text.startsWith("/start")) {
        chatId = id;
        await send(
          "✅ XAUUSD Signal Bot connected.\n" +
          "Automatic scanning is enabled when market data is available.\n\n" +
          "/status — bot status\n" +
          "/stats — tracked outcomes\n" +
          "/scan — request a scan\n" +
          "/help — help"
        );
      } else if (msg.text.startsWith("/status")) {
        await telegram("sendMessage", {
          chat_id: id,
          text: `Bot: running\nSymbol: ${SYMBOL}\nLast scan: ${lastScanTime ? new Date(lastScanTime).toISOString() : "not yet"}\nOpen signals: ${openSignals.length}\nTrend is checked on each scan.`
        });
      } else if (msg.text.startsWith("/stats")) {
        await telegram("sendMessage", {
          chat_id: id,
          text: `📊 Tracked outcomes (since last restart)\nWins: ${stats.wins}\nLosses: ${stats.losses}\nExpired: ${stats.expired}\nOpen signals: ${openSignals.length}\nThese stats are in-memory and reset on restart.`
        });
      } else if (msg.text.startsWith("/scan")) {
        await telegram("sendMessage", {
          chat_id: id,
          text: "🔎 Scan requested. Results will be sent if a valid setup is detected."
        });
        scan();
      } else if (msg.text.startsWith("/help")) {
        await telegram("sendMessage", {
          chat_id: id,
          text: "/start — connect alerts\n/status — service status\n/stats — outcome totals\n/scan — request scan\n/help — commands"
        });
      }
    }
  } catch (e) {
    console.error("Telegram polling error:", e.message);
  }
}

app.listen(PORT, () => {
  console.log(`Web server listening on ${PORT}`);
  scan();
  setInterval(scan, SCAN_MS);
  setInterval(pollTelegram, 4000);
});
