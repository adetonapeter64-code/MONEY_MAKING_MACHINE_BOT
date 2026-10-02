const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

const SYMBOL = "XAU/USD";

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

if (!TWELVE_DATA_API_KEY) {
  console.error("TWELVE_DATA_API_KEY is missing");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true
});

app.use(express.urlencoded({ extended: true }));


// ================================================================
// CONFIGURATION
// ================================================================

const TIMEFRAMES = {
  HTF: "4h",
  MID: "1h",
  SETUP: "15min",
  ENTRY: "5min"
};

const DATA_REFRESH_MS = 60 * 1000;

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
const SETUP_EXPIRY_MS = 3 * 60 * 60 * 1000;

const MAX_SIGNAL_HISTORY = 100;

const HTF_CANDLES = 250;
const MID_CANDLES = 250;
const SETUP_CANDLES = 300;
const ENTRY_CANDLES = 300;

const SWING_LOOKBACK = 2;

const MIN_FVG_SIZE = 0.30;

// Maximum distance price may move away from the zone
// before the setup becomes invalid.
const MAX_ENTRY_DISTANCE = 12.0;

// Minimum displacement candle body.
const MIN_DISPLACEMENT = 1.0;


// ================================================================
// STATE
// ================================================================

const subscribers = new Map();

const signalHistory = [];

let pendingSetup = null;

let lastSignalTime = 0;

let lastAnalysisTime = 0;

let cachedMarket = {
  htf: [],
  mid: [],
  setup: [],
  entry: [],
  price: null,
  updatedAt: 0
};


// ================================================================
// ADMIN AUTH
// ================================================================

function requireAdminAuth(req, res, next) {

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Basic ")) {

    res.set(
      "WWW-Authenticate",
      'Basic realm="Admin Panel"'
    );

    return res.status(401).send("Authentication required.");
  }

  const decoded = Buffer
    .from(authHeader.split(" ")[1], "base64")
    .toString();

  const separator = decoded.indexOf(":");

  const user = separator >= 0
    ? decoded.slice(0, separator)
    : "";

  const pass = separator >= 0
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

  return res.status(401).send("Invalid credentials.");
}


// ================================================================
// TELEGRAM MENU
// ================================================================

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


// ================================================================
// HTML HELPERS
// ================================================================

