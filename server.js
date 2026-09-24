const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const token = process.env.BOT_TOKEN;
const TD_KEY = process.env.TWELVE_DATA_KEY;

if (!token) { console.error("BOT_TOKEN is missing"); process.exit(1); }
if (!TD_KEY) { console.error("TWELVE_DATA_KEY is missing"); process.exit(1); }

const bot = new TelegramBot(token, { polling: true });
app.use(express.urlencoded({ extended: true }));


// ================================================================
// SETTINGS (all can be tuned here or via Render environment vars)
// ================================================================
const CFG = {
  TP_RR: Number(process.env.TP_RR) || 1.0,       // take profit = risk x this
  SPREAD: Number(process.env.SPREAD) || 0.30,    // typical XAUUSD spread in $ (counted in results)
  ATR_PERIOD: 14,
  MIN_ATR: 1.0,                                  // skip dead markets (5m ATR in $)
  DISPLACEMENT_ATR: 0.8,                         // breakout candle body must be >= this x ATR
  SL_BUFFER_ATR: 0.25,                           // extra room beyond the sweep level
  MIN_RISK_ATR: 1.0,                             // reject stops tighter than 1 ATR
  MAX_RISK_ATR: 4.0,                             // reject stops wider than 4 ATR
  SESSION_START_UTC: 7,                          // London open
  SESSION_END_UTC: 19,                           // end of NY overlap
  SETUP_EXPIRY_CANDLES: 24,                      // 24 x 5m = 2 hours
  SIGNAL_EXPIRY_MS: 6 * 60 * 60 * 1000,          // close stuck trades after 6h
  COOLDOWN_MS: 30 * 60 * 1000
};

// Optional news blackout, e.g. NEWS_BLACKOUT="2026-10-02T12:15/2026-10-02T14:00,2026-10-28T17:45/2026-10-28T20:00" (UTC)
const NEWS_BLACKOUTS = (process.env.NEWS_BLACKOUT || "")
  .split(",").map(s => s.trim()).filter(Boolean)
  .map(r => r.split("/").map(t => Date.parse(t.endsWith("Z") ? t : t + "Z")))
  .filter(r => r.length === 2 && r.every(Number.isFinite));


// ================================================================
// ADMIN PANEL LOGIN
// ================================================================
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("Admin panel disabled: set ADMIN_PASSWORD in the environment variables.");
  }
  const h = req.headers.authorization;
  if (h && h.startsWith("Basic ")) {
    const decoded = Buffer.from(h.split(" ")[1], "base64").toString();
    const i = decoded.indexOf(":");
    if (i >= 0 && safeEqual(decoded.slice(0, i), ADMIN_USER) && safeEqual(decoded.slice(i + 1), ADMIN_PASSWORD)) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Authentication required.");
}


