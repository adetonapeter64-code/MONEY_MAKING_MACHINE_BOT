
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

// Read the Twelve Data API key from Render environment variables.
const TD_KEY_NAME = Object.keys(process.env).find(k => k.toUpperCase().startsWith("TWE"));
const TD_KEY = TD_KEY_NAME
  ? String(process.env[TD_KEY_NAME]).trim().replace(/^["']|["']$/g, "")
  : null;

if (!TD_KEY) {
  console.error("No Twelve Data key found. Add TWELVE_DATA_API_KEY in Render.");
} else {
  console.log(`Twelve Data key loaded from variable: ${TD_KEY_NAME}`);
}

const bot = new TelegramBot(token, {
  polling: true
});

app.use(express.urlencoded({ extended: true }));

// ===============================
// ADMIN PANEL LOGIN
// ===============================

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Authentication required.");
  }

  const decoded = Buffer.from(authHeader.split(" ")[1], "base64").toString();
  const [user, pass] = decoded.split(":");

  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) {
    return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Invalid credentials.");
}

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

const subscribers = new Map();
const signalHistory = [];
const MAX_SIGNAL_HISTORY = 100;
const botStartedAt = Date.now();

// ================================================================
// STRATEGY SETTINGS: 1H BIAS -> 15M ZONE -> 5M ENTRY
// ================================================================

const SYMBOL = "XAU/USD";

const TF = {
  "1h":  { interval: "1h",    ms: 60 * 60 * 1000, size: 120 },
  "15m": { interval: "15min", ms: 15 * 60 * 1000, size: 150 },
  "5m":  { interval: "5min",  ms: 5 * 60 * 1000, size: 150 }
};

const SWING_LOOKBACK = { "1h": 2, "15m": 2, "5m": 1 };

const HTF_RANGE_CANDLES = 36;
const SETUP_FRESH_CANDLES = 30;
const IMPULSE_WINDOW = 10;
const TOUCH_LOOKBACK_5M = 18;
const PLAN_EXPIRY_MS = 6 * 60 * 60 * 1000;
const INVALIDATION_BUFFER = 0.5;

const PIP_SIZE = 0.1;
const SL_BUFFER = 1.0;
const MIN_SL_USD = 1.5;
const MAX_SL_USD = 15;
const MIN_RR = 2;

const SESSION_FILTER = true;
const SESSION_START_UTC = 7;
const SESSION_END_UTC = 20;

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;

// Twelve Data usage safeguards
const FETCH_DELAY_MS = 15000;
const RETRY_MS = 60000;
const DAILY_CREDIT_LIMIT = 700;

// ================================================================
// DATA STATE
// ================================================================

const candles = { "1h": [], "15m": [], "5m": [] };
const lastBucket = {};
const lastAttempt = {};
const lastFetchOk = {};

let creditsUsed = 0;
let creditDay = new Date().getUTCDate();
let pausedUntil = 0;
let dataStatus = "Starting...";
let fetching = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rolloverCredits() {
  const day = new Date().getUTCDate();
  if (day !== creditDay) {
    creditDay = day;
    creditsUsed = 0;
  }
}

function nextUtcMidnight() {
  const n = new Date();
  return Date.UTC(
    n.getUTCFullYear(),
    n.getUTCMonth(),
    n.getUTCDate() + 1
  ) + 60000;
}

// Gold market closing hours
function isMarketClosed(now = new Date()) {
  const d = now.getUTCDay();
  const h = now.getUTCHours();

  if (d === 6) return true;
  if (d === 5 && h >= 22) return true;
  if (d === 0 && h < 22) return true;

  return false;
}

async function fetchCandles(tf) {
  const cfg = TF[tf];

  const res = await axios.get(
    "https://api.twelvedata.com/time_series",
    {
      params: {
        symbol: SYMBOL,
        interval: cfg.interval,
        outputsize: cfg.size,
        order: "asc",
        timezone: "UTC",
        apikey: TD_KEY
      },
      timeout: 15000
    }
  );

  creditsUsed++;
  const d = res.data;

  if (!d || d.status === "error" || !Array.isArray(d.values)) {
    const err = new Error(
      (d && d.message) || "Bad response from Twelve Data"
    );
    err.apiCode = d && d.code;
    throw err;
  }

  const now = Date.now();

  return d.values
    .map(v => ({
      t: Date.parse(String(v.datetime).replace(" ", "T") + "Z"),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close)
    }))
    .filter(c =>
      Number.isFinite(c.t) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.t + cfg.ms <= now + 2000
    );
}

function handleDataError(e) {
  const body = e.response && e.response.data;
  const msg = (body && body.message) || e.message || "Unknown error";
  const code = (body && body.code) ||
    e.apiCode ||
    (e.response && e.response.status);

  dataStatus = `Error: ${String(msg).slice(0, 140)}`;
  console.error(
    "Twelve Data error:",
    code,
    String(msg).slice(0, 200)
  );

  if (/for the day/i.test(msg)) {
    pausedUntil = nextUtcMidnight();
    dataStatus = "Daily Twelve Data credits used up - resumes after 00:00 UTC";
  } else if (Number(code) === 429 || /current minute/i.test(msg)) {
    pausedUntil = Date.now() + 70000;
  } else if (Number(code) === 401 || Number(code) === 403) {
    pausedUntil = Date.now() + 10 * 60000;
    dataStatus = "Twelve Data key rejected - check the key in Render";
  }
}

// Fetch data when a new candle has closed.
async function dataTick() {
  if (fetching) return;
  fetching = true;

  try {
    rolloverCredits();

    if (!TD_KEY) {
      dataStatus = "No Twelve Data key found in Render variables";
      return;
    }

    if (Date.now() < pausedUntil) return;

    const closed = isMarketClosed();
    let updated = false;

    for (const tf of Object.keys(TF)) {
      const cfg = TF[tf];
      const have = candles[tf].length > 0;

      if (closed && have) continue;

      const now = Date.now();
      const bucket = Math.floor(now / cfg.ms);
      const due = !have ||
        (lastBucket[tf] !== bucket &&
         now - bucket * cfg.ms >= FETCH_DELAY_MS);

      if (!due) continue;
      if (now - (lastAttempt[tf] || 0) < RETRY_MS) continue;

      if (creditsUsed >= DAILY_CREDIT_LIMIT) {
        dataStatus = "Credit safety limit reached - paused until 00:00 UTC";
        break;
      }

      lastAttempt[tf] = now;

      try {
        candles[tf] = await fetchCandles(tf);
        lastBucket[tf] = bucket;
        lastFetchOk[tf] = Date.now();
        updated = true;
        dataStatus = "OK";

        console.log(
          `[DATA] ${tf}: ${candles[tf].length} candles | credits today: ${creditsUsed}`
        );
      } catch (e) {
        handleDataError(e);
        if (Date.now() < pausedUntil) break;
      }

      await sleep(1500);
    }

    if (updated) analyze();
  } catch (e) {
    console.error("Data tick error:", e.message);
  } finally {
    fetching = false;
  }
}

// ================================================================
// LIVE PRICE
// ================================================================

let cached = { price: null, time: 0 };

async function getGoldPrice() {
  if (cached.price && Date.now() - cached.time < 20000) {
    return cached.price;
  }

  const sources = [
    async () => Number(
      (await axios.get(
        "https://api.gold-api.com/price/XAU",
        { timeout: 10000 }
      )).data.price
    ),
    async () => Number(
      (await axios.get(
        "https://xaus.com/api/v1/spot?compact=1",
        { timeout: 10000 }
      )).data.xau.price
    )
  ];

  for (const source of sources) {
    try {
      const p = await source();

      if (p > 0) {
        cached = { price: p, time: Date.now() };
        return p;
      }
    } catch (e) {
      console.error(
        "Price source failed:",
        (e.response && e.response.status) || e.message
      );
    }
  }

  if (cached.price && Date.now() - cached.time < 600000) {
    return cached.price;
  }

  const c5 = candles["5m"];

  if (c5.length > 0) {
    return c5[c5.length - 1].close;
  }

  throw new Error("All price sources failed");
}

// ================================================================
// STRUCTURE TOOLS
// ================================================================

// Confirmed swing high/low
function findSwings(arr, lookback) {
  const swings = [];

  for (let i = lookback; i < arr.length - lookback; i++) {
    const slice = arr.slice(i - lookback, i + lookback + 1);
    const c = arr[i];

    if (slice.every(s => s.high <= c.high)) {
      swings.push({
        index: i,
        price: c.high,
        type: "high"
      });
    }

    if (slice.every(s => s.low >= c.low)) {
      swings.push({
        index: i,
        price: c.low,
        type: "low"
      });
    }
  }

  return swings;
}

// Identify BOS and CHoCH from candle closes.
function analyzeStructure(arr, lookback) {
  const swings = findSwings(arr, lookback);
  const breaks = [];

  let trend = null;
  let lastHigh = null;
  let lastLow = null;
  let si = 0;

  for (let i = 0; i < arr.length; i++) {
    while (
      si < swings.length &&
      swings[si].index + lookback <= i
    ) {
      const s = swings[si++];

      if (s.type === "high") lastHigh = s;
      else lastLow = s;
    }

    const c = arr[i];

    if (lastHigh && !lastHigh.broken && c.close > lastHigh.price) {
      breaks.push({
        dir: "bullish",
        type: trend === "bullish" || trend === null ? "BOS" : "CHoCH",
        index: i,
        level: lastHigh.price
      });

      trend = "bullish";
      lastHigh.broken = true;
    } else if (lastLow && !lastLow.broken && c.close < lastLow.price) {
      breaks.push({
        dir: "bearish",
        type: trend === "bearish" || trend === null ? "BOS" : "CHoCH",
        index: i,
        level: lastLow.price
      });

      trend = "bearish";
      lastLow.broken = true;
    }
  }

  return { trend, swings, breaks };
}

// ================================================================
// STEP 1 - 1H BIAS + PREMIUM / DISCOUNT RANGE
// ================================================================

function getHTF() {

  const c = candles["1h"];
  if (c.length < 30) return null;

  const st = analyzeStructure(c, SWING_LOOKBACK["1h"]);
  const recent = c.slice(-HTF_RANGE_CANDLES);

  const rangeHigh = Math.max(...recent.map(x => x.high));
  const rangeLow = Math.min(...recent.map(x => x.low));

  return {
    bias: st.trend,
    lastBreak: st.breaks.length ? st.breaks[st.breaks.length - 1] : null,
    swings: st.swings,
    rangeHigh,
    rangeLow,
    eq: (rangeHigh + rangeLow) / 2
  };
}

// ================================================================
// STEP 2 - 15M: STRUCTURE BREAK + POINT OF INTEREST
// ================================================================

