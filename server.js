"use strict";

const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();

/* =========================================================
   ENVIRONMENT
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";

const TELEGRAM_WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || "";

const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ""
).replace(/\/+$/, "");

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

if (!TWELVE_DATA_API_KEY) {
  console.error("❌ TWELVE_DATA_API_KEY is missing");
  process.exit(1);
}

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "1mb" }));

/* =========================================================
   TELEGRAM
   IMPORTANT:
   polling is FALSE.
   We use webhook mode to prevent Telegram 409 conflicts.
========================================================= */

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false
});

/* =========================================================
   CONSTANTS
========================================================= */

const SYMBOL = "XAU/USD";

const FIVE_MIN_MS = 5 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;

const PIP_SIZE = 0.1;

/*
   Original bot target range:
   200 - 300 pips

   With PIP_SIZE = 0.1:
   200 pips = $20
   300 pips = $30
*/

const MIN_TP_DOLLARS = 20;
const MAX_TP_DOLLARS = 30;

const MIN_RISK_DOLLARS = 3;
const MAX_RISK_DOLLARS = 15;

const SL_BUFFER = 1.0;

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
const SETUP_EXPIRY_MS = 3 * 60 * 60 * 1000;

const MAX_SIGNAL_HISTORY = 100;

/*
   API history sizes.
*/

const INITIAL_OUTPUT = {
  "5min": 300,
  "15min": 160,
  "1h": 120,
  "4h": 100
};

const UPDATE_OUTPUT = {
  "5min": 3,
  "15min": 3,
  "1h": 3,
  "4h": 3
};

/*
   Maximum candles kept in RAM.
*/

const MAX_CANDLES = {
  "5min": 500,
  "15min": 250,
  "1h": 150,
  "4h": 100
};

/* =========================================================
   MARKET STATE
========================================================= */

const market = {
  candles: {
    "5min": [],
    "15min": [],
    "1h": [],
    "4h": []
  },

  latestPrice: null,

  lastUpdated: {
    "5min": null,
    "15min": null,
    "1h": null,
    "4h": null
  },

  topDown: {
    bias4h: "neutral",
    confirmation1h: "neutral",
    direction: "neutral",
    liquidity: null,
    bos: null,
    fvg: null,
    orderBlock: null,
    zone: null
  },

  pendingSetup: null,

  lastProcessed5m: null,

  lastSignalCloseTime: 0,

  apiQuotaBlockedUntil: 0,

  apiQuotaMessage: "",

  initialized: false
};

/* =========================================================
   SUBSCRIBERS / SIGNAL HISTORY
========================================================= */

const subscribers = new Map();

const signalHistory = [];

let signalsSent = 0;
let wins = 0;
let losses = 0;

/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundPrice(value) {
  return Number(Number(value).toFixed(2));
}

function formatPrice(value) {
  if (value === null || value === undefined) {
    return "N/A";
  }

  return Number(value).toFixed(2);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "N/A";
  }

  return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function parseDateTime(value) {
  let text = String(value).trim();

  if (!text.includes("T")) {
    text = text.replace(" ", "T");
  }

  /*
     Twelve Data is requested with UTC timezone.
     Only append Z when no timezone is already supplied.
  */

  if (!/[zZ]|[+-]\d\d:\d\d$/.test(text)) {
    text += "Z";
  }

  const timestamp = Date.parse(text);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return timestamp;
}

function getIntervalMs(interval) {
  if (interval === "5min") return FIVE_MIN_MS;
  if (interval === "15min") return FIFTEEN_MIN_MS;
  if (interval === "1h") return ONE_HOUR_MS;
  if (interval === "4h") return FOUR_HOUR_MS;

  return FIVE_MIN_MS;
}

function isMarketWeekend() {
  const day = new Date().getUTCDay();
  const hour = new Date().getUTCHours();

  /*
     Saturday = closed.
     Sunday before approximately 22:00 UTC = usually closed.
  */

  if (day === 6) {
    return true;
  }

  if (day === 0 && hour < 22) {
    return true;
  }

  return false;
}

function nextUtcMidnight() {
  const d = new Date();

  d.setUTCHours(24, 0, 0, 0);

  return d.getTime();
}

/* =========================================================
   EMA
========================================================= */

function calculateEMA(candles, period) {
  if (!candles || candles.length < period) {
    return null;
  }

  const closes = candles.map(c => c.close);

  const multiplier = 2 / (period + 1);

  let emaValue = 0;

  for (let i = 0; i < period; i++) {
    emaValue += closes[i];
  }

  emaValue /= period;

  for (let i = period; i < closes.length; i++) {
    emaValue =
      (closes[i] - emaValue) * multiplier + emaValue;
  }

  return emaValue;
}

/* =========================================================
   SWING DETECTION
========================================================= */

function findSwings(candles, lookback = 2) {
  const swings = [];

  if (!candles || candles.length < lookback * 2 + 1) {
    return swings;
  }

  for (
    let i = lookback;
    i < candles.length - lookback;
    i++
  ) {
    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (
      let j = i - lookback;
      j <= i + lookback;
      j++
    ) {
      if (j === i) {
        continue;
      }

      if (candles[j].high > current.high) {
        isHigh = false;
      }

      if (candles[j].low < current.low) {
        isLow = false;
      }
    }

    if (isHigh) {
      swings.push({
        type: "high",
        index: i,
        price: current.high,
        time: current.time
      });
    }

    if (isLow) {
      swings.push({
        type: "low",
        index: i,
        price: current.low,
        time: current.time
      });
    }
  }

  return swings;
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function getStructureDirection(candles) {
  if (!candles || candles.length < 20) {
    return "neutral";
  }

  const swings = findSwings(candles, 2);

  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");

  if (highs.length < 2 || lows.length < 2) {
    return "neutral";
  }

  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];

  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];

  const bullish =
    h2.price > h1.price &&
    l2.price > l1.price;

  const bearish =
    h2.price < h1.price &&
    l2.price < l1.price;

  if (bullish) {
    return "bullish";
  }

  if (bearish) {
    return "bearish";
  }

  return "neutral";
}

/* =========================================================
   TIMEFRAME TREND
========================================================= */

function getTimeframeTrend(candles) {
  if (!candles || candles.length < 50) {
    return "neutral";
  }

  const structure = getStructureDirection(candles);

  const ema20 = calculateEMA(candles, 20);
  const ema50 = calculateEMA(candles, 50);

  if (ema20 === null || ema50 === null) {
    return "neutral";
  }

  if (
    structure === "bullish" &&
    ema20 > ema50
  ) {
    return "bullish";
  }

  if (
    structure === "bearish" &&
    ema20 < ema50
  ) {
    return "bearish";
  }

  return "neutral";
}

/* =========================================================
   FVG
========================================================= */

function findFVGNearIndex(candles, index, direction) {
  const start = Math.max(2, index - 5);

  for (let i = index; i >= start; i--) {
    const left = candles[i - 2];
    const middle = candles[i - 1];
    const right = candles[i];

    if (!left || !middle || !right) {
      continue;
    }

    /*
       Bullish FVG:
       candle 1 high < candle 3 low
    */

    if (
      direction === "bullish" &&
      left.high < right.low
    ) {
      return {
        direction: "bullish",
        bottom: left.high,
        top: right.low,
        index: i,
        time: right.time
      };
    }

    /*
       Bearish FVG:
       candle 1 low > candle 3 high
    */

    if (
      direction === "bearish" &&
      left.low > right.high
    ) {
      return {
        direction: "bearish",
        bottom: right.high,
        top: left.low,
        index: i,
        time: right.time
      };
    }
  }

  return null;
}