// ================================================================
// BOT MENU / SUBSCRIBERS / SIGNAL HISTORY
// ================================================================
const mainMenu = {
  reply_markup: {
    keyboard: [
      ["📊 XAUUSD Signal", "💰 Live Price"],
      ["📖 How It Works", "⚙️ Settings"]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

const subscribers = new Map(); // chatId -> { username, firstName, joinedAt }
const signalHistory = [];      // most recent first
const MAX_SIGNAL_HISTORY = 500;
const botStartedAt = Date.now();

(process.env.SIGNAL_CHAT_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean)
  .forEach(id => subscribers.set(Number(id), { username: null, firstName: "Permanent", joinedAt: Date.now() }));

function autoSubscribe(msg) {
  const id = msg.chat.id;
  if (subscribers.has(id)) return;
  subscribers.set(id, {
    username: msg.from?.username || null,
    firstName: msg.from?.first_name || "Unknown",
    joinedAt: Date.now()
  });
  persist();
}

function broadcast(text) {
  for (const chatId of subscribers.keys()) {
    bot.sendMessage(chatId, text).catch(err => console.error(`Send failed for ${chatId}:`, err.message));
  }
}


// ================================================================
// STORAGE (optional Postgres). Set DATABASE_URL in Render so signals
// and subscribers survive restarts. Without it, data is in memory.
// ================================================================
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function dbInit() {
  if (!pool) { console.log("[DB] No DATABASE_URL - using memory only"); return; }
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS bot_store (k TEXT PRIMARY KEY, v JSONB NOT NULL)");
    const r = await pool.query("SELECT k, v FROM bot_store");
    for (const row of r.rows) {
      if (row.k === "signals") signalHistory.push(...row.v);
      if (row.k === "subscribers") for (const [id, info] of row.v) subscribers.set(Number(id), info);
    }
    console.log(`[DB] Loaded ${signalHistory.length} signals, ${subscribers.size} subscribers`);
  } catch (e) { console.error("[DB] init failed:", e.message); }
}

let saveTimer = null;
function persist() {
  if (!pool || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const sql = "INSERT INTO bot_store (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v";
    try {
      await pool.query(sql, ["signals", JSON.stringify(signalHistory)]);
      await pool.query(sql, ["subscribers", JSON.stringify([...subscribers])]);
    } catch (e) { console.error("[DB] save failed:", e.message); }
  }, 2000);
}


// ================================================================
// REAL CANDLE DATA (Twelve Data)
// ================================================================
const CANDLE_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
let candles5 = []; // closed 5m candles, oldest first
let candles1h = []; // closed 1h candles, oldest first

async function fetchCandles(interval, size, ms) {
  const r = await axios.get("https://api.twelvedata.com/time_series", {
    params: { symbol: "XAU/USD", interval, outputsize: size, timezone: "UTC", order: "ASC", apikey: TD_KEY },
    timeout: 15000
  });
  const d = r.data;
  if (!d || d.status === "error" || !Array.isArray(d.values)) {
    throw new Error((d && d.message) || "Bad response from Twelve Data");
  }
  return d.values
    .map(v => ({
      time: Date.parse(v.datetime.replace(" ", "T") + "Z"),
      open: +v.open, high: +v.high, low: +v.low, close: +v.close
    }))
    .filter(c => Number.isFinite(c.close) && c.time + ms <= Date.now()) // closed candles only
    .sort((a, b) => a.time - b.time);
}

// Gold is closed from Friday ~22:00 UTC to Sunday ~22:00 UTC
function marketClosed(ts = Date.now()) {
  const d = new Date(ts), day = d.getUTCDay(), h = d.getUTCHours();
  return day === 6 || (day === 0 && h < 22) || (day === 5 && h >= 22);
}

function inSession(ts) {
  if (marketClosed(ts)) return false;
  const h = new Date(ts).getUTCHours();
  if (h < CFG.SESSION_START_UTC || h >= CFG.SESSION_END_UTC) return false;
  return !NEWS_BLACKOUTS.some(([a, b]) => ts >= a && ts <= b);
}


// ================================================================
// STRATEGY (pure functions: candles in, decision out)
// Idea: trade only WITH the 1h trend. Wait for a liquidity sweep
// (a swing low/high that takes out the previous one), then a strong
// break of structure (MSS) that leaves a Fair Value Gap. Enter on
// the FVG retest with a confirming candle. SL sits beyond the sweep.
// ================================================================
function atr(c, period = CFG.ATR_PERIOD) {
  if (c.length < period + 1) return null;
  let sum = 0;
  for (let i = c.length - period; i < c.length; i++) {
    sum += Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close)
    );
  }
  return sum / period;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function htfTrend(c1h) {
  if (c1h.length < 60) return null;
  const closes = c1h.map(c => c.close);
  const e20 = ema(closes, 20), e50 = ema(closes, 50), last = closes[closes.length - 1];
  if (e20 > e50 && last > e50) return "bullish";
  if (e20 < e50 && last < e50) return "bearish";
  return null; // no clear trend -> no trading
}

function findSwings(c, lb = 2) {
  const out = [];
  for (let i = lb; i < c.length - lb; i++) {
    let hi = true, lo = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) hi = false;
      if (c[j].low <= c[i].low) lo = false;
    }
    if (hi) out.push({ index: i, price: c[i].high, type: "high" });
    if (lo) out.push({ index: i, price: c[i].low, type: "low" });
  }
  return out;
}

function findFVG(c, n, direction) {
  for (let i = n; i >= 2 && i >= n - 2; i--) {
    const c1 = c[i - 2], c3 = c[i];
    if (direction === "bullish" && c1.high < c3.low) return { top: c3.low, bottom: c1.high };
    if (direction === "bearish" && c1.low > c3.high) return { top: c1.low, bottom: c3.high };
  }
  return null;
}

