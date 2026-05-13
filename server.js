/**
 * Trading Bot — HTTP API + Internal Scheduler
 *
 * Replaces Railway's cron-service model with an always-on web service:
 *   • Internal node-cron fires `node bot.js` every 5 minutes (one-shot, sandboxed).
 *   • Express serves read-only JSON endpoints (/api/summary, /api/trades,
 *     /api/log, /api/health) that the Cowork dashboard polls.
 *
 * Required env vars on Railway:
 *   PORT       → injected automatically by Railway
 *   DATA_DIR   → /data  (mount point of the Railway Volume; persists trade logs)
 * Optional:
 *   API_KEY    → if set, /api/* require ?key=<API_KEY>  (read-only data, so off by default)
 *   CRON_SPEC  → override the default (every 5 minutes)
 */

import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { spawn } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const API_KEY = process.env.API_KEY || null;
const CRON_SPEC = process.env.CRON_SPEC || "*/5 * * * *";
const SYMBOL = process.env.SYMBOL || "BTCUSDT";

const TRADES_CSV = join(DATA_DIR, "trades.csv");
const LOG_FILE = join(DATA_DIR, "safety-check-log.json");

// ─── Run state (in-memory) ──────────────────────────────────────────────────

let lastRunAt = null;
let lastRunOk = null;
let lastRunStderr = "";
let runInFlight = false;
let runCount = 0;
const startedAt = new Date().toISOString();

// ─── Spawn the trading bot ──────────────────────────────────────────────────

function runBot(reason = "cron") {
  if (runInFlight) {
    console.log(`[scheduler] skip — previous run still in flight (${reason})`);
    return;
  }
  runInFlight = true;
  runCount += 1;
  const startedAtMs = Date.now();
  console.log(`[scheduler] starting bot.js (#${runCount}, ${reason})`);

  const child = spawn(process.execPath, ["bot.js"], {
    cwd: __dirname,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stdout.on("data", (b) => process.stdout.write(b));
  child.stderr.on("data", (b) => {
    stderrBuf += b.toString();
    process.stderr.write(b);
  });

  child.on("close", (code) => {
    const dur = ((Date.now() - startedAtMs) / 1000).toFixed(1);
    lastRunAt = new Date().toISOString();
    lastRunOk = code === 0;
    lastRunStderr = code === 0 ? "" : stderrBuf.slice(-500);
    runInFlight = false;
    console.log(`[scheduler] bot.js exited code=${code} dur=${dur}s`);
  });

  child.on("error", (err) => {
    lastRunAt = new Date().toISOString();
    lastRunOk = false;
    lastRunStderr = String(err);
    runInFlight = false;
    console.error(`[scheduler] spawn error: ${err.message}`);
  });
}

// Seed run on startup so the volume gets populated immediately.
runBot("startup");
cron.schedule(CRON_SPEC, () => runBot("cron"), { timezone: "UTC" });
console.log(`[scheduler] cron registered: "${CRON_SPEC}" (UTC)`);

// ─── CSV parser (handles quoted Notes field) ────────────────────────────────

function parseCSVLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Headers: Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes
function readTrades() {
  if (!existsSync(TRADES_CSV)) return [];
  const lines = readFileSync(TRADES_CSV, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const rows = lines.slice(1).map(parseCSVLine);
  return rows
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0])) // drops the funny "NOTE" row
    .map((r) => ({
      date: r[0],
      time: r[1],
      exchange: r[2],
      symbol: r[3],
      side: r[4],
      quantity: parseFloat(r[5]) || 0,
      price: parseFloat(r[6]) || 0,
      totalUSD: parseFloat(r[7]) || 0,
      fee: parseFloat(r[8]) || 0,
      netAmount: parseFloat(r[9]) || 0,
      orderId: r[10],
      mode: r[11],
      notes: (r[12] || "").replace(/^"|"$/g, ""),
    }));
}

function readLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  try {
    return JSON.parse(readFileSync(LOG_FILE, "utf8"));
  } catch (err) {
    return { trades: [], _parseError: String(err) };
  }
}

