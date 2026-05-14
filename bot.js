/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length === 0) {
    const csvPath = new URL("trades.csv", import.meta.url).pathname;
    console.log(`\n📄 Trade log: ${csvPath}`);
    console.log(
      `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
        `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
    );
    return;
  }

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "1.0") / 100,
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "0.5") / 100,
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

// DATA_DIR overrides default write location — used on Railway with a persistent
// volume mounted at e.g. /data so trades.csv and safety-check-log.json survive
// across cron invocations. Falls back to existing behavior when unset.
const DATA_DIR = process.env.DATA_DIR || null;
const SHEET_WEBHOOK = process.env.SHEET_WEBHOOK_URL || null;
const LOG_FILE = DATA_DIR ? join(DATA_DIR, "safety-check-log.json") : "safety-check-log.json";
const POSITION_FILE = DATA_DIR ? join(DATA_DIR, "position.json") : "position.json";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

// ─── Telegram Alerts ─────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.log(`[telegram] alert failed: ${err.message}`);
  }
}

// ─── Google Sheet Webhook ────────────────────────────────────────────────────

async function postToSheet(logEntry) {
  if (!SHEET_WEBHOOK) return;
  const now = new Date(logEntry.timestamp);
  const failed = logEntry.conditions
    ? logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ")
    : "";
  const payload = {
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 19),
    exchange: "BitGet",
    symbol: logEntry.symbol,
    side: logEntry.orderPlaced ? "BUY" : "",
    quantity: logEntry.orderPlaced ? (logEntry.tradeSize / logEntry.price).toFixed(6) : "",
    price: logEntry.price.toFixed(2),
    total: logEntry.orderPlaced ? logEntry.tradeSize.toFixed(2) : "",
    fee: logEntry.orderPlaced ? (logEntry.tradeSize * 0.001).toFixed(4) : "",
    orderId: logEntry.orderId || "",
    mode: logEntry.paperTrading ? "PAPER" : "LIVE",
    notes: !logEntry.allPass ? `Blocked: ${failed}` : logEntry.error ? `Error: ${logEntry.error}` : "All conditions met",
  };
  try {
    await fetch(SHEET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("Google Sheet updated ✅");
  } catch (err) {
    console.log(`Google Sheet webhook failed: ${err.message}`);
  }
}

// ─── Position Management ─────────────────────────────────────────────────────

function loadPosition() {
  if (!existsSync(POSITION_FILE)) return null;
  const data = JSON.parse(readFileSync(POSITION_FILE, "utf8"));
  return data;
}

function savePosition(position) {
  writeFileSync(POSITION_FILE, JSON.stringify(position, null, 2));
}