// Looks only at the latest closed candle for a fresh setup
function detectSetup(c, trend) {
  const n = c.length - 1, last = c[n], prev = c[n - 1];
  const a = atr(c);
  if (!a || a < CFG.MIN_ATR) return null;
  if (Math.abs(last.close - last.open) < CFG.DISPLACEMENT_ATR * a) return null;

  const sw = findSwings(c);
  const highs = sw.filter(s => s.type === "high"), lows = sw.filter(s => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return null;
  const lh = highs[highs.length - 1], ph = highs[highs.length - 2];
  const ll = lows[lows.length - 1], pl = lows[lows.length - 2];

  // Bullish: high -> lower low (sweeps sell-side liquidity) -> fresh close above that high
  if (trend === "bullish" && ll.index > lh.index && ll.price < pl.price
      && n - lh.index <= 50 && prev.close <= lh.price && last.close > lh.price && last.close > last.open) {
    const zone = findFVG(c, n, "bullish");
    if (zone) return { direction: "bullish", slLevel: ll.price, zone, age: 0, createdAt: Date.now() };
  }

  // Bearish: low -> higher high (sweeps buy-side liquidity) -> fresh close below that low
  if (trend === "bearish" && lh.index > ll.index && lh.price > ph.price
      && n - ll.index <= 50 && prev.close >= ll.price && last.close < ll.price && last.close < last.open) {
    const zone = findFVG(c, n, "bearish");
    if (zone) return { direction: "bearish", slLevel: lh.price, zone, age: 0, createdAt: Date.now() };
  }
  return null;
}


// ================================================================
// ENGINE: runs once per newly closed 5m candle
// ================================================================
let pendingSetup = null;
let lastSignalTime = 0;
let lastProcessedTime = 0;

const hasOpenSignal = () => signalHistory.some(s => s.status === "open");

function manageSetup(c, trend) {
  const s = pendingSetup, last = c[c.length - 1];
  const drop = why => { console.log(`[SETUP] Cancelled: ${why}`); pendingSetup = null; };
  const bull = s.direction === "bullish";

  s.age++;
  if (s.age > CFG.SETUP_EXPIRY_CANDLES) return drop("expired");
  if (trend !== s.direction) return drop("1h trend changed");

  const invalid = bull
    ? (last.low <= s.slLevel || last.close < s.zone.bottom)
    : (last.high >= s.slLevel || last.close > s.zone.top);
  if (invalid) return drop("price closed through the zone / structure");

  const touched = bull ? last.low <= s.zone.top : last.high >= s.zone.bottom;
  const confirmed = bull ? last.close > last.open : last.close < last.open;
  if (!touched || !confirmed) return;
  if (!inSession(last.time) || Date.now() - lastSignalTime < CFG.COOLDOWN_MS) return;

  const a = atr(c), entry = last.close;
  const buffer = CFG.SPREAD + CFG.SL_BUFFER_ATR * a;
  const sl = bull ? s.slLevel - buffer : s.slLevel + buffer;
  const risk = Math.abs(entry - sl);

  if (risk < CFG.MIN_RISK_ATR * a || risk > CFG.MAX_RISK_ATR * a) return drop("risk size out of range");

  const tp = bull ? entry + CFG.TP_RR * risk : entry - CFG.TP_RR * risk;
  fireSignal(bull ? "BUY" : "SELL", entry, sl, tp, risk, last.time);
  pendingSetup = null;
}

function runEngine() {
  const c = candles5;
  if (c.length < 60) return;
  const last = c[c.length - 1];
  if (last.time === lastProcessedTime) return;
  lastProcessedTime = last.time;

  trackOutcomes(c);

  if (Date.now() - last.time > 20 * 60 * 1000) return; // stale data / market closed
  const trend = htfTrend(candles1h);

  if (hasOpenSignal()) { pendingSetup = null; return; }
  if (pendingSetup) { manageSetup(c, trend); return; }
  if (!trend || !inSession(last.time) || Date.now() - lastSignalTime < CFG.COOLDOWN_MS) return;

  const s = detectSetup(c, trend);
  if (s) {
    pendingSetup = s;
    console.log(`[SETUP] ${s.direction} sweep + MSS, FVG ${s.zone.bottom.toFixed(2)}-${s.zone.top.toFixed(2)}`);
  }
}


// ================================================================
// SIGNAL SENDING + OUTCOME TRACKING (uses candle highs / lows)
// ================================================================
function fireSignal(direction, entry, sl, tp, risk, candleTime) {
  lastSignalTime = Date.now();
  const emoji = direction === "BUY" ? "🟢" : "🔴";

  signalHistory.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    time: Date.now(),
    label: "Sweep+MSS",
    direction,
    entryPrice: entry,
    stopLoss: sl,
    takeProfit: tp,
    risk,
    status: "open",
    checkedTime: candleTime,
    closedAt: null,
    closePrice: null,
    r: null
  });
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.pop();
  persist();

  console.log(`[SIGNAL FIRED] ${direction} @ ${entry.toFixed(2)} SL ${sl.toFixed(2)} TP ${tp.toFixed(2)}`);

  broadcast(
`🚨 XAUUSD SIGNAL

${emoji} ${direction} @ ${entry.toFixed(2)}

🛡️ Stop Loss: ${sl.toFixed(2)}
🎯 Take Profit: ${tp.toFixed(2)}
📏 Risk $${risk.toFixed(2)} | Reward $${(risk * CFG.TP_RR).toFixed(2)} (1:${CFG.TP_RR})

📊 Why:
• 1H trend agrees (${direction === "BUY" ? "bullish" : "bearish"})
• Liquidity sweep + structure break
• FVG retest with confirmation candle

⚠️ Manage your own risk. This is not financial advice.`
  );
}