// ─── Live price (cached 30 s) ───────────────────────────────────────────────

let priceCache = { value: null, at: 0 };
async function getLivePrice() {
  const now = Date.now();
  if (priceCache.value && now - priceCache.at < 30_000) return priceCache.value;
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    const price = parseFloat(data.price);
    if (!isFinite(price)) throw new Error("non-numeric price");
    priceCache = { value: price, at: now };
    return price;
  } catch (err) {
    console.warn(`[price] live fetch failed: ${err.message}`);
    return priceCache.value; // last-known
  }
}

// ─── Summary computation ────────────────────────────────────────────────────

function computeSummary(trades, livePrice) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const executed = trades.filter((t) => t.mode === "PAPER" || t.mode === "LIVE");
  const blocked = trades.filter((t) => t.mode === "BLOCKED");

  const totalQty = executed.reduce((s, t) => s + t.quantity, 0);
  const totalSpent = executed.reduce((s, t) => s + t.totalUSD, 0);
  const totalFees = executed.reduce((s, t) => s + t.fee, 0);
  const avgEntry = totalQty > 0 ? totalSpent / totalQty : 0;

  let currentValue = null;
  let unrealizedPnLUSD = null;
  let unrealizedPnLPct = null;
  if (livePrice && totalQty > 0) {
    currentValue = totalQty * livePrice;
    unrealizedPnLUSD = currentValue - totalSpent;
    unrealizedPnLPct = (unrealizedPnLUSD / totalSpent) * 100;
  }

  const tradesToday = executed.filter((t) => t.date === today);
  const tradesYesterday = executed.filter((t) => t.date === yesterday);
  const blockedToday = blocked.filter((t) => t.date === today);

  return {
    allTime: {
      totalDecisions: trades.length,
      tradesExecuted: executed.length,
      paperTrades: executed.filter((t) => t.mode === "PAPER").length,
      liveTrades: executed.filter((t) => t.mode === "LIVE").length,
      blockedTrades: blocked.length,
      totalQuantity: round(totalQty, 6),
      totalSpentUSD: round(totalSpent, 2),
      totalFeesUSD: round(totalFees, 4),
      avgEntryPrice: round(avgEntry, 2),
    },
    position: {
      quantityBTC: round(totalQty, 6),
      costBasisUSD: round(totalSpent, 2),
      avgEntryPrice: round(avgEntry, 2),
      currentPrice: livePrice ? round(livePrice, 2) : null,
      currentValueUSD: currentValue !== null ? round(currentValue, 2) : null,
      unrealizedPnLUSD: unrealizedPnLUSD !== null ? round(unrealizedPnLUSD, 2) : null,
      unrealizedPnLPct: unrealizedPnLPct !== null ? round(unrealizedPnLPct, 2) : null,
    },
    today: {
      date: today,
      tradesPlaced: tradesToday.length,
      tradesBlocked: blockedToday.length,
      spentUSD: round(tradesToday.reduce((s, t) => s + t.totalUSD, 0), 2),
      feesUSD: round(tradesToday.reduce((s, t) => s + t.fee, 0), 4),
    },
    yesterday: {
      date: yesterday,
      tradesPlaced: tradesYesterday.length,
      spentUSD: round(tradesYesterday.reduce((s, t) => s + t.totalUSD, 0), 2),
    },
  };
}

function round(x, dp) {
  if (x === null || x === undefined || !isFinite(x)) return x;
  const m = Math.pow(10, dp);
  return Math.round(x * m) / m;
}

// ─── Auth + CORS middleware ─────────────────────────────────────────────────

