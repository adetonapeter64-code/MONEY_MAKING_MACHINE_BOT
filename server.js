const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL;

const WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || "";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "changeme123";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

if (!TWELVE_DATA_API_KEY) {
  console.error("TWELVE_DATA_API_KEY is missing");
  process.exit(1);
}

if (!PUBLIC_URL) {
  console.error(
    "PUBLIC_URL / RENDER_EXTERNAL_URL is missing"
  );
  process.exit(1);
}


/* =========================================================
   TELEGRAM
   ========================================================= */

// IMPORTANT:
// We deliberately DO NOT use polling.
// Webhook mode prevents the 409:
// "terminated by other getUpdates request"

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false
});

const WEBHOOK_PATH = "/telegram/webhook";


/* =========================================================
   EXPRESS
   ========================================================= */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


/* =========================================================
   BASIC BOT MENU
   ========================================================= */

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


/* =========================================================
   SUBSCRIBERS
   ========================================================= */

const subscribers = new Map();


/* =========================================================
   SIGNAL HISTORY
   ========================================================= */

const signalHistory = [];

const MAX_SIGNAL_HISTORY = 100;


/* =========================================================
   MARKET DATA
   ========================================================= */

const SYMBOL = "XAU/USD";

const BASE_INTERVAL = "5min";

// 400 x 5-minute candles = about 33 hours.
// Enough to build:
// 4H
// 1H
// 15M
// 5M
const HISTORY_SIZE = 400;

let candles5m = [];

let lastMarketUpdate = 0;
let lastMarketPrice = null;

let marketBusy = false;


/* =========================================================
   STRATEGY SETTINGS
   ========================================================= */

const SWING_LOOKBACK = 2;

const SETUP_EXPIRY_MS =
  3 * 60 * 60 * 1000;

const SIGNAL_COOLDOWN_MS =
  30 * 60 * 1000;

const SIGNAL_MAX_HOLD_MS =
  12 * 60 * 60 * 1000;

const PIP_SIZE = 0.10;

// Original bot target range.
// We use the midpoint = 250 pips = $25.
const TP_PIPS_MIN = 200;
const TP_PIPS_MAX = 300;

const TP_PIPS =
  (TP_PIPS_MIN + TP_PIPS_MAX) / 2;

const TP_DISTANCE =
  TP_PIPS * PIP_SIZE;

// Small XAUUSD protection buffer.
const SL_BUFFER = 1.0;


/* =========================================================
   TOP-DOWN STATE
   ========================================================= */

let pendingSetup = null;

let lastSignalTime = 0;


/*
pendingSetup:

{
  direction: "bullish" | "bearish",

  label: "BOS" | "CHoCH",

  createdAt,

  liquiditySweep,

  bos,

  fvg,

  orderBlock,

  entryZoneTop,

  entryZoneBottom,

  structureLow,

  structureHigh
}
*/


/* =========================================================
   TELEGRAM WEBHOOK
   ========================================================= */

app.post(WEBHOOK_PATH, (req, res) => {

  try {

    if (WEBHOOK_SECRET) {

      const incomingSecret =
        req.headers["x-telegram-bot-api-secret-token"];

      if (incomingSecret !== WEBHOOK_SECRET) {
        return res.sendStatus(403);
      }

    }

    bot.processUpdate(req.body);

    res.sendStatus(200);

  } catch (error) {

    console.error(
      "Webhook processing error:",
      error.message
    );

    res.sendStatus(500);
  }

});


/* =========================================================
   HEALTH
   ========================================================= */

app.get("/", (req, res) => {

  res.json({
    status: "online",
    bot: "MONEY MAKING MACHINE BOT",
    strategy: "4H → 1H → 15M → 5M",
    market: SYMBOL,
    candles5m: candles5m.length,
    pendingSetup: !!pendingSetup,
    signals: signalHistory.length
  });

});


app.get("/health", (req, res) => {

  res.json({
    ok: true,
    marketData: lastMarketPrice !== null,
    candles5m: candles5m.length,
    lastMarketUpdate:
      lastMarketUpdate
        ? new Date(lastMarketUpdate).toISOString()
        : null
  });

});


/* =========================================================
   ADMIN AUTH
   ========================================================= */

function requireAdminAuth(req, res, next) {

  const authHeader =
    req.headers.authorization;

  if (
    !authHeader ||
    !authHeader.startsWith("Basic ")
  ) {

    res.set(
      "WWW-Authenticate",
      'Basic realm="Admin Panel"'
    );

    return res
      .status(401)
      .send("Authentication required.");
  }

  const decoded =
    Buffer.from(
      authHeader.split(" ")[1],
      "base64"
    ).toString();

  const separator =
    decoded.indexOf(":");

  const user =
    separator >= 0
      ? decoded.slice(0, separator)
      : decoded;

  const pass =
    separator >= 0
      ? decoded.slice(separator + 1)
      : "";

  if (
    user === ADMIN_USER &&
    pass === ADMIN_PASSWORD
  ) {
    return next();
  }

  res.set(
    "WWW-Authenticate",
    'Basic realm="Admin Panel"'
  );

  return res
    .status(401)
    .send("Invalid credentials.");
}


