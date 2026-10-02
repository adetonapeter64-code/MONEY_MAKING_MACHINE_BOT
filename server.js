const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
const token = process.env.BOT_TOKEN;
const TD_KEY = process.env.TWELVE_DATA_KEY; // free key from twelvedata.com

if (!token) { console.error("BOT_TOKEN is missing"); process.exit(1); }
if (!TD_KEY) { console.error("TWELVE_DATA_KEY is missing"); process.exit(1); }

const bot = new TelegramBot(token, { polling: true });
app.use(express.urlencoded({ extended: true }));

// ===============================
// SETTINGS (tweak these)
// ===============================
const PIP_SIZE = 0.1;              // 1 "pip" = $0.10
const RR = 2;                      // take profit = RR x risk
const MIN_SL_USD = 6;              // never risk less than $6
const MAX_SL_USD = 25;             // skip trades needing a stop wider than this
const ATR_PERIOD = 14;
const ATR_SL_MULT = 1.5;           // SL at least 1.5 x ATR
const SL_BUFFER_ATR = 0.3;         // extra room beyond zone edge, in ATR
const SESSION_START_UTC = 7;       // London open
const SESSION_END_UTC = 20;        // NY late
const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
const SETUP_EXPIRY_MS = 90 * 60 * 1000;
const LTF = { interval: "5min", ms: 5 * 60 * 1000 };
const HTF = { interval: "1h", ms: 60 * 60 * 1000 };

// ===============================
// ADMIN LOGIN
// ===============================
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

function requireAdminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Authentication required.");
  }
  const decoded = Buffer.from(h.split(" ")[1], "base64").toString();
  const idx = decoded.indexOf(":");
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Invalid credentials.");
}

// ===============================
// STATE
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

const subscribers = new Map(); // chatId -> { username, firstName, joinedAt }
const signalHistory = [];      // newest first
const MAX_SIGNAL_HISTORY = 100;
const botStartedAt = Date.now();

let allCandles = [];   // 5m, includes the still-forming candle (for outcome checks)
let candles = [];      // 5m, closed candles only (for analysis)
let htfCandles = [];   // 1h closed candles
let htfTrend = "neutral";
let lastAnalyzedTime = 0;
let pendingSetup = null;
let lastSignalTime = 0;
let lastPrice = null;
let lastFetchError = null;

// ===============================
// DATA: REAL OHLC CANDLES
// ===============================
async function fetchCandles(tf, size) {
  const r = await axios.get("https://api.twelvedata.com/time_series", {
    params: { symbol: "XAU/USD", interval: tf.interval, outputsize: size, timezone: "UTC", apikey: TD_KEY },
    timeout: 15000
  });
  if (r.data.status === "error" || !r.data.values) {
    throw new Error(r.data.message || "Bad response from Twelve Data");
  }
  return r.data.values
    .map(v => ({
      time: Date.parse(v.datetime.replace(" ", "T") + "Z"), // candle OPEN time, UTC
      open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close)
    }))
    .filter(c => c.time && c.high > 0)
    .sort((a, b) => a.time - b.time);
}

let blockedUntil = 0; // pause API calls after a rate-limit error

function handleApiError(e) {
  const data = e.response?.data;
  const msg = data?.message || e.message;
  if (e.response?.status === 429 || data?.code === 429) {
    if (/day/i.test(msg)) {
      const d = new Date();
      blockedUntil = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5);
      console.error("[API] Daily credits used up - pausing until 00:05 UTC");
    } else {
      blockedUntil = Date.now() + 90000;
      console.error("[API] Per-minute limit hit - pausing 90s");
    }
  }
  return msg;
}

async function refreshLTF() {
  if (Date.now() < blockedUntil) return;
  try {
    allCandles = await fetchCandles(LTF, 200);
    candles = allCandles.filter(c => c.time + LTF.ms <= Date.now());
    if (candles.length) lastPrice = allCandles[allCandles.length - 1].close;
    lastFetchError = null;

    checkOpenSignals();

    const latest = candles[candles.length - 1];
    if (latest && latest.time !== lastAnalyzedTime) {
      lastAnalyzedTime = latest.time;
      analyzeMarket();
    }
  } catch (e) {
    lastFetchError = handleApiError(e);
    console.error("5m refresh failed:", lastFetchError);
  }
}

