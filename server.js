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

// The Twelve Data key is read from whichever Render variable name
// starts with "TWE" (e.g. TWELVE_DATA_API_KEY). The key is never logged.
const TD_KEY_NAME = Object.keys(process.env).find(k => k.toUpperCase().startsWith("TWE"));
const TD_KEY = TD_KEY_NAME
  ? String(process.env[TD_KEY_NAME]).trim().replace(/^["']|["']$/g, "")
  : null;

if (!TD_KEY) {
  console.error("No Twelve Data key found. Add a variable such as TWELVE_DATA_API_KEY in Render.");
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
// Set ADMIN_USER / ADMIN_PASSWORD in Render's Environment tab.
// Defaults are admin / changeme123 - change them.
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

const subscribers = new Map(); // chatId -> { username, firstName, joinedAt }
const signalHistory = [];      // most recent first
const MAX_SIGNAL_HISTORY = 100;
const botStartedAt = Date.now();

// ================================================================
// STRATEGY SETTINGS  (top-down SMC: 4H bias -> 15M zone -> 5M entry)
// ================================================================

const SYMBOL = "XAU/USD";

const TF = {
  "4h":  { interval: "4h",    ms: 4 * 60 * 60 * 1000, size: 120 },
  "15m": { interval: "15min", ms: 15 * 60 * 1000,     size: 150 },
  "5m":  { interval: "5min",  ms: 5 * 60 * 1000,      size: 150 }
};

const SWING_LOOKBACK = { "4h": 2, "15m": 2, "5m": 1 };

const HTF_RANGE_CANDLES = 36;        // 4H candles used for the premium/discount range (~6 days)
const SETUP_FRESH_CANDLES = 30;      // the 15M structure break must be this recent (~7.5h)
const IMPULSE_WINDOW = 10;           // 15M candles searched back from the break for the leg origin
const TOUCH_LOOKBACK_5M = 18;        // 5M candles (~90 min) in which the zone tap must have happened
const PLAN_EXPIRY_MS = 6 * 60 * 60 * 1000;
const INVALIDATION_BUFFER = 0.5;     // $ beyond the zone that kills the setup (candle close)

const PIP_SIZE = 0.1;                // 1 "pip" = $0.10
const SL_BUFFER = 1.0;               // $ beyond the 5M extreme / zone
const MIN_SL_USD = 1.5;
const MAX_SL_USD = 15;
const MIN_RR = 2;

const SESSION_FILTER = true;         // only fire signals during London + New York hours
const SESSION_START_UTC = 7;
const SESSION_END_UTC = 20;

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;

// Twelve Data free plan = 800 credits/day, 8/minute
const FETCH_DELAY_MS = 15000;        // wait after a candle closes before fetching it
const RETRY_MS = 60000;              // minimum gap between retries of a failed fetch
const DAILY_CREDIT_LIMIT = 700;      // safety stop, below the 800 limit

// ================================================================
// DATA STATE
// ================================================================

const candles = { "4h": [], "15m": [], "5m": [] }; // closed candles only, oldest first
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
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) + 60000;
}

// Gold is closed from Friday 22:00 UTC until Sunday 22:00 UTC
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

  const res = await axios.get("https://api.twelvedata.com/time_series", {
    params: {
      symbol: SYMBOL,
      interval: cfg.interval,
      outputsize: cfg.size,
      order: "asc",
      timezone: "UTC",
      apikey: TD_KEY
    },
    timeout: 15000
  });

  creditsUsed++;
  const d = res.data;

  if (!d || d.status === "error" || !Array.isArray(d.values)) {
    const err = new Error((d && d.message) || "Bad response from Twelve Data");
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
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close) &&
      c.t + cfg.ms <= now + 2000          // drop the candle that is still forming
    );
}