function corsAllow(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
}

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const supplied = req.query.key || req.get("X-API-Key");
  if (supplied === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ─── App ────────────────────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => { corsAllow(res); if (req.method === "OPTIONS") return res.sendStatus(204); next(); });

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Trading Bot API</title>
<style>body{font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px;color:#222}code{background:#f4f4f5;padding:2px 6px;border-radius:4px}a{color:#0a66c2}</style>
</head><body><h1>Trading Bot API</h1>
<p>Running. Internal scheduler: <code>${CRON_SPEC}</code> · started ${startedAt}</p>
<p>Endpoints:</p>
<ul>
  <li><a href="/api/health">/api/health</a></li>
  <li><a href="/api/summary">/api/summary</a></li>
  <li><a href="/api/trades?limit=20">/api/trades?limit=20</a></li>
  <li><a href="/api/log?limit=20">/api/log?limit=20</a></li>
  <li><a href="/api/trades/download">/api/trades/download</a> — download trades.csv</li>
</ul>
<p>Dashboard reads <code>/api/summary</code>.</p>
</body></html>`);
});

app.get("/api/health", (req, res) => {
  let dataDirOk = false;
  let dataDirInfo = { dir: DATA_DIR, exists: false };
  try {
    dataDirInfo.exists = existsSync(DATA_DIR);
    if (dataDirInfo.exists) dataDirInfo.isDir = statSync(DATA_DIR).isDirectory();
    dataDirOk = dataDirInfo.exists && dataDirInfo.isDir !== false;
  } catch (err) { dataDirInfo.error = String(err); }

  res.json({
    ok: true,
    startedAt,
    nowUTC: new Date().toISOString(),
    runCount,
    runInFlight,
    lastRunAt,
    lastRunOk,
    lastRunStderr: lastRunStderr ? lastRunStderr.slice(0, 200) : "",
    cron: CRON_SPEC,
    dataDir: dataDirInfo,
    dataDirOk,
    tradesCsvExists: existsSync(TRADES_CSV),
    logFileExists: existsSync(LOG_FILE),
    symbol: SYMBOL,
    apiKeyRequired: Boolean(API_KEY),
  });
});

app.get("/api/summary", requireKey, async (req, res) => {
  try {
    const trades = readTrades();
    const log = readLog();
    const last = log.trades && log.trades.length ? log.trades[log.trades.length - 1] : null;
    const livePrice = await getLivePrice();
    const summary = computeSummary(trades, livePrice);

    res.json({
      generatedAt: new Date().toISOString(),
      symbol: SYMBOL,
      bot: {
        startedAt,
        lastRunAt,
        lastRunOk,
        runCount,
        runInFlight,
        cron: CRON_SPEC,
        paperTrading: last ? Boolean(last.paperTrading) : null,
        timeframe: last ? last.timeframe : null,
      },
      latest: last ? {
        timestamp: last.timestamp,
        price: last.price,
        indicators: last.indicators,
        conditions: last.conditions,
        allPass: last.allPass,
        orderPlaced: last.orderPlaced,
        orderId: last.orderId,
        tradesToday: last.limits ? last.limits.tradesToday : null,
        maxTradesPerDay: last.limits ? last.limits.maxTradesPerDay : null,
      } : null,
      ...summary,
    });
  } catch (err) {
    console.error("/api/summary error:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/trades", requireKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10) || 50, 500);
  const trades = readTrades();
  res.json({ count: trades.length, returned: Math.min(limit, trades.length), trades: trades.slice(-limit).reverse() });
});

app.get("/api/log", requireKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10) || 20, 200);
  const log = readLog();
  const entries = log.trades || [];
  res.json({ count: entries.length, returned: Math.min(limit, entries.length), entries: entries.slice(-limit).reverse() });
});

app.get("/api/run-now", requireKey, (req, res) => {
  if (runInFlight) return res.status(429).json({ ok: false, error: "run already in flight" });
  runBot("manual");
  res.json({ ok: true, started: true });
});

app.get("/api/trades/download", requireKey, (req, res) => {
  if (!existsSync(TRADES_CSV)) return res.status(404).json({ error: "trades.csv not found" });
  res.setHeader("Content-Disposition", 'attachment; filename="trades.csv"');
  res.setHeader("Content-Type", "text/csv");
  res.sendFile(TRADES_CSV);
});

app.use((req, res) => res.status(404).json({ error: "not found" }));

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} (DATA_DIR=${DATA_DIR}, API_KEY=${API_KEY ? "set" : "off"})`);
});
});