async function refreshHTF() {
  if (Date.now() < blockedUntil) return;
  try {
    const all = await fetchCandles(HTF, 120);
    htfCandles = all.filter(c => c.time + HTF.ms <= Date.now());
    htfTrend = computeHTFTrend();
    console.log(`[HTF] trend: ${htfTrend}`);
  } catch (e) {
    console.error("1h refresh failed:", handleApiError(e));
  }
}

async function getGoldPrice() {
  if (lastPrice && allCandles.length) return lastPrice;
  if (Date.now() < blockedUntil) throw new Error("API limit reached");
  const r = await axios.get("https://api.twelvedata.com/price", {
    params: { symbol: "XAU/USD", apikey: TD_KEY }, timeout: 10000
  });
  const p = Number(r.data.price);
  if (!(p > 0)) throw new Error("No price");
  return p;
}

// ===============================
// INDICATORS
// ===============================
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function computeATR(arr, period = ATR_PERIOD) {
  if (arr.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < arr.length; i++) {
    const c = arr[i], p = arr[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function computeHTFTrend() {
  const closes = htfCandles.map(c => c.close);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  if (e20 === null || e50 === null) return "neutral";
  const last = closes[closes.length - 1];
  if (e20 > e50 && last > e50) return "bullish";
  if (e20 < e50 && last < e50) return "bearish";
  return "neutral";
}

function inSession() {
  const h = new Date().getUTCHours();
  const d = new Date().getUTCDay();
  return d >= 1 && d <= 5 && h >= SESSION_START_UTC && h < SESSION_END_UTC;
}

// ===============================
// STRUCTURE TOOLS
// ===============================
function findSwings(lookback = 3) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    if (slice.every(s => s.high <= c.high)) swings.push({ index: i, price: c.high, type: "high" });
    if (slice.every(s => s.low >= c.low)) swings.push({ index: i, price: c.low, type: "low" });
  }
  return swings;
}

function findFVG(startIndex, direction) {
  for (let i = startIndex; i >= 2 && i >= startIndex - 5; i--) {
    const c1 = candles[i - 2], c3 = candles[i];
    if (direction === "bullish" && c1.high < c3.low) return { top: c3.low, bottom: c1.high, index: i };
    if (direction === "bearish" && c1.low > c3.high) return { top: c1.low, bottom: c3.high, index: i };
  }
  return null;
}

function findOrderBlock(breakIndex, direction) {
  for (let i = breakIndex; i >= 0 && i >= breakIndex - 6; i--) {
    const c = candles[i];
    if (direction === "bullish" && c.close < c.open) return { top: c.high, bottom: c.low, index: i };
    if (direction === "bearish" && c.close > c.open) return { top: c.high, bottom: c.low, index: i };
  }
  return null;
}

// ===============================
// SIGNAL ENGINE (runs once per closed 5m candle)
// ===============================
function hasOpenSignal() {
  return signalHistory.some(s => s.status === "open");
}

function analyzeMarket() {
  if (candles.length < 40) return;
  if (hasOpenSignal()) return;

  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const latestIndex = candles.length - 1;

  // ---- 1. Manage an existing pending setup first ----
  if (pendingSetup) {
    const s = pendingSetup;

    if (Date.now() - s.createdAt > SETUP_EXPIRY_MS) {
      console.log("[SETUP] Expired");
      pendingSetup = null;
    } else if (
      (s.direction === "bullish" && latest.close < s.zoneBottom) ||
      (s.direction === "bearish" && latest.close > s.zoneTop)
    ) {
      console.log("[SETUP] Invalidated - closed through the zone");
      pendingSetup = null;
    } else if (latest.time > s.createdCandleTime) {
      // retest = wick touched the zone, candle closed back out in our direction
      const touched = latest.low <= s.zoneTop && latest.high >= s.zoneBottom;
      const bullConfirm = s.direction === "bullish" && latest.close > latest.open && latest.close > s.zoneBottom;
      const bearConfirm = s.direction === "bearish" && latest.close < latest.open && latest.close < s.zoneTop;

      if (touched && (bullConfirm || bearConfirm)) {
        const setup = pendingSetup;
        pendingSetup = null;
        fireSignal(setup, latest);
      }
    }
    if (pendingSetup) return;
  }

  // ---- 2. Look for a fresh structure break ----
  if (!inSession()) return;
  if (htfTrend === "neutral") return;

  const atr = computeATR(candles);
  if (!atr) return;

  const swings = findSwings(3);
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  if (!lastHigh || !lastLow) return;

  // Only trade WITH the 1h trend, and only on the candle that does the breaking
  if (htfTrend === "bullish" && latest.close > lastHigh.price && prev.close <= lastHigh.price) {
    const fvg = findFVG(latestIndex, "bullish");
    if (!fvg) return;
    const ob = findOrderBlock(fvg.index, "bullish");
    const zone = ob || fvg;
    pendingSetup = {
      direction: "bullish", label: "BOS", atr,
      zoneTop: zone.top, zoneBottom: zone.bottom,
      createdAt: Date.now(), createdCandleTime: latest.time
    };
    console.log(`[SETUP] Bullish BOS | zone ${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}`);
  } else if (htfTrend === "bearish" && latest.close < lastLow.price && prev.close >= lastLow.price) {
    const fvg = findFVG(latestIndex, "bearish");
    if (!fvg) return;
    const ob = findOrderBlock(fvg.index, "bearish");
    const zone = ob || fvg;
    pendingSetup = {
      direction: "bearish", label: "BOS", atr,
      zoneTop: zone.top, zoneBottom: zone.bottom,
      createdAt: Date.now(), createdCandleTime: latest.time
    };
    console.log(`[SETUP] Bearish BOS | zone ${zone.bottom.toFixed(2)}-${zone.top.toFixed(2)}`);
  }
}

// ===============================
// FIRE SIGNAL - ATR stop, RR-based target
// ===============================
function fireSignal(setup, confirmCandle) {
  if (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS) {
    console.log("[SIGNAL] Skipped - cooldown");
    return;
  }
  if (!inSession()) return;

  const entry = confirmCandle.close;
  const atr = computeATR(candles) || setup.atr;
  const buffer = atr * SL_BUFFER_ATR;
  const bull = setup.direction === "bullish";

  // Risk = distance past the zone edge, but never tighter than the ATR/min floors
  const zoneRisk = bull
    ? entry - (setup.zoneBottom - buffer)
    : (setup.zoneTop + buffer) - entry;
  const risk = Math.max(zoneRisk, atr * ATR_SL_MULT, MIN_SL_USD);

  if (risk > MAX_SL_USD) {
    console.log(`[SIGNAL] Skipped - stop would be $${risk.toFixed(2)} (max ${MAX_SL_USD})`);
    return;
  }

  const stopLoss = bull ? entry - risk : entry + risk;
  const takeProfit = bull ? entry + risk * RR : entry - risk * RR;
  const direction = bull ? "BUY" : "SELL";
  const emoji = bull ? "🟢" : "🔴";
  const riskPips = Math.round(risk / PIP_SIZE);
  const tpPips = Math.round((risk * RR) / PIP_SIZE);

  lastSignalTime = Date.now();

  const message =
`🚨 XAUUSD SIGNAL - ${setup.label}

${emoji} ${direction} @ ${entry.toFixed(2)}

🛡️ Stop Loss: ${stopLoss.toFixed(2)} (~${riskPips} pips)
🎯 Take Profit: ${takeProfit.toFixed(2)} (~${tpPips} pips)
⚖️ Risk:Reward 1:${RR}

📊 Confirmed by:
• 1h trend (${htfTrend})
• Structure break (${setup.label}) + FVG
• Zone retest with confirming candle

⚠️ Always manage your own risk. This is not financial advice.`;

  console.log(`[SIGNAL FIRED] ${direction} @ ${entry} SL ${stopLoss.toFixed(2)} TP ${takeProfit.toFixed(2)}`);

  signalHistory.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    time: Date.now(),
    fromTime: confirmCandle.time + LTF.ms, // only candles opening after this count
    label: setup.label,
    direction, entryPrice: entry, stopLoss, takeProfit,
    status: "open", closedAt: null, closePrice: null
  });
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.pop();

  for (const chatId of subscribers.keys()) {
    bot.sendMessage(chatId, message).catch(err => console.error(`Send failed ${chatId}:`, err.message));
  }
}