function closeSignal(sig, result, price) {
  const buy = sig.direction === "BUY";
  const move = buy ? price - sig.entryPrice : sig.entryPrice - price;
  sig.status = result;
  sig.closedAt = Date.now();
  sig.closePrice = price;
  sig.r = (move - CFG.SPREAD) / sig.risk; // result in R, after spread
  lastSignalTime = Date.now();
  persist();

  const head = { win: "✅ TAKE PROFIT HIT", loss: "❌ STOP LOSS HIT", expired: "⌛ SIGNAL EXPIRED" }[result];
  console.log(`[SIGNAL CLOSED] ${sig.direction} @ ${sig.entryPrice.toFixed(2)} -> ${result.toUpperCase()} (${sig.r.toFixed(2)}R)`);

  broadcast(
`${head}

${sig.direction} @ ${sig.entryPrice.toFixed(2)}
Closed @ ${price.toFixed(2)}
Result: ${sig.r >= 0 ? "+" : ""}${sig.r.toFixed(2)}R`
  );
}

function trackOutcomes(c) {
  const lastTime = c[c.length - 1].time;
  for (const sig of signalHistory.filter(s => s.status === "open")) {
    const buy = sig.direction === "BUY";
    let result = null, price = null;

    for (const k of c) {
      if (k.time <= sig.checkedTime) continue;
      const slHit = buy ? k.low <= sig.stopLoss : k.high >= sig.stopLoss;
      const tpHit = buy ? k.high >= sig.takeProfit : k.low <= sig.takeProfit;
      // If both are touched in the same candle, count the loss (conservative)
      if (slHit) { result = "loss"; price = sig.stopLoss; break; }
      if (tpHit) { result = "win"; price = sig.takeProfit; break; }
    }
    sig.checkedTime = lastTime;

    if (!result && Date.now() - sig.time > CFG.SIGNAL_EXPIRY_MS) {
      result = "expired";
      price = c[c.length - 1].close;
    }
    if (result) closeSignal(sig, result, price);
  }
}


// ================================================================
// MARKET REFRESH SCHEDULER
// Fetches once per 5m candle close (plus once per hour for 1h),
// which stays inside Twelve Data's free limits.
// ================================================================
let lastBoundary = 0, last1hBoundary = 0, attempts = 0, busy = false;