/* =========================================================
   ORDER BLOCK
========================================================= */

function findOrderBlock(candles, bosIndex, direction) {
  const start = Math.max(0, bosIndex - 8);

  for (let i = bosIndex - 1; i >= start; i--) {
    const candle = candles[i];

    if (!candle) {
      continue;
    }

    /*
       Bullish setup:
       Find last bearish candle.
    */

    if (
      direction === "bullish" &&
      candle.close < candle.open
    ) {
      return {
        direction: "bullish",
        bottom: candle.low,
        top: candle.high,
        index: i,
        time: candle.time
      };
    }

    /*
       Bearish setup:
       Find last bullish candle.
    */

    if (
      direction === "bearish" &&
      candle.close > candle.open
    ) {
      return {
        direction: "bearish",
        bottom: candle.low,
        top: candle.high,
        index: i,
        time: candle.time
      };
    }
  }

  return null;
}

/* =========================================================
   FVG + ORDER BLOCK ZONE
========================================================= */

function buildEntryZone(fvg, orderBlock) {
  if (!fvg && !orderBlock) {
    return null;
  }

  if (fvg && orderBlock) {
    const intersectionBottom = Math.max(
      fvg.bottom,
      orderBlock.bottom
    );

    const intersectionTop = Math.min(
      fvg.top,
      orderBlock.top
    );

    /*
       If FVG and OB overlap, use the overlap.
    */

    if (intersectionBottom < intersectionTop) {
      return {
        bottom: intersectionBottom,
        top: intersectionTop,
        source: "FVG + OB"
      };
    }

    /*
       If they don't overlap, use FVG for the entry zone.
       OB still remains available for SL.
    */

    return {
      bottom: fvg.bottom,
      top: fvg.top,
      source: "FVG"
    };
  }

  if (fvg) {
    return {
      bottom: fvg.bottom,
      top: fvg.top,
      source: "FVG"
    };
  }

  return {
    bottom: orderBlock.bottom,
    top: orderBlock.top,
    source: "OB"
  };
}

/* =========================================================
   15M LIQUIDITY + BOS
========================================================= */

function findLiquidityAndBOS(candles, direction) {
  if (!candles || candles.length < 25) {
    return null;
  }

  const swings = findSwings(candles, 2);

  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");

  /*
     Only inspect recent candles.
     20 x 15M = 5 hours.
  */

  const minimumIndex = Math.max(
    10,
    candles.length - 20
  );

  /*
     ======================================================
     BULLISH:
     Sell-side liquidity sweep
     then BOS above previous swing high
     ======================================================
  */

  if (direction === "bullish") {
    for (
      let i = candles.length - 1;
      i >= minimumIndex;
      i--
    ) {
      const candle = candles[i];

      const previousLows = lows.filter(
        swing => swing.index < i
      );

      const previousHighs = highs.filter(
        swing => swing.index < i
      );

      if (
        previousLows.length === 0 ||
        previousHighs.length === 0
      ) {
        continue;
      }

      const liquidityLow =
        previousLows[previousLows.length - 1];

      const referenceHigh =
        previousHighs[previousHighs.length - 1];

      /*
         Sell-side liquidity sweep:
         wick below low,
         close back above it.
      */

      if (
        candle.low < liquidityLow.price &&
        candle.close > liquidityLow.price
      ) {
        /*
           Now search for bullish BOS.
        */

        for (
          let j = i + 1;
          j < candles.length;
          j++
        ) {
          if (
            candles[j].close >
            referenceHigh.price
          ) {
            return {
              direction: "bullish",
              sweepIndex: i,
              bosIndex: j,
              liquidityLevel: liquidityLow.price,
              referenceLevel: referenceHigh.price,
              sweepTime: candle.time,
              bosTime: candles[j].time,
              sweepExtreme: candle.low
            };
          }
        }
      }
    }
  }

  /*
     ======================================================
     BEARISH:
     Buy-side liquidity sweep
     then BOS below previous swing low
     ======================================================
  */

  if (direction === "bearish") {
    for (
      let i = candles.length - 1;
      i >= minimumIndex;
      i--
    ) {
      const candle = candles[i];

      const previousHighs = highs.filter(
        swing => swing.index < i
      );

      const previousLows = lows.filter(
        swing => swing.index < i
      );

      if (
        previousHighs.length === 0 ||
        previousLows.length === 0
      ) {
        continue;
      }

      const liquidityHigh =
        previousHighs[previousHighs.length - 1];

      const referenceLow =
        previousLows[previousLows.length - 1];

      /*
         Buy-side liquidity sweep:
         wick above high,
         close back below it.
      */

      if (
        candle.high > liquidityHigh.price &&
        candle.close < liquidityHigh.price
      ) {
        /*
           Search for bearish BOS.
        */

        for (
          let j = i + 1;
          j < candles.length;
          j++
        ) {
          if (
            candles[j].close <
            referenceLow.price
          ) {
            return {
              direction: "bearish",
              sweepIndex: i,
              bosIndex: j,
              liquidityLevel: liquidityHigh.price,
              referenceLevel: referenceLow.price,
              sweepTime: candle.time,
              bosTime: candles[j].time,
              sweepExtreme: candle.high
            };
          }
        }
      }
    }
  }

  return null;
}

/* =========================================================
   TOP-DOWN ANALYSIS
========================================================= */

function calculateTopDown() {
  const h4 = market.candles["4h"];
  const h1 = market.candles["1h"];
  const m15 = market.candles["15min"];

  const bias4h = getTimeframeTrend(h4);
  const confirmation1h = getTimeframeTrend(h1);

  let direction = "neutral";

  if (
    bias4h === "bullish" &&
    confirmation1h === "bullish"
  ) {
    direction = "bullish";
  }

  if (
    bias4h === "bearish" &&
    confirmation1h === "bearish"
  ) {
    direction = "bearish";
  }

  let liquidity = null;
  let bos = null;
  let fvg = null;
  let orderBlock = null;
  let zone = null;

  if (direction !== "neutral") {
    const structure = findLiquidityAndBOS(
      m15,
      direction
    );

    if (structure) {
      liquidity = {
        direction,
        level: structure.liquidityLevel,
        time: structure.sweepTime,
        extreme: structure.sweepExtreme,
        index: structure.sweepIndex
      };

      bos = {
        direction,
        level: structure.referenceLevel,
        time: structure.bosTime,
        index: structure.bosIndex
      };

      fvg = findFVGNearIndex(
        m15,
        structure.bosIndex,
        direction
      );

      orderBlock = findOrderBlock(
        m15,
        structure.bosIndex,
        direction
      );

      zone = buildEntryZone(
        fvg,
        orderBlock
      );
    }
  }

  market.topDown = {
    bias4h,
    confirmation1h,
    direction,
    liquidity,
    bos,
    fvg,
    orderBlock,
    zone
  };

  return market.topDown;
}

/* =========================================================
   API QUOTA CONTROL
========================================================= */