// ===============================
// OUTCOME TRACKER - uses real candle highs/lows (catches wicks)
// ===============================
function checkOpenSignals() {
  for (const signal of signalHistory.filter(s => s.status === "open")) {
    const relevant = allCandles.filter(c => c.time >= signal.fromTime);

    for (const c of relevant) {
      const buy = signal.direction === "BUY";
      const hitSL = buy ? c.low <= signal.stopLoss : c.high >= signal.stopLoss;
      const hitTP = buy ? c.high >= signal.takeProfit : c.low <= signal.takeProfit;
      if (!hitSL && !hitTP) continue;

      // Both in one candle -> assume SL first (conservative)
      signal.status = hitSL ? "loss" : "win";
      signal.closedAt = Date.now();
      signal.closePrice = hitSL ? signal.stopLoss : signal.takeProfit;
      lastSignalTime = Date.now();

      const won = signal.status === "win";
      const closeMessage =
`${won ? "✅" : "❌"} SIGNAL CLOSED - ${won ? "TAKE PROFIT HIT" : "STOP LOSS HIT"}

${signal.direction} @ ${signal.entryPrice.toFixed(2)}
Closed @ ${signal.closePrice.toFixed(2)}

${won ? "🎯 Target reached." : "🛡️ Stop loss protected your downside."}`;

      console.log(`[SIGNAL CLOSED] ${signal.direction} -> ${signal.status.toUpperCase()}`);
      for (const chatId of subscribers.keys()) {
        bot.sendMessage(chatId, closeMessage).catch(err => console.error(`Send failed ${chatId}:`, err.message));
      }
      break;
    }
  }
}