const deadPOIs = new Set();

function find15mSetup(htf) {
  const c = candles["15m"];
  if (c.length < 40 || !htf || !htf.bias) return null;

  const dir = htf.bias;
  const bull = dir === "bullish";
  const st = analyzeStructure(c, SWING_LOOKBACK["15m"]);

  const last = st.breaks.length ? st.breaks[st.breaks.length - 1] : null;
  if (!last || last.dir !== dir) return null;

  const b = last.index;
  if (b < c.length - 1 - SETUP_FRESH_CANDLES) return null;

  let o = Math.max(0, b - IMPULSE_WINDOW);

  for (let i = o; i <= b; i++) {
    if (bull ? c[i].low < c[o].low : c[i].high > c[o].high) {
      o = i;
    }
  }

  let obIdx = o;

  for (let i = o; i >= Math.max(0, o - 3); i--) {
    const opposite = bull
      ? c[i].close < c[i].open
      : c[i].close > c[i].open;

    if (opposite) {
      obIdx = i;
      break;
    }
  }

  const zone = {
    top: c[obIdx].high,
    bottom: c[obIdx].low
  };

  let fvg = null;
  const endI = Math.min(b + 1, c.length - 1);

  for (let i = Math.max(2, o + 1); i <= endI; i++) {
    const c1 = c[i - 2];
    const c3 = c[i];

    if (bull && c1.high < c3.low) {
      fvg = { top: c3.low, bottom: c1.high };
      break;
    }

    if (!bull && c1.low > c3.high) {
      fvg = { top: c1.low, bottom: c3.high };
      break;
    }
  }

  if (!fvg) return null;

  const obTime = c[obIdx].t;
  if (deadPOIs.has(obTime)) return null;

  for (let k = b + 1; k < c.length; k++) {
    if (bull && c[k].close < zone.bottom - INVALIDATION_BUFFER) {
      return null;
    }

    if (!bull && c[k].close > zone.top + INVALIDATION_BUFFER) {
      return null;
    }
  }

  const mid = (zone.top + zone.bottom) / 2;

  if (bull && mid > htf.eq) return null;
  if (!bull && mid < htf.eq) return null;

  let sweep = false;

  for (let k = st.swings.length - 1; k >= 0; k--) {
    const s = st.swings[k];

    if (s.index >= o || s.index < o - 40) continue;

    if (bull && s.type === "low") {
      sweep = c[o].low < s.price;
      break;
    }

    if (!bull && s.type === "high") {
      sweep = c[o].high > s.price;
      break;
    }
  }

  const overlap = zone.top >= fvg.bottom &&
    zone.bottom <= fvg.top;

  return {
    dir,
    label: last.type,
    zone,
    fvg,
    sweep,
    overlap,
    obTime,
    breakTime: c[b].t + TF["15m"].ms,
    createdAt: Date.now(),
    eq: htf.eq,
    rangeHigh: htf.rangeHigh,
    rangeLow: htf.rangeLow
  };
}

// ================================================================
// STEP 3 - 5M: RETEST + CONFIRMATION
// ================================================================

let activePlan = null;

function killPlan(reason) {
  if (activePlan) {
    deadPOIs.add(activePlan.obTime);
    console.log(`[PLAN] Dropped: ${reason}`);
  }

  activePlan = null;
}

function evaluateEntry() {
  const c = candles["5m"];
  const plan = activePlan;

  if (!plan || c.length < 30) return null;

  const buy = plan.dir === "bullish";
  const z = plan.zone;

  const startIdx = c.findIndex(x => x.t >= plan.breakTime);
  if (startIdx < 0) return null;

  for (let i = startIdx; i < c.length; i++) {
    if (
      buy
        ? c[i].close < z.bottom - INVALIDATION_BUFFER
        : c[i].close > z.top + INVALIDATION_BUFFER
    ) {
      killPlan("5M closed through the zone");
      return null;
    }
  }

  const last = c.length - 1;
  let touchIdx = -1;

  for (
    let i = Math.max(startIdx, c.length - TOUCH_LOOKBACK_5M);
    i <= last;
    i++
  ) {
    if (c[i].low <= z.top && c[i].high >= z.bottom) {
      touchIdx = i;
      break;
    }
  }

  if (touchIdx < 0) return null;

  let extIdx = touchIdx;

  for (let i = touchIdx; i <= last; i++) {
    if (
      buy
        ? c[i].low < c[extIdx].low
        : c[i].high > c[extIdx].high
    ) {
      extIdx = i;
    }
  }

  let level = null;
  let levelIdx = -1;

  for (
    let k = extIdx - 1;
    k >= Math.max(1, touchIdx - 6);
    k--
  ) {
    if (
      buy &&
      c[k].high >= c[k - 1].high &&
      c[k].high >= c[k + 1].high
    ) {
      level = c[k].high;
      levelIdx = k;
      break;
    }

    if (
      !buy &&
      c[k].low <= c[k - 1].low &&
      c[k].low <= c[k + 1].low
    ) {
      level = c[k].low;
      levelIdx = k;
      break;
    }
  }

  if (level === null) return null;

  const lc = c[last];
  const prev = c[last - 1];

  const confirmed = buy
    ? lc.close > level &&
      lc.close > lc.open &&
      prev.close <= level
    : lc.close < level &&
      lc.close < lc.open &&
      prev.close >= level;

  if (!confirmed || last <= levelIdx) return null;

  const entry = lc.close;
  const ext = buy ? c[extIdx].low : c[extIdx].high;

  const sl = buy
    ? Math.min(ext, z.bottom) - SL_BUFFER
    : Math.max(ext, z.top) + SL_BUFFER;

  const risk = Math.abs(entry - sl);

  if (risk < MIN_SL_USD || risk > MAX_SL_USD) {
    console.log(
      `[PLAN] Confirmation seen but stop distance $${risk.toFixed(2)} is outside limits - skipped`
    );
    return null;
  }

  const htf = getHTF();

  const htfSwings = htf
    ? htf.swings.map(s => s.price)
    : [];

  const ltfSwings = analyzeStructure(
    candles["15m"],
    SWING_LOOKBACK["15m"]
  ).swings.map(s => s.price);

  const levels = [...htfSwings, ...ltfSwings]
    .filter(p => buy ? p > entry : p < entry)
    .sort((a, b2) => buy ? a - b2 : b2 - a);

  let tp = buy
    ? entry + MIN_RR * risk
    : entry - MIN_RR * risk;

  let tpType = `fixed ${MIN_RR}R`;

  for (const p of levels) {
    if (Math.abs(p - entry) / risk >= MIN_RR) {
      tp = p;
      tpType = "next swing liquidity";
      break;
    }
  }

  return {
    plan,
    entry,
    sl,
    tp,
    risk,
    rr: Math.abs(tp - entry) / risk,
    tpType,
    ltfLabel: buy ? "bullish CHoCH/BOS" : "bearish CHoCH/BOS"
  };
}

// ================================================================
// MAIN ANALYSIS
// ================================================================

let htfState = null;

function hasOpenSignal() {
  return signalHistory.some(s => s.status === "open");
}

function analyze() {
  htfState = getHTF();

  if (!htfState || !htfState.bias) {
    activePlan = null;
    return;
  }

  if (hasOpenSignal()) return;

  if (activePlan && activePlan.dir !== htfState.bias) {
    killPlan("1H bias changed");
  }

  if (
    activePlan &&
    Date.now() - activePlan.createdAt > PLAN_EXPIRY_MS
  ) {
    killPlan("plan expired");
  }

  if (!activePlan) {
    activePlan = find15mSetup(htfState);

    if (activePlan) {
      const p = activePlan;

      console.log(
        `[PLAN] ${p.dir} ${p.label} on 15M | zone ${p.zone.bottom.toFixed(2)}-${p.zone.top.toFixed(2)} | sweep: ${p.sweep}`
      );
    }
  }

  if (!activePlan) return;

  const sig = evaluateEntry();

  if (sig) fireSignal(sig);
}

// ================================================================
// FIRE SIGNAL
// ================================================================

let lastSignalTime = 0;

function fireSignal(sig) {
  const plan = sig.plan;
  const c5 = candles["5m"];

  if (Date.now() - lastSignalTime < SIGNAL_COOLDOWN_MS) {
    console.log("[SIGNAL] Skipped - cooldown active");
    return;
  }

  if (SESSION_FILTER) {
    const h = new Date().getUTCHours();

    if (h < SESSION_START_UTC || h >= SESSION_END_UTC) {
      console.log("[SIGNAL] Skipped - outside London/New York session");
      return;
    }
  }

  if (
    c5.length === 0 ||
    Date.now() - (c5[c5.length - 1].t + TF["5m"].ms) >
      15 * 60 * 1000
  ) {
    console.log("[SIGNAL] Skipped - 5M data is stale");
    return;
  }

  lastSignalTime = Date.now();
  deadPOIs.add(plan.obTime);
  activePlan = null;

  const buy = plan.dir === "bullish";
  const direction = buy ? "BUY" : "SELL";
  const emoji = buy ? "🟢" : "🔴";

  const riskPips = Math.round(sig.risk / PIP_SIZE);
  const rewardPips = Math.round(Math.abs(sig.tp - sig.entry) / PIP_SIZE);
  const side = buy ? "discount" : "premium";

  const confluences = [];

  if (plan.sweep) confluences.push("liquidity sweep");
  if (plan.overlap) confluences.push("OB + FVG overlap");

  const message =
`🚨 XAUUSD ${direction} SIGNAL
🧠 Top-Down SMC

${emoji} ${direction} @ ${sig.entry.toFixed(2)}

🛡️ Stop Loss: ${sig.sl.toFixed(2)} (${riskPips} pips)
🎯 Take Profit: ${sig.tp.toFixed(2)} (${rewardPips} pips)
⚖️ Risk:Reward 1:${sig.rr.toFixed(1)} (${sig.tpType})

🧭 Top-down analysis
• 📈 1H: ${plan.dir.toUpperCase()} bias, entry zone in ${side}
• 🟦 15M: ${plan.label} ${plan.dir} + FVG, Order Block ${plan.zone.bottom.toFixed(2)}-${plan.zone.top.toFixed(2)}${confluences.length ? " (" + confluences.join(", ") + ")" : ""}
• ✅ 5M: price tapped the zone, then ${sig.ltfLabel}

⚠️ Always manage your own risk. This is not financial advice.`;

  console.log(
    `[SIGNAL FIRED] ${direction} @ ${sig.entry} SL ${sig.sl} TP ${sig.tp}`
  );

  signalHistory.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    time: Date.now(),
    label: `${plan.label} 15M`,
    direction,
    entryPrice: sig.entry,
    stopLoss: sig.sl,
    takeProfit: sig.tp,
    status: "open",
    closedAt: null,
    closePrice: null
  });

  if (signalHistory.length > MAX_SIGNAL_HISTORY) {
    signalHistory.pop();
  }

  for (const chatId of subscribers.keys()) {
    bot.sendMessage(chatId, message).catch(err => {
      console.error(
        `Failed to send signal to ${chatId}:`,
        err.message
      );
    });
  }
}