function apiQuotaBlocked() {
  return (
    market.apiQuotaBlockedUntil > Date.now()
  );
}

function setApiQuotaBlocked(message) {
  market.apiQuotaMessage = message || "API quota reached";

  /*
     If this is the daily limit, stop API requests
     until the next UTC day.
  */

  if (
    /day|daily|800|quota/i.test(
      String(message)
    )
  ) {
    market.apiQuotaBlockedUntil =
      nextUtcMidnight();

    console.error(
      `⛔ Twelve Data daily quota reached. ` +
      `No more API requests until ${formatTime(
        market.apiQuotaBlockedUntil
      )}`
    );

    return;
  }

  /*
     Otherwise assume a temporary 429.
  */

  market.apiQuotaBlockedUntil =
    Date.now() + 65 * 1000;

  console.error(
    "⚠️ Twelve Data temporary 429. " +
    "Waiting about 65 seconds before retry."
  );
}

/* =========================================================
   TWELVE DATA FETCH
========================================================= */

async function fetchTimeSeries(
  interval,
  outputsize
) {
  if (apiQuotaBlocked()) {
    return false;
  }

  /*
     Don't waste API credits while the normal
     forex/commodity market is closed.
  */

  if (isMarketWeekend()) {
    return false;
  }

  try {
    const response = await axios.get(
      "https://api.twelvedata.com/time_series",
      {
        timeout: 15000,

        params: {
          symbol: SYMBOL,
          interval,
          outputsize,
          timezone: "UTC",
          apikey: TWELVE_DATA_API_KEY
        }
      }
    );

    const data = response.data;

    if (
      !data ||
      data.status === "error" ||
      !Array.isArray(data.values)
    ) {
      const message =
        data?.message ||
        "Invalid Twelve Data response";

      if (
        data?.code === 429 ||
        /credit|quota|rate limit/i.test(
          String(message)
        )
      ) {
        setApiQuotaBlocked(message);
      }

      console.error(
        `[TWELVE DATA ${interval}] ${message}`
      );

      return false;
    }

    const duration = getIntervalMs(interval);

    const parsed = data.values
      .map(item => {
        const time = parseDateTime(
          item.datetime
        );

        return {
          time,
          open: Number(item.open),
          high: Number(item.high),
          low: Number(item.low),
          close: Number(item.close)
        };
      })
      .filter(candle => {
        if (!Number.isFinite(candle.time)) {
          return false;
        }

        if (
          !Number.isFinite(candle.open) ||
          !Number.isFinite(candle.high) ||
          !Number.isFinite(candle.low) ||
          !Number.isFinite(candle.close)
        ) {
          return false;
        }

        /*
           IMPORTANT:
           Only closed candles enter our analysis.
        */

        return (
          candle.time + duration <= Date.now()
        );
      });

    /*
       Sort oldest -> newest.
    */

    parsed.sort(
      (a, b) => a.time - b.time
    );

    /*
       Merge with existing candles.
    */

    const existing =
      market.candles[interval] || [];

    const combined = [
      ...existing,
      ...parsed
    ];

    const byTime = new Map();

    for (const candle of combined) {
      byTime.set(candle.time, candle);
    }

    const merged = Array.from(
      byTime.values()
    ).sort(
      (a, b) => a.time - b.time
    );

    market.candles[interval] =
      merged.slice(
        -MAX_CANDLES[interval]
      );

    market.lastUpdated[interval] =
      Date.now();

    if (interval === "5min") {
      const latest =
        market.candles["5min"][
          market.candles["5min"].length - 1
        ];

      if (latest) {
        market.latestPrice =
          latest.close;
      }
    }

    const used =
      response.headers["api-credits-used"];

    const left =
      response.headers["api-credits-left"];

    console.log(
      `📊 ${interval} updated: ` +
      `${market.candles[interval].length} candles` +
      (left
        ? ` | credits left: ${left}`
        : "")
    );

    return true;

  } catch (error) {
    const status =
      error.response?.status;

    const message =
      error.response?.data?.message ||
      error.message ||
      "Unknown API error";

    if (status === 429) {
      setApiQuotaBlocked(message);
    }

    console.error(
      `[MARKET ERROR ${interval}]`,
      message
    );

    return false;
  }
}

/* =========================================================
   STRATEGY EVALUATION
========================================================= */

function canCreateNewSignal() {
  if (
    Date.now() -
      market.lastSignalCloseTime <
    SIGNAL_COOLDOWN_MS
  ) {
    return false;
  }

  const openSignal =
    signalHistory.find(
      signal => signal.status === "open"
    );

  return !openSignal;
}

/* =========================================================
   CREATE PENDING SETUP
========================================================= */

function createPendingSetup() {
  if (market.pendingSetup) {
    return;
  }

  if (!canCreateNewSignal()) {
    return;
  }

  const td = calculateTopDown();

  if (
    td.direction !== "bullish" &&
    td.direction !== "bearish"
  ) {
    return;
  }

  if (
    !td.liquidity ||
    !td.bos ||
    !td.zone
  ) {
    return;
  }

  const m15 =
    market.candles["15min"];

  const bosCandle =
    m15[td.bos.index];

  if (!bosCandle) {
    return;
  }

  const setup = {
    direction: td.direction,

    createdAt: Date.now(),

    sweepTime:
      td.liquidity.time,

    sweepExtreme:
      td.liquidity.extreme,

    bosTime:
      td.bos.time,

    bosLevel:
      td.bos.level,

    fvg:
      td.fvg,

    orderBlock:
      td.orderBlock,

    zone:
      td.zone
  };

  market.pendingSetup = setup;

  console.log(
    `🎯 NEW ${td.direction.toUpperCase()} ` +
    `SETUP | ` +
    `4H=${td.bias4h} ` +
    `1H=${td.confirmation1h} ` +
    `15M=LIQ+BOS ` +
    `ZONE=${formatPrice(td.zone.bottom)}-${formatPrice(td.zone.top)}`
  );
}

/* =========================================================
   PENDING SETUP INVALIDATION
========================================================= */

function invalidatePendingSetupIfNeeded() {
  const setup =
    market.pendingSetup;

  if (!setup) {
    return;
  }

  /*
     Expire after 3 hours.
  */

  if (
    Date.now() - setup.createdAt >
    SETUP_EXPIRY_MS
  ) {
    console.log("⌛ Pending setup expired.");

    market.pendingSetup = null;

    return;
  }

  const m15 =
    market.candles["15min"];

  if (!m15.length) {
    return;
  }

  const latest =
    m15[m15.length - 1];

  /*
     Bullish invalidation:
     15M closes below sweep extreme.
  */

  if (
    setup.direction === "bullish" &&
    latest.close < setup.sweepExtreme
  ) {
    console.log(
      "❌ Bullish setup invalidated."
    );

    market.pendingSetup = null;

    return;
  }

  /*
     Bearish invalidation:
     15M closes above sweep extreme.
  */

  if (
    setup.direction === "bearish" &&
    latest.close > setup.sweepExtreme
  ) {
    console.log(
      "❌ Bearish setup invalidated."
    );

    market.pendingSetup = null;
  }
}

/* =========================================================
   ENTRY CONFIRMATION
========================================================= */