async function refreshMarket() {
  if (busy) return;
  const now = Date.now();
  const boundary = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  if (boundary === lastBoundary || now - boundary < 8000 || marketClosed(now)) return;

  busy = true;
  try {
    const hourBoundary = Math.floor(now / HOUR_MS) * HOUR_MS;
    if (hourBoundary !== last1hBoundary || candles1h.length === 0) {
      candles1h = await fetchCandles("1h", 120, HOUR_MS);
      last1hBoundary = hourBoundary;
    }
    candles5 = await fetchCandles("5min", 250, CANDLE_MS);

    const last = candles5[candles5.length - 1];
    console.log(`[MARKET] ${candles5.length} x 5m, ${candles1h.length} x 1h | last close ${last ? last.close : "-"} | trend ${htfTrend(candles1h) || "none"}`);

    if (last && last.time >= boundary - CANDLE_MS) { lastBoundary = boundary; attempts = 0; }
    else if (++attempts >= 3) { lastBoundary = boundary; attempts = 0; } // provider lagging, move on
    runEngine();
  } catch (e) {
    console.error("[MARKET] refresh failed:", (e.response && e.response.data && e.response.data.message) || e.message);
    if (++attempts >= 3) { lastBoundary = boundary; attempts = 0; }
  } finally {
    busy = false;
  }
}


// ================================================================
// LIVE PRICE (display only - used by the "Live Price" button)
// ================================================================
const PRICE_SOURCES = [
  { name: "gold-api.com", url: "https://api.gold-api.com/price/XAU", parse: d => Number(d && d.price) },
  {
    name: "swissquote",
    url: "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
    parse: d => {
      const p = d && d[0] && d[0].spreadProfilePrices && d[0].spreadProfilePrices[0];
      return p ? (Number(p.bid) + Number(p.ask)) / 2 : NaN;
    }
  },
  { name: "xaus.com", url: "https://xaus.com/api/v1/spot?compact=1", parse: d => Number(d && d.xau && d.xau.price) }
];
PRICE_SOURCES.forEach(s => { s.skipUntil = 0; });

let lastPrice = { value: null, time: 0 };

async function getGoldPrice() {
  if (lastPrice.value && Date.now() - lastPrice.time < 15000) return lastPrice.value;
  let list = PRICE_SOURCES.filter(s => Date.now() >= s.skipUntil);
  if (list.length === 0) list = PRICE_SOURCES;

  for (const s of list) {
    try {
      const r = await axios.get(s.url, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MoneyMakingMachineBot/2.0)", "Accept": "application/json" }
      });
      const p = s.parse(r.data);
      if (!Number.isFinite(p) || p <= 0) throw new Error("Invalid price data");
      lastPrice = { value: p, time: Date.now() };
      return p;
    } catch (e) {
      const status = e.response ? e.response.status : null;
      s.skipUntil = Date.now() + (status === 429 ? 10 : 2) * 60 * 1000;
      console.error(`[PRICE] ${s.name} failed: ${status ? "HTTP " + status : e.message}`);
    }
  }
  // Fall back to the last real candle close
  const c = candles5[candles5.length - 1];
  if (c) return c.close;
  throw new Error("All price sources failed");
}


// ================================================================
// WEB SERVER + ADMIN PANEL
// ================================================================
app.get("/", (req, res) => res.send("🔥 MONEY MAKING MACHINE BOT is running."));

const escapeHtml = str => str === null || str === undefined ? "" :
  String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const formatUptime = ms => `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m`;