// ================================================================
// OUTCOME TRACKER
// ================================================================

function checkOpenSignals(currentPrice) {
  const openSignals = signalHistory.filter(s => s.status === "open");

  for (const signal of openSignals) {
    let hitTP = false;
    let hitSL = false;

    if (signal.direction === "BUY") {
      hitTP = currentPrice >= signal.takeProfit;
      hitSL = currentPrice <= signal.stopLoss;
    } else {
      hitTP = currentPrice <= signal.takeProfit;
      hitSL = currentPrice >= signal.stopLoss;
    }

    if (hitSL) {
      signal.status = "loss";
    } else if (hitTP) {
      signal.status = "win";
    } else {
      continue;
    }

    signal.closedAt = Date.now();
    signal.closePrice = currentPrice;
    lastSignalTime = Date.now();

    const resultEmoji = signal.status === "win" ? "✅" : "❌";
    const resultText = signal.status === "win"
      ? "TAKE PROFIT HIT"
      : "STOP LOSS HIT";

    const closeMessage =
`${resultEmoji} SIGNAL CLOSED - ${resultText}

📌 ${signal.direction} @ ${signal.entryPrice.toFixed(2)}
🏁 Closed @ ${currentPrice.toFixed(2)}

${signal.status === "win" ? "🎯 Target reached." : "🛡️ Stop loss protected your downside."}`;

    console.log(`[SIGNAL CLOSED] ${signal.direction} @ ${signal.entryPrice} -> ${signal.status.toUpperCase()} @ ${currentPrice}`);

    for (const chatId of subscribers.keys()) {
      bot.sendMessage(chatId, closeMessage).catch(err => {
        console.error(`Failed to send close update to ${chatId}:`, err.message);
      });
    }
  }
}

async function monitorPrice() {
  try {
    const price = await getGoldPrice();
    checkOpenSignals(price);
  } catch (error) {
    console.error("Price monitor error:", error.message);
  }
}

// ================================================================
// STATUS TEXT (used by the Signal button)
// ================================================================

function statusText() {
  const lines = [];

  if (!htfState) {
    lines.push("⏳ Loading 1H data...");
  } else if (!htfState.bias) {
    lines.push("📈 1H bias: not clear yet");
  } else {
    lines.push(`📈 1H bias: ${htfState.bias.toUpperCase()}`);
  }

  if (activePlan) {
    const p = activePlan;
    lines.push(`🧭 15M: ${p.label} ${p.dir} found`);
    lines.push(`🟦 Watching zone ${p.zone.bottom.toFixed(2)} - ${p.zone.top.toFixed(2)}`);
    lines.push("⏳ Waiting for a 5M tap and confirmation");
  } else if (htfState && htfState.bias) {
    lines.push("🔎 15M: no setup in line with the 1H bias yet");
  }

  if (hasOpenSignal()) lines.push("📌 A signal is currently open");

  return lines.join("\n");
}

// ===============================
// WEB SERVER + ADMIN PANEL
// ===============================

app.get("/", (req, res) => {
  res.send("🔥 MONEY MAKING MACHINE BOT is running.");
});

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatUptime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