function check5mEntry() {
  const setup =
    market.pendingSetup;

  if (!setup) {
    return;
  }

  const candles =
    market.candles["5min"];

  if (!candles.length) {
    return;
  }

  const latest =
    candles[candles.length - 1];

  /*
     Don't process the same candle twice.
  */

  if (
    market.lastProcessed5m ===
    latest.time
  ) {
    return;
  }

  market.lastProcessed5m =
    latest.time;

  /*
     Don't enter using a candle that existed
     before the BOS.
  */

  if (
    latest.time <= setup.bosTime
  ) {
    return;
  }

  const zone =
    setup.zone;

  if (!zone) {
    return;
  }

  /*
     Candle must interact with the zone.
  */

  const touchedZone =
    latest.low <= zone.top &&
    latest.high >= zone.bottom;

  if (!touchedZone) {
    return;
  }

  const midpoint =
    (zone.top + zone.bottom) / 2;

  let confirmed = false;

  if (
    setup.direction === "bullish"
  ) {
    confirmed =
      latest.close > latest.open &&
      latest.close > midpoint;
  }

  if (
    setup.direction === "bearish"
  ) {
    confirmed =
      latest.close < latest.open &&
      latest.close < midpoint;
  }

  if (!confirmed) {
    return;
  }

  /*
     Prevent chasing an entry too far away
     from the zone.
  */

  const zoneHeight =
    Math.max(
      zone.top - zone.bottom,
      0.1
    );

  const maxDistance =
    zoneHeight * 2 + 1.0;

  if (
    Math.abs(latest.close - midpoint) >
    maxDistance
  ) {
    console.log(
      "⚠️ 5M confirmation occurred too far from zone. Skipping."
    );

    return;
  }

  fireSignal(
    setup,
    latest
  );
}

/* =========================================================
   FIRE SIGNAL
========================================================= */

function fireSignal(
  setup,
  entryCandle
) {
  if (!canCreateNewSignal()) {
    return;
  }

  const entry =
    entryCandle.close;

  let stopLoss;

  if (
    setup.direction === "bullish"
  ) {
    const obLow =
      setup.orderBlock?.bottom ??
      setup.sweepExtreme;

    stopLoss =
      obLow - SL_BUFFER;

  } else {
    const obHigh =
      setup.orderBlock?.top ??
      setup.sweepExtreme;

    stopLoss =
      obHigh + SL_BUFFER;
  }

  stopLoss =
    roundPrice(stopLoss);

  const risk =
    Math.abs(entry - stopLoss);

  /*
     Don't trade setups with unreasonable
     stop distance.
  */

  if (
    risk < MIN_RISK_DOLLARS ||
    risk > MAX_RISK_DOLLARS
  ) {
    console.log(
      `⚠️ Signal skipped. ` +
      `Risk distance=${risk.toFixed(2)}`
    );

    market.pendingSetup = null;

    return;
  }

  /*
     Target is approximately 2R,
     constrained to the original
     200-300 pip range.
  */

  const targetDistance =
    clamp(
      risk * 2,
      MIN_TP_DOLLARS,
      MAX_TP_DOLLARS
    );

  let takeProfit;

  if (
    setup.direction === "bullish"
  ) {
    takeProfit =
      entry + targetDistance;
  } else {
    takeProfit =
      entry - targetDistance;
  }

  takeProfit =
    roundPrice(takeProfit);

  const tpPips =
    Math.round(
      targetDistance / PIP_SIZE
    );

  const signal = {
    id:
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    time: Date.now(),

    direction:
      setup.direction,

    label:
      "TOP-DOWN SMC",

    entry:
      roundPrice(entry),

    stopLoss,

    takeProfit,

    tpPips,

    risk:
      Number(risk.toFixed(2)),

    status:
      "open",

    openBarTime:
      entryCandle.time,

    result:
      null,

    resultTime:
      null,

    fvg:
      setup.fvg,

    orderBlock:
      setup.orderBlock,

    zone:
      setup.zone
  };

  signalHistory.unshift(signal);

  if (
    signalHistory.length >
    MAX_SIGNAL_HISTORY
  ) {
    signalHistory.pop();
  }

  signalsSent++;

  market.pendingSetup = null;

  console.log(
    `🚨 SIGNAL FIRED: ` +
    `${signal.direction.toUpperCase()} ` +
    `ENTRY=${formatPrice(signal.entry)} ` +
    `SL=${formatPrice(signal.stopLoss)} ` +
    `TP=${formatPrice(signal.takeProfit)}`
  );

  broadcastSignal(signal);
}

/* =========================================================
   SIGNAL RESULT
========================================================= */

function checkOpenSignals() {
  const candles =
    market.candles["5min"];

  if (!candles.length) {
    return;
  }

  const latest =
    candles[candles.length - 1];

  for (const signal of signalHistory) {
    if (
      signal.status !== "open"
    ) {
      continue;
    }

    /*
       Never use the entry candle itself
       to determine the result.
    */

    if (
      latest.time <=
      signal.openBarTime
    ) {
      continue;
    }

    let hitSL = false;
    let hitTP = false;

    if (
      signal.direction === "bullish"
    ) {
      hitSL =
        latest.low <= signal.stopLoss;

      hitTP =
        latest.high >= signal.takeProfit;
    }

    if (
      signal.direction === "bearish"
    ) {
      hitSL =
        latest.high >= signal.stopLoss;

      hitTP =
        latest.low <= signal.takeProfit;
    }

    /*
       Conservative rule:
       If both happen inside one 5M candle,
       count SL first because candle order
       is unknown.
    */

    if (hitSL) {
      closeSignal(
        signal,
        "loss"
      );

      continue;
    }

    if (hitTP) {
      closeSignal(
        signal,
        "win"
      );
    }
  }
}

/* =========================================================
   CLOSE SIGNAL
========================================================= */

async function closeSignal(
  signal,
  result
) {
  if (
    signal.status !== "open"
  ) {
    return;
  }

  signal.status = result;
  signal.result = result;
  signal.resultTime = Date.now();

  market.lastSignalCloseTime =
    Date.now();

  if (result === "win") {
    wins++;
  } else {
    losses++;
  }

  const emoji =
    result === "win"
      ? "✅"
      : "❌";

  const text =
    `${emoji} <b>XAUUSD SIGNAL CLOSED</b>\n\n` +
    `Direction: <b>${signal.direction.toUpperCase()}</b>\n` +
    `Entry: <b>${formatPrice(signal.entry)}</b>\n` +
    `SL: <b>${formatPrice(signal.stopLoss)}</b>\n` +
    `TP: <b>${formatPrice(signal.takeProfit)}</b>\n\n` +
    `Result: <b>${result.toUpperCase()}</b>`;

  console.log(
    `📌 Signal closed: ${result}`
  );

  await broadcastText(text);
}

/* =========================================================
   BROADCAST
========================================================= */

async function broadcastSignal(
  signal
) {
  const direction =
    signal.direction === "bullish"
      ? "BUY"
      : "SELL";

  const text =
    `🚨 <b>XAUUSD ${direction} SIGNAL</b>\n\n` +

    `Strategy: <b>4H → 1H → 15M → 5M</b>\n` +

    `Setup: <b>${signal.label}</b>\n\n` +

    `🎯 Entry: <b>${formatPrice(signal.entry)}</b>\n` +

    `🛑 Stop Loss: <b>${formatPrice(signal.stopLoss)}</b>\n` +

    `💰 Take Profit: <b>${formatPrice(signal.takeProfit)}</b>\n` +

    `📏 TP: <b>${signal.tpPips} pips</b>\n\n` +

    `15M liquidity + BOS confirmed\n` +
    `15M FVG/OB zone confirmed\n` +
    `5M entry candle confirmed`;

  await broadcastText(text);
}