app.get("/admin", requireAdminAuth, (req, res) => {
  const last = candles5[candles5.length - 1];
  const price = last ? last.close : null;

  const subscriberRows = [...subscribers.entries()].map(([chatId, info]) => `
    <tr>
      <td>${escapeHtml(info.firstName)}${info.username ? " (@" + escapeHtml(info.username) + ")" : ""}</td>
      <td>${chatId}</td>
      <td>${new Date(info.joinedAt).toLocaleString()}</td>
      <td><form method="POST" action="/admin/remove" style="margin:0;">
        <input type="hidden" name="chatId" value="${chatId}">
        <button type="submit" class="danger">Remove</button></form></td>
    </tr>`).join("") || `<tr><td colspan="4">No subscribers yet.</td></tr>`;

  const badge = { open: "⏳ Open", win: "✅ Win", loss: "❌ Loss", expired: "⌛ Expired" };
  const signalRows = signalHistory.slice(0, 20).map(s => `
    <tr>
      <td>${new Date(s.time).toLocaleString()}</td>
      <td>${escapeHtml(s.label)}</td>
      <td>${s.direction}</td>
      <td>${s.entryPrice.toFixed(2)}</td>
      <td>${s.stopLoss.toFixed(2)}</td>
      <td>${s.takeProfit.toFixed(2)}</td>
      <td>${badge[s.status] || s.status}${s.r !== null && s.r !== undefined ? " (" + s.r.toFixed(2) + "R)" : ""}</td>
    </tr>`).join("") || `<tr><td colspan="7">No signals fired yet.</td></tr>`;

  const closed = signalHistory.filter(s => s.status !== "open");
  const wins = closed.filter(s => s.status === "win").length;
  const losses = closed.filter(s => s.status === "loss").length;
  const openCount = signalHistory.length - closed.length;
  const decided = wins + losses;
  const winRate = decided > 0 ? ((wins / decided) * 100).toFixed(1) + "%" : "—";
  const avgR = closed.length > 0 ? (closed.reduce((a, s) => a + (s.r || 0), 0) / closed.length).toFixed(2) + "R" : "—";

  const trend = htfTrend(candles1h);
  const setupStatus = pendingSetup
    ? `Watching a ${escapeHtml(pendingSetup.direction)} setup, waiting for FVG retest.`
    : "No active setup right now.";

  res.send(`<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Money Making Machine - Admin</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background: #0f1115; color: #eee; margin: 0; padding: 16px; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 28px; color: #f5c542; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
  .card { background: #1b1f27; border-radius: 10px; padding: 12px 16px; flex: 1 1 140px; }
  .card .label { font-size: 0.75rem; color: #999; } .card .value { font-size: 1.3rem; font-weight: bold; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.85rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #2a2f3a; } th { color: #aaa; font-weight: normal; }
  button { background: #2b6fe0; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-size: 0.85rem; }
  button.danger { background: #c0392b; }
  textarea { width: 100%; box-sizing: border-box; background: #1b1f27; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 8px; font-size: 0.9rem; }
  .scroll { overflow-x: auto; }
</style></head>
<body>
<h1>🔥 Money Making Machine - Admin</h1>

<div class="stats">
  <div class="card"><div class="label">Bot uptime</div><div class="value">${formatUptime(Date.now() - botStartedAt)}</div></div>
  <div class="card"><div class="label">Last close</div><div class="value">${price ? price.toFixed(2) : "—"}</div></div>
  <div class="card"><div class="label">1H trend</div><div class="value">${trend || "none"}</div></div>
  <div class="card"><div class="label">Subscribers</div><div class="value">${subscribers.size}</div></div>
  <div class="card"><div class="label">Signals</div><div class="value">${signalHistory.length}</div></div>
</div>

<div class="stats">
  <div class="card"><div class="label">Win rate</div><div class="value">${winRate}</div></div>
  <div class="card"><div class="label">Avg result</div><div class="value">${avgR}</div></div>
  <div class="card"><div class="label">Wins</div><div class="value">${wins}</div></div>
  <div class="card"><div class="label">Losses</div><div class="value">${losses}</div></div>
  <div class="card"><div class="label">Open</div><div class="value">${openCount}</div></div>
</div>

<p><strong>Setup status:</strong> ${setupStatus}</p>
<p><strong>Storage:</strong> ${pool ? "Postgres (saved)" : "Memory only (resets on restart)"}</p>

<h2>Send a manual message to all subscribers</h2>
<form method="POST" action="/admin/broadcast">
  <textarea name="message" rows="3" placeholder="Type a message to send to every subscriber..."></textarea><br><br>
  <button type="submit">Send Broadcast</button>
</form>

<h2>Subscribers (${subscribers.size})</h2>
<div class="scroll"><table>
  <tr><th>Name</th><th>Chat ID</th><th>Joined</th><th></th></tr>${subscriberRows}
</table></div>

<h2>Recent Signals</h2>
<div class="scroll"><table>
  <tr><th>Time</th><th>Type</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP</th><th>Result</th></tr>${signalRows}
</table></div>
</body></html>`);
});

app.post("/admin/remove", requireAdminAuth, (req, res) => {
  subscribers.delete(Number(req.body.chatId));
  persist();
  res.redirect("/admin");
});