app.get("/admin", requireAdminAuth, (req, res) => {

  const c5 = candles["5m"];
  const price = c5.length > 0 ? c5[c5.length - 1].close : null;

  const subscriberRows = [...subscribers.entries()].map(([chatId, info]) => `
    <tr>
      <td>${escapeHtml(info.firstName)}${info.username ? " (@" + escapeHtml(info.username) + ")" : ""}</td>
      <td>${chatId}</td>
      <td>${new Date(info.joinedAt).toLocaleString()}</td>
      <td>
        <form method="POST" action="/admin/remove" style="margin:0;">
          <input type="hidden" name="chatId" value="${chatId}">
          <button type="submit" class="danger">Remove</button>
        </form>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="4">No subscribers yet.</td></tr>`;

  const statusBadge = { open: "⏳ Open", win: "✅ Win", loss: "❌ Loss" };

  const signalRows = signalHistory.slice(0, 20).map(s => `
    <tr>
      <td>${new Date(s.time).toLocaleString()}</td>
      <td>${escapeHtml(s.label)}</td>
      <td>${s.direction}</td>
      <td>${s.entryPrice.toFixed(2)}</td>
      <td>${s.stopLoss.toFixed(2)}</td>
      <td>${s.takeProfit.toFixed(2)}</td>
      <td>${statusBadge[s.status] || s.status}</td>
    </tr>
  `).join("") || `<tr><td colspan="7">No signals fired yet.</td></tr>`;

  const wins = signalHistory.filter(s => s.status === "win").length;
  const losses = signalHistory.filter(s => s.status === "loss").length;
  const openCount = signalHistory.filter(s => s.status === "open").length;
  const decided = wins + losses;
  const winRate = decided > 0 ? ((wins / decided) * 100).toFixed(1) : "—";

  const bias = htfState && htfState.bias ? htfState.bias.toUpperCase() : "—";
  const planStatus = activePlan
    ? `Watching ${escapeHtml(activePlan.label)} ${escapeHtml(activePlan.dir)} zone ${activePlan.zone.bottom.toFixed(2)}-${activePlan.zone.top.toFixed(2)}`
    : "No active setup right now.";

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Money Making Machine - Admin</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; background: #0f1115; color: #eee; margin: 0; padding: 16px; }
  h1 { font-size: 1.3rem; }
  h2 { font-size: 1.05rem; margin-top: 28px; color: #f5c542; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
  .card { background: #1b1f27; border-radius: 10px; padding: 12px 16px; flex: 1 1 140px; }
  .card .label { font-size: 0.75rem; color: #999; }
  .card .value { font-size: 1.3rem; font-weight: bold; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.85rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #2a2f3a; }
  th { color: #aaa; font-weight: normal; }
  button { background: #2b6fe0; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-size: 0.85rem; }
  button.danger { background: #c0392b; }
  textarea { width: 100%; box-sizing: border-box; background: #1b1f27; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 8px; font-size: 0.9rem; }
  form.broadcast { margin-top: 8px; }
  .scroll { overflow-x: auto; }
</style>
</head>
<body>
  <h1>🔥 Money Making Machine - Admin</h1>
  <p><a href="/panel" style="color:#f5c542">📈 Open the live chart panel</a></p>

  <div class="stats">
    <div class="card"><div class="label">Bot uptime</div><div class="value">${formatUptime(Date.now() - botStartedAt)}</div></div>
    <div class="card"><div class="label">Last 5M close</div><div class="value">${price ? price.toFixed(2) : "—"}</div></div>
    <div class="card"><div class="label">1H bias</div><div class="value">${bias}</div></div>
    <div class="card"><div class="label">Subscribers</div><div class="value">${subscribers.size}</div></div>
    <div class="card"><div class="label">Signals sent</div><div class="value">${signalHistory.length}</div></div>
  </div>

  <div class="stats">
    <div class="card"><div class="label">Win rate</div><div class="value">${winRate}${decided > 0 ? "%" : ""}</div></div>
    <div class="card"><div class="label">Wins</div><div class="value">${wins}</div></div>
    <div class="card"><div class="label">Losses</div><div class="value">${losses}</div></div>
    <div class="card"><div class="label">Open</div><div class="value">${openCount}</div></div>
  </div>

  <div class="stats">
    <div class="card"><div class="label">1H / 15M / 5M candles</div><div class="value">${candles["1h"].length} / ${candles["15m"].length} / ${candles["5m"].length}</div></div>
    <div class="card"><div class="label">Credits used today</div><div class="value">${creditsUsed} / 800</div></div>
  </div>

  <p><strong>Data status:</strong> ${escapeHtml(dataStatus)}</p>
  <p><strong>Setup status:</strong> ${planStatus}</p>

  <h2>Send a manual message to all subscribers</h2>
  <form class="broadcast" method="POST" action="/admin/broadcast">
    <textarea name="message" rows="3" placeholder="Type a message to send to every subscriber..."></textarea>
    <br><br>
    <button type="submit">Send Broadcast</button>
  </form>

  <h2>Subscribers (${subscribers.size})</h2>
  <div class="scroll">
    <table>
      <tr><th>Name</th><th>Chat ID</th><th>Joined</th><th></th></tr>
      ${subscriberRows}
    </table>
  </div>

  <h2>Recent Signals</h2>
  <div class="scroll">
    <table>
      <tr><th>Time</th><th>Type</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP</th><th>Result</th></tr>
      ${signalRows}
    </table>
  </div>

</body>
</html>
  `);
});

app.post("/admin/remove", requireAdminAuth, (req, res) => {
  const chatId = Number(req.body.chatId);
  subscribers.delete(chatId);
  res.redirect("/admin");
});

app.post("/admin/broadcast", requireAdminAuth, async (req, res) => {
  const text = (req.body.message || "").trim();

  if (text) {
    for (const chatId of subscribers.keys()) {
      bot.sendMessage(chatId, `📢 ${text}`).catch(err => {
        console.error(`Broadcast failed for ${chatId}:`, err.message);
      });
    }
  }

  res.redirect("/admin");
});

// ================================================================
// ON-DEMAND CHART DATA  (any pair, any timeframe - chart only)
// XAU/USD on 5m / 15m / 1h comes from the bot's own data (no credits).
// Everything else is fetched when you open it and cached, with a
// daily cap so it can never use up the Twelve Data credits.
// ================================================================

const CHART_TFS = {
  "1m":  { interval: "1min",  ms: 60 * 1000 },
  "5m":  { interval: "5min",  ms: 5 * 60 * 1000 },
  "15m": { interval: "15min", ms: 15 * 60 * 1000 },
  "30m": { interval: "30min", ms: 30 * 60 * 1000 },
  "1h":  { interval: "1h",    ms: 60 * 60 * 1000 },
  "4h":  { interval: "4h",    ms: 4 * 60 * 60 * 1000 },
  "1d":  { interval: "1day",  ms: 24 * 60 * 60 * 1000 },
  "1w":  { interval: "1week", ms: 7 * 24 * 60 * 60 * 1000 }
};

const ONDEMAND_DAILY_CAP = 200; // extra chart loads per day (1 credit each)
const ONDEMAND_BARS = 300;
const CHART_CACHE_MAX = 60;

const chartCache = new Map();    // "SYMBOL|tf" -> { at, candles }
const chartInflight = new Map(); // "SYMBOL|tf" -> promise
let onDemandUsed = 0;
let onDemandDay = new Date().getUTCDate();

function rolloverOnDemand() {
  const d = new Date().getUTCDate();
  if (d !== onDemandDay) {
    onDemandDay = d;
    onDemandUsed = 0;
  }
}

function packCandles(arr) {
  return (arr || []).map(c => ({ t: c.t, o: c.open, h: c.high, l: c.low, c: c.close }));
}

// How long a loaded chart is reused before it is fetched again
function chartTtl(tf) {
  return Math.min(Math.max(CHART_TFS[tf].ms, 60 * 1000), 60 * 60 * 1000);
}

async function fetchOnDemand(symbol, tf) {
  const cfg = CHART_TFS[tf];

  const res = await axios.get("https://api.twelvedata.com/time_series", {
    params: {
      symbol,
      interval: cfg.interval,
      outputsize: ONDEMAND_BARS,
      order: "asc",
      timezone: "UTC",
      apikey: TD_KEY
    },
    timeout: 15000
  });

  creditsUsed++;
  onDemandUsed++;

  const d = res.data;

  if (!d || d.status === "error" || !Array.isArray(d.values)) {
    const err = new Error((d && d.message) || "Bad response from Twelve Data");
    err.apiCode = d && d.code;
    throw err;
  }

  const now = Date.now();

  return d.values
    .map(v => {
      const raw = String(v.datetime);
      const iso = raw.length <= 10 ? raw + "T00:00:00Z" : raw.replace(" ", "T") + "Z";
      return {
        t: Date.parse(iso),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close)
      };
    })
    .filter(c =>
      Number.isFinite(c.t) &&
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close) &&
      c.t + cfg.ms <= now + 2000          // drop the candle that is still forming
    );
}

app.get("/api/chart", requireAdminAuth, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    rolloverOnDemand();

    const symbol = String(req.query.symbol || SYMBOL).toUpperCase().trim();
    const tf = String(req.query.tf || "5m").toLowerCase().trim();

    if (!/^[A-Z]{2,6}\\/[A-Z]{2,6}$/.test(symbol)) {
      return res.json({ error: "Use a pair like EUR/USD.", candles: [] });
    }
    if (!CHART_TFS[tf]) {
      return res.json({ error: "Unknown timeframe.", candles: [] });
    }

    const usage = { onDemandUsed, onDemandCap: ONDEMAND_DAILY_CAP, creditsUsed };

    // 1) the bot's own candles - free
    if (symbol === SYMBOL && candles[tf] && candles[tf].length) {
      return res.json({
        symbol, tf, source: "bot",
        candles: packCandles(candles[tf]),
        fetchedAt: lastFetchOk[tf] || Date.now(),
        usage
      });
    }

    // 2) recently loaded - free
    const key = symbol + "|" + tf;
    const hit = chartCache.get(key);

    if (hit && Date.now() - hit.at < chartTtl(tf)) {
      return res.json({ symbol, tf, source: "cache", candles: packCandles(hit.candles), fetchedAt: hit.at, usage });
    }

    // 3) needs a Twelve Data credit
    const stale = note => {
      if (hit) {
        return res.json({ symbol, tf, source: "stale", candles: packCandles(hit.candles), fetchedAt: hit.at, note, usage });
      }
      return res.json({ error: note, candles: [], usage });
    };

    if (!TD_KEY) return stale("No Twelve Data key is set in Render.");
    if (Date.now() < pausedUntil) return stale("Twelve Data is paused: " + dataStatus);
    if (onDemandUsed >= ONDEMAND_DAILY_CAP) {
      return stale("Extra chart limit reached today (" + ONDEMAND_DAILY_CAP + " loads). It resets at 00:00 UTC.");
    }
    if (creditsUsed >= DAILY_CREDIT_LIMIT) {
      return stale("Twelve Data credit safety limit reached for today.");
    }

    let p = chartInflight.get(key);
    if (!p) {
      p = fetchOnDemand(symbol, tf).finally(() => chartInflight.delete(key));
      chartInflight.set(key, p);
    }

    try {
      const list = await p;

      chartCache.set(key, { at: Date.now(), candles: list });
      if (chartCache.size > CHART_CACHE_MAX) {
        chartCache.delete(chartCache.keys().next().value);
      }

      return res.json({
        symbol, tf, source: "live",
        candles: packCandles(list),
        fetchedAt: Date.now(),
        usage: { onDemandUsed, onDemandCap: ONDEMAND_DAILY_CAP, creditsUsed }
      });

    } catch (e) {
      const body = e.response && e.response.data;
      const msg = String((body && body.message) || e.message || "Could not load this chart").slice(0, 160);
      const code = Number((body && body.code) || e.apiCode || (e.response && e.response.status));

      // only quota / key problems should pause the whole bot
      if (code === 429 || code === 401 || code === 403 || /credits/i.test(msg)) {
        handleDataError(e);
      }

      return stale(msg);
    }

  } catch (e) {
    res.status(500).json({ error: e.message, candles: [] });
  }
});


// ================================================================
// LIVE PANEL  -  open  your-bot-url/panel  (same login as /admin)
// Shows the candles and the top-down SMC read-out of the bot.
// ================================================================

function structureFor(tf) {
  const arr = candles[tf];
  if (!arr || arr.length < 12) return [];

  const st = analyzeStructure(arr, SWING_LOOKBACK[tf]);

  return st.breaks.slice(-12).map(b => ({
    t: arr[b.index].t,
    dir: b.dir,
    type: b.type,
    level: b.level
  }));
}

// Read-only version of the 5M entry check, used to show progress on the panel
function describeProgress() {
  const plan = activePlan;
  const c = candles["5m"];

  if (!plan || c.length < 30) return null;

  const buy = plan.dir === "bullish";
  const z = plan.zone;

  const startIdx = c.findIndex(x => x.t >= plan.breakTime);
  if (startIdx < 0) return { tapped: false, note: "Waiting for 5M candles after the 15M break" };

  const last = c.length - 1;
  let touchIdx = -1;

  for (let i = Math.max(startIdx, c.length - TOUCH_LOOKBACK_5M); i <= last; i++) {
    if (c[i].low <= z.top && c[i].high >= z.bottom) {
      touchIdx = i;
      break;
    }
  }

  if (touchIdx < 0) return { tapped: false, note: "Waiting for price to return to the zone" };

  let extIdx = touchIdx;
  for (let i = touchIdx; i <= last; i++) {
    if (buy ? c[i].low < c[extIdx].low : c[i].high > c[extIdx].high) extIdx = i;
  }

  let level = null;
  for (let k = extIdx - 1; k >= Math.max(1, touchIdx - 6); k--) {
    if (buy && c[k].high >= c[k - 1].high && c[k].high >= c[k + 1].high) {
      level = c[k].high;
      break;
    }
    if (!buy && c[k].low <= c[k - 1].low && c[k].low <= c[k + 1].low) {
      level = c[k].low;
      break;
    }
  }

  return {
    tapped: true,
    tapTime: c[touchIdx].t,
    level,
    note: level === null
      ? "Zone tapped - waiting for a 5M structure level to form"
      : "Zone tapped - waiting for a 5M candle to close beyond the level"
  };
}

async function buildPanelData() {
  let price = null;

  try {
    price = await getGoldPrice();
  } catch (e) {
    price = null;
  }

  const pack = arr => (arr || []).map(c => ({ t: c.t, o: c.open, h: c.high, l: c.low, c: c.close }));

  const htf = getHTF();

  let htfOut = null;
  if (htf) {
    htfOut = {
      bias: htf.bias,
      rangeHigh: htf.rangeHigh,
      rangeLow: htf.rangeLow,
      eq: htf.eq,
      zone: price ? (price < htf.eq ? "discount" : "premium") : null
    };
  }

  let planOut = null;
  if (activePlan) {
    const p = activePlan;
    planOut = {
      dir: p.dir,
      label: p.label,
      zoneTop: p.zone.top,
      zoneBottom: p.zone.bottom,
      fvgTop: p.fvg ? p.fvg.top : null,
      fvgBottom: p.fvg ? p.fvg.bottom : null,
      sweep: p.sweep,
      overlap: p.overlap,
      obTime: p.obTime,
      breakTime: p.breakTime,
      createdAt: p.createdAt
    };
  }

  const hr = new Date().getUTCHours();

  return {
    now: Date.now(),
    price,
    htf: htfOut,
    plan: planOut,
    progress: describeProgress(),
    candles: {
      "5m": pack(candles["5m"]),
      "15m": pack(candles["15m"]),
      "1h": pack(candles["1h"])
    },
    structure: {
      "5m": structureFor("5m"),
      "15m": structureFor("15m"),
      "1h": structureFor("1h")
    },
    signals: signalHistory.slice(0, 15).map(s => ({
      time: s.time,
      dir: s.direction,
      label: s.label,
      entry: s.entryPrice,
      sl: s.stopLoss,
      tp: s.takeProfit,
      status: s.status,
      closedAt: s.closedAt,
      closePrice: s.closePrice
    })),
    status: {
      marketClosed: isMarketClosed(),
      session: !SESSION_FILTER || (hr >= SESSION_START_UTC && hr < SESSION_END_UTC),
      dataStatus,
      creditsUsed,
      onDemandUsed,
      onDemandCap: ONDEMAND_DAILY_CAP,
      paused: Date.now() < pausedUntil,
      lastFetch: {
        "5m": lastFetchOk["5m"] || 0,
        "15m": lastFetchOk["15m"] || 0,
        "1h": lastFetchOk["1h"] || 0
      },
      wins: signalHistory.filter(s => s.status === "win").length,
      losses: signalHistory.filter(s => s.status === "loss").length
    }
  };
}

app.get("/api/panel", requireAdminAuth, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await buildPanelData());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/panel", requireAdminAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(PANEL_HTML);
});

const PANEL_HTML = String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>MMM Live Panel</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; height: 100%; background: #131722; color: #d1d4dc; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 14px; overflow: hidden; }
  #app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
  .up { color: #26a69a; }
  .down { color: #ef5350; }
  .warn { color: #f5c542; }
  .dim { color: #787b86; }
  .small { font-size: 12px; }

  #bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px 6px; background: #131722; border-bottom: 1px solid #2a2e39; }
  #symWrap { position: relative; }
  #symSel { background: transparent; color: #d1d4dc; border: none; font-size: 17px; font-weight: 700; padding: 0 16px 0 0; margin: 0; -webkit-appearance: none; appearance: none; outline: none; max-width: 150px; }
  #symWrap:after { content: "\25BE"; position: absolute; right: 0; top: 2px; color: #787b86; pointer-events: none; }
  #symSub { font-size: 11px; color: #787b86; margin-top: 1px; }
  #pbox { text-align: right; }
  #price { font-size: 22px; font-weight: 700; }
  #live { font-size: 11px; margin-top: 1px; }

  #tfs { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px; background: #131722; border-bottom: 1px solid #2a2e39; }
  #tfbtns { display: flex; overflow-x: auto; flex: 1; -webkit-overflow-scrolling: touch; }
  #tfbtns::-webkit-scrollbar { display: none; }
  #tfbtns button { background: transparent; border: none; color: #787b86; font-size: 14px; font-weight: 600; padding: 7px 10px; border-radius: 4px; flex: 0 0 auto; }
  #tfbtns button.on { color: #2962ff; background: rgba(41, 98, 255, 0.14); }
  #tools { display: flex; flex: 0 0 auto; }
  #tools button { background: transparent; border: 1px solid #2a2e39; color: #787b86; font-size: 12px; padding: 5px 8px; border-radius: 12px; margin-left: 4px; }
  #tools button.on { color: #d1d4dc; border-color: #5d606b; background: #1e222d; }

  #pages { position: relative; flex: 1; min-height: 0; }
  .page { position: absolute; left: 0; top: 0; right: 0; bottom: 0; display: none; }
  .page.on { display: block; }
  .scroll { overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: 14px; }
  #pChart { overflow: hidden; background: #131722; }
  #chart { position: absolute; left: 0; top: 0; right: 0; bottom: 0; }
  #ov { position: absolute; left: 0; top: 0; pointer-events: none; }
  #legend { position: absolute; left: 8px; top: 6px; font-size: 12px; pointer-events: none; text-shadow: 0 0 4px #131722; z-index: 3; }
  #legend b { font-weight: 600; margin-right: 6px; }
  #float { position: absolute; left: 8px; top: 26px; pointer-events: none; z-index: 3; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin: 2px 4px 0 0; background: rgba(30, 34, 45, 0.88); border: 1px solid #2a2e39; }
  #msg { position: absolute; left: 12px; right: 12px; top: 45%; text-align: center; color: #787b86; pointer-events: none; z-index: 3; }
  #err { position: absolute; left: 8px; right: 8px; bottom: 6px; color: #ef5350; font-size: 12px; text-align: center; pointer-events: none; z-index: 4; }

  #nav { display: flex; background: #1e222d; border-top: 1px solid #2a2e39; padding-bottom: env(safe-area-inset-bottom); }
  #nav button { flex: 1; background: transparent; border: none; color: #787b86; padding: 8px 0 7px; font-size: 10.5px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  #nav button span { font-size: 18px; line-height: 20px; }
  #nav button i { font-style: normal; }
  #nav button.on { color: #2962ff; }

  .card { background: #1e222d; border-radius: 10px; padding: 12px; margin: 10px 12px 0; border: 1px solid #2a2e39; }
  .card h3 { margin: 0 0 8px; font-size: 14px; color: #f5c542; }
  .card p { margin: 0 0 8px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid #2a2e39; }
  .row:last-child { border-bottom: none; }
  .row span:last-child { text-align: right; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 7px 4px; border-bottom: 1px solid #2a2e39; }
  th { color: #787b86; font-weight: normal; }
  .key { display: inline-block; width: 11px; height: 11px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }

  .txt, .num { background: #131722; color: #d1d4dc; border: 1px solid #2a2e39; border-radius: 6px; padding: 6px 8px; font-size: 14px; }
  .num { width: 64px; margin-left: 4px; }
  .txt { width: 150px; }
  .btn, .mini { background: #2962ff; color: #fff; border: none; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-right: 6px; }
  .mini { padding: 5px 9px; font-size: 12px; background: #2a2e39; color: #d1d4dc; margin: 0; }
  .btn.gray { background: #2a2e39; color: #d1d4dc; }
  textarea.code { width: 100%; background: #0e1118; color: #d1d4dc; border: 1px solid #2a2e39; border-radius: 6px; padding: 8px; font-family: Menlo, Consolas, monospace; font-size: 12px; margin: 6px 0; }
  .lbl { display: flex; align-items: center; gap: 8px; }
  .lbl input { width: 18px; height: 18px; }
</style>
</head>
<body>
<div id="app">
  <div id="bar">
    <div>
      <div id="symWrap"><select id="symSel"></select></div>
      <div id="symSub">Top-Down SMC</div>
    </div>
    <div id="pbox"><div id="price">--</div><div id="live" class="dim">connecting...</div></div>
  </div>
  <div id="tfs">
    <div id="tfbtns"></div>
    <div id="tools">
      <button id="tZones" class="on">Zones</button>
      <button id="tMarks" class="on">Marks</button>
    </div>
  </div>
  <div id="pages">
    <div id="pChart" class="page on">
      <div id="chart"></div>
      <canvas id="ov"></canvas>
      <div id="legend"></div>
      <div id="float"></div>
      <div id="msg">Loading candles...</div>
    </div>
    <div id="pAnalysis" class="page scroll"></div>
    <div id="pSignals" class="page scroll"></div>
    <div id="pInd" class="page scroll"></div>
    <div id="pSet" class="page scroll"></div>
    <div id="err"></div>
  </div>
  <div id="nav">
    <button class="nb on" data-page="pChart"><span>&#128200;</span>Chart</button>
    <button class="nb" data-page="pAnalysis"><span>&#129517;</span>Analysis</button>
    <button class="nb" data-page="pSignals"><span>&#128680;</span><i id="sigLabel">Signals</i></button>
    <button class="nb" data-page="pInd"><span>&#128202;</span>Indicators</button>
    <button class="nb" data-page="pSet"><span>&#9881;&#65039;</span>Settings</button>
  </div>
</div>

<script>
(function () {
  var MS = { "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };
  var TFS = [["1m", "1m"], ["5m", "5m"], ["15m", "15m"], ["30m", "30m"], ["1h", "1H"], ["4h", "4H"], ["1d", "1D"], ["1w", "1W"]];
  var GOLD = "XAU/USD";
  var DEF_PAIRS = ["XAU/USD", "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY", "XAG/USD", "BTC/USD", "ETH/USD"];
  var IND_DEF = {
    sma: { on: false, p: 50, name: "SMA" },
    ema1: { on: false, p: 20, name: "EMA 1" },
    ema2: { on: false, p: 50, name: "EMA 2" },
    bb: { on: false, p: 20, m: 2, name: "Bollinger Bands" },
    rsi: { on: false, p: 14, name: "RSI (separate pane)" },
    macd: { on: false, f: 12, s: 26, g: 9, name: "MACD (separate pane)" }
  };
  var IND_ORDER = ["sma", "ema1", "ema2", "bb", "rsi", "macd"];
  var IND_FIELDS = {
    sma: [["p", "period"]],
    ema1: [["p", "period"]],
    ema2: [["p", "period"]],
    bb: [["p", "period"], ["m", "dev"]],
    rsi: [["p", "period"]],
    macd: [["f", "fast"], ["s", "slow"], ["g", "signal"]]
  };
  var EXAMPLE = "// Example: two EMAs drawn on the chart\nreturn {\n  lines: [ta.ema(c, 9), ta.ema(c, 21)],\n  colors: ['#26a69a', '#ef5350']\n};";

  var TZ = -new Date().getTimezoneOffset() * 60;
  var cfg = loadCfg();
  var botData = null;
  var cur = { candles: [] };
  var chart = null;
  var series = null;
  var plines = [];
  var zones = [];
  var indSeries = [];
  var sig = "";
  var indSig = "";
  var needFit = true;
  var reqId = 0;
  var tick = 0;
  var lastPrice = null;
  var lastBar = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function num(n) { return (n === null || n === undefined || isNaN(n)) ? "--" : Number(n).toFixed(2); }
  function precisionFor(p) { return p >= 500 ? 2 : (p >= 20 ? 3 : 5); }
  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return "--";
    return Number(n).toFixed(precisionFor(Math.abs(n)));
  }
  function hhmm(ms) { if (!ms) return "--"; return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function localHour(h) { return new Date(Date.UTC(2020, 0, 1, h, 0, 0)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function ago(ms) {
    if (!ms) return "never";
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 90) return s + "s ago";
    var m = Math.round(s / 60);
    if (m < 90) return m + " min ago";
    return Math.round(m / 60) + " h ago";
  }
  function showErr(t) { $("err").textContent = t || ""; }
  function chip(txt, cls) { return '<span class="chip ' + (cls || "") + '">' + txt + '</span>'; }
  function row(a, b) { return '<div class="row"><span>' + a + '</span><span>' + b + '</span></div>'; }
  function keyBox(color, txt) { return '<div class="row"><span><i class="key" style="background:' + color + '"></i>' + txt + '</span><span></span></div>'; }

  // ---------------- saved settings (kept in this browser) ----------------
  function loadCfg() {
    var c = null;
    try { c = JSON.parse(localStorage.getItem("mmm_cfg") || "null"); } catch (e) { c = null; }
    c = c || {};
    if (!c.pairs || !c.pairs.length) c.pairs = DEF_PAIRS.slice();
    if (!c.symbol) c.symbol = GOLD;
    if (!MS[c.tf]) c.tf = "5m";
    c.ind = c.ind || {};
    for (var k in IND_DEF) {
      var d = {};
      for (var f in IND_DEF[k]) d[f] = IND_DEF[k][f];
      var s = c.ind[k] || {};
      for (var g in s) d[g] = s[g];
      d.name = IND_DEF[k].name;
      c.ind[k] = d;
    }
    c.custom = c.custom || { code: "", on: false };
    c.zones = c.zones !== false;
    c.marks = c.marks !== false;
    return c;
  }
  function saveCfg() { try { localStorage.setItem("mmm_cfg", JSON.stringify(cfg)); } catch (e) { } }

  // ---------------- indicator maths (also available in the code box as "ta") ----------------
  var ta = {
    sma: function (a, p) {
      var out = [], s = 0;
      for (var i = 0; i < a.length; i++) {
        s += a[i];
        if (i >= p) s -= a[i - p];
        out.push(i >= p - 1 ? s / p : null);
      }
      return out;
    },
    ema: function (a, p) {
      var k = 2 / (p + 1), out = [], e = null, cnt = 0;
      for (var i = 0; i < a.length; i++) {

        var v = a[i];
        if (v === null || v === undefined || isNaN(v)) { out.push(null); continue; }
        cnt++;
        e = (e === null) ? v : v * k + e * (1 - k);
        out.push(cnt >= p ? e : null);
      }
      return out;
    },
    stdev: function (a, p) {
      var out = [];
      for (var i = 0; i < a.length; i++) {
        if (i < p - 1) { out.push(null); continue; }
        var m = 0, j;
        for (j = i - p + 1; j <= i; j++) m += a[j];
        m /= p;
        var v = 0;
        for (j = i - p + 1; j <= i; j++) v += (a[j] - m) * (a[j] - m);
        out.push(Math.sqrt(v / p));
      }
      return out;
    },
    highest: function (a, p) {
      var out = [];
      for (var i = 0; i < a.length; i++) {
        if (i < p - 1) { out.push(null); continue; }
        var m = a[i];
        for (var j = i - p + 1; j < i; j++) if (a[j] > m) m = a[j];
        out.push(m);
      }
      return out;
    },
    lowest: function (a, p) {
      var out = [];
      for (var i = 0; i < a.length; i++) {
        if (i < p - 1) { out.push(null); continue; }
        var m = a[i];
        for (var j = i - p + 1; j < i; j++) if (a[j] < m) m = a[j];
        out.push(m);
      }
      return out;
    },
    rsi: function (a, p) {
      var out = [], g = 0, l = 0;
      for (var i = 0; i < a.length; i++) {
        if (i === 0) { out.push(null); continue; }
        var d = a[i] - a[i - 1];
        var up = d > 0 ? d : 0;
        var dn = d < 0 ? -d : 0;
        if (i <= p) {
          g += up; l += dn;
          if (i === p) {
            g /= p; l /= p;
            out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
          } else out.push(null);
        } else {
          g = (g * (p - 1) + up) / p;
          l = (l * (p - 1) + dn) / p;
          out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
        }
      }
      return out;
    },
    atr: function (hh, ll, cc, p) {
      var out = [], a = 0;
      for (var i = 0; i < cc.length; i++) {
        var tr = i === 0 ? hh[i] - ll[i] : Math.max(hh[i] - ll[i], Math.abs(hh[i] - cc[i - 1]), Math.abs(ll[i] - cc[i - 1]));
        if (i < p - 1) { out.push(null); a += tr; continue; }
        if (i === p - 1) { a = (a + tr) / p; out.push(a); continue; }
        a = (a * (p - 1) + tr) / p;
        out.push(a);
      }
      return out;
    }
  };

  // ---------------- chart library ----------------
  function loadLib(cb) {
    if (window.LightweightCharts) { cb(); return; }
    var urls = [
      "https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js",
      "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"
    ];
    var i = 0;
    function next() {
      if (i >= urls.length) { showErr("Could not load the chart library. Check your internet connection."); return; }
      var s = document.createElement("script");
      s.src = urls[i++];
      s.onload = function () { if (window.LightweightCharts) cb(); else next(); };
      s.onerror = next;
      document.head.appendChild(s);
    }
    next();
  }

  function resizeChart() {
    if (!chart) return;
    var el = $("pChart");
    if (el.clientWidth > 0 && el.clientHeight > 0) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }

  function setLegend(c) {
    if (!c) { $("legend").innerHTML = ""; return; }
    var cls = c.close >= c.open ? "up" : "down";
    $("legend").innerHTML = '<b>' + esc(cfg.symbol) + ' - ' + cfg.tf.toUpperCase() + '</b><span class="' + cls + '">O ' + fmt(c.open) + '  H ' + fmt(c.high) + '  L ' + fmt(c.low) + '  C ' + fmt(c.close) + '</span>';
  }

  function initChart() {
    var el = $("pChart");
    chart = LightweightCharts.createChart($("chart"), {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: { background: { type: "solid", color: "#131722" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
      rightPriceScale: { borderColor: "#2a2e39" },
      timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 0 }
    });
    series = chart.addCandlestickSeries({
      upColor: "#26a69a", downColor: "#ef5350", borderVisible: false,
      wickUpColor: "#26a69a", wickDownColor: "#ef5350"
    });
    if (chart.subscribeCrosshairMove) {
      chart.subscribeCrosshairMove(function (p) {
        var c = null;
        if (p && p.seriesData && p.seriesData.get) c = p.seriesData.get(series);
        setLegend(c || lastBar);
      });
    }
    window.addEventListener("resize", resizeChart);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeChart).observe(el);
    render();
    loop();
  }

  // ---------------- data ----------------
  function isGold() { return cfg.symbol === GOLD; }
  function usingBot() {
    return isGold() && botData && botData.candles && botData.candles[cfg.tf] && botData.candles[cfg.tf].length > 0;
  }
  function candlesOf() {
    if (usingBot()) return botData.candles[cfg.tf];
    if (cur.symbol === cfg.symbol && cur.tf === cfg.tf) return cur.candles || [];
    return [];
  }

  function loadChart() {
    if (usingBot()) return;
    var s = cfg.symbol;
    var t = cfg.tf;
    var my = ++reqId;
    fetch("/api/chart?symbol=" + encodeURIComponent(s) + "&tf=" + t, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (my !== reqId) return;
        cur = { symbol: s, tf: t, candles: j.candles || [], error: j.error || "", note: j.note || "", source: j.source || "", fetchedAt: j.fetchedAt || 0, usage: j.usage || null };
        showErr(j.error || j.note || "");
        render();
        renderTop();
        renderSettingsData();
      })
      .catch(function (e) {
        if (my !== reqId) return;
        showErr("Connection problem: " + e.message + " (retrying)");
      });
  }

  function pollBot() {
    fetch("/api/panel", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        botData = j;
        if (usingBot()) showErr("");
        render();
        renderPanel();
      })
      .catch(function (e) {
        showErr("Connection problem: " + e.message + " (retrying)");
      });
  }

  // ---------------- chart content ----------------
  function buildMarkers(cs) {
    var out = [];
    if (!cs.length || !botData || !isGold()) return out;
    var first = cs[0].t;
    var last = cs[cs.length - 1].t;
    var br = (botData.structure && botData.structure[cfg.tf]) || [];
    br.forEach(function (b) {
      if (b.t < first || b.t > last) return;
      out.push({
        time: b.t / 1000 + TZ,
        position: b.dir === "bullish" ? "belowBar" : "aboveBar",
        color: b.dir === "bullish" ? "#26a69a" : "#ef5350",
        shape: b.dir === "bullish" ? "arrowUp" : "arrowDown",
        text: b.type
      });
    });

        return { time: x.t / 1000 + TZ, open: x.o, high: x.h, low: x.l, close: x.c };
      }));
      if (needFit && cs.length) {
        var n = cs.length;
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 90), to: n + 12 });
        needFit = false;
      }
    }

    var ik = key + "|" + JSON.stringify([cfg.ind, cfg.custom]);
    if (ik !== indSig) {
      indSig = ik;
      applyIndicators(cs);
    }

    if (cs.length) {
      var lc = cs[cs.length - 1];
      lastBar = { open: lc.o, high: lc.h, low: lc.l, close: lc.c };
      setLegend(lastBar);
    } else {
      lastBar = null;
      setLegend(null);
    }

    for (var i = 0; i < plines.length; i++) series.removePriceLine(plines[i]);
    plines = [];
    function pl(price, color, title, style) {
      if (price === null || price === undefined) return;
      plines.push(series.createPriceLine({
        price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title
      }));
    }
    if (isGold() && botData) {
      if (botData.price) pl(botData.price, "#ffffff", "live", 2);
      if (cfg.zones && botData.htf && botData.htf.eq) pl(botData.htf.eq, "#b388ff", "1H 50%", 2);
      var os = openSignalOf(botData);
      if (os) {
        pl(os.entry, "#9e9e9e", "entry", 0);
        pl(os.sl, "#ef5350", "SL", 0);
        pl(os.tp, "#26a69a", "TP", 0);
      }
    }

    series.setMarkers(cfg.marks ? buildMarkers(cs) : []);
    buildZones(cs);
  }

  function draw() {
    var wrap = $("pChart");
    var cv = $("ov");
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    var ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (!cfg.zones || !chart || !series || w === 0) return;
    var cs = candlesOf();
    if (!cs.length) return;

    var ts = chart.timeScale();
    var plotW = ts.width ? ts.width() : w - 60;
    var firstT = cs[0].t;
    var lastT = cs[cs.length - 1].t;

    zones.forEach(function (z) {
      var x1 = ts.timeToCoordinate(Math.max(z.t1, firstT) / 1000 + TZ);
      var x2 = z.t2 > lastT ? plotW : ts.timeToCoordinate(z.t2 / 1000 + TZ);
      if (x1 === null || x1 === undefined) x1 = 0;
      if (x2 === null || x2 === undefined) x2 = plotW;
      x1 = Math.max(0, x1);
      x2 = Math.min(plotW, x2);
      if (x2 <= x1) return;
      var ya = series.priceToCoordinate(z.top);
      var yb = series.priceToCoordinate(z.bottom);
      if (ya === null || yb === null || ya === undefined || yb === undefined) return;
      var yTop = Math.min(ya, yb);
      var hh = Math.abs(yb - ya);
      ctx.fillStyle = z.fill;
      ctx.fillRect(x1, yTop, x2 - x1, hh);
      if (z.stroke) {
        ctx.strokeStyle = z.stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x1, yTop, x2 - x1, hh);
      }
      if (hh > 14 && z.label) {
        ctx.fillStyle = z.stroke || "rgba(200,200,200,0.55)";
        ctx.font = "11px Arial";
        ctx.fillText(z.label, x1 + 4, yTop + 12);
      }
    });
  }

  function loop() {
    try { draw(); } catch (e) { }
    requestAnimationFrame(loop);
  }

  // ---------------- text pages ----------------
  function openSignalOf(d) {
    for (var i = 0; i < d.signals.length; i++) if (d.signals[i].status === "open") return d.signals[i];
    return null;
  }

  function renderTop() {
    var cs = candlesOf();
    var last = cs.length ? cs[cs.length - 1] : null;
    var gold = isGold();
    var price = (gold && botData && botData.price) ? botData.price : (last ? last.c : null);

    var pe = $("price");
    pe.textContent = price ? fmt(price) : "--";
    if (price && lastPrice !== null && price !== lastPrice) pe.className = price > lastPrice ? "up" : "down";
    if (price) lastPrice = price;

    $("symSub").textContent = gold ? "Gold - Top-Down SMC strategy" : "Chart only";

    var liveHtml = "";
    if (gold && botData) {
      liveHtml = botData.status.marketClosed
        ? '<span class="warn">Market closed</span>'
        : '<span class="up">&#9679; LIVE</span> <span class="dim">' + hhmm(botData.now) + '</span>';
    } else if (cur.fetchedAt) {
      liveHtml = '<span class="dim">candles ' + ago(cur.fetchedAt) + '</span>';
    } else {
      liveHtml = '<span class="dim">loading...</span>';
    }
    $("live").innerHTML = liveHtml;

    var f = "";
    if (gold && botData) {
      var h = botData.htf;
      var p = botData.plan;
      if (h && h.bias) f += chip("1H " + h.bias.toUpperCase() + (h.zone ? " - " + h.zone : ""), h.bias === "bullish" ? "up" : "down");
      else f += chip("1H bias unclear", "dim");
      var os = openSignalOf(botData);
      if (os) f += chip("Signal open: " + os.dir, "warn");
      else if (p) f += chip("Watching " + (p.dir === "bullish" ? "buy" : "sell") + " zone " + num(p.zoneBottom) + "-" + num(p.zoneTop), "warn");
      else f += chip("Searching for a 15M setup", "dim");
    } else if (!gold) {
      f += chip("Strategy signals run on XAU/USD only", "dim");
    }
    $("float").innerHTML = f;

    $("sigLabel").textContent = (botData && openSignalOf(botData)) ? "Signals \u25CF" : "Signals";
  }

  function renderAnalysis() {
    if (!botData) return;
    var d = botData;
    var h = d.htf;
    var p = d.plan;
    var pr = d.progress;

    var html = '<div class="card"><h3>Top-down check (XAU/USD)</h3>';

    html += row("1&#65039;&#8419; 1H bias", h && h.bias
      ? '<b class="' + (h.bias === "bullish" ? "up" : "down") + '">' + h.bias.toUpperCase() + '</b>'
      : '<span class="dim">not clear yet</span>');
    if (h) {
      html += row("1H range", num(h.rangeLow) + " - " + num(h.rangeHigh));
      html += row("50% level", num(h.eq));
      html += row("Price is in", h.zone ? (h.zone === "discount" ? '<span class="up">DISCOUNT (buys)</span>' : '<span class="down">PREMIUM (sells)</span>') : "--");
    }

    if (p) {
      var buy = p.dir === "bullish";
      html += row("2&#65039;&#8419; 15M break", '<b class="' + (buy ? "up" : "down") + '">' + esc(p.label) + " " + p.dir + '</b> &#10003;');
      html += row("Displacement (FVG)", p.fvgTop !== null && p.fvgTop !== undefined ? num(p.fvgBottom) + " - " + num(p.fvgTop) + " &#10003;" : "--");
      html += row("Order Block zone", num(p.zoneBottom) + " - " + num(p.zoneTop) + " &#10003;");
      html += row("Liquidity sweep", p.sweep ? '<span class="up">yes &#10003;</span>' : '<span class="dim">no (bonus only)</span>');
      html += row("OB + FVG overlap", p.overlap ? '<span class="up">yes &#10003;</span>' : '<span class="dim">no</span>');
    } else {
      html += row("2&#65039;&#8419; 15M setup", '<span class="dim">searching - no break in the 1H direction yet</span>');
    }

    if (p && pr) {
      html += row("3&#65039;&#8419; 5M tap of zone", pr.tapped ? '<span class="up">tapped ' + hhmm(pr.tapTime) + ' &#10003;</span>' : '<span class="warn">waiting</span>');
      if (pr.level !== null && pr.level !== undefined) html += row("5M needs a close beyond", num(pr.level));
      html += row("Status", esc(pr.note || ""));
    } else {
      html += row("3&#65039;&#8419; 5M entry", '<span class="dim">starts after a 15M zone is found</span>');
    }
    html += '</div>';

    html += '<div class="card"><h3>How to read the chart</h3>';
    html += keyBox("#26a69a", "Green box: 15M buy zone (order block)");
    html += keyBox("#ef5350", "Red box: 15M sell zone (order block)");
    html += keyBox("#f5c542", "Yellow box: 15M fair value gap");
    html += keyBox("#b388ff", "Purple line: 1H 50% level (above = premium, below = discount)");
    html += keyBox("#ffffff", "White dashed line: live price");
    html += keyBox("#787b86", "Arrows: BOS / CHoCH structure breaks and signals");
    html += '</div>';

    $("pAnalysis").innerHTML = html;
  }

  function renderSignals() {
    if (!botData) return;
    var d = botData;
    var s = d.status;
    var os = openSignalOf(d);
    var html = "";

    if (os) {
      html += '<div class="card"><h3>Open signal</h3>';
      html += row("Direction", '<b class="' + (os.dir === "BUY" ? "up" : "down") + '">' + os.dir + '</b>');
      html += row("Entry", num(os.entry));
      html += row("Stop loss", num(os.sl));
      html += row("Take profit", num(os.tp));
      html += row("Opened", new Date(os.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
      html += '</div>';
    }

    var done = s.wins + s.losses;
    var rate = done ? Math.round((s.wins / done) * 100) + "%" : "--";
    html += '<div class="card"><h3>Results</h3>';
    html += row("Wins", '<span class="up">' + s.wins + '</span>');
    html += row("Losses", '<span class="down">' + s.losses + '</span>');
    html += row("Win rate (finished trades)", rate);
    html += '</div>';

    html += '<div class="card"><h3>Recent signals</h3>';
    if (d.signals.length) {
      html += '<table><tr><th>Time</th><th>Side</th><th>Entry</th><th>SL</th><th>TP</th><th>Result</th></tr>';
      d.signals.forEach(function (x) {
        var res = x.status === "win" ? '<span class="up">TP</span>' : x.status === "loss" ? '<span class="down">SL</span>' : '<span class="warn">open</span>';
        html += '<tr><td>' + new Date(x.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + '</td><td>' + x.dir + '</td><td>' + num(x.entry) + '</td><td>' + num(x.sl) + '</td><td>' + num(x.tp) + '</td><td>' + res + '</td></tr>';
      });
      html += '</table>';
    } else {
      html += '<span class="dim">No signals yet. The bot only signals when all three timeframes line up, so this can take a while.</span>';
    }
    html += '</div>';

    $("pSignals").innerHTML = html;
  }

  // ---------------- indicators page ----------------
  function renderIndicators() {
    var html = '<div class="card"><h3>Indicators on the chart</h3>';
    IND_ORDER.forEach(function (k) {
      var I = cfg.ind[k];
      var fields = "";
      IND_FIELDS[k].forEach(function (f) {
        fields += ' ' + f[1] + ' <input type="number" class="num" data-k="' + k + '" data-f="' + f[0] + '" value="' + I[f[0]] + '">';
      });
      html += '<div class="row"><label class="lbl"><input type="checkbox" data-k="' + k + '" data-f="on"' + (I.on ? " checked" : "") + '> ' + I.name + '</label><span class="small dim">' + fields + '</span></div>';
    });
    html += '</div>';

    html += '<div class="card"><h3>Custom indicator (code box)</h3>';
    html += '<p class="dim small">Pine Script only runs inside TradingView, so it cannot run here. Write the indicator in JavaScript instead, or send the Pine code to your assistant and ask for it to be converted. Only paste code you trust.</p>';
    html += '<textarea id="cCode" class="code" rows="9" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>';
    html += '<div><button class="btn" id="cRun">Apply</button><button class="btn gray" id="cEx">Example</button><button class="btn gray" id="cOff">Remove</button></div>';
    html += '<div id="cErr" class="small warn" style="margin-top:8px"></div>';
    html += '<p class="dim small" style="margin-top:8px">You can use o, h, l, c, t (open, high, low, close, time of every candle) and ta.sma, ta.ema, ta.rsi, ta.stdev, ta.highest, ta.lowest, ta.atr(h, l, c, period). Return one array for a line on the price, or an object like {lines: [a, b], colors: [...], pane: true} (pane: true draws in a separate area under the chart).</p>';
    html += '</div>';

    $("pInd").innerHTML = html;
    $("cCode").value = cfg.custom.code || "";
    setCErr(cfg.custom.on ? "Running" : "");
  }

  $("pInd").onchange = function (e) {
    var t = e.target;
    var k = t.getAttribute("data-k");
    var f = t.getAttribute("data-f");
    if (!k || !f || !cfg.ind[k]) return;
    if (f === "on") cfg.ind[k].on = !!t.checked;
    else {
      var v = parseFloat(t.value);
      if (isFinite(v) && v > 0) cfg.ind[k][f] = v;
    }
    saveCfg();
    render();
  };
  $("pInd").onclick = function (e) {
    var id = e.target.id;
    if (id === "cRun") {
      cfg.custom.code = $("cCode").value;
      cfg.custom.on = !!cfg.custom.code.replace(/\s/g, "");
      saveCfg();
      indSig = "";
      render();
    } else if (id === "cEx") {
      $("cCode").value = EXAMPLE;
    } else if (id === "cOff") {
      cfg.custom.on = false;
      saveCfg();
      indSig = "";
      render();
      setCErr("Removed");
    }
  };

  // ---------------- settings page ----------------
  function tfOptions(selected) {
    var h = "";
    TFS.forEach(function (x) { h += '<option value="' + x[0] + '"' + (x[0] === selected ? " selected" : "") + '>' + x[1] + '</option>'; });
    return h;
  }

  function fillSymSel() {
    var h = "";
    cfg.pairs.forEach(function (p) { h += '<option value="' + esc(p) + '"' + (p === cfg.symbol ? " selected" : "") + '>' + esc(p) + '</option>'; });
    $("symSel").innerHTML = h;
    $("symSel").value = cfg.symbol;
  }

  function renderSettings() {
    var html = '<div class="card"><h3>Pairs</h3>';
    cfg.pairs.forEach(function (p, i) {
      html += '<div class="row"><span>' + esc(p) + (p === GOLD ? ' <span class="dim small">(strategy runs here)</span>' : '') + '</span><span><button class="mini" data-del="' + i + '">Remove</button></span></div>';
    });
    html += '<div class="row"><span><input id="newPair" class="txt" placeholder="e.g. USD/JPY" autocapitalize="characters" autocomplete="off"></span><span><button class="mini" id="addPair">Add</button></span></div>';
    html += '<div id="pairErr" class="small warn"></div>';
    html += '<p class="dim small" style="margin-top:8px">Other pairs are chart-only. Every pair and timeframe you open is loaded when needed and reused for a while. It uses Twelve Data credits (see Data feed below).</p>';
    html += '</div>';

    html += '<div class="card"><h3>Chart</h3>';
    html += row("Default timeframe", '<select id="defTf" class="txt" style="width:90px">' + tfOptions(cfg.tf) + '</select>');
    html += row("Show zones and levels", '<input type="checkbox" id="optZones"' + (cfg.zones ? " checked" : "") + '>');
    html += row("Show arrows (BOS / CHoCH / signals)", '<input type="checkbox" id="optMarks"' + (cfg.marks ? " checked" : "") + '>');
    html += '<div style="margin-top:10px"><button class="btn gray" id="resetInd">Reset indicators</button></div>';
    html += '</div>';

    html += '<div id="dataCard"></div>';

    html += '<div class="card"><h3>Strategy (XAU/USD)</h3>';
    html += row("Flow", "1H bias &#8594; 15M zone &#8594; 5M entry");
    html += row("Minimum reward : risk", "1 : 2");
    html += row("Signal hours", localHour(7) + " - " + localHour(20) + " (your time)");
    html += row("One signal at a time", "yes");
    html += '</div>';

    $("pSet").innerHTML = html;
    renderSettingsData();
  }

  function renderSettingsData() {
    var box = $("dataCard");
    if (!box) return;
    var s = botData ? botData.status : null;
    var html = '<div class="card"><h3>Data feed</h3>';
    if (s) {
      html += row("Status", esc(s.dataStatus));
      html += row("Gold market", s.marketClosed ? '<span class="warn">closed</span>' : '<span class="up">open</span>');
      html += row("5M candles updated", ago(s.lastFetch["5m"]));
      html += row("15M candles updated", ago(s.lastFetch["15m"]));
      html += row("1H candles updated", ago(s.lastFetch["1h"]));
      html += row("Twelve Data credits used today", s.creditsUsed + " / 800");
      html += row("Extra chart loads today", s.onDemandUsed + " / " + s.onDemandCap);
    } else {
      html += '<span class="dim">Loading...</span>';
    }
    html += '</div>';
    box.innerHTML = html;
  }

  function renderPanel() {
    renderTop();
    renderAnalysis();
    renderSignals();
    renderSettingsData();
  }

  $("pSet").onclick = function (e) {
    var t = e.target;
    var del = t.getAttribute ? t.getAttribute("data-del") : null;
    if (del !== null && del !== undefined) {
      var i = parseInt(del, 10);
      if (cfg.pairs.length > 1 && i >= 0 && i < cfg.pairs.length) {
        var gone = cfg.pairs.splice(i, 1)[0];
        var wasCurrent = gone === cfg.symbol;
        if (wasCurrent) cfg.symbol = cfg.pairs[0];
        saveCfg();
        fillSymSel();
        renderSettings();
        if (wasCurrent) switchTo(cfg.symbol, cfg.tf);
      }
    } else if (t.id === "addPair") {
      var inp = $("newPair");
      var v = String(inp.value || "").toUpperCase().replace(/\s/g, "");
      if (v.indexOf("/") < 0 && v.length === 6) v = v.slice(0, 3) + "/" + v.slice(3);
      if (!/^[A-Z]{2,6}\/[A-Z]{2,6}$/.test(v)) { $("pairErr").textContent = "Use a pair like EUR/USD."; return; }
      if (cfg.pairs.indexOf(v) >= 0) { $("pairErr").textContent = "Already in the list."; return; }
      if (cfg.pairs.length >= 40) { $("pairErr").textContent = "List is full (40 pairs)."; return; }
      cfg.pairs.push(v);
      saveCfg();
      fillSymSel();
      renderSettings();
    } else if (t.id === "resetInd") {
      for (var k in IND_DEF) {
        var d = {};
        for (var f in IND_DEF[k]) d[f] = IND_DEF[k][f];
        cfg.ind[k] = d;
      }
      cfg.custom = { code: "", on: false };
      saveCfg();

      indSig = "";
      renderIndicators();
      render();
    }
  };
  $("pSet").onchange = function (e) {
    var t = e.target;
    if (t.id === "defTf") {
      switchTo(cfg.symbol, t.value);
    } else if (t.id === "optZones") {
      cfg.zones = !!t.checked;
      $("tZones").className = cfg.zones ? "on" : "";
      saveCfg();
      render();
    } else if (t.id === "optMarks") {
      cfg.marks = !!t.checked;
      $("tMarks").className = cfg.marks ? "on" : "";
      saveCfg();
      render();
    }
  };

  // ---------------- controls ----------------
  function buildTfButtons() {
    var h = "";
    TFS.forEach(function (x) { h += '<button data-tf="' + x[0] + '" class="' + (x[0] === cfg.tf ? "on" : "") + '">' + x[1] + '</button>'; });
    $("tfbtns").innerHTML = h;
  }

  function switchTo(symbol, tf) {
    cfg.symbol = symbol;
    cfg.tf = tf;
    saveCfg();
    sig = "";
    indSig = "";
    needFit = true;
    cur = { candles: [] };
    reqId++;
    buildTfButtons();
    $("symSel").value = cfg.symbol;
    showErr("");
    render();
    renderTop();
    loadChart();
  }

  function showPage(id) {
    var pgs = document.querySelectorAll(".page");
    for (var i = 0; i < pgs.length; i++) {
      pgs[i].className = (pgs[i].id === "pChart" ? "page" : "page scroll") + (pgs[i].id === id ? " on" : "");
    }
    var nbs = document.querySelectorAll("#nav button");
    for (var k = 0; k < nbs.length; k++) {
      nbs[k].className = "nb" + (nbs[k].getAttribute("data-page") === id ? " on" : "");
    }
    $("tfs").style.display = id === "pChart" ? "flex" : "none";
    if (id === "pChart") setTimeout(resizeChart, 30);
  }

  var navBtns = document.querySelectorAll("#nav button");
  for (var a = 0; a < navBtns.length; a++) {
    navBtns[a].onclick = function () { showPage(this.getAttribute("data-page")); };
  }

  $("tfbtns").onclick = function (e) {
    var t = e.target.getAttribute ? e.target.getAttribute("data-tf") : null;
    if (t && t !== cfg.tf) switchTo(cfg.symbol, t);
  };
  $("symSel").onchange = function () { switchTo(this.value, cfg.tf); };

  $("tZones").className = cfg.zones ? "on" : "";
  $("tMarks").className = cfg.marks ? "on" : "";
  $("tZones").onclick = function () {
    cfg.zones = !cfg.zones;
    this.className = cfg.zones ? "on" : "";
    saveCfg();
    render();
  };
  $("tMarks").onclick = function () {
    cfg.marks = !cfg.marks;
    this.className = cfg.marks ? "on" : "";
    saveCfg();
    render();
  };

  // ---------------- start ----------------
  fillSymSel();
  buildTfButtons();
  renderIndicators();
  renderSettings();
  pollBot();
  loadChart();
  setInterval(function () {
    pollBot();
    tick++;
    if (!usingBot() && tick % 2 === 0) loadChart();
  }, 15000);
  loadLib(initChart);
})();
</script>
</body>
</html>`;


// ===============================
// START COMMAND
// ===============================

bot.onText(/\/start/, (msg) => {

  bot.sendMessage(
    msg.chat.id,

`🔥 MONEY MAKING MACHINE BOT

Welcome! 👋

🥇 Your XAUUSD trading assistant.

🧭 Top-down Smart Money analysis
🚨 Entry alerts
⚖️ Minimum 1:2 risk to reward
🛡️ Clear stop loss and take profit

👇 Choose an option below:`,
    mainMenu
  );

});

// ===============================
// MENU BUTTON HANDLERS
// ===============================

bot.on("message", async (msg) => {

  if (!msg.text) return;

  // 📊 XAUUSD SIGNAL
  if (msg.text === "📊 XAUUSD Signal") {

    try {

      const price = await getGoldPrice();

      await bot.sendMessage(
        msg.chat.id,

`🔎 XAUUSD MARKET CHECK

💰 Current Price: ${price.toFixed(2)}

${statusText()}

🚨 A signal is sent automatically when all three timeframes line up.`
      );

    } catch (error) {

      console.error("Signal price error:", error.message);

      bot.sendMessage(
        msg.chat.id,
        "⚠️ XAUUSD market data is temporarily unavailable."
      );

    }

  }

  // 💰 LIVE PRICE
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

  // 🔔 AUTO SIGNALS
  if (msg.text === "🔔 Auto Signals") {

    subscribers.set(msg.chat.id, {
      username: msg.from.username || null,
      firstName: msg.from.first_name || "Unknown",
      joinedAt: subscribers.has(msg.chat.id) ? subscribers.get(msg.chat.id).joinedAt : Date.now()
    });

    bot.sendMessage(
      msg.chat.id,

`🔔 AUTOMATIC SIGNALS ENABLED

🤖 MONEY MAKING MACHINE BOT will monitor XAUUSD automatically.

📩 You will receive an alert when a full top-down setup is confirmed:

🧭 1H bias
🟦 15M structure break + Order Block + FVG
✅ 5M tap and confirmation
⚖️ At least 1:2 risk to reward`
    );

  }

  // 🔕 STOP ALERTS
  if (msg.text === "🔕 Stop Alerts") {

    subscribers.delete(msg.chat.id);

    bot.sendMessage(
      msg.chat.id,

`🔕 AUTOMATIC SIGNALS STOPPED

🚫 You will no longer receive automatic XAUUSD entry alerts.

🔄 You can turn them back on anytime with:

🔔 Auto Signals`
    );

  }

  // 📖 HOW IT WORKS
  if (msg.text === "📖 How It Works") {

    bot.sendMessage(
      msg.chat.id,

`📖 HOW IT WORKS

🧠 The bot analyses XAUUSD top-down, like a Smart Money trader:

1️⃣ 1H - Bias
📊 Market structure (BOS / CHoCH) sets the direction. Buys only in discount, sells only in premium of the 1H range.

2️⃣ 15M - Zone
🟦 Structure breaks in the 1H direction with displacement (Fair Value Gap). The Order Block behind the move becomes the entry zone.

3️⃣ 5M - Entry
✅ Price must return to the zone, then a 5M change of character confirms the entry.

🛡️ Stop loss goes beyond the sweep / zone.
🎯 Take profit targets the next swing liquidity, minimum 1:2 risk to reward.

🕐 Only one signal at a time, during London and New York hours.`
    );

  }

  // ⚙️ SETTINGS
  if (msg.text === "⚙️ Settings") {

    bot.sendMessage(
      msg.chat.id,

`⚙️ SETTINGS

📊 Market
XAUUSD

🧭 Timeframes
1H bias → 15M zone → 5M entry

⚖️ Minimum risk:reward
1:${MIN_RR}

🕐 Signal hours
${SESSION_FILTER ? `${SESSION_START_UTC}:00 - ${SESSION_END_UTC}:00 UTC` : "All hours"}

🔔 Automatic Alerts
Available`
    );

  }

});

// ===============================
// SCHEDULERS
// ===============================

setInterval(dataTick, 20000);
setInterval(monitorPrice, 30000);

dataTick();
monitorPrice();

// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
  console.log(`🔥 MONEY MAKING MACHINE BOT running on port ${PORT}`);
});