function clearPosition() {
  writeFileSync(POSITION_FILE, JSON.stringify(null));
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, candles, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Volume filter — use the last COMPLETED candle (index -2) since the current
  // candle (index -1) is still forming and often has near-zero volume on Binance.
  const volumes = candles.map((c) => c.volume);
  const avgVol20 = volumes.slice(-22, -2).reduce((a, b) => a + b, 0) / 20;
  const currentVol = volumes[volumes.length - 2];
  const volPct = avgVol20 > 0 ? (currentVol / avgVol20) * 100 : 100;

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // Tightened: 35 → 25 — require deeper pullback for stronger snap-back signal
    check(
      "RSI(3) below 25 (deep pullback in uptrend)",
      "< 25",
      rsi3.toFixed(2),
      rsi3 < 25,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );

    check(
      "Volume above 50% of 20-period average (conviction)",
      "> 50%",
      `${volPct.toFixed(0)}%`,
      avgVol20 === 0 || currentVol > avgVol20 * 0.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking reversal entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    // Tightened: 65 → 80 — require extreme overbought for counter-trend entry
    check(
      "RSI(3) above 80 (extreme overbought reversal setup)",
      "> 80",
      rsi3.toFixed(2),
      rsi3 > 80,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );

    check(
      "Volume above 50% of 20-period average (conviction)",
      "> 50%",
      `${volPct.toFixed(0)}%`,
      avgVol20 === 0 || currentVol > avgVol20 * 0.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_DIR = DATA_DIR
  ? DATA_DIR
  : process.platform === "win32"
  ? join(homedir(), "Desktop", "Trading Bot")
  : ".";
const CSV_FILE = join(CSV_DIR, "trades.csv");

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_DIR)) mkdirSync(CSV_DIR, { recursive: true });
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function writeSellCsv(position, exitPrice, exitReason, pnl) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const mode = position.paperTrading ? "PAPER" : "LIVE";
  const totalUSD = (position.quantity * exitPrice).toFixed(2);
  const fee = (parseFloat(totalUSD) * 0.001).toFixed(4);
  const notes = `${exitReason} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`;

  const row = [
    date, time, "BitGet", position.symbol, "SELL",
    position.quantity, exitPrice.toFixed(2), totalUSD, fee,
    (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2),
    position.orderId || "", mode, `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

async function postExitToSheet(position, exitPrice, exitReason, pnl) {
  if (!SHEET_WEBHOOK) return;
  const now = new Date();
  const totalUSD = (position.quantity * exitPrice).toFixed(2);
  const fee = (parseFloat(totalUSD) * 0.001).toFixed(4);
  const payload = {
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 19),
    exchange: "BitGet",
    symbol: position.symbol,
    side: "SELL",
    quantity: position.quantity,
    price: exitPrice.toFixed(2),
    total: totalUSD,
    fee,
    orderId: position.orderId || "",
    mode: position.paperTrading ? "PAPER" : "LIVE",
    notes: `${exitReason} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`,
  };
  try {
    await fetch(SHEET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("Google Sheet updated ✅");
  } catch (err) {
    console.log(`Google Sheet webhook failed: ${err.message}`);
  }
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // ── Check open position (TP/SL) ─────────────────────────────────────────
  const position = loadPosition();
  if (position) {
    console.log("\n── Open Position ────────────────────────────────────────\n");
    console.log(`  Symbol:  ${position.symbol}`);
    console.log(`  Entry:   $${position.entryPrice.toFixed(2)}`);
    console.log(`  Size:    $${position.tradeSize.toFixed(2)}`);
    console.log(`  TP:      $${position.tpPrice.toFixed(2)} (+${(CONFIG.takeProfitPct * 100).toFixed(1)}%)`);
    console.log(`  SL:      $${position.slPrice.toFixed(2)} (-${(CONFIG.stopLossPct * 100).toFixed(1)}%)`);

    const exitCandles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 10);
    const exitPrice = exitCandles[exitCandles.length - 1].close;
    console.log(`  Current: $${exitPrice.toFixed(2)}`);

    const tpHit = exitPrice >= position.tpPrice;
    const slHit = exitPrice <= position.slPrice;

    if (tpHit || slHit) {
      const exitReason = tpHit ? "TAKE PROFIT" : "STOP LOSS";
      const pnl = (exitPrice - position.entryPrice) * position.quantity;
      const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice * 100).toFixed(2);

      console.log(`\n  ${tpHit ? "✅" : "🛑"} ${exitReason} HIT`);
      console.log(`  Exit:  $${exitPrice.toFixed(2)}`);
      console.log(`  P&L:   ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} (${pnl >= 0 ? "+" : ""}${pnlPct}%)`);

      if (!position.paperTrading) {
        try {
          await placeBitGetOrder(CONFIG.symbol, "sell", position.tradeSize, exitPrice);
          console.log(`  SELL order placed on BitGet ✅`);
        } catch (err) {
          console.log(`  ❌ SELL order failed: ${err.message}`);
        }
      } else {
        console.log(`  📋 PAPER SELL — $${(position.quantity * exitPrice).toFixed(2)}`);
      }

      writeSellCsv(position, exitPrice, exitReason, pnl);
      await postExitToSheet(position, exitPrice, exitReason, pnl);
      const pnlSign = pnl >= 0 ? "+" : "";
      await sendTelegram(
        `${tpHit ? "✅" : "🛑"} *${exitReason} — ${position.symbol}*\n` +
        `Entry: $${position.entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
        `P&L: ${pnlSign}$${pnl.toFixed(4)} (${pnlSign}${pnlPct}%)\n` +
        `Mode: ${position.paperTrading ? "PAPER" : "LIVE"}`
      );
      clearPosition();
    } else {
      const distToTP = ((position.tpPrice - exitPrice) / exitPrice * 100).toFixed(2);
      const distToSL = ((exitPrice - position.slPrice) / exitPrice * 100).toFixed(2);
      console.log(`\n  ⏳ Holding — TP in +${distToTP}% | SL in -${distToSL}%`);
    }

    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap !== null ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 !== null ? rsi3.toFixed(2) : "N/A"}`);

  if (vwap === null || rsi3 === null) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Run safety check
  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, candles, rules);

  // Near-entry alert: RSI is the only failing condition and within 5 points of threshold
  if (!allPass) {
    const failing = results.filter((r) => !r.pass);
    const onlyRsiFailing = failing.length === 1 && failing[0].label.startsWith("RSI");
    if (onlyRsiFailing) {
      const bullishBias = price > vwap && price > ema8;
      const nearThreshold = bullishBias ? rsi3 < 30 : rsi3 > 75;
      if (nearThreshold) {
        const bias = bullishBias ? "LONG" : "SHORT";
        const threshold = bullishBias ? "< 25" : "> 80";
        await sendTelegram(
          `⚠️ *Near Entry — ${CONFIG.symbol}*\n` +
          `Bias: ${bias} | RSI(3): ${rsi3.toFixed(1)} (need ${threshold})\n` +
          `Price: $${price.toFixed(2)} | EMA(8): $${ema8.toFixed(2)} | VWAP: $${vwap.toFixed(2)}\n` +
          `_All other conditions pass — watching for RSI_`
        );
      }
    }
  }

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      savePosition({
        symbol: CONFIG.symbol,
        entryPrice: price,
        quantity: parseFloat((tradeSize / price).toFixed(6)),
        tradeSize,
        orderId: logEntry.orderId,
        timestamp: logEntry.timestamp,
        paperTrading: CONFIG.paperTrading,
        tpPrice: price * (1 + CONFIG.takeProfitPct),
        slPrice: price * (1 - CONFIG.stopLossPct),
      });
      console.log(`  TP: $${(price * (1 + CONFIG.takeProfitPct)).toFixed(2)} | SL: $${(price * (1 - CONFIG.stopLossPct)).toFixed(2)}`);
      await sendTelegram(
        `📋 *PAPER BUY — ${CONFIG.symbol}*\n` +
        `Price: $${price.toFixed(2)} | Size: $${tradeSize.toFixed(2)}\n` +
        `TP: $${(price * (1 + CONFIG.takeProfitPct)).toFixed(2)} (+${(CONFIG.takeProfitPct * 100).toFixed(1)}%) | SL: $${(price * (1 - CONFIG.stopLossPct)).toFixed(2)} (-${(CONFIG.stopLossPct * 100).toFixed(1)}%)\n` +
        `RSI(3): ${rsi3.toFixed(1)} | VWAP: $${vwap.toFixed(2)}`
      );
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`,
      );
      try {
        const order = await placeBitGetOrder(
          CONFIG.symbol,
          "buy",
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
        savePosition({
          symbol: CONFIG.symbol,
          entryPrice: price,
          quantity: parseFloat((tradeSize / price).toFixed(6)),
          tradeSize,
          orderId: order.orderId,
          timestamp: logEntry.timestamp,
          paperTrading: CONFIG.paperTrading,
          tpPrice: price * (1 + CONFIG.takeProfitPct),
          slPrice: price * (1 - CONFIG.stopLossPct),
        });
        console.log(`  TP: $${(price * (1 + CONFIG.takeProfitPct)).toFixed(2)} | SL: $${(price * (1 - CONFIG.stopLossPct)).toFixed(2)}`);
        await sendTelegram(
          `🔴 *LIVE BUY — ${CONFIG.symbol}*\n` +
          `Order: ${order.orderId}\n` +
          `Price: $${price.toFixed(2)} | Size: $${tradeSize.toFixed(2)}\n` +
          `TP: $${(price * (1 + CONFIG.takeProfitPct)).toFixed(2)} (+${(CONFIG.takeProfitPct * 100).toFixed(1)}%) | SL: $${(price * (1 - CONFIG.stopLossPct)).toFixed(2)} (-${(CONFIG.stopLossPct * 100).toFixed(1)}%)`
        );
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  // Post to Google Sheet
  await postToSheet(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