// ===============================
// WEB + ADMIN PANEL
// ===============================
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUptime(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

app.get("/", (req, res) => res.send("🔥 MONEY MAKING MACHINE BOT is running."));

app.get("/admin", requireAdminAuth, (req, res) => {
  const subscriberRows = [...subscribers.entries()].map(([chatId, info]) => `
    <tr>
      <td>${escapeHtml(info.firstName)}${info.username ? " (@" + escapeHtml(info.username) + ")" : ""}</td>
      <td>${chatId}</td>
      <td>${new Date(info.joinedAt).toLocaleString()}</td>
      <td><form method="POST" action="/admin/remove" style="margin:0;">
        <input type="hidden" name="chatId" value="${chatId}">
        <button type="submit" class="danger">Remove</button></form></td>
    </tr>`).join("") || `<tr><td colspan="4">No subscribers yet.</td></tr>`;

  const badge = { open: "⏳ Open", win: "✅ Win", loss: "❌ Loss" };
  const signalRows = signalHistory.slice(0, 20).map(s => `
    <tr>
      <td>${new Date(s.time).toLocaleString()}</td><td>${s.label}</td><td>${s.direction}</td>
      <td>${s.entryPrice.toFixed(2)}</td><td>${s.stopLoss.toFixed(2)}</td><td>${s.takeProfit.toFixed(2)}</td>
      <td>${badge[s.status] || s.status}</td>
    </tr>`).join("") || `<tr><td colspan="7">No signals fired yet.</td></tr>`;

  const wins = signalHistory.filter(s => s.status === "win").length;
  const losses = signalHistory.filter(s => s.status === "loss").length;
  const openCount = signalHistory.filter(s => s.status === "open").length;
  const decided = wins + losses;
  const winRate = decided > 0 ? ((wins / decided) * 100).toFixed(1) + "%" : "—";

  const setupStatus = pendingSetup
    ? `Watching a ${escapeHtml(pendingSetup.label)} ${escapeHtml(pendingSetup.direction.toUpperCase())} setup, waiting for retest.`
    : "No active setup right now.";

  res.send(`<!DOCTYPE html><html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Money Making Machine - Admin</title>
  <style>
    body { font-family: -apple-system, Arial, sans-serif; background:#0f1115; color:#eee; margin:0; padding:16px; }
    h1 { font-size:1.3rem; } h2 { font-size:1.05rem; margin-top:28px; color:#f5c542; }
    .stats { display:flex; flex-wrap:wrap; gap:10px; margin:12px 0; }
    .card { background:#1b1f27; border-radius:10px; padding:12px 16px; flex:1 1 140px; }
    .card .label { font-size:.75rem; color:#999; } .card .value { font-size:1.3rem; font-weight:bold; margin-top:4px; }
    table { width:100%; border-collapse:collapse; margin-top:8px; font-size:.85rem; }
    th, td { text-align:left; padding:8px 6px; border-bottom:1px solid #2a2f3a; } th { color:#aaa; font-weight:normal; }
    button { background:#2b6fe0; color:#fff; border:none; padding:8px 14px; border-radius:6px; font-size:.85rem; }
    button.danger { background:#c0392b; }
    textarea { width:100%; box-sizing:border-box; background:#1b1f27; color:#eee; border:1px solid #333; border-radius:6px; padding:8px; }
    .scroll { overflow-x:auto; }
  </style></head><body>
  <h1>🔥 Money Making Machine - Admin</h1>
  <div class="stats">
    <div class="card"><div class="label">Uptime</div><div class="value">${formatUptime(Date.now() - botStartedAt)}</div></div>
    <div class="card"><div class="label">Price</div><div class="value">${lastPrice ? lastPrice.toFixed(2) : "—"}</div></div>
    <div class="card"><div class="label">1h trend</div><div class="value">${htfTrend}</div></div>
    <div class="card"><div class="label">Candles</div><div class="value">${candles.length}</div></div>
    <div class="card"><div class="label">Subscribers</div><div class="value">${subscribers.size}</div></div>
  </div>
  <div class="stats">
    <div class="card"><div class="label">Win rate</div><div class="value">${winRate}</div></div>
    <div class="card"><div class="label">Wins</div><div class="value">${wins}</div></div>
    <div class="card"><div class="label">Losses</div><div class="value">${losses}</div></div>
    <div class="card"><div class="label">Open</div><div class="value">${openCount}</div></div>
  </div>
  <p><strong>Setup:</strong> ${setupStatus}</p>
  ${lastFetchError ? `<p style="color:#e74c3c;">Data error: ${escapeHtml(lastFetchError)}</p>` : ""}
  <h2>Broadcast</h2>
  <form method="POST" action="/admin/broadcast">
    <textarea name="message" rows="3" placeholder="Message to all subscribers..."></textarea><br><br>
    <button type="submit">Send Broadcast</button>
  </form>
  <h2>Subscribers (${subscribers.size})</h2>
  <div class="scroll"><table><tr><th>Name</th><th>Chat ID</th><th>Joined</th><th></th></tr>${subscriberRows}</table></div>
  <h2>Recent Signals</h2>
  <div class="scroll"><table><tr><th>Time</th><th>Type</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP</th><th>Result</th></tr>${signalRows}</table></div>
  </body></html>`);
});

app.post("/admin/remove", requireAdminAuth, (req, res) => {
  subscribers.delete(Number(req.body.chatId));
  res.redirect("/admin");
});

app.post("/admin/broadcast", requireAdminAuth, (req, res) => {
  const text = (req.body.message || "").trim();
  if (text) {
    for (const chatId of subscribers.keys()) {
      bot.sendMessage(chatId, `📢 ${text}`).catch(err => console.error(`Broadcast failed ${chatId}:`, err.message));
    }
  }
  res.redirect("/admin");
});

// ===============================
// BOT COMMANDS
// ===============================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
`🔥 MONEY MAKING MACHINE BOT

Welcome! 👋

Your XAUUSD trading assistant.

📊 Market analysis
🚨 Entry alerts
⚖️ 1:${RR} risk-to-reward
🛡️ ATR-based risk levels

Choose an option below:`, mainMenu);
});

bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;

  if (msg.text === "📊 XAUUSD Signal") {
    try {
      const price = await getGoldPrice();
      const status = pendingSetup
        ? `👀 Watching a ${pendingSetup.label} ${pendingSetup.direction.toUpperCase()} setup - waiting for retest.`
        : candles.length < 40
          ? `⏳ Loading candle history (${candles.length}/40).`
          : !inSession()
            ? `😴 Outside London/NY hours - not hunting setups.`
            : `🔎 No active setup right now.`;

      await bot.sendMessage(chatId,
`🔎 XAUUSD MARKET CHECK

💰 Current Price: ${price.toFixed(2)}
📈 1h Trend: ${htfTrend.toUpperCase()}

${status}

A signal is sent automatically when all conditions confirm.`);
    } catch (e) {
      console.error("Signal price error:", e.message);
      bot.sendMessage(chatId, "⚠️ XAUUSD market data is temporarily unavailable.");
    }
  }

  if (msg.text === "💰 Live Price") {
    try {
      const price = await getGoldPrice();
      bot.sendMessage(chatId, `💰 XAUUSD PRICE\n\n🪙 ${price.toFixed(2)}\n⏱️ Updated every few minutes`);
    } catch (e) {
      console.error("Live price error:", e.response?.data || e.message);
      bot.sendMessage(chatId, "⚠️ Unable to retrieve the current XAUUSD price.");
    }
  }

  if (msg.text === "🔔 Auto Signals") {
    subscribers.set(chatId, {
      username: msg.from.username || null,
      firstName: msg.from.first_name || "Unknown",
      joinedAt: subscribers.has(chatId) ? subscribers.get(chatId).joinedAt : Date.now()
    });
    bot.sendMessage(chatId,
`🔔 AUTOMATIC SIGNALS ENABLED

You'll get an alert when a full setup is confirmed:

📈 1h trend filter
📊 BOS + FVG / Order Block
✅ Retest + confirmation candle
⚖️ 1:${RR} risk-to-reward

Signals only fire during London/NY hours.`);
  }

  if (msg.text === "🔕 Stop Alerts") {
    subscribers.delete(chatId);
    bot.sendMessage(chatId, "🔕 AUTOMATIC SIGNALS STOPPED\n\nTurn them back on anytime with 🔔 Auto Signals");
  }

  if (msg.text === "📖 How It Works") {
    bot.sendMessage(chatId,
`📖 HOW IT WORKS

1️⃣ Real 5-minute candles from a data provider
2️⃣ 1h trend must agree (EMA 20/50)
3️⃣ Break of structure + Fair Value Gap
4️⃣ Price retests the zone and a confirming candle closes
5️⃣ Stop = ATR-based (min $${MIN_SL_USD}), Target = ${RR}x the risk

Setups are cancelled if price closes through the zone.
Only one signal at a time. London/NY hours only.`);
  }

  if (msg.text === "⚙️ Settings") {
    bot.sendMessage(chatId,
`⚙️ SETTINGS

📊 Market: XAUUSD
⚖️ Risk:Reward 1:${RR}
🛡️ Min stop: $${MIN_SL_USD} / Max: $${MAX_SL_USD}
🕐 Hours: ${SESSION_START_UTC}:00-${SESSION_END_UTC}:00 UTC, Mon-Fri
📈 1h trend: ${htfTrend}
📉 Candles loaded: ${candles.length}`);
  }
});

// ===============================
// START
// ===============================
// Fetch only when a new candle has just closed, and only during
// trading hours (or while a signal is open). ~170 calls/day vs 800 limit.
let lastLtfSlot = Math.floor(Date.now() / LTF.ms);
let lastHtfSlot = Math.floor(Date.now() / HTF.ms);

function tick() {
  const now = Date.now();
  const active = inSession() || hasOpenSignal();

  const ltfSlot = Math.floor(now / LTF.ms);
  if (ltfSlot !== lastLtfSlot && now - ltfSlot * LTF.ms >= 10000 && (active || candles.length === 0)) {
    lastLtfSlot = ltfSlot;
    refreshLTF();
  }

  const htfSlot = Math.floor(now / HTF.ms);
  if (htfSlot !== lastHtfSlot && now - htfSlot * HTF.ms >= 15000 && (active || htfCandles.length === 0)) {
    lastHtfSlot = htfSlot;
    refreshHTF();
  }
}

refreshHTF().then(refreshLTF);
setInterval(tick, 20000);

app.listen(PORT, () => console.log(`🔥 MONEY MAKING MACHINE BOT running on port ${PORT}`));