async function broadcastText(text) {
  const entries =
    Array.from(subscribers.entries());

  for (const [chatId] of entries) {
    try {
      await bot.sendMessage(
        chatId,
        text,
        {
          parse_mode: "HTML"
        }
      );

      /*
         Small delay helps avoid hammering
         Telegram when subscriber count grows.
      */

      await sleep(50);

    } catch (error) {
      console.error(
        `Telegram send failed for ${chatId}:`,
        error.message
      );
    }
  }
}

/* =========================================================
   MARKET UPDATE
========================================================= */

async function updateMarket(
  interval,
  initial = false
) {
  const outputsize =
    initial
      ? INITIAL_OUTPUT[interval]
      : UPDATE_OUTPUT[interval];

  const success =
    await fetchTimeSeries(
      interval,
      outputsize
    );

  if (!success) {
    return;
  }

  /*
     Recalculate top-down state after
     every successful market update.
  */

  calculateTopDown();

  /*
     First check whether an existing setup
     has become invalid.
  */

  invalidatePendingSetupIfNeeded();

  /*
     Then look for a new top-down setup.
  */

  if (!market.pendingSetup) {
    createPendingSetup();
  }

  /*
     Entry confirmation only happens on
     a new closed 5M candle.
  */

  if (interval === "5min") {
    checkOpenSignals();
    check5mEntry();
  }
}

/* =========================================================
   SCHEDULER
========================================================= */

function scheduleAligned(
  interval,
  periodMs,
  callback
) {
  async function run() {
    try {
      await callback();
    } catch (error) {
      console.error(
        `Scheduler error ${interval}:`,
        error.message
      );
    }

    /*
       Schedule the next exact boundary
       + 10 seconds so the candle has closed.
    */

    const current =
      Date.now();

    const nextBoundary =
      Math.floor(
        current / periodMs
      ) *
        periodMs +
      periodMs;

    const delay =
      Math.max(
        5000,
        nextBoundary -
          Date.now() +
          10000
      );

    setTimeout(
      run,
      delay
    );
  }

  const current =
    Date.now();

  const nextBoundary =
    Math.floor(
      current / periodMs
    ) *
      periodMs +
    periodMs;

  const firstDelay =
    Math.max(
      5000,
      nextBoundary -
        current +
        10000
    );

  setTimeout(
    run,
    firstDelay
  );
}

/* =========================================================
   TELEGRAM KEYBOARD
========================================================= */

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [
          {
            text: "📊 XAUUSD Signal"
          },
          {
            text: "💰 Live Price"
          }
        ],
        [
          {
            text: "🔔 Auto Signals"
          },
          {
            text: "🔕 Stop Alerts"
          }
        ],
        [
          {
            text: "📖 How It Works"
          },
          {
            text: "⚙️ Settings"
          }
        ]
      ],
      resize_keyboard: true,
      persistent: true
    }
  };
}

/* =========================================================
   TELEGRAM START
========================================================= */

bot.onText(/^\/start(?:\s+.*)?$/i, async msg => {
  const chatId =
    msg.chat.id;

  subscribers.set(
    chatId,
    {
      username:
        msg.from?.username || "",
      firstName:
        msg.from?.first_name || "",
      joinedAt:
        Date.now()
    }
  );

  const text =
    `🔥 <b>MONEY MAKING MACHINE BOT</b>\n\n` +

    `XAUUSD top-down signal engine is ready.\n\n` +

    `The strategy checks:\n` +
    `• 4H overall bias\n` +
    `• 1H confirmation\n` +
    `• 15M liquidity sweep\n` +
    `• 15M BOS\n` +
    `• 15M FVG + Order Block\n` +
    `• 5M entry confirmation\n\n` +

    `The bot will NOT send a trade simply because a small 5M breakout occurs.\n\n` +

    `Use the menu below.`;

  await bot.sendMessage(
    chatId,
    text,
    {
      parse_mode: "HTML",
      ...mainKeyboard()
    }
  );
});

/* =========================================================
   TELEGRAM MESSAGE HANDLER
========================================================= */