function escapeHtml(str) {

  if (str === null || str === undefined) {
    return "";
  }

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


// ================================================================
// WEB SERVER
// ================================================================

app.get("/", (req, res) => {

  res.send(
    "🔥 MONEY MAKING MACHINE BOT is running."
  );

});


// ================================================================
// ADMIN PANEL
// ================================================================

const botStartedAt = Date.now();

app.get(
  "/admin",
  requireAdminAuth,
  (req, res) => {

    const price =
      cachedMarket.price;

    const subscriberRows =
      [...subscribers.entries()]
        .map(([chatId, info]) => `

<tr>

<td>
${escapeHtml(info.firstName)}
${info.username
  ? " (@" + escapeHtml(info.username) + ")"
  : ""}
</td>

<td>${chatId}</td>

<td>
${new Date(info.joinedAt).toLocaleString()}
</td>

<td>

<form
method="POST"
action="/admin/remove"
style="margin:0;"
>

<input
type="hidden"
name="chatId"
value="${chatId}"
>

<button
type="submit"
class="danger"
>
Remove
</button>

</form>

</td>

</tr>

`)
.join("")

||
`<tr>
<td colspan="4">
No subscribers yet.
</td>
</tr>`;


    const statusBadge = {

      open: "⏳ Open",

      win: "✅ Win",

      loss: "❌ Loss"

    };


    const signalRows =
      signalHistory
        .slice(0, 20)
        .map(s => `

<tr>

<td>
${new Date(s.time).toLocaleString()}
</td>

<td>
${escapeHtml(s.label)}
</td>

<td>
${s.direction}
</td>

<td>
${Number(s.entryPrice).toFixed(2)}
</td>

<td>
${Number(s.stopLoss).toFixed(2)}
</td>

<td>
${Number(s.takeProfit).toFixed(2)}
</td>

<td>
${statusBadge[s.status] || s.status}
</td>

</tr>

`)
.join("")

||
`<tr>
<td colspan="7">
No signals fired yet.
</td>
</tr>`;


    const wins =
      signalHistory.filter(
        s => s.status === "win"
      ).length;


    const losses =
      signalHistory.filter(
        s => s.status === "loss"
      ).length;


    const openCount =
      signalHistory.filter(
        s => s.status === "open"
      ).length;


    const decided =
      wins + losses;


    const winRate =
      decided > 0
        ? ((wins / decided) * 100).toFixed(1)
        : "—";


    let setupStatus =
      "No active setup right now.";


    if (pendingSetup) {

      setupStatus =
        `Watching ${pendingSetup.direction.toUpperCase()}
        ${pendingSetup.label}
        setup.`;

    }


    res.send(`

<!DOCTYPE html>

<html>

<head>

<meta name="viewport"
content="width=device-width, initial-scale=1">

<title>
Money Making Machine - Admin
</title>

<style>

body {

font-family:
-apple-system,
Arial,
sans-serif;

background:#0f1115;

color:#eee;

margin:0;

padding:16px;

}

h1 {

font-size:1.3rem;

}

h2 {

font-size:1.05rem;

margin-top:28px;

color:#f5c542;

}

.stats {

display:flex;

flex-wrap:wrap;

gap:10px;

margin:12px 0;

}

.card {

background:#1b1f27;

border-radius:10px;

padding:12px 16px;

flex:1 1 140px;

}

.card .label {

font-size:.75rem;

color:#999;

}

.card .value {

font-size:1.3rem;

font-weight:bold;

margin-top:4px;

}

table {

width:100%;

border-collapse:collapse;

margin-top:8px;

font-size:.85rem;

}

th,td {

text-align:left;

padding:8px 6px;

border-bottom:
1px solid #2a2f3a;

}

th {

color:#aaa;

font-weight:normal;

}

button {

background:#2b6fe0;

color:white;

border:none;

padding:8px 14px;

border-radius:6px;

font-size:.85rem;

}

button.danger {

background:#c0392b;

}

textarea {

width:100%;

box-sizing:border-box;

background:#1b1f27;

color:#eee;

border:
1px solid #333;

border-radius:6px;

padding:8px;

font-size:.9rem;

}

.scroll {

overflow-x:auto;

}

</style>

</head>

<body>

<h1>
🔥 Money Making Machine - Admin
</h1>

<div class="stats">

<div class="card">

<div class="label">
Bot uptime
</div>

<div class="value">
${formatUptime(
  Date.now() - botStartedAt
)}
</div>

</div>


<div class="card">

<div class="label">
Live price
</div>

<div class="value">
${price
  ? Number(price).toFixed(2)
  : "—"}
</div>

</div>


<div class="card">

<div class="label">
4H candles
</div>

<div class="value">
${cachedMarket.htf.length}
</div>

</div>


<div class="card">

<div class="label">
15M candles
</div>

<div class="value">
${cachedMarket.setup.length}
</div>

</div>


<div class="card">

<div class="label">
Subscribers
</div>

<div class="value">
${subscribers.size}
</div>

</div>

</div>


<div class="stats">

<div class="card">

<div class="label">
Win rate
</div>

<div class="value">
${winRate}${decided > 0 ? "%" : ""}
</div>

</div>


<div class="card">

<div class="label">
Wins
</div>

<div class="value">
${wins}
</div>

</div>


<div class="card">

<div class="label">
Losses
</div>

<div class="value">
${losses}
</div>

</div>


<div class="card">

<div class="label">
Open
</div>

<div class="value">
${openCount}
</div>

</div>

</div>


<p>

<strong>
Setup status:
</strong>

${escapeHtml(setupStatus)}

</p>


<h2>
Send manual message
</h2>

<form
method="POST"
action="/admin/broadcast"
>

<textarea
name="message"
rows="3"
placeholder="Message..."
></textarea>

<br><br>

<button
type="submit"
>
Send Broadcast
</button>

</form>


<h2>
Subscribers (${subscribers.size})
</h2>

<div class="scroll">

<table>

<tr>

<th>Name</th>
<th>Chat ID</th>
<th>Joined</th>
<th></th>

</tr>

${subscriberRows}

</table>

</div>


<h2>
Recent Signals
</h2>

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


// ================================================================
// ADMIN REMOVE
// ================================================================

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


// ================================================================
// ADMIN BROADCAST
// ================================================================

app.post(
  "/admin/broadcast",
  requireAdminAuth,
  async (req, res) => {

    const text =
      (req.body.message || "").trim();

    if (text) {

      for (
        const chatId of subscribers.keys()
      ) {

        bot.sendMessage(
          chatId,
          `📢 ${text}`
        ).catch(err => {

          console.error(
            `Broadcast failed for ${chatId}:`,
            err.message
          );

        });

      }

    }

    res.redirect("/admin");

  }
);


// ================================================================
// TWELVE DATA
// ================================================================

async function getTimeSeries(
  interval,
  outputsize
) {

  const response =
    await axios.get(
      "https://api.twelvedata.com/time_series",
      {
        timeout: 15000,

        params: {

          symbol: SYMBOL,

          interval,

          outputsize,

          order: "asc",

          timezone: "UTC",

          include_ohlc: true,

          apikey:
            TWELVE_DATA_API_KEY

        }

      }
    );


  const data = response.data;


  if (
    !data ||
    data.status === "error"
  ) {

    throw new Error(
      data?.message ||
      "Twelve Data returned an error"
    );

  }


  if (
    !Array.isArray(data.values)
  ) {

    throw new Error(
      `No ${interval} candle data returned`
    );

  }


  const candles =
    data.values
      .map(v => ({

        time:
          new Date(v.datetime).getTime(),

        open:
          Number(v.open),

        high:
          Number(v.high),

        low:
          Number(v.low),

        close:
          Number(v.close)

      }))
      .filter(c =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        Number.isFinite(c.time)
      )
      .sort(
        (a, b) =>
          a.time - b.time
      );


  /*
   * The newest intraday candle may still be forming.
   *
   * We remove it so the strategy only analyzes
   * COMPLETED candles.
   */

  if (candles.length > 2) {

    candles.pop();

  }


  return candles;

}


// ================================================================
// LIVE PRICE
// ================================================================

async function getGoldPrice() {

  /*
   * We use Twelve Data's latest 5-minute close
   * for the market display.
   *
   * The strategy itself works only from completed
   * OHLC candles.
   */

  const candles =
    await getTimeSeries(
      "5min",
      3
    );


  if (!candles.length) {

    throw new Error(
      "No current XAUUSD price"
    );

  }


  const price =
    candles[candles.length - 1].close;


  cachedMarket.price =
    price;


  return price;

}


// ================================================================
// SWING DETECTION
// ================================================================

function findSwings(
  candles,
  lookback = SWING_LOOKBACK
) {

  const swings = [];


  for (
    let i = lookback;
    i < candles.length - lookback;
    i++
  ) {

    const c =
      candles[i];


    let isHigh = true;
    let isLow = true;


    for (
      let j = i - lookback;
      j <= i + lookback;
      j++
    ) {

      if (j === i) continue;


      if (
        candles[j].high >
        c.high
      ) {

        isHigh = false;

      }


      if (
        candles[j].low <
        c.low
      ) {

        isLow = false;

      }

    }


    if (isHigh) {

      swings.push({

        index: i,

        price: c.high,

        type: "high",

        time: c.time

      });

    }


    if (isLow) {

      swings.push({

        index: i,

        price: c.low,

        type: "low",

        time: c.time

      });

    }

  }


  return swings;

}


// ================================================================
// TOP-DOWN BIAS
// ================================================================

function getStructureBias(
  candles
) {

  if (candles.length < 30) {

    return "neutral";

  }


  const swings =
    findSwings(candles);


  const highs =
    swings.filter(
      s => s.type === "high"
    );


  const lows =
    swings.filter(
      s => s.type === "low"
    );


  if (
    highs.length < 2 ||
    lows.length < 2
  ) {

    return "neutral";

  }


  const h1 =
    highs[highs.length - 2];

  const h2 =
    highs[highs.length - 1];

  const l1 =
    lows[lows.length - 2];

  const l2 =
    lows[lows.length - 1];


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


// ================================================================
// FVG
// ================================================================

function findFVGAt(
  candles,
  index,
  direction
) {

  if (
    index < 2 ||
    index >= candles.length
  ) {

    return null;

  }


  const c1 =
    candles[index - 2];

  const c2 =
    candles[index - 1];

  const c3 =
    candles[index];


  /*
   * We also require displacement.
   */

  const body =
    Math.abs(
      c2.close - c2.open
    );


  if (
    body < MIN_DISPLACEMENT
  ) {

    return null;

  }


  if (
    direction === "bullish" &&
    c1.high < c3.low
  ) {

    const bottom =
      c1.high;

    const top =
      c3.low;

    if (
      top - bottom <
      MIN_FVG_SIZE
    ) {

      return null;

    }


    return {

      top,

      bottom,

      index,

      time:
        c3.time

    };

  }


  if (
    direction === "bearish" &&
    c1.low > c3.high
  ) {

    const bottom =
      c3.high;

    const top =
      c1.low;

    if (
      top - bottom <
      MIN_FVG_SIZE
    ) {

      return null;

    }


    return {

      top,

      bottom,

      index,

      time:
        c3.time

    };

  }


  return null;

}


// ================================================================
// ORDER BLOCK
// ================================================================

function findOrderBlock(
  candles,
  displacementIndex,
  direction
) {

  /*
   * Search backward for the final opposite
   * candle before the displacement.
   */

  for (
    let i =
      displacementIndex - 1;

    i >= 0 &&
    i >= displacementIndex - 8;

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


// ================================================================
// LIQUIDITY SWEEP DETECTION
// ================================================================

function findLiquiditySweep(
  candles,
  direction
) {

  const swings =
    findSwings(candles);


  const highs =
    swings.filter(
      s => s.type === "high"
    );


  const lows =
    swings.filter(
      s => s.type === "low"
    );


  /*
   * Look at recent completed candles.
   */

  const start =
    Math.max(
      SWING_LOOKBACK + 2,
      candles.length - 15
    );


  if (
    direction === "bullish"
  ) {

    for (
      let i =
        candles.length - 1;

      i >= start;

      i--
    ) {

      const c =
        candles[i];


      const previousLows =
        lows.filter(
          s => s.index < i
        );


      if (!previousLows.length) {

        continue;

      }


      const target =
        previousLows[
          previousLows.length - 1
        ];


      /*
       * Price takes sell-side liquidity
       * then closes back above it.
       */

      if (
        c.low < target.price &&
        c.close > target.price
      ) {

        return {

          index: i,

          level:
            target.price,

          time:
            c.time

        };

      }

    }

  }


  if (
    direction === "bearish"
  ) {

    for (
      let i =
        candles.length - 1;

      i >= start;

      i--
    ) {

      const c =
        candles[i];


      const previousHighs =
        highs.filter(
          s => s.index < i
        );


      if (!previousHighs.length) {

        continue;

      }


      const target =
        previousHighs[
          previousHighs.length - 1
        ];


      /*
       * Price takes buy-side liquidity
       * then closes back below it.
       */

      if (
        c.high > target.price &&
        c.close < target.price
      ) {

        return {

          index: i,

          level:
            target.price,

          time:
            c.time

        };

      }

    }

  }


  return null;

}


// ================================================================
// FIND 15M DISPLACEMENT / BOS AFTER SWEEP
// ================================================================

function findDisplacementAfterSweep(
  candles,
  sweep,
  direction
) {

  const maxBars =
    Math.min(
      candles.length - 1,
      sweep.index + 6
    );


  for (
    let i =
      sweep.index + 1;

    i <= maxBars;

    i++
  ) {

    const c =
      candles[i];


    const body =
      Math.abs(
        c.close - c.open
      );


    if (
      body < MIN_DISPLACEMENT
    ) {

      continue;

    }


    if (
      direction === "bullish" &&
      c.close <= c.open
    ) {

      /*
       * Find the nearest recent swing high
       * before the displacement.
       */

      const swings =
        findSwings(
          candles.slice(
            0,
            i
          )
        );


      const highs =
        swings.filter(
          s => s.type === "high"
        );


      if (!highs.length) {

        continue;

      }


      const lastHigh =
        highs[highs.length - 1];


      if (
        c.close >
        lastHigh.price
      ) {

        return {

          index: i,

          level:
            lastHigh.price,

          time:
            c.time

        };

      }

    }


    if (
      direction === "bearish" &&
      c.close >= c.open
    ) {

      const swings =
        findSwings(
          candles.slice(
            0,
            i
          )
        );


      const lows =
        swings.filter(
          s => s.type === "low"
        );


      if (!lows.length) {

        continue;

      }


      const lastLow =
        lows[lows.length - 1];


      if (
        c.close <
        lastLow.price
      ) {

        return {

          index: i,

          level:
            lastLow.price,

          time:
            c.time

        };

      }

    }

  }


  return null;

}


// ================================================================
// BUILD 15M SETUP
// ================================================================

function build15mSetup(
  candles,
  direction
) {

  const sweep =
    findLiquiditySweep(
      candles,
      direction
    );


  if (!sweep) {

    return null;

  }


  const displacement =
    findDisplacementAfterSweep(
      candles,
      sweep,
      direction
    );


  if (!displacement) {

    return null;

  }


  /*
   * Search the candles around the displacement
   * for the FVG created by the move.
   */

  let fvg = null;


  for (
    let i =
      displacement.index;

    i >= Math.max(
      2,
      displacement.index - 3
    );

    i--
  ) {

    const candidate =
      findFVGAt(
        candles,
        i,
        direction
      );


    if (candidate) {

      fvg = candidate;

      break;

    }

  }


  if (!fvg) {

    return null;

  }


  const orderBlock =
    findOrderBlock(
      candles,
      displacement.index,
      direction
    );


  /*
   * Prefer the order block if it overlaps
   * the FVG. Otherwise use the FVG.
   */

  let zone = fvg;


  if (orderBlock) {

    const overlaps =
      orderBlock.bottom <= fvg.top &&
      orderBlock.top >= fvg.bottom;


    if (overlaps) {

      zone = {

        top:
          Math.min(
            orderBlock.top,
            fvg.top
          ),

        bottom:
          Math.max(
            orderBlock.bottom,
            fvg.bottom
          ),

        index:
          fvg.index,

        time:
          fvg.time

      };

    }

  }


  return {

    direction,

    label:
      direction === "bullish"
        ? "LIQUIDITY + BOS"
        : "LIQUIDITY + BOS",

    sweep,

    displacement,

    fvg,

    orderBlock,

    zone,

    createdAt:
      Date.now(),

    createdCandleTime:
      candles[
        displacement.index
      ].time

  };

}


// ================================================================
// 5M ENTRY CONFIRMATION
// ================================================================

function find5mConfirmation(
  candles,
  setup
) {

  if (!candles.length) {

    return null;

  }


  const zone =
    setup.zone;


  for (
    let i =
      candles.length - 1;

    i >= 0;

    i--
  ) {

    const c =
      candles[i];


    /*
     * Do not use candles that existed before
     * the 15M setup was created.
     */

    if (
      c.time <=
      setup.createdCandleTime
    ) {

      continue;

    }


    /*
     * Zone interaction.
     */

    const touched =
      c.low <= zone.top &&
      c.high >= zone.bottom;


    if (!touched) {

      continue;

    }


    /*
     * Bullish rejection:
     * candle trades into zone but closes
     * above the zone.
     */

    if (
      setup.direction === "bullish"
    ) {

      const bullish =
        c.close > c.open;


      const rejection =
        c.close > zone.top;


      if (
        bullish &&
        rejection
      ) {

        return {

          candle: c,

          entry:
            c.close

        };

      }

    }


    /*
     * Bearish rejection.
     */

    if (
      setup.direction === "bearish"
    ) {

      const bearish =
        c.close < c.open;


      const rejection =
        c.close < zone.bottom;


      if (
        bearish &&
        rejection
      ) {

        return {

          candle: c,

          entry:
            c.close

        };

      }

    }

  }


  return null;

}


// ================================================================
// STRUCTURE STOP / TARGET
// ================================================================

function calculateTradeLevels(
  setup,
  entry
) {

  let stopLoss;

  let takeProfit;


  if (
    setup.direction === "bullish"
  ) {

    /*
     * Stop below the liquidity sweep.
     */

    stopLoss =
      setup.sweep.level - 1.0;


    /*
     * Target is based on the next meaningful
     * 15M swing high rather than a fixed $25.
     */

    const candles =
      cachedMarket.setup;


    const swings =
      findSwings(candles);


    const highs =
      swings.filter(
        s =>
          s.type === "high" &&
          s.price > entry
      );


    if (highs.length) {

      takeProfit =
        highs[
          highs.length - 1
        ].price;

    } else {

      takeProfit =
        entry + 25;

    }

  } else {

    stopLoss =
      setup.sweep.level + 1.0;


    const candles =
      cachedMarket.setup;


    const swings =
      findSwings(candles);


    const lows =
      swings.filter(
        s =>
          s.type === "low" &&
          s.price < entry
      );


    if (lows.length) {

      takeProfit =
        lows[
          lows.length - 1
        ].price;

    } else {

      takeProfit =
        entry - 25;

    }

  }


  /*
   * Safety checks.
   */

  if (
    setup.direction === "bullish" &&
    takeProfit <= entry
  ) {

    takeProfit =
      entry + 25;

  }


  if (
    setup.direction === "bearish" &&
    takeProfit >= entry
  ) {

    takeProfit =
      entry - 25;

  }


  return {

    stopLoss,

    takeProfit

  };

}


// ================================================================
// RISK / REWARD CHECK
// ================================================================

function validRiskReward(
  direction,
  entry,
  stopLoss,
  takeProfit
) {

  const risk =
    Math.abs(
      entry - stopLoss
    );


  const reward =
    Math.abs(
      takeProfit - entry
    );


  if (
    risk <= 0 ||
    reward <= 0
  ) {

    return false;

  }


  const rr =
    reward / risk;


  /*
   * Require at least 1.5R.
   */

  return rr >= 1.5;

}


// ================================================================
// OPEN SIGNAL
// ================================================================

function hasOpenSignal() {

  return signalHistory.some(
    s => s.status === "open"
  );

}


// ================================================================
// FIRE SIGNAL
// ================================================================

function fireSignal(
  setup,
  entry
) {

  if (hasOpenSignal()) {

    return;

  }


  if (
    Date.now() -
    lastSignalTime <
    SIGNAL_COOLDOWN_MS
  ) {

    console.log(
      "[SIGNAL] Cooldown active"
    );

    return;

  }


  const levels =
    calculateTradeLevels(
      setup,
      entry
    );


  const stopLoss =
    levels.stopLoss;


  const takeProfit =
    levels.takeProfit;


  if (
    !validRiskReward(
      setup.direction,
      entry,
      stopLoss,
      takeProfit
    )
  ) {

    console.log(
      "[SIGNAL] Rejected - R:R below 1.5"
    );

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


  const risk =
    Math.abs(
      entry - stopLoss
    );


  const reward =
    Math.abs(
      takeProfit - entry
    );


  const rr =
    reward / risk;


  lastSignalTime =
    Date.now();


  const message =
`🚨 XAUUSD TOP-DOWN SIGNAL

${emoji} ${direction}

💰 Entry: ${entry.toFixed(2)}

🛡️ Stop Loss:
${stopLoss.toFixed(2)}

🎯 Take Profit:
${takeProfit.toFixed(2)}

📊 Risk/Reward:
1:${rr.toFixed(2)}

━━━━━━━━━━━━━━

🔎 TOP-DOWN CONFIRMATION

4H:
${setup.htfBias.toUpperCase()} bias

1H:
${setup.midBias.toUpperCase()} confirmation

15M:
💧 Liquidity sweep
📈 Displacement
📊 BOS
🟨 FVG
🟦 Order Block

5M:
✅ Retest
✅ Rejection candle

━━━━━━━━━━━━━━

⚠️ Risk management is your responsibility.
This is not financial advice.`;


  const signal = {

    id:
      `${Date.now()}-${Math.floor(
        Math.random() * 1000
      )}`,

    time:
      Date.now(),

    label:
      "TOP-DOWN SMC",

    direction,

    entryPrice:
      entry,

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


  console.log(
    `[SIGNAL FIRED] ${direction} @ ${entry.toFixed(2)}`
  );


  for (
    const chatId of subscribers.keys()
  ) {

    bot.sendMessage(
      chatId,
      message
    ).catch(err => {

      console.error(
        `Failed to send signal to ${chatId}:`,
        err.message
      );

    });

  }

}


// ================================================================
// MARKET ANALYSIS
// ================================================================

async function analyzeMarket() {

  try {

    /*
     * Never create another trade while one is open.
     */

    if (hasOpenSignal()) {

      return;

    }


    /*
     * Prevent repeated analysis within the same minute.
     */

    if (
      Date.now() -
      lastAnalysisTime <
      DATA_REFRESH_MS
    ) {

      return;

    }


    lastAnalysisTime =
      Date.now();


    console.log(
      "[ANALYSIS] Fetching multi-timeframe data..."
    );


    const [
      htf,
      mid,
      setupCandles,
      entryCandles
    ] =
      await Promise.all([

        getTimeSeries(
          TIMEFRAMES.HTF,
          HTF_CANDLES
        ),

        getTimeSeries(
          TIMEFRAMES.MID,
          MID_CANDLES
        ),

        getTimeSeries(
          TIMEFRAMES.SETUP,
          SETUP_CANDLES
        ),

        getTimeSeries(
          TIMEFRAMES.ENTRY,
          ENTRY_CANDLES
        )

      ]);


    cachedMarket.htf =
      htf;

    cachedMarket.mid =
      mid;

    cachedMarket.setup =
      setupCandles;

    cachedMarket.entry =
      entryCandles;

    cachedMarket.updatedAt =
      Date.now();


    if (
      htf.length < 40 ||
      mid.length < 40 ||
      setupCandles.length < 50 ||
      entryCandles.length < 50
    ) {

      console.log(
        "[ANALYSIS] Not enough candle history."
      );

      return;

    }


    const htfBias =
      getStructureBias(
        htf
      );


    const midBias =
      getStructureBias(
        mid
      );


    console.log(
      `[BIAS] 4H=${htfBias} | 1H=${midBias}`
    );


    /*
     * TOP-DOWN FILTER
     *
     * Both higher timeframes must agree.
     */

    if (
      htfBias === "neutral" ||
      midBias === "neutral"
    ) {

      pendingSetup = null;

      console.log(
        "[ANALYSIS] No clear higher-timeframe bias."
      );

      return;

    }


    if (
      htfBias !== midBias
    ) {

      pendingSetup = null;

      console.log(
        "[ANALYSIS] 4H and 1H disagree. No trade."
      );

      return;

    }


    const direction =
      htfBias;


    /*
     * If an existing setup has expired,
     * remove it.
     */

    if (pendingSetup) {

      if (
        Date.now() -
        pendingSetup.createdAt >
        SETUP_EXPIRY_MS
      ) {

        console.log(
          "[SETUP] Expired."
        );

        pendingSetup =
          null;

      }

    }


    /*
     * If no setup exists, search 15M.
     */

    if (!pendingSetup) {

      const setup =
        build15mSetup(
          setupCandles,
          direction
        );


      if (setup) {

        setup.htfBias =
          htfBias;

        setup.midBias =
          midBias;


        pendingSetup =
          setup;


        console.log(
          `[SETUP] ${direction.toUpperCase()} liquidity sweep + BOS + FVG found.`
        );

      }

    }


    if (!pendingSetup) {

      console.log(
        "[ANALYSIS] No valid 15M setup."
      );

      return;

    }


    /*
     * Make sure the pending setup still agrees
     * with the higher timeframes.
     */

    if (
      pendingSetup.direction !==
      direction
    ) {

      pendingSetup =
        null;

      return;

    }


    /*
     * Check 5M retest.
     */

    const confirmation =
      find5mConfirmation(
        entryCandles,
        pendingSetup
      );


    if (!confirmation) {

      console.log(
        "[ANALYSIS] Waiting for 5M retest."
      );

      return;

    }


    const entry =
      confirmation.entry;


    /*
     * Prevent entries that occur far away
     * from the intended zone.
     */

    const zone =
      pendingSetup.zone;


    const distance =
      pendingSetup.direction === "bullish"

        ? Math.max(
            0,
            entry - zone.top
          )

        : Math.max(
            0,
            zone.bottom - entry
          );


    if (
      distance >
      MAX_ENTRY_DISTANCE
    ) {

      console.log(
        "[SETUP] Price moved too far from zone."
      );

      pendingSetup =
        null;

      return;

    }


    fireSignal(
      pendingSetup,
      entry
    );


    /*
     * Whether signal fired or was rejected,
     * don't repeatedly process the exact setup.
     */

    pendingSetup =
      null;

  } catch (error) {

    console.error(
      "[ANALYSIS ERROR]",
      error.response?.data ||
      error.message
    );

  }

}


// ================================================================
// OPEN SIGNAL TRACKER
// ================================================================

function checkOpenSignals(
  currentPrice
) {

  if (!currentPrice) {

    return;

  }


  const openSignals =
    signalHistory.filter(
      s => s.status === "open"
    );


  for (
    const signal of openSignals
  ) {

    let hitTP =
      false;

    let hitSL =
      false;


    if (
      signal.direction === "BUY"
    ) {

      hitTP =
        currentPrice >=
        signal.takeProfit;

      hitSL =
        currentPrice <=
        signal.stopLoss;

    } else {

      hitTP =
        currentPrice <=
        signal.takeProfit;

      hitSL =
        currentPrice >=
        signal.stopLoss;

    }


    /*
     * Conservative rule if both are crossed
     * between checks.
     */

    if (hitSL) {

      signal.status =
        "loss";

    } else if (hitTP) {

      signal.status =
        "win";

    } else {

      continue;

    }


    signal.closedAt =
      Date.now();

    signal.closePrice =
      currentPrice;


    lastSignalTime =
      Date.now();


    const win =
      signal.status === "win";


    const resultEmoji =
      win ? "✅" : "❌";


    const resultText =
      win
        ? "TAKE PROFIT HIT"
        : "STOP LOSS HIT";


    const closeMessage =
`${resultEmoji} XAUUSD SIGNAL CLOSED

${resultText}

${signal.direction} @ ${signal.entryPrice.toFixed(2)}

Closed @ ${currentPrice.toFixed(2)}

${win
  ? "🎯 Target reached."
  : "🛡️ Stop loss reached."}`;


    console.log(
      `[RESULT] ${signal.direction} -> ${signal.status.toUpperCase()}`
    );


    for (
      const chatId of subscribers.keys()
    ) {

      bot.sendMessage(
        chatId,
        closeMessage
      ).catch(err => {

        console.error(
          `Failed result message to ${chatId}:`,
          err.message
        );

      });

    }

  }

}


// ================================================================
// MARKET MONITOR
// ================================================================

async function monitorMarket() {

  try {

    /*
     * Get latest completed 5M candle.
     */

    const candles =
      await getTimeSeries(
        "5min",
        3
      );


    if (!candles.length) {

      return;

    }


    const price =
      candles[
        candles.length - 1
      ].close;


    cachedMarket.price =
      price;


    console.log(
      `[MARKET] XAUUSD ${price.toFixed(2)}`
    );


    checkOpenSignals(
      price
    );


    /*
     * Full top-down analysis.
     */

    await analyzeMarket();

  } catch (error) {

    console.error(
      "[MARKET ERROR]",
      error.response?.data ||
      error.message
    );

  }

}


// ================================================================
// START COMMAND
// ================================================================

bot.onText(
  /\/start/,
  async msg => {

    await bot.sendMessage(

      msg.chat.id,

`🔥 MONEY MAKING MACHINE BOT

Welcome! 👋

Your XAUUSD top-down
SMC trading assistant.

📊 4H + 1H bias
💧 15M liquidity sweep
📈 15M BOS/displacement
🟨 FVG
🟦 Order Block
✅ 5M confirmation

Choose an option below:`,

      mainMenu

    );

  }
);


// ================================================================
// TELEGRAM MENU
// ================================================================

bot.on(
  "message",
  async msg => {

    if (!msg.text) {

      return;

    }


    // ------------------------------------------------------------
    // XAUUSD SIGNAL
    // ------------------------------------------------------------

    if (
      msg.text ===
      "📊 XAUUSD Signal"
    ) {

      try {

        const price =
          cachedMarket.price ||
          await getGoldPrice();


        let status;


        if (pendingSetup) {

          status =
`👀 Active setup

Direction:
${pendingSetup.direction.toUpperCase()}

4H:
${pendingSetup.htfBias.toUpperCase()}

1H:
${pendingSetup.midBias.toUpperCase()}

15M:
Liquidity sweep + BOS + FVG

⏳ Waiting for 5M retest.`;

        } else {

          status =
`🔎 No active setup.

The bot is waiting for:

4H bias
→ 1H confirmation
→ 15M liquidity sweep
→ 15M BOS
→ FVG/OB
→ 5M retest`;

        }


        await bot.sendMessage(

          msg.chat.id,

`🔎 XAUUSD TOP-DOWN MARKET CHECK

💰 Price:
${price.toFixed(2)}

📡 Market data:
Twelve Data OHLC

${status}

⚠️ No signal is generated
unless the complete sequence
is confirmed.`

        );

      } catch (error) {

        console.error(
          "Signal button error:",
          error.message
        );


        bot.sendMessage(

          msg.chat.id,

          "⚠️ XAUUSD market data is temporarily unavailable."

        );

      }

    }


    // ------------------------------------------------------------
    // LIVE PRICE
    // ------------------------------------------------------------

    if (
      msg.text ===
      "💰 Live Price"
    ) {

      try {

        const price =
          cachedMarket.price ||
          await getGoldPrice();


        await bot.sendMessage(

          msg.chat.id,

`💰 XAUUSD LIVE PRICE

🪙 ${price.toFixed(2)}

📡 Source:
Twelve Data

⏱️ Updated:
${new Date().toLocaleTimeString()}`

        );

      } catch (error) {

        bot.sendMessage(

          msg.chat.id,

          "⚠️ Unable to retrieve XAUUSD price."

        );

      }

    }


    // ------------------------------------------------------------
    // AUTO SIGNALS
    // ------------------------------------------------------------

    if (
      msg.text ===
      "🔔 Auto Signals"
    ) {

      const existing =
        subscribers.get(
          msg.chat.id
        );


      subscribers.set(

        msg.chat.id,

        {

          username:
            msg.from.username ||
            null,

          firstName:
            msg.from.first_name ||
            "Unknown",

          joinedAt:
            existing
              ? existing.joinedAt
              : Date.now()

        }

      );


      await bot.sendMessage(

        msg.chat.id,

`🔔 AUTOMATIC SIGNALS ENABLED

The bot will scan XAUUSD using:

4H → overall bias
1H → confirmation
15M → liquidity + BOS
15M → FVG + OB
5M → entry confirmation

The bot will NOT send a trade merely because
a small 5M breakout occurs.

All higher-timeframe conditions must agree first.`

      );

    }


    // ------------------------------------------------------------
    // STOP SIGNALS
    // ------------------------------------------------------------

    if (
      msg.text ===
      "🔕 Stop Alerts"
    ) {

      subscribers.delete(
        msg.chat.id
      );


      await bot.sendMessage(

        msg.chat.id,

`🔕 AUTOMATIC SIGNALS STOPPED

You will no longer receive
automatic XAUUSD signals.

Turn them back on with:

🔔 Auto Signals`

      );

    }


    // ------------------------------------------------------------
    // HOW IT WORKS
    // ------------------------------------------------------------

    if (
      msg.text ===
      "📖 How It Works"
    ) {

      await bot.sendMessage(

        msg.chat.id,

`📖 HOW THE NEW STRATEGY WORKS

1️⃣ 4H

Determines the major market structure.

2️⃣ 1H

Must confirm the 4H direction.

3️⃣ 15M

The bot waits for a liquidity sweep.

4️⃣ 15M

The sweep must be followed by
strong displacement and BOS.

5️⃣ 15M

The displacement must create
a valid FVG.

6️⃣ 15M

The bot identifies the relevant
Order Block.

7️⃣ 5M

Price must return to the zone.

8️⃣ 5M

A rejection/confirmation candle
must appear.

9️⃣ ENTRY

Only then is the signal sent.

🚫 If the higher timeframes disagree,
there is NO trade.`

      );

    }


    // ------------------------------------------------------------
    // SETTINGS
    // ------------------------------------------------------------

    if (
      msg.text ===
      "⚙️ Settings"
    ) {

      await bot.sendMessage(

        msg.chat.id,

`⚙️ SETTINGS

Symbol:
XAU/USD

Strategy:
Top-Down SMC

4H:
Market bias

1H:
Bias confirmation

15M:
Liquidity + BOS + FVG + OB

5M:
Entry confirmation

Minimum R:R:
1.5

Signal cooldown:
30 minutes

Setup expiry:
3 hours

Candles currently loaded:

4H: ${cachedMarket.htf.length}
1H: ${cachedMarket.mid.length}
15M: ${cachedMarket.setup.length}
5M: ${cachedMarket.entry.length}`

      );

    }

  }
);


// ================================================================
// INITIAL MONITOR
// ================================================================

console.log(
  "🔥 Starting MONEY MAKING MACHINE BOT..."
);


monitorMarket();


// ================================================================
// PERIODIC MONITOR
// ================================================================

setInterval(
  monitorMarket,
  60 * 1000
);


// ================================================================
// SERVER
// ================================================================

app.listen(
  PORT,
  () => {

    console.log(
      `🔥 MONEY MAKING MACHINE BOT running on port ${PORT}`
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `📊 Strategy: 4H → 1H → 15M → 5M`
    );

  }
);