/* =========================================================
   HTML ESCAPE
   ========================================================= */

function escapeHtml(str) {

  if (
    str === null ||
    str === undefined
  ) {
    return "";
  }

  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


/* =========================================================
   ADMIN PANEL
   ========================================================= */

app.get(
  "/admin",
  requireAdminAuth,
  (req, res) => {

    const wins =
      signalHistory.filter(
        s => s.status === "win"
      ).length;

    const losses =
      signalHistory.filter(
        s => s.status === "loss"
      ).length;

    const open =
      signalHistory.filter(
        s => s.status === "open"
      ).length;

    const decided =
      wins + losses;

    const winRate =
      decided > 0
        ? ((wins / decided) * 100).toFixed(1)
        : "—";


    const setupStatus =
      pendingSetup
        ? `
          ${pendingSetup.direction.toUpperCase()}
          ${pendingSetup.label}
          — waiting for 5M entry confirmation
        `
        : "No active setup.";


    const subscriberRows =
      [...subscribers.entries()]
        .map(([chatId, info]) => {

          return `
            <tr>
              <td>
                ${escapeHtml(info.firstName)}
                ${
                  info.username
                    ? " @" +
                      escapeHtml(info.username)
                    : ""
                }
              </td>

              <td>${chatId}</td>

              <td>
                ${new Date(
                  info.joinedAt
                ).toLocaleString()}
              </td>

              <td>

                <form
                  method="POST"
                  action="/admin/remove"
                >

                  <input
                    type="hidden"
                    name="chatId"
                    value="${chatId}"
                  >

                  <button class="danger">
                    Remove
                  </button>

                </form>

              </td>
            </tr>
          `;

        })
        .join("");


    const signalRows =
      signalHistory
        .slice(0, 30)
        .map(s => {

          const result =
            s.status === "win"
              ? "✅ Win"
              : s.status === "loss"
                ? "❌ Loss"
                : "⏳ Open";

          return `
            <tr>

              <td>
                ${new Date(
                  s.time
                ).toLocaleString()}
              </td>

              <td>
                ${escapeHtml(s.label)}
              </td>

              <td>
                ${s.direction}
              </td>

              <td>
                ${s.entryPrice.toFixed(2)}
              </td>

              <td>
                ${s.stopLoss.toFixed(2)}
              </td>

              <td>
                ${s.takeProfit.toFixed(2)}
              </td>

              <td>
                ${result}
              </td>

            </tr>
          `;

        })
        .join("");


    res.send(`

<!DOCTYPE html>

<html>

<head>

<meta name="viewport"
content="width=device-width, initial-scale=1">

<title>
Money Making Machine
</title>

<style>

body {
  font-family: Arial, sans-serif;
  background:#0f1115;
  color:#eee;
  padding:16px;
}

.card {
  background:#1b1f27;
  padding:15px;
  margin:8px 0;
  border-radius:10px;
}

table {
  width:100%;
  border-collapse:collapse;
  font-size:13px;
}

th, td {
  padding:8px;
  border-bottom:1px solid #333;
  text-align:left;
}

.scroll {
  overflow-x:auto;
}

button {
  background:#2878e8;
  color:white;
  border:0;
  padding:8px 12px;
  border-radius:6px;
}

.danger {
  background:#c0392b;
}

textarea {
  width:100%;
  box-sizing:border-box;
  background:#181b22;
  color:white;
  border:1px solid #333;
  padding:10px;
}

</style>

</head>

<body>

<h2>
🔥 MONEY MAKING MACHINE
</h2>

<div class="card">
<b>Market:</b> ${SYMBOL}
</div>

<div class="card">
<b>Price:</b>
${
  lastMarketPrice !== null
    ? lastMarketPrice.toFixed(2)
    : "—"
}
</div>

<div class="card">
<b>5M candles:</b>
${candles5m.length}
</div>

<div class="card">
<b>Subscribers:</b>
${subscribers.size}
</div>

<div class="card">
<b>Signals:</b>
${signalHistory.length}
</div>

<div class="card">
<b>Wins:</b> ${wins}
<br>
<b>Losses:</b> ${losses}
<br>
<b>Open:</b> ${open}
<br>
<b>Win rate:</b>
${winRate}${decided ? "%" : ""}
</div>

<div class="card">

<b>Top-down setup:</b>

<br><br>

${escapeHtml(setupStatus)}

</div>


<h3>
Broadcast
</h3>

<form
method="POST"
action="/admin/broadcast"
>

<textarea
name="message"
rows="4"
placeholder="Message..."
></textarea>

<br><br>

<button>
Send Broadcast
</button>

</form>


<h3>
Subscribers
</h3>

<div class="scroll">

<table>

<tr>
<th>Name</th>
<th>ID</th>
<th>Joined</th>
<th></th>
</tr>

${subscriberRows}

</table>

</div>


<h3>
Recent Signals
</h3>

<div class="scroll">

<table>

<tr>
<th>Time</th>
<th>Type</th>
<th>Direction</th>
<th>Entry</th>
<th>SL</th>
<th>TP</th>
<th>Result</th>
</tr>

${signalRows}

</table>

</div>

</body>

</html>

`);

  }
);


/* =========================================================
   ADMIN REMOVE
   ========================================================= */

app.post(
  "/admin/remove",
  requireAdminAuth,
  (req, res) => {

    const chatId =
      Number(req.body.chatId);

    subscribers.delete(chatId);

    res.redirect("/admin");
  }
);


/* =========================================================
   ADMIN BROADCAST
   ========================================================= */

app.post(
  "/admin/broadcast",
  requireAdminAuth,
  async (req, res) => {

    const text =
      String(
        req.body.message || ""
      ).trim();

    if (text) {

      for (
        const chatId of subscribers.keys()
      ) {

        try {

          await bot.sendMessage(
            chatId,
            `📢 ${text}`
          );

        } catch (error) {

          console.error(
            `Broadcast failed for ${chatId}:`,
            error.message
          );

        }

      }

    }

    res.redirect("/admin");
  }
);


/* =========================================================
   TIME HELPERS
   ========================================================= */

function timestampMs(datetime) {

  // Twelve Data forex timestamps are UTC
  // when timezone=UTC is requested.

  return new Date(
    datetime.replace(" ", "T") + "Z"
  ).getTime();

}


function floorTimestamp(
  timestamp,
  minutes
) {

  const size =
    minutes * 60 * 1000;

  return (
    Math.floor(timestamp / size) *
    size
  );

}


/* =========================================================
   TWELVE DATA
   ========================================================= */

async function fetch5mHistory() {

  if (marketBusy) {
    return;
  }

  marketBusy = true;

  try {

    const response =
      await axios.get(
        "https://api.twelvedata.com/time_series",
        {
          timeout: 15000,

          params: {
            symbol: SYMBOL,
            interval: BASE_INTERVAL,
            outputsize: HISTORY_SIZE,
            timezone: "UTC",
            order: "ASC",
            apikey: TWELVE_DATA_API_KEY
          }
        }
      );


    const data =
      response.data;


    if (
      data.status === "error"
    ) {

      throw new Error(
        data.message ||
        "Twelve Data returned an error."
      );

    }


    if (
      !Array.isArray(data.values) ||
      data.values.length === 0
    ) {

      throw new Error(
        "No 5M candles returned."
      );

    }


    const now =
      Date.now();


    const parsed =
      data.values
        .map(row => {

          const time =
            timestampMs(
              row.datetime
            );

          return {

            time,

            open:
              Number(row.open),

            high:
              Number(row.high),

            low:
              Number(row.low),

            close:
              Number(row.close)

          };

        })
        .filter(c => {

          if (
            !Number.isFinite(c.open) ||
            !Number.isFinite(c.high) ||
            !Number.isFinite(c.low) ||
            !Number.isFinite(c.close)
          ) {
            return false;
          }

          // Only CLOSED 5M candles.
          return (
            c.time + 5 * 60 * 1000
            <= now
          );

        })
        .sort(
          (a, b) =>
            a.time - b.time
        );


    if (parsed.length < 100) {

      throw new Error(
        `Only ${parsed.length} closed 5M candles available.`
      );

    }


    candles5m = dedupeCandles(
      parsed
    ).slice(-HISTORY_SIZE);


    lastMarketPrice =
      candles5m[
        candles5m.length - 1
      ].close;

    lastMarketUpdate =
      Date.now();


    console.log(
      `[MARKET] ${SYMBOL} ${lastMarketPrice.toFixed(2)} | 5M candles: ${candles5m.length}`
    );


    runStrategy();


    updateOpenSignalsFromLatestCandle();


  } catch (error) {

    if (
      error.response?.status === 429
    ) {

      console.error(
        "[MARKET] Twelve Data 429 - quota/rate limit."
      );

    } else {

      console.error(
        "[MARKET ERROR]",
        error.response?.data ||
        error.message
      );

    }

  } finally {

    marketBusy = false;

  }

}


function dedupeCandles(
  candles
) {

  const map = new Map();

  for (
    const candle of candles
  ) {
    map.set(
      candle.time,
      candle
    );
  }

  return [
    ...map.values()
  ].sort(
    (a, b) =>
      a.time - b.time
  );

}


/* =========================================================
   AGGREGATE 5M → 15M / 1H / 4H
   ========================================================= */

function aggregateCandles(
  source,
  minutes
) {

  const groups = new Map();

  for (
    const c of source
  ) {

    const bucket =
      floorTimestamp(
        c.time,
        minutes
      );

    if (
      !groups.has(bucket)
    ) {

      groups.set(
        bucket,
        {
          time: bucket,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          count: 1
        }
      );

    } else {

      const g =
        groups.get(bucket);

      g.high =
        Math.max(
          g.high,
          c.high
        );

      g.low =
        Math.min(
          g.low,
          c.low
        );

      g.close =
        c.close;

      g.count++;

    }

  }


  const expected =
    minutes / 5;


  return [
    ...groups.values()
  ]
    .filter(
      g =>
        g.count === expected
    )
    .map(
      g => ({
        time: g.time,
        open: g.open,
        high: g.high,
        low: g.low,
        close: g.close
      })
    )
    .sort(
      (a, b) =>
        a.time - b.time
    );

}


/* =========================================================
   SWINGS
   ========================================================= */

function findSwings(
  candles,
  lookback = 2
) {

  const highs = [];
  const lows = [];

  for (
    let i = lookback;
    i <
      candles.length -
      lookback;
    i++
  ) {

    const current =
      candles[i];

    let isHigh = true;
    let isLow = true;


    for (
      let j = 1;
      j <= lookback;
      j++
    ) {

      if (
        candles[i - j].high >
        current.high ||
        candles[i + j].high >
        current.high
      ) {
        isHigh = false;
      }


      if (
        candles[i - j].low <
        current.low ||
        candles[i + j].low <
        current.low
      ) {
        isLow = false;
      }

    }


    if (isHigh) {

      highs.push({
        index: i,
        price: current.high,
        time: current.time
      });

    }


    if (isLow) {

      lows.push({
        index: i,
        price: current.low,
        time: current.time
      });

    }

  }


  return {
    highs,
    lows
  };

}


/* =========================================================
   STRUCTURE
   ========================================================= */

function getStructure(
  candles
) {

  const {
    highs,
    lows
  } =
    findSwings(
      candles,
      SWING_LOOKBACK
    );


  if (
    highs.length < 2 ||
    lows.length < 2
  ) {

    return {
      bias: "neutral",
      highs,
      lows
    };

  }


  const lastHigh =
    highs[highs.length - 1];

  const prevHigh =
    highs[highs.length - 2];

  const lastLow =
    lows[lows.length - 1];

  const prevLow =
    lows[lows.length - 2];


  const bullish =
    lastHigh.price >
      prevHigh.price &&
    lastLow.price >
      prevLow.price;


  const bearish =
    lastHigh.price <
      prevHigh.price &&
    lastLow.price <
      prevLow.price;


  return {

    bias:
      bullish
        ? "bullish"
        : bearish
          ? "bearish"
          : "neutral",

    highs,
    lows,

    lastHigh,
    prevHigh,

    lastLow,
    prevLow

  };

}


/* =========================================================
   FVG
   ========================================================= */

function findRecentFVG(
  candles,
  direction,
  endIndex
) {

  const start =
    Math.max(
      2,
      endIndex - 8
    );


  for (
    let i = endIndex;
    i >= start;
    i--
  ) {

    const c1 =
      candles[i - 2];

    const c3 =
      candles[i];


    if (
      direction === "bullish" &&
      c1.high < c3.low
    ) {

      return {

        top: c3.low,

        bottom: c1.high,

        index: i,

        time: c3.time

      };

    }


    if (
      direction === "bearish" &&
      c1.low > c3.high
    ) {

      return {

        top: c1.low,

        bottom: c3.high,

        index: i,

        time: c3.time

      };

    }

  }


  return null;

}


/* =========================================================
   ORDER BLOCK
   ========================================================= */

function findOrderBlock(
  candles,
  breakIndex,
  direction
) {

  const start =
    Math.max(
      0,
      breakIndex - 8
    );


  for (
    let i = breakIndex - 1;
    i >= start;
    i--
  ) {

    const c =
      candles[i];


    const bearish =
      c.close < c.open;

    const bullish =
      c.close > c.open;


    if (
      direction === "bullish" &&
      bearish
    ) {

      return {

        top: c.high,

        bottom: c.low,

        index: i,

        time: c.time

      };

    }


    if (
      direction === "bearish" &&
      bullish
    ) {

      return {

        top: c.high,

        bottom: c.low,

        index: i,

        time: c.time

      };

    }

  }


  return null;

}


/* =========================================================
   15M LIQUIDITY SWEEP
   ========================================================= */

function detectLiquiditySweep(
  candles15,
  direction
) {

  if (
    candles15.length < 10
  ) {
    return null;
  }


  const currentIndex =
    candles15.length - 1;

  const current =
    candles15[currentIndex];


  const {
    highs,
    lows
  } =
    findSwings(
      candles15,
      SWING_LOOKBACK
    );


  if (
    direction === "bullish"
  ) {

    const previousLows =
      lows.filter(
        s =>
          s.index <
          currentIndex
      );


    if (
      previousLows.length === 0
    ) {
      return null;
    }


    const liquidity =
      previousLows[
        previousLows.length - 1
      ];


    const swept =
      current.low <
      liquidity.price;


    const reclaimed =
      current.close >
      liquidity.price;


    if (
      swept &&
      reclaimed
    ) {

      return {

        type: "bullish",

        level:
          liquidity.price,

        candleIndex:
          currentIndex,

        time:
          current.time

      };

    }

  }


  if (
    direction === "bearish"
  ) {

    const previousHighs =
      highs.filter(
        s =>
          s.index <
          currentIndex
      );


    if (
      previousHighs.length === 0
    ) {
      return null;
    }


    const liquidity =
      previousHighs[
        previousHighs.length - 1
      ];


    const swept =
      current.high >
      liquidity.price;


    const rejected =
      current.close <
      liquidity.price;


    if (
      swept &&
      rejected
    ) {

      return {

        type: "bearish",

        level:
          liquidity.price,

        candleIndex:
          currentIndex,

        time:
          current.time

      };

    }

  }


  return null;

}


/* =========================================================
   15M BOS AFTER LIQUIDITY SWEEP
   ========================================================= */

function findBOSAfterSweep(
  candles15,
  sweep,
  direction
) {

  const start =
    sweep.candleIndex + 1;


  if (
    start >= candles15.length
  ) {
    return null;
  }


  const structure =
    getStructure(
      candles15
    );


  if (
    !structure.lastHigh ||
    !structure.lastLow
  ) {

    return null;

  }


  const reference =
    direction === "bullish"
      ? structure.lastHigh.price
      : structure.lastLow.price;


  for (
    let i = start;
    i < candles15.length;
    i++
  ) {

    const c =
      candles15[i];


    if (
      direction === "bullish" &&
      c.close > reference
    ) {

      return {

        direction,

        index: i,

        level: reference,

        time: c.time

      };

    }


    if (
      direction === "bearish" &&
      c.close < reference
    ) {

      return {

        direction,

        index: i,

        level: reference,

        time: c.time

      };

    }

  }


  return null;

}


/* =========================================================
   BUILD PENDING SETUP
   ========================================================= */

function buildSetup(
  candles15,
  candles1h,
  candles4h
) {

  if (pendingSetup) {

    if (
      Date.now() -
        pendingSetup.createdAt >
      SETUP_EXPIRY_MS
    ) {

      console.log(
        "[SETUP] Expired."
      );

      pendingSetup = null;

    } else {

      return;

    }

  }


  const structure4h =
    getStructure(
      candles4h
    );


  const structure1h =
    getStructure(
      candles1h
    );


  /*
   4H = directional bias
   1H = confirmation
  */

  if (
    structure4h.bias === "neutral" ||
    structure1h.bias === "neutral"
  ) {

    return;

  }


  if (
    structure4h.bias !==
    structure1h.bias
  ) {

    return;

  }


  const direction =
    structure4h.bias;


  /*
   15M liquidity sweep
  */

  const sweep =
    detectLiquiditySweep(
      candles15,
      direction
    );


  if (!sweep) {

    return;

  }


  /*
   15M BOS after sweep
  */

  const bos =
    findBOSAfterSweep(
      candles15,
      sweep,
      direction
    );


  if (!bos) {

    return;

  }


  /*
   15M FVG
  */

  const fvg =
    findRecentFVG(
      candles15,
      direction,
      bos.index
    );


  if (!fvg) {

    return;

  }


  /*
   15M Order Block
  */

  const orderBlock =
    findOrderBlock(
      candles15,
      bos.index,
      direction
    );


  /*
   Prefer OB when available.
   Otherwise use FVG.
  */

  const zoneTop =
    orderBlock
      ? orderBlock.top
      : fvg.top;

  const zoneBottom =
    orderBlock
      ? orderBlock.bottom
      : fvg.bottom;


  const structure =
    getStructure(
      candles15
    );


  pendingSetup = {

    direction,

    label:
      structure4h.bias ===
        structure1h.bias
        ? "BOS"
        : "CHoCH",

    createdAt:
      Date.now(),

    liquiditySweep:
      sweep,

    bos,

    fvg,

    orderBlock,

    entryZoneTop:
      zoneTop,

    entryZoneBottom:
      zoneBottom,

    structureLow:
      structure.lastLow
        ? structure.lastLow.price
        : null,

    structureHigh:
      structure.lastHigh
        ? structure.lastHigh.price
        : null

  };


  console.log(
    `[SETUP] ${direction.toUpperCase()} ${pendingSetup.label} | 4H=${structure4h.bias} | 1H=${structure1h.bias} | 15M liquidity+BOS+FVG+OB`
  );

}


/* =========================================================
   5M ENTRY CONFIRMATION
   ========================================================= */

function check5mEntry() {

  if (!pendingSetup) {
    return;
  }


  const c =
    candles5m[
      candles5m.length - 1
    ];


  if (!c) {
    return;
  }


  if (
    Date.now() -
      pendingSetup.createdAt >
    SETUP_EXPIRY_MS
  ) {

    pendingSetup = null;

    return;

  }


  const insideZone =
    c.low <=
      pendingSetup.entryZoneTop &&
    c.high >=
      pendingSetup.entryZoneBottom;


  if (!insideZone) {

    return;

  }


  const bullishConfirmation =
    pendingSetup.direction ===
      "bullish" &&
    c.close > c.open;


  const bearishConfirmation =
    pendingSetup.direction ===
      "bearish" &&
    c.close < c.open;


  if (
    !bullishConfirmation &&
    !bearishConfirmation
  ) {

    return;

  }


  fireSignal(
    pendingSetup,
    c.close
  );


  pendingSetup = null;

}


/* =========================================================
   MAIN TOP-DOWN ENGINE
   ========================================================= */

function runStrategy() {

  if (
    candles5m.length < 100
  ) {

    console.log(
      `[STRATEGY] Building history: ${candles5m.length}/100`
    );

    return;

  }


  if (
    hasOpenSignal()
  ) {

    return;

  }


  const candles15 =
    aggregateCandles(
      candles5m,
      15
    );


  const candles1h =
    aggregateCandles(
      candles5m,
      60
    );


  const candles4h =
    aggregateCandles(
      candles5m,
      240
    );


  if (
    candles15.length < 30 ||
    candles1h.length < 20 ||
    candles4h.length < 10
  ) {

    return;

  }


  /*
   4H:
   overall direction
  */

  const structure4h =
    getStructure(
      candles4h
    );


  /*
   1H:
   confirmation
  */

  const structure1h =
    getStructure(
      candles1h
    );


  console.log(
    `[TOP-DOWN] 4H=${structure4h.bias} | 1H=${structure1h.bias}`
  );


  /*
   Only continue when both agree.
  */

  if (
    structure4h.bias === "neutral" ||
    structure1h.bias === "neutral" ||
    structure4h.bias !==
      structure1h.bias
  ) {

    return;

  }


  /*
   15M liquidity + BOS + FVG + OB
  */

  buildSetup(
    candles15,
    candles1h,
    candles4h
  );


  /*
   5M entry
  */

  check5mEntry();

}


/* =========================================================
   OPEN SIGNAL
   ========================================================= */

function hasOpenSignal() {

  return signalHistory.some(
    s =>
      s.status === "open"
  );

}


/* =========================================================
   FIRE SIGNAL
   ========================================================= */

async function fireSignal(
  setup,
  entryPrice
) {

  if (
    Date.now() -
      lastSignalTime <
    SIGNAL_COOLDOWN_MS
  ) {

    console.log(
      "[SIGNAL] Cooldown active."
    );

    return;

  }


  if (
    hasOpenSignal()
  ) {

    return;

  }


  const direction =
    setup.direction === "bullish"
      ? "BUY"
      : "SELL";


  const emoji =
    direction === "BUY"
      ? "🟢"
      : "🔴";


  let stopLoss;
  let takeProfit;


  if (
    setup.direction ===
    "bullish"
  ) {

    stopLoss =
      (
        setup.orderBlock
          ? setup.orderBlock.bottom
          : setup.structureLow
      ) - SL_BUFFER;

    takeProfit =
      entryPrice +
      TP_DISTANCE;

  } else {

    stopLoss =
      (
        setup.orderBlock
          ? setup.orderBlock.top
          : setup.structureHigh
      ) + SL_BUFFER;

    takeProfit =
      entryPrice -
      TP_DISTANCE;

  }


  /*
   Safety validation.
  */

  if (
    !Number.isFinite(stopLoss) ||
    !Number.isFinite(takeProfit)
  ) {

    console.error(
      "[SIGNAL] Invalid SL/TP."
    );

    return;

  }


  if (
    direction === "BUY" &&
    stopLoss >= entryPrice
  ) {

    console.log(
      "[SIGNAL] Invalid BUY stop."
    );

    return;

  }


  if (
    direction === "SELL" &&
    stopLoss <= entryPrice
  ) {

    console.log(
      "[SIGNAL] Invalid SELL stop."
    );

    return;

  }


  const signal = {

    id:
      `${Date.now()}-${Math.floor(Math.random() * 10000)}`,

    time:
      Date.now(),

    label:
      setup.label,

    direction,

    entryPrice,

    stopLoss,

    takeProfit,

    status:
      "open",

    closedAt:
      null,

    closePrice:
      null

  };


  signalHistory.unshift(
    signal
  );


  if (
    signalHistory.length >
    MAX_SIGNAL_HISTORY
  ) {

    signalHistory.pop();

  }


  lastSignalTime =
    Date.now();


  const message =

`🚨 XAUUSD TOP-DOWN SIGNAL

${emoji} ${direction}
Entry: ${entryPrice.toFixed(2)}

🛡️ SL: ${stopLoss.toFixed(2)}
🎯 TP: ${takeProfit.toFixed(2)}

📊 TOP-DOWN CONFIRMATION

4H → Overall bias
1H → Trend confirmation
15M → Liquidity sweep
15M → BOS
15M → FVG
15M → Order Block
5M → Entry confirmation

📏 Target:
${TP_PIPS_MIN}-${TP_PIPS_MAX} pips

⚠️ Risk management is your responsibility.`;


  console.log(
    `[SIGNAL FIRED] ${direction} @ ${entryPrice.toFixed(2)} | SL ${stopLoss.toFixed(2)} | TP ${takeProfit.toFixed(2)}`
  );


  await broadcast(
    message
  );

}


/* =========================================================
   BROADCAST
   ========================================================= */

async function broadcast(
  message
) {

  for (
    const chatId of subscribers.keys()
  ) {

    try {

      await bot.sendMessage(
        chatId,
        message
      );

    } catch (error) {

      console.error(
        `Telegram send failed for ${chatId}:`,
        error.message
      );

    }

  }

}


/* =========================================================
   OPEN SIGNAL TRACKER
   ========================================================= */

function updateOpenSignalsFromLatestCandle() {

  if (
    candles5m.length === 0
  ) {

    return;

  }


  const candle =
    candles5m[
      candles5m.length - 1
    ];


  const openSignals =
    signalHistory.filter(
      s =>
        s.status === "open"
    );


  for (
    const signal of openSignals
  ) {

    let hitSL = false;
    let hitTP = false;


    if (
      signal.direction ===
      "BUY"
    ) {

      hitSL =
        candle.low <=
        signal.stopLoss;

      hitTP =
        candle.high >=
        signal.takeProfit;

    } else {

      hitSL =
        candle.high >=
        signal.stopLoss;

      hitTP =
        candle.low <=
        signal.takeProfit;

    }


    /*
     If the same candle touches both,
     conservatively count SL first.
    */

    if (hitSL) {

      closeSignal(
        signal,
        "loss",
        signal.stopLoss
      );

      continue;

    }


    if (hitTP) {

      closeSignal(
        signal,
        "win",
        signal.takeProfit
      );

      continue;

    }


    /*
     Maximum holding period.
    */

    if (
      Date.now() -
        signal.time >
      SIGNAL_MAX_HOLD_MS
    ) {

      signal.status =
        "expired";

      signal.closedAt =
        Date.now();

      signal.closePrice =
        candle.close;


      console.log(
        `[SIGNAL EXPIRED] ${signal.direction}`
      );

    }

  }

}


/* =========================================================
   CLOSE SIGNAL
   ========================================================= */

async function closeSignal(
  signal,
  result,
  closePrice
) {

  signal.status =
    result;

  signal.closedAt =
    Date.now();

  signal.closePrice =
    closePrice;


  lastSignalTime =
    Date.now();


  const message =

result === "win"

? `

✅ XAUUSD SIGNAL CLOSED

🎯 TAKE PROFIT HIT

${signal.direction}
Entry: ${signal.entryPrice.toFixed(2)}
Closed: ${closePrice.toFixed(2)}

`

: `

❌ XAUUSD SIGNAL CLOSED

🛡️ STOP LOSS HIT

${signal.direction}
Entry: ${signal.entryPrice.toFixed(2)}
Closed: ${closePrice.toFixed(2)}

`;


  console.log(
    `[SIGNAL CLOSED] ${signal.direction} -> ${result.toUpperCase()} @ ${closePrice.toFixed(2)}`
  );


  await broadcast(
    message
  );

}


/* =========================================================
   /START
   ========================================================= */

bot.onText(
  /\/start/,
  async msg => {

    await bot.sendMessage(
      msg.chat.id,

`🔥 MONEY MAKING MACHINE BOT

Welcome 👋

This version uses:

4H → Overall bias
1H → Confirmation
15M → Liquidity + BOS
15M → FVG + OB
5M → Entry confirmation

The bot waits for the complete top-down setup instead of trading every small 5M breakout.`,

      mainMenu
    );

  }
);


/* =========================================================
   MESSAGE HANDLER
   ========================================================= */

bot.on(
  "message",
  async msg => {

    if (!msg.text) {
      return;
    }


    const chatId =
      msg.chat.id;


    /*
     XAUUSD SIGNAL
    */

    if (
      msg.text ===
      "📊 XAUUSD Signal"
    ) {

      const status =
        pendingSetup

          ? `
👀 Active setup:

${pendingSetup.direction.toUpperCase()}
${pendingSetup.label}

Waiting for 5M entry confirmation.
`

          : candles5m.length < 100

            ? `
⏳ Building market history.

5M candles:
${candles5m.length}/100
`

            : `
🔎 No complete top-down setup right now.

The bot is scanning:
4H → 1H → 15M → 5M
`;


      await bot.sendMessage(
        chatId,

`📊 XAUUSD MARKET CHECK

💰 Price:
${
  lastMarketPrice !== null
    ? lastMarketPrice.toFixed(2)
    : "Unavailable"
}

${status}

The bot will only send a trade after the complete top-down conditions agree.`
      );

    }


    /*
     LIVE PRICE
    */

    else if (
      msg.text ===
      "💰 Live Price"
    ) {

      await bot.sendMessage(
        chatId,

`💰 XAUUSD LIVE DATA

Price:
${
  lastMarketPrice !== null
    ? lastMarketPrice.toFixed(2)
    : "Unavailable"
}

5M candles:
${candles5m.length}

Last update:
${
  lastMarketUpdate
    ? new Date(
        lastMarketUpdate
      ).toLocaleString()
    : "Not yet available"
}`
      );

    }


    /*
     AUTO SIGNALS
    */

    else if (
      msg.text ===
      "🔔 Auto Signals"
    ) {

      subscribers.set(
        chatId,
        {

          username:
            msg.from?.username ||
            null,

          firstName:
            msg.from?.first_name ||
            "Unknown",

          joinedAt:
            subscribers.has(chatId)
              ? subscribers.get(chatId).joinedAt
              : Date.now()

        }
      );


      await bot.sendMessage(
        chatId,

`🔔 AUTOMATIC SIGNALS ENABLED

The bot will scan XAUUSD using:

4H → overall bias
1H → confirmation
15M → liquidity sweep
15M → BOS
15M → FVG + OB
5M → entry confirmation

The bot will NOT enter simply because a small 5M breakout occurs.

All higher-timeframe conditions must agree first.`
      );

    }


    /*
     STOP ALERTS
    */

    else if (
      msg.text ===
      "🔕 Stop Alerts"
    ) {

      subscribers.delete(
        chatId
      );


      await bot.sendMessage(
        chatId,

`🔕 AUTOMATIC SIGNALS STOPPED

You will no longer receive automatic trade alerts.

Press 🔔 Auto Signals to enable them again.`
      );

    }


    /*
     HOW IT WORKS
    */

    else if (
      msg.text ===
      "📖 How It Works"
    ) {

      await bot.sendMessage(
        chatId,

`📖 HOW THE TOP-DOWN ENGINE WORKS

1️⃣ 4H

Determines the overall market structure.

Bullish:
Higher High + Higher Low

Bearish:
Lower High + Lower Low


2️⃣ 1H

Must confirm the 4H direction.

If 4H and 1H disagree:
NO TRADE.


3️⃣ 15M

The bot waits for a liquidity sweep.

Then it waits for a 15M break of structure.

After the BOS it searches for:

🟨 Fair Value Gap
🟦 Order Block


4️⃣ 5M

Price must return to the 15M entry zone.

A confirming 5M candle must then close in the trade direction.


5️⃣ SIGNAL

Only after all conditions agree does the bot send the XAUUSD signal.`
      );

    }


    /*
     SETTINGS
    */

    else if (
      msg.text ===
      "⚙️ Settings"
    ) {

      await bot.sendMessage(
        chatId,

`⚙️ SETTINGS

Market:
XAUUSD

Strategy:
Top-down SMC

4H:
Overall bias

1H:
Confirmation

15M:
Liquidity + BOS + FVG + OB

5M:
Entry confirmation

Target:
${TP_PIPS_MIN}-${TP_PIPS_MAX} pips

Data:
Twelve Data 5M OHLC

5M candles:
${candles5m.length}

Open signal:
${
  hasOpenSignal()
    ? "YES"
    : "NO"
}`
      );

    }

  }
);


/* =========================================================
   WEBHOOK STARTUP
   ========================================================= */

async function configureTelegramWebhook() {

  const webhookUrl =
    `${PUBLIC_URL}${WEBHOOK_PATH}`;


  try {

    /*
     Remove any previous webhook first.
     This also makes migration from an old webhook clean.
    */

    await bot.deleteWebHook();


    const options = {};


    if (WEBHOOK_SECRET) {

      options.secret_token =
        WEBHOOK_SECRET;

    }


    await bot.setWebHook(
      webhookUrl,
      options
    );


    const info =
      await bot.getWebHookInfo();


    console.log(
      "🔥 Telegram webhook configured:"
    );

    console.log(
      webhookUrl
    );

    console.log(
      "[TELEGRAM] pending updates:",
      info.pending_update_count
    );


  } catch (error) {

    console.error(
      "[TELEGRAM WEBHOOK ERROR]",
      error.message
    );

    /*
     Do not crash the web service.
     Render can still serve /health and /admin.
    */

  }

}


/* =========================================================
   MARKET SCHEDULER
   ========================================================= */

/*
   Fetch immediately at startup.

   After that, run around every 5 minutes.

   We intentionally do NOT run every 30 seconds.
*/

let marketTimer = null;


function startMarketScheduler() {

  fetch5mHistory();


  marketTimer =
    setInterval(
      () => {

        fetch5mHistory();

      },
      5 * 60 * 1000
    );

}


/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */

async function shutdown(
  signal
) {

  console.log(
    `[SYSTEM] ${signal} received.`
  );


  if (marketTimer) {

    clearInterval(
      marketTimer
    );

  }


  try {

    await bot.deleteWebHook();

  } catch (error) {

    console.error(
      "Webhook cleanup error:",
      error.message
    );

  }


  process.exit(0);

}


process.once(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.once(
  "SIGINT",
  () => shutdown("SIGINT")
);


/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  PORT,
  async () => {

    console.log(
      "🔥 MONEY MAKING MACHINE BOT running"
    );

    console.log(
      `🔥 Port: ${PORT}`
    );

    console.log(
      "📊 Strategy: 4H → 1H → 15M → 5M"
    );

    console.log(
      "📡 Market data: Twelve Data 5M"
    );

    console.log(
      "🔐 Telegram: WEBHOOK MODE"
    );


    await configureTelegramWebhook();


    startMarketScheduler();

  }
);