bot.on("message", async msg => {
  try {
    if (!msg.text) {
      return;
    }

    /*
       /start is handled separately.
    */

    if (
      /^\/start/i.test(
        msg.text
      )
    ) {
      return;
    }

    const chatId =
      msg.chat.id;

    /*
       Keep the user registered.
    */

    subscribers.set(
      chatId,
      {
        username:
          msg.from?.username || "",
        firstName:
          msg.from?.first_name || "",
        joinedAt:
          subscribers.get(chatId)?.joinedAt ||
          Date.now()
      }
    );

    const text =
      msg.text.trim();

    /* =====================================================
       XAUUSD SIGNAL
    ===================================================== */

    if (
      text ===
      "📊 XAUUSD Signal"
    ) {
      if (
        !market.initialized ||
        !market.latestPrice
      ) {
        await bot.sendMessage(
          chatId,
          `⚠️ <b>XAUUSD market data is temporarily unavailable.</b>\n\n` +
          `The market-data engine is waiting for Twelve Data.`,
          {
            parse_mode: "HTML"
          }
        );

        return;
      }

      const td =
        calculateTopDown();

      let response =
        `📊 <b>XAUUSD TOP-DOWN ANALYSIS</b>\n\n` +

        `Latest closed 5M price: <b>${formatPrice(
          market.latestPrice
        )}</b>\n\n` +

        `4H Bias: <b>${td.bias4h.toUpperCase()}</b>\n` +

        `1H Confirmation: <b>${td.confirmation1h.toUpperCase()}</b>\n` +

        `15M Direction: <b>${td.direction.toUpperCase()}</b>\n\n`;

      if (
        td.liquidity
      ) {
        response +=
          `💧 Liquidity sweep: <b>CONFIRMED</b>\n` +
          `Level: <b>${formatPrice(
            td.liquidity.level
          )}</b>\n\n`;
      } else {
        response +=
          `💧 Liquidity sweep: <b>WAITING</b>\n\n`;
      }

      if (td.bos) {
        response +=
          `📈 15M BOS: <b>CONFIRMED</b>\n` +
          `Level: <b>${formatPrice(
            td.bos.level
          )}</b>\n\n`;
      } else {
        response +=
          `📈 15M BOS: <b>WAITING</b>\n\n`;
      }

      if (td.fvg) {
        response +=
          `🟦 FVG: <b>${formatPrice(
            td.fvg.bottom
          )} - ${formatPrice(
            td.fvg.top
          )}</b>\n`;
      } else {
        response +=
          `🟦 FVG: <b>WAITING</b>\n`;
      }

      if (td.orderBlock) {
        response +=
          `🟨 Order Block: <b>${formatPrice(
            td.orderBlock.bottom
          )} - ${formatPrice(
            td.orderBlock.top
          )}</b>\n`;
      } else {
        response +=
          `🟨 Order Block: <b>WAITING</b>\n`;
      }

      if (td.zone) {
        response +=
          `\n🎯 Entry zone: <b>${formatPrice(
            td.zone.bottom
          )} - ${formatPrice(
            td.zone.top
          )}</b>\n`;
      }

      if (
        market.pendingSetup
      ) {
        response +=
          `\n⏳ <b>SETUP ACTIVE</b>\n` +
          `Waiting for 5M confirmation.`;
      } else {
        response +=
          `\n⏳ <b>No active entry setup.</b>`;
      }

      await bot.sendMessage(
        chatId,
        response,
        {
          parse_mode: "HTML"
        }
      );

      return;
    }

    /* =====================================================
       LIVE PRICE
    ===================================================== */

    if (
      text ===
      "💰 Live Price"
    ) {
      if (
        !market.latestPrice
      ) {
        await bot.sendMessage(
          chatId,
          `⚠️ <b>Unable to retrieve XAUUSD price.</b>\n\n` +
          `Market data is not available yet.`,
          {
            parse_mode: "HTML"
          }
        );

        return;
      }

      await bot.sendMessage(
        chatId,
        `💰 <b>XAUUSD PRICE</b>\n\n` +
        `Latest closed 5M price:\n` +
        `<b>${formatPrice(
          market.latestPrice
        )}</b>\n\n` +
        `Updated: ${formatTime(
          market.lastUpdated["5min"]
        )}\n\n` +
        `ℹ️ This button uses the bot's cached market data and does not make a new API request.`,
        {
          parse_mode: "HTML"
        }
      );

      return;
    }

    /* =====================================================
       AUTO SIGNALS
    ===================================================== */

    if (
      text ===
      "🔔 Auto Signals"
    ) {
      subscribers.set(
        chatId,
        {
          username:
            msg.from?.username || "",
          firstName:
            msg.from?.first_name || "",
          joinedAt:
            subscribers.get(chatId)?.joinedAt ||
            Date.now()
        }
      );

      await bot.sendMessage(
        chatId,
        `🔔 <b>AUTO SIGNALS ENABLED</b>\n\n` +

        `The bot will scan XAUUSD using:\n\n` +

        `4H → overall bias\n` +
        `1H → confirmation\n` +
        `15M → liquidity + BOS\n` +
        `15M → FVG + OB\n` +
        `5M → entry confirmation\n\n` +

        `The bot will NOT send a trade merely because a small 5M breakout occurs.\n\n` +

        `All higher-timeframe conditions must agree first.`,
        {
          parse_mode: "HTML",
          ...mainKeyboard()
        }
      );

      return;
    }

    /* =====================================================
       STOP ALERTS
    ===================================================== */

    if (
      text ===
      "🔕 Stop Alerts"
    ) {
      subscribers.delete(
        chatId
      );

      await bot.sendMessage(
        chatId,
        `🔕 <b>AUTO SIGNALS STOPPED</b>\n\n` +
        `You will no longer receive automatic trade alerts.`,
        {
          parse_mode: "HTML",
          ...mainKeyboard()
        }
      );

      return;
    }

    /* =====================================================
       HOW IT WORKS
    ===================================================== */

    if (
      text ===
      "📖 How It Works"
    ) {
      await bot.sendMessage(
        chatId,
        `📖 <b>HOW THE STRATEGY WORKS</b>\n\n` +

        `<b>1️⃣ 4H</b>\n` +
        `Determines the overall market structure and directional bias.\n\n` +

        `<b>2️⃣ 1H</b>\n` +
        `Must confirm the 4H direction.\n\n` +

        `<b>3️⃣ 15M</b>\n` +
        `Looks for liquidity being swept, followed by a Break of Structure.\n\n` +

        `<b>4️⃣ 15M FVG + OB</b>\n` +
        `After BOS, the engine searches for the Fair Value Gap and Order Block zone.\n\n` +

        `<b>5️⃣ 5M</b>\n` +
        `Price must return to the zone and produce a directional confirmation candle.\n\n` +

        `<b>6️⃣ SIGNAL</b>\n` +
        `Only after all confirmations agree is a BUY or SELL signal sent.\n\n` +

        `This prevents the bot from treating every small 5M breakout as a trade.`,
        {
          parse_mode: "HTML"
        }
      );

      return;
    }

    /* =====================================================
       SETTINGS
    ===================================================== */

    if (
      text ===
      "⚙️ Settings"
    ) {
      const winRate =
        wins + losses > 0
          ? (
              (wins /
                (wins + losses)) *
              100
            ).toFixed(1)
          : "0.0";

      await bot.sendMessage(
        chatId,
        `⚙️ <b>BOT STATUS</b>\n\n` +

        `Strategy: <b>4H → 1H → 15M → 5M</b>\n` +
        `Price: <b>${formatPrice(
          market.latestPrice
        )}</b>\n` +
        `Subscribers: <b>${subscribers.size}</b>\n` +
        `Signals sent: <b>${signalsSent}</b>\n` +
        `Wins: <b>${wins}</b>\n` +
        `Losses: <b>${losses}</b>\n` +
        `Win rate: <b>${winRate}%</b>\n\n` +

        `4H: <b>${market.topDown.bias4h}</b>\n` +
        `1H: <b>${market.topDown.confirmation1h}</b>\n` +
        `15M: <b>${market.topDown.direction}</b>`,
        {
          parse_mode: "HTML"
        }
      );

      return;
    }

  } catch (error) {
    console.error(
      "Telegram message handler error:",
      error.message
    );
  }
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "MONEY MAKING MACHINE BOT",
      webhook: true,
      marketData:
        market.initialized,
      latestPrice:
        market.latestPrice,
      lastUpdated:
        market.lastUpdated,
      pendingSetup:
        Boolean(
          market.pendingSetup
        ),
      renderInstance:
        process.env.RENDER_INSTANCE_ID ||
        null
    });
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.send(
      "🔥 MONEY MAKING MACHINE BOT is running."
    );
  }
);

/* =========================================================
   TELEGRAM WEBHOOK
========================================================= */

app.post(
  "/telegram/webhook",
  (req, res) => {
    try {
      /*
         Telegram sends this header when a secret
         token is configured.
      */

      if (
        TELEGRAM_WEBHOOK_SECRET
      ) {
        const receivedSecret =
          req.get(
            "x-telegram-bot-api-secret-token"
          );

        if (
          receivedSecret !==
          TELEGRAM_WEBHOOK_SECRET
        ) {
          return res.sendStatus(
            401
          );
        }
      }

      /*
         Give Telegram an immediate 200.
      */

      res.sendStatus(200);

      /*
         Pass the update into node-telegram-bot-api.
      */

      bot.processUpdate(
        req.body
      );

    } catch (error) {
      console.error(
        "Webhook processing error:",
        error.message
      );

      /*
         Response may already have been sent.
      */
    }
  }
);

/* =========================================================
   ADMIN AUTH
========================================================= */