app.post("/admin/broadcast", requireAdminAuth, (req, res) => {
  const text = (req.body.message || "").trim();
  if (text) broadcast(`📢 ${text}`);
  res.redirect("/admin");
});


// ================================================================
// TELEGRAM COMMANDS
// ================================================================
bot.onText(/\/start/, (msg) => {
  autoSubscribe(msg);
  bot.sendMessage(msg.chat.id,
`🔥 MONEY MAKING MACHINE BOT

Welcome! 👋

Your XAUUSD trading assistant.

📊 Real-candle market analysis
🚨 Entry alerts with Stop Loss and Take Profit
🛡️ Risk sized from market volatility

🔔 Automatic signals are already ON for you - no setup needed.

Choose an option below:`, mainMenu);
});

bot.on("message", async (msg) => {
  if (!msg.text) return;
  autoSubscribe(msg);

  if (msg.text === "📊 XAUUSD Signal") {
    try {
      const price = await getGoldPrice();
      const trend = htfTrend(candles1h);
      const status = hasOpenSignal()
        ? "⏳ A signal is currently open - waiting for its result."
        : pendingSetup
          ? `👀 Watching a ${pendingSetup.direction.toUpperCase()} setup - waiting for FVG retest.`
          : candles5.length < 60
            ? "⏳ Loading market data..."
            : "🔎 No active setup right now - scanning every 5 minutes.";

      await bot.sendMessage(msg.chat.id,
`🔎 XAUUSD MARKET CHECK

💰 Price: ${price.toFixed(2)}
📈 1H trend: ${trend ? trend.toUpperCase() : "NO CLEAR TREND (no trades)"}
🕐 Session: ${inSession(Date.now()) ? "ACTIVE (London/NY)" : "OFF (signals paused)"}

${status}

🚨 A signal is sent automatically when all conditions are confirmed.`);
    } catch (error) {
      console.error("Signal price error:", error.message);
      bot.sendMessage(msg.chat.id, "⚠️ XAUUSD market data is temporarily unavailable.");
    }
  }

  if (msg.text === "💰 Live Price") {
    try {
      const price = await getGoldPrice();
      bot.sendMessage(msg.chat.id, `💰 XAUUSD LIVE PRICE\n\n🪙 ${price.toFixed(2)}\n\n📡 Market Data: LIVE`);
    } catch (error) {
      console.error("Price error:", error.message);
      bot.sendMessage(msg.chat.id, "⚠️ Unable to retrieve the current XAUUSD price.");
    }
  }

  if (msg.text === "📖 How It Works") {
    bot.sendMessage(msg.chat.id,
`📖 HOW IT WORKS

The bot reads real 5-minute and 1-hour XAUUSD candles and only trades when everything lines up:

📈 1H trend – trades only in the direction of the higher-timeframe trend
💧 Liquidity sweep – price takes out a swing low/high, then reverses
💥 Structure break – a strong candle breaks structure and leaves a Fair Value Gap
✅ Entry – price retraces into the gap and a confirming candle closes
🛡️ Stop Loss – beyond the sweep level, sized with volatility (ATR)
🎯 Take Profit – ${CFG.TP_RR}x the risk

🕐 Signals are only sent during London/New York hours (07:00–19:00 UTC), never on weekends, and never during dead-volatility periods.

Only one signal is active at a time. Setups are cancelled if price closes through the zone.`);
  }

  if (msg.text === "⚙️ Settings") {
    bot.sendMessage(msg.chat.id,
`⚙️ SETTINGS

📊 Market: XAUUSD
📈 Signal type: 1H trend + sweep + MSS + FVG retest
🎯 Reward:risk: 1:${CFG.TP_RR}
🕐 Session: ${CFG.SESSION_START_UTC}:00–${CFG.SESSION_END_UTC}:00 UTC
🔔 Automatic alerts: always on
📉 Candles loaded: ${candles5.length} (5m) / ${candles1h.length} (1h)`);
  }
});


// ================================================================
// START
// ================================================================
process.on("SIGTERM", async () => {
  try { await bot.stopPolling(); } catch (err) { console.error("Error stopping polling:", err.message); }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🔥 MONEY MAKING MACHINE BOT running on port ${PORT}`);
});

dbInit().then(() => {
  refreshMarket();
  setInterval(refreshMarket, 30000);
});