function handleDataError(e) {
  const body = e.response && e.response.data;
  const msg = (body && body.message) || e.message || "Unknown error";
  const code = (body && body.code) || e.apiCode || (e.response && e.response.status);

  dataStatus = `Error: ${String(msg).slice(0, 140)}`;
  console.error("Twelve Data error:", code, String(msg).slice(0, 200));

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

// Runs every 20s. Each timeframe is fetched ONCE per candle close, so
// usage is about 288 (5m) + 96 (15m) + 6 (4h) credits per day.
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
      const due = !have || (lastBucket[tf] !== bucket && now - bucket * cfg.ms >= FETCH_DELAY_MS);

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
        console.log(`[DATA] ${tf}: ${candles[tf].length} candles | credits today: ${creditsUsed}`);
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
// LIVE PRICE (no Twelve Data credits - used for the price button and
// for checking TP/SL on open signals)
// ================================================================

let cached = { price: null, time: 0 };

async function getGoldPrice() {
  if (cached.price && Date.now() - cached.time < 20000) {
    return cached.price;
  }

  const sources = [
    async () => Number((await axios.get(
      "https://api.gold-api.com/price/XAU",
      { timeout: 10000 })).data.price),
    async () => Number((await axios.get(
      "https://xaus.com/api/v1/spot?compact=1",
      { timeout: 10000 })).data.xau.price)
  ];

  for (const source of sources) {
    try {
      const p = await source();
      if (p > 0) {
        cached = { price: p, time: Date.now() };
        return p;
      }
    } catch (e) {
      console.error("Price source failed:", (e.response && e.response.status) || e.message);
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

// Swing high/low (fractal). A swing at index i is only confirmed once
// `lookback` candles after it exist.
function findSwings(arr, lookback) {
  const swings = [];

  for (let i = lookback; i < arr.length - lookback; i++) {
    const slice = arr.slice(i - lookback, i + lookback + 1);
    const c = arr[i];

    if (slice.every(s => s.high <= c.high)) swings.push({ index: i, price: c.high, type: "high" });
    if (slice.every(s => s.low >= c.low)) swings.push({ index: i, price: c.low, type: "low" });
  }

  return swings;
}

// Walks the candles in order and records every close-based break of the
// latest swing high/low. A break in the direction of the running trend is
// a BOS; a break against it is a CHoCH (change of character).
function analyzeStructure(arr, lookback) {
  const swings = findSwings(arr, lookback);
  const breaks = [];

  let trend = null;
  let lastHigh = null;
  let lastLow = null;
  let si = 0;

  for (let i = 0; i < arr.length; i++) {
    while (si < swings.length && swings[si].index + lookback <= i) {
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
// STEP 1 - 4H BIAS + PREMIUM / DISCOUNT RANGE
// ================================================================

function getHTF() {
  const c = candles["4h"];
  if (c.length < 30) return null;

  const st = analyzeStructure(c, SWING_LOOKBACK["4h"]);
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
// STEP 2 - 15M: structure break in the bias direction + POI
// ================================================================
// Requirements:
//  - the latest 15M break is in the 4H bias direction (BOS or CHoCH)
//  - the break was made with displacement (it left a Fair Value Gap)
//  - the Order Block that started the move is still unmitigated
//  - the Order Block sits in discount (buys) or premium (sells) of the 4H range
// Bonus confluences: liquidity sweep before the move, OB overlapping the FVG.
// ================================================================

const deadPOIs = new Set(); // order blocks already used or invalidated

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

  // Origin of the impulse leg: lowest low (buys) / highest high (sells) before the break
  const from = Math.max(0, b - IMPULSE_WINDOW);
  let o = from;
  for (let i = from; i <= b; i++) {
    if (bull ? c[i].low < c[o].low : c[i].high > c[o].high) o = i;
  }

  // Order Block = last opposite-colour candle at the origin
  let obIdx = o;
  for (let i = o; i >= Math.max(0, o - 3); i--) {
    const opposite = bull ? c[i].close < c[i].open : c[i].close > c[i].open;
    if (opposite) {
      obIdx = i;
      break;
    }
  }
  const zone = { top: c[obIdx].high, bottom: c[obIdx].low };

  // Displacement: a Fair Value Gap inside the impulse
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

  // Zone must not already be broken through
  for (let k = b + 1; k < c.length; k++) {
    if (bull && c[k].close < zone.bottom - INVALIDATION_BUFFER) return null;
    if (!bull && c[k].close > zone.top + INVALIDATION_BUFFER) return null;
  }

  // Premium / discount filter against the 4H range
  const mid = (zone.top + zone.bottom) / 2;
  if (bull && mid > htf.eq) return null;
  if (!bull && mid < htf.eq) return null;

  // Liquidity sweep before the move
  let sweep = false;
  for (let k = st.swings.length - 1; k >= 0; k--) {
    const s = st.swings[k];
    if (s.index >= o || s.index < o - 40) continue;
    if (bull && s.type === "low") {
      sweep = c[o].low < s.price; // took out the most recent swing low
      break;
    }
    if (!bull && s.type === "high") {
      sweep = c[o].high > s.price;
      break;
    }
  }

  const overlap = zone.top >= fvg.bottom && zone.bottom <= fvg.top;

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
// STEP 3 - 5M: tap the zone, then confirm with a 5M CHoCH/BOS
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
  if (startIdx < 0) return null; // no 5M candles after the 15M break yet

  // Zone broken through on a 5M close -> setup is dead
  for (let i = startIdx; i < c.length; i++) {
    if (buy ? c[i].close < z.bottom - INVALIDATION_BUFFER : c[i].close > z.top + INVALIDATION_BUFFER) {
      killPlan("5M closed through the zone");
      return null;
    }
  }

  // The zone must have been tapped recently
  const last = c.length - 1;
  let touchIdx = -1;
  for (let i = Math.max(startIdx, c.length - TOUCH_LOOKBACK_5M); i <= last; i++) {
    if (c[i].low <= z.top && c[i].high >= z.bottom) {
      touchIdx = i;
      break;
    }
  }
  if (touchIdx < 0) return null;

  // Extreme (lowest low for buys / highest high for sells) since the tap
  let extIdx = touchIdx;
  for (let i = touchIdx; i <= last; i++) {
    if (buy ? c[i].low < c[extIdx].low : c[i].high > c[extIdx].high) extIdx = i;
  }

  // The 5M lower-high (buys) / higher-low (sells) that formed before the extreme
  let level = null;
  let levelIdx = -1;
  for (let k = extIdx - 1; k >= Math.max(1, touchIdx - 6); k--) {
    if (buy && c[k].high >= c[k - 1].high && c[k].high >= c[k + 1].high) {
      level = c[k].high;
      levelIdx = k;
      break;
    }
    if (!buy && c[k].low <= c[k - 1].low && c[k].low <= c[k + 1].low) {
      level = c[k].low;
      levelIdx = k;
      break;
    }
  }
  if (level === null) return null;

  // Confirmation: the latest 5M candle is the first to close beyond that level
  const lc = c[last];
  const prev = c[last - 1];
  const confirmed = buy
    ? lc.close > level && lc.close > lc.open && prev.close <= level
    : lc.close < level && lc.close < lc.open && prev.close >= level;
  if (!confirmed || last <= levelIdx) return null;

  // Stop loss beyond the extreme / zone
  const entry = lc.close;
  const ext = buy ? c[extIdx].low : c[extIdx].high;
  const sl = buy
    ? Math.min(ext, z.bottom) - SL_BUFFER
    : Math.max(ext, z.top) + SL_BUFFER;

  const risk = Math.abs(entry - sl);
  if (risk < MIN_SL_USD || risk > MAX_SL_USD) {
    console.log(`[PLAN] Confirmation seen but stop distance $${risk.toFixed(2)} is outside limits - skipped`);
    return null;
  }

  // Take profit = nearest swing liquidity at least MIN_RR away (15M and 4H swings),
  // otherwise a fixed MIN_RR target.
  const htfSwings = getHTF() ? getHTF().swings.map(s => s.price) : [];
  const ltfSwings = analyzeStructure(candles["15m"], SWING_LOOKBACK["15m"]).swings.map(s => s.price);
  const levels = [...htfSwings, ...ltfSwings]
    .filter(p => (buy ? p > entry : p < entry))
    .sort((a, b2) => (buy ? a - b2 : b2 - a));

  let tp = buy ? entry + MIN_RR * risk : entry - MIN_RR * risk;
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
// MAIN ANALYSIS - runs after every successful data refresh
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

  if (activePlan && activePlan.dir !== htfState.bias) killPlan("4H bias changed");
  if (activePlan && Date.now() - activePlan.createdAt > PLAN_EXPIRY_MS) killPlan("plan expired");

  if (!activePlan) {
    activePlan = find15mSetup(htfState);
    if (activePlan) {
      const p = activePlan;
      console.log(`[PLAN] ${p.dir} ${p.label} on 15M | zone ${p.zone.bottom.toFixed(2)}-${p.zone.top.toFixed(2)} | sweep: ${p.sweep}`);
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

  if (c5.length === 0 || Date.now() - (c5[c5.length - 1].t + TF["5m"].ms) > 15 * 60 * 1000) {
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
Top-Down SMC

${emoji} ${direction} @ ${sig.entry.toFixed(2)}

🛡️ Stop Loss: ${sig.sl.toFixed(2)} (${riskPips} pips)
🎯 Take Profit: ${sig.tp.toFixed(2)} (${rewardPips} pips)
⚖️ Risk:Reward 1:${sig.rr.toFixed(1)} (${sig.tpType})

🧭 Top-down analysis
• 4H: ${plan.dir.toUpperCase()} bias, entry zone in ${side}
• 15M: ${plan.label} ${plan.dir} + FVG, Order Block ${plan.zone.bottom.toFixed(2)}-${plan.zone.top.toFixed(2)}${confluences.length ? " (" + confluences.join(", ") + ")" : ""}
• 5M: price tapped the zone, then ${sig.ltfLabel}

⚠️ Always manage your own risk. This is not financial advice.`;

  console.log(`[SIGNAL FIRED] ${direction} @ ${sig.entry} SL ${sig.sl} TP ${sig.tp}`);

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
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.pop();

  for (const chatId of subscribers.keys()) {
    bot.sendMessage(chatId, message).catch(err => {
      console.error(`Failed to send signal to ${chatId}:`, err.message);
    });
  }
}

// ================================================================
// OUTCOME TRACKER (live price, every 30 seconds)
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
    const resultText = signal.status === "win" ? "TAKE PROFIT HIT" : "STOP LOSS HIT";

    const closeMessage =
`${resultEmoji} SIGNAL CLOSED - ${resultText}

${signal.direction} @ ${signal.entryPrice.toFixed(2)}
Closed @ ${currentPrice.toFixed(2)}

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
    lines.push("⏳ Loading 4H data...");
  } else if (!htfState.bias) {
    lines.push("📈 4H bias: not clear yet");
  } else {
    lines.push(`📈 4H bias: ${htfState.bias.toUpperCase()}`);
  }

  if (activePlan) {
    const p = activePlan;
    lines.push(`🧭 15M: ${p.label} ${p.dir} found`);
    lines.push(`🟦 Watching zone ${p.zone.bottom.toFixed(2)} - ${p.zone.top.toFixed(2)}`);
    lines.push("⏳ Waiting for a 5M tap and confirmation");
  } else if (htfState && htfState.bias) {
    lines.push("🔎 15M: no setup in line with the 4H bias yet");
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

  <div class="stats">
    <div class="card"><div class="label">Bot uptime</div><div class="value">${formatUptime(Date.now() - botStartedAt)}</div></div>
    <div class="card"><div class="label">Last 5M close</div><div class="value">${price ? price.toFixed(2) : "—"}</div></div>
    <div class="card"><div class="label">4H bias</div><div class="value">${bias}</div></div>
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
    <div class="card"><div class="label">4H / 15M / 5M candles</div><div class="value">${candles["4h"].length} / ${candles["15m"].length} / ${candles["5m"].length}</div></div>
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

// ===============================
// START COMMAND
// ===============================

bot.onText(/\/start/, (msg) => {

  bot.sendMessage(
    msg.chat.id,

`🔥 MONEY MAKING MACHINE BOT

Welcome! 👋

Your XAUUSD trading assistant.

🧭 Top-down Smart Money analysis
🚨 Entry alerts
⚖️ Minimum 1:2 risk to reward
🛡️ Clear stop loss and take profit

Choose an option below:`,
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

MONEY MAKING MACHINE BOT will monitor XAUUSD automatically.

You will receive an alert when a full top-down setup is confirmed:

🧭 4H bias
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

You will no longer receive automatic XAUUSD entry alerts.

You can turn them back on anytime with:

🔔 Auto Signals`
    );

  }

  // 📖 HOW IT WORKS
  if (msg.text === "📖 How It Works") {

    bot.sendMessage(
      msg.chat.id,

`📖 HOW IT WORKS

The bot analyses XAUUSD top-down, like a Smart Money trader:

1️⃣ 4H - Bias
Market structure (BOS / CHoCH) sets the direction. Buys only in discount, sells only in premium of the 4H range.

2️⃣ 15M - Zone
Structure breaks in the 4H direction with displacement (Fair Value Gap). The Order Block behind the move becomes the entry zone.

3️⃣ 5M - Entry
Price must return to the zone, then a 5M change of character confirms the entry.

🛡️ Stop loss goes beyond the sweep / zone.
🎯 Take profit targets the next swing liquidity, minimum 1:2 risk to reward.

Only one signal at a time, during London and New York hours.`
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
4H bias → 15M zone → 5M entry

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