function adminAuth(
  req,
  res,
  next
) {
  const header =
    req.headers.authorization ||
    "";

  if (
    !header.startsWith("Basic ")
  ) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Money Making Machine Admin"'
    );

    return res.status(401).send(
      "Authentication required."
    );
  }

  const encoded =
    header.slice(6);

  let decoded;

  try {
    decoded =
      Buffer.from(
        encoded,
        "base64"
      ).toString("utf8");
  } catch {
    return res.status(401).send(
      "Invalid authentication."
    );
  }

  const separator =
    decoded.indexOf(":");

  if (separator === -1) {
    return res.status(401).send(
      "Invalid authentication."
    );
  }

  const username =
    decoded.slice(0, separator);

  const password =
    decoded.slice(separator + 1);

  if (
    username !== ADMIN_USER ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).send(
      "Invalid credentials."
    );
  }

  next();
}

/* =========================================================
   ADMIN PAGE
========================================================= */

app.get(
  "/admin",
  adminAuth,
  (req, res) => {
    const openSignals =
      signalHistory.filter(
        s => s.status === "open"
      ).length;

    const closed =
      wins + losses;

    const winRate =
      closed > 0
        ? (
            (wins / closed) *
            100
          ).toFixed(1)
        : "0.0";

    const td =
      market.topDown;

    let setupStatus =
      "No active setup right now.";

    if (
      market.pendingSetup
    ) {
      setupStatus =
        `Watching ${market.pendingSetup.direction.toUpperCase()} setup ` +
        `and waiting for 5M confirmation.`;
    }

    const rows =
      signalHistory
        .slice(0, 20)
        .map(signal => {
          const result =
            signal.status === "open"
              ? "⏳ Open"
              : signal.status === "win"
                ? "✅ Win"
                : "❌ Loss";

          return `
            <tr>
              <td>${escapeHtml(
                formatTime(signal.time)
              )}</td>

              <td>${escapeHtml(
                signal.label
              )}</td>

              <td>${escapeHtml(
                signal.direction
                  .toUpperCase()
              )}</td>

              <td>${formatPrice(
                signal.entry
              )}</td>

              <td>${formatPrice(
                signal.stopLoss
              )}</td>

              <td>${formatPrice(
                signal.takeProfit
              )}</td>

              <td>${result}</td>
            </tr>
          `;
        })
        .join("");

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport"
              content="width=device-width, initial-scale=1">

        <title>Money Making Machine - Admin</title>

        <style>
          body {
            font-family: Arial, sans-serif;
            background: #111827;
            color: #f9fafb;
            padding: 20px;
          }

          h1 {
            margin-bottom: 20px;
          }

          .grid {
            display: grid;
            grid-template-columns:
              repeat(auto-fit, minmax(180px, 1fr));
            gap: 12px;
          }

          .card {
            background: #1f2937;
            padding: 16px;
            border-radius: 12px;
          }

          .value {
            font-size: 24px;
            font-weight: bold;
            margin-top: 8px;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 25px;
            background: #1f2937;
          }

          th,
          td {
            padding: 10px;
            border-bottom:
              1px solid #374151;
            text-align: left;
          }

          th {
            background: #374151;
          }

          .status {
            margin-top: 20px;
            padding: 16px;
            background: #1f2937;
            border-radius: 12px;
          }

          input,
          textarea,
          button {
            width: 100%;
            box-sizing: border-box;
            padding: 10px;
            margin-top: 8px;
            border-radius: 8px;
            border: none;
          }

          button {
            cursor: pointer;
            font-weight: bold;
          }

          .danger {
            background: #7f1d1d;
            color: white;
          }

          .broadcast {
            margin-top: 25px;
            background: #1f2937;
            padding: 16px;
            border-radius: 12px;
          }

          @media (max-width: 700px) {
            table {
              font-size: 12px;
            }

            th,
            td {
              padding: 6px;
            }
          }
        </style>
      </head>

      <body>

        <h1>🔥 MONEY MAKING MACHINE - Admin</h1>

        <div class="grid">

          <div class="card">
            Uptime
            <div class="value">
              ${escapeHtml(
                process.uptime().toFixed(0)
              )}s
            </div>
          </div>

          <div class="card">
            Latest 5M Price
            <div class="value">
              ${formatPrice(
                market.latestPrice
              )}
            </div>
          </div>

          <div class="card">
            5M Candles
            <div class="value">
              ${
                market.candles["5min"].length
              }
            </div>
          </div>

          <div class="card">
            Subscribers
            <div class="value">
              ${subscribers.size}
            </div>
          </div>

          <div class="card">
            Signals
            <div class="value">
              ${signalsSent}
            </div>
          </div>

          <div class="card">
            Win Rate
            <div class="value">
              ${winRate}%
            </div>
          </div>

          <div class="card">
            Wins
            <div class="value">
              ${wins}
            </div>
          </div>

          <div class="card">
            Losses
            <div class="value">
              ${losses}
            </div>
          </div>

          <div class="card">
            Open Signals
            <div class="value">
              ${openSignals}
            </div>
          </div>

        </div>

        <div class="status">

          <h2>Top-Down Analysis</h2>

          <p>
            <b>4H Bias:</b>
            ${escapeHtml(td.bias4h)}
          </p>

          <p>
            <b>1H Confirmation:</b>
            ${escapeHtml(td.confirmation1h)}
          </p>

          <p>
            <b>15M Direction:</b>
            ${escapeHtml(td.direction)}
          </p>

          <p>
            <b>Liquidity:</b>
            ${
              td.liquidity
                ? "CONFIRMED"
                : "WAITING"
            }
          </p>

          <p>
            <b>BOS:</b>
            ${
              td.bos
                ? "CONFIRMED"
                : "WAITING"
            }
          </p>

          <p>
            <b>FVG:</b>
            ${
              td.fvg
                ? `${formatPrice(
                    td.fvg.bottom
                  )} - ${formatPrice(
                    td.fvg.top
                  )}`
                : "WAITING"
            }
          </p>

          <p>
            <b>Order Block:</b>
            ${
              td.orderBlock
                ? `${formatPrice(
                    td.orderBlock.bottom
                  )} - ${formatPrice(
                    td.orderBlock.top
                  )}`
                : "WAITING"
            }
          </p>

          <p>
            <b>Setup:</b>
            ${escapeHtml(setupStatus)}
          </p>

          <p>
            <b>Last 5M update:</b>
            ${escapeHtml(
              formatTime(
                market.lastUpdated["5min"]
              )
            )}
          </p>

          <p>
            <b>Last 15M update:</b>
            ${escapeHtml(
              formatTime(
                market.lastUpdated["15min"]
              )
            )}
          </p>

          <p>
            <b>Last 1H update:</b>
            ${escapeHtml(
              formatTime(
                market.lastUpdated["1h"]
              )
            )}
          </p>

          <p>
            <b>Last 4H update:</b>
            ${escapeHtml(
              formatTime(
                market.lastUpdated["4h"]
              )
            )}
          </p>

        </div>

        <h2>Recent Signals</h2>

        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Direction</th>
              <th>Entry</th>
              <th>SL</th>
              <th>TP</th>
              <th>Result</th>
            </tr>
          </thead>

          <tbody>
            ${rows || `
              <tr>
                <td colspan="7">
                  No signals yet.
                </td>
              </tr>
            `}
          </tbody>
        </table>

        <div class="broadcast">

          <h2>📢 Broadcast</h2>

          <form method="POST"
                action="/admin/broadcast">

            <textarea
              name="message"
              rows="5"
              placeholder="Enter broadcast message..."
              required
            ></textarea>

            <button type="submit">
              Send Broadcast
            </button>

          </form>

        </div>

        <div class="broadcast">

          <h2>Subscribers</h2>

          ${
            Array.from(
              subscribers.entries()
            )
              .map(
                ([chatId, user]) => `
                  <div style="
                    padding:10px;
                    border-bottom:1px solid #374151;
                  ">
                    <b>
                      ${escapeHtml(
                        user.firstName
                      )}
                    </b>

                    ${
                      user.username
                        ? `@${escapeHtml(
                            user.username
                          )}`
                        : ""
                    }

                    <form
                      method="POST"
                      action="/admin/remove"
                      style="margin-top:5px;"
                    >
                      <input
                        type="hidden"
                        name="chatId"
                        value="${escapeHtml(
                          chatId
                        )}"
                      >

                      <button
                        class="danger"
                        type="submit"
                      >
                        Remove
                      </button>
                    </form>
                  </div>
                `
              )
              .join("") ||
            "<p>No subscribers.</p>"
          }

        </div>

      </body>
      </html>
    `);
  }
);

/* =========================================================
   ADMIN REMOVE SUBSCRIBER
========================================================= */

app.post(
  "/admin/remove",
  adminAuth,
  (req, res) => {
    const chatId =
      String(
        req.body.chatId || ""
      );

    if (chatId) {
      subscribers.delete(
        Number(chatId)
      );
    }

    res.redirect(
      "/admin"
    );
  }
);

/* =========================================================
   ADMIN BROADCAST
========================================================= */

app.post(
  "/admin/broadcast",
  adminAuth,
  async (req, res) => {
    const message =
      String(
        req.body.message || ""
      ).trim();

    if (!message) {
      return res.redirect(
        "/admin"
      );
    }

    await broadcastText(
      `📢 <b>ADMIN BROADCAST</b>\n\n${escapeHtml(
        message
      )}`
    );

    res.redirect(
      "/admin"
    );
  }
);

/* =========================================================
   TELEGRAM WEBHOOK CONFIGURATION
========================================================= */

async function configureTelegramWebhook() {
  if (!PUBLIC_URL) {
    console.error(
      "❌ PUBLIC_URL / RENDER_EXTERNAL_URL is missing."
    );

    console.error(
      "Telegram webhook cannot be configured."
    );

    return;
  }

  const webhookUrl =
    `${PUBLIC_URL}/telegram/webhook`;

  try {
    const payload = {
      url: webhookUrl,

      allowed_updates: [
        "message"
      ]
    };

    if (
      TELEGRAM_WEBHOOK_SECRET
    ) {
      payload.secret_token =
        TELEGRAM_WEBHOOK_SECRET;
    }

    const response =
      await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
        payload,
        {
          timeout: 15000
        }
      );

    if (!response.data?.ok) {
      throw new Error(
        response.data?.description ||
        "Telegram rejected webhook"
      );
    }

    console.log(
      "✅ Telegram webhook configured:"
    );

    console.log(
      webhookUrl
    );

    /*
       Verify webhook.
    */

    const info =
      await axios.get(
        `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`,
        {
          timeout: 10000
        }
      );

    if (
      info.data?.ok
    ) {
      console.log(
        "🔗 Telegram webhook URL:",
        info.data.result.url
      );

      if (
        info.data.result.last_error_message
      ) {
        console.log(
          "⚠️ Telegram webhook last error:",
          info.data.result
            .last_error_message
        );
      }
    }

  } catch (error) {
    console.error(
      "❌ Failed to configure Telegram webhook:",
      error.response?.data ||
      error.message
    );
  }
}

/* =========================================================
   INITIAL MARKET DATA
========================================================= */

async function initializeMarket() {
  console.log(
    "📊 Loading initial XAUUSD market data..."
  );

  /*
     Four initial requests:
       5M
       15M
       1H
       4H

     Then each timeframe updates on its
     own schedule.
  */

  await updateMarket(
    "5min",
    true
  );

  await updateMarket(
    "15min",
    true
  );

  await updateMarket(
    "1h",
    true
  );

  await updateMarket(
    "4h",
    true
  );

  calculateTopDown();

  market.initialized =
    Boolean(
      market.candles["5min"].length &&
      market.candles["15min"].length &&
      market.candles["1h"].length &&
      market.candles["4h"].length
    );

  console.log(
    "===================================="
  );

  console.log(
    `📊 5M candles: ${
      market.candles["5min"].length
    }`
  );

  console.log(
    `📊 15M candles: ${
      market.candles["15min"].length
    }`
  );

  console.log(
    `📊 1H candles: ${
      market.candles["1h"].length
    }`
  );

  console.log(
    `📊 4H candles: ${
      market.candles["4h"].length
    }`
  );

  console.log(
    `💰 Latest price: ${
      formatPrice(
        market.latestPrice
      )
    }`
  );

  console.log(
    `📈 4H bias: ${
      market.topDown.bias4h
    }`
  );

  console.log(
    `📈 1H confirmation: ${
      market.topDown.confirmation1h
    }`
  );

  console.log(
    `📈 15M direction: ${
      market.topDown.direction
    }`
  );

  console.log(
    "===================================="
  );
}

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log(
      "🔥 Starting MONEY MAKING MACHINE BOT..."
    );

    console.log(
      `🔥 MONEY MAKING MACHINE BOT running on port ${PORT}`
    );

    console.log(
      "🌐 Telegram mode: WEBHOOK"
    );

    console.log(
      "🚫 Telegram polling: DISABLED"
    );

    console.log(
      "📊 Strategy: 4H → 1H → 15M → 5M"
    );

    console.log(
      "💧 15M Liquidity + BOS"
    );

    console.log(
      "🟦 15M FVG + OB"
    );

    console.log(
      "🎯 5M Entry Confirmation"
    );

    /*
       Configure webhook first.
    */

    await configureTelegramWebhook();

    /*
       Load historical market data.
    */

    await initializeMarket();

    /*
       5M updates every 5 minutes.
    */

    scheduleAligned(
      "5min",
      FIVE_MIN_MS,
      async () => {
        await updateMarket(
          "5min",
          false
        );
      }
    );

    /*
       15M updates every 15 minutes.
    */

    scheduleAligned(
      "15min",
      FIFTEEN_MIN_MS,
      async () => {
        await updateMarket(
          "15min",
          false
        );
      }
    );

    /*
       1H updates every hour.
    */

    scheduleAligned(
      "1h",
      ONE_HOUR_MS,
      async () => {
        await updateMarket(
          "1h",
          false
        );
      }
    );

    /*
       4H updates every 4 hours.
    */

    scheduleAligned(
      "4h",
      FOUR_HOUR_MS,
      async () => {
        await updateMarket(
          "4h",
          false
        );
      }
    );

    console.log(
      "⏱️ Market-data schedulers started."
    );

    console.log(
      "🚀 BOT READY."
    );
  }
);

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

process.on(
  "SIGTERM",
  () => {
    console.log(
      "SIGTERM received. Shutting down..."
    );

    /*
       We deliberately DO NOT delete the Telegram
       webhook here. Render can restart the service,
       and the webhook URL remains configured.
    */

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {
    console.log(
      "SIGINT received. Shutting down..."
    );

    process.exit(0);
  }
);
