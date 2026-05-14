# PROJECT AUDIT — Claude Trading Bot
**Last updated:** 2026-05-14 (Telegram trade alerts)  
**Audited by:** Claude Code

---

## Project Overview

Automated trading bot deployed on Railway. Pulls live OHLCV data from Binance, runs a VWAP + RSI(3) + EMA(8) safety check against `rules.json`, and executes trades on BitGet. Runs as an always-on Express server (`server.js`) with an internal 5-minute cron. Currently in **Paper Trading mode**.

---

## Deployment

| Setting | Value |
|---|---|
| Platform | Railway |
| Project | claude-trading-bot |
| Service | claude-trading-bot |
| Service URL | `https://claude-trading-bot-production-750c.up.railway.app` |
| Region | us-west2 |
| Service type | Always-on web service (converted from cron on 2026-05-14) |
| Internal cron | every 5 minutes via `node-cron` inside `server.js` |
| Start command | `node server.js` |
| Restart policy | ON_FAILURE (max 3 retries) |
| Volume mount | `/data` — persists `position.json`, `trades.csv`, `safety-check-log.json` |

---

## HTTP API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Service health, last run status, volume mount check |
| `GET /api/summary` | Full bot summary — live price, indicators, all-time stats |
| `GET /api/trades` | Parsed trade log as JSON (`?limit=N`) |
| `GET /api/log` | Raw safety-check decision log as JSON |
| `GET /api/trades/download` | Download `trades.csv` directly from Railway volume |
| `GET /api/run-now` | Trigger an immediate bot run |
| `GET /api/report/send` | Trigger Telegram digest now (`?period=daily` or `?period=weekly`) |

---

## Changes Made (Post-Initial Build)

### 2026-05-11 — DATA_DIR Persistence + Cron Fix (`4d156eb`, `f1d9700`)
- Added `DATA_DIR` env var so `trades.csv`, `position.json`, and `safety-check-log.json` survive Railway container restarts.
- Changed Railway cron from `0 */4 * * *` (every 4H) to `*/5 * * * *` (every 5 minutes).
- Added Binance mirror fallback for candle fetching and RSI null-check fix.

### 2026-05-12 — Google Sheets Webhook Integration (`815d1d2`)
- `postToSheet()` posts every trade decision (blocked or executed) to a Google Sheet via webhook POST.
- Controlled by `SHEET_WEBHOOK_URL` env var; silently no-ops when unset.
- Added `"type": "module"` to `package.json` to suppress Node.js ESM warning.

### 2026-05-12 — Take Profit & Stop Loss Exit Logic (`a0d9e73`)
- Open position saved to `position.json` on entry, cleared on exit. Persists via `DATA_DIR`.
- TP/SL check runs first on every cron tick — skips entry logic if position is open.
- TP and SL configurable via `TAKE_PROFIT_PCT` and `STOP_LOSS_PCT` env vars.
- On exit: logs SELL row to `trades.csv`, posts to Google Sheet with P&L, clears `position.json`.

### 2026-05-13 — Timeframe + Always-On Server (`server.js` committed, `3b92510`)
- `server.js` committed and deployed — replaces Railway's cron-type service with an always-on Express web server that runs `bot.js` internally via `node-cron`.
- Added `GET /api/trades/download` endpoint to serve `trades.csv` directly from the Railway volume.
- Fixed stray `});` syntax error in `server.js` that was crashing startup (`d887c23`).

### 2026-05-14 — Service Type Fix (cron → always-on)
- Railway GraphQL API used to clear the `cronSchedule` field server-side (`serviceInstanceUpdate` mutation) — railway.json alone was insufficient.
- Service confirmed running as always-on web service. Health endpoint verified live.

### 2026-05-14 — Telegram Daily/Weekly Digest (`3744b7e`)
- `sendTelegram()` and `sendTelegramDigest()` added to `server.js`.
- **Daily digest:** fires automatically at midnight UTC — covers trades entered, closed, win rate, net P&L, and blocked count for the previous day.
- **Weekly digest:** fires every Monday at 00:05 UTC — same format, covers the rolling 7-day window.
- **Manual trigger:** `GET /api/report/send?period=daily|weekly` — fires the digest on demand.
- Controlled by `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` env vars; silently no-ops when unset.

### 2026-05-14 — Volume Filter Fix (`e9390a0`)
- Volume filter was reading 0% on every run because it was comparing the current live (still-forming) candle's volume, which Binance returns as near-zero at the start of each 5m window.
- Fixed by using the last **completed** candle (`index -2`) for both the current volume reading and the 20-period average baseline (`slice(-22, -2)`).
- Volume now reads correctly — confirmed at 97% and 248% on subsequent runs.

### 2026-05-14 — Telegram Trade Alerts (`bd2be8c`)
- `sendTelegram()` helper added to `bot.js` (reads same `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env vars already set on Railway).
- **BUY alert:** fires on every paper or live trade entry — shows price, size, TP, SL, RSI(3).
- **TP/SL exit alert:** fires when a position closes — shows entry→exit price and P&L $ and %.
- **Near-entry alert:** fires when RSI is the only failing condition and within 5 points of the threshold (e.g. RSI = 27 when threshold is < 25) — early warning before the bot triggers.

### 2026-05-14 — Strategy Tuning to Improve Win Rate (`0158e84`)
- **RSI long threshold:** `< 35` → `< 25` — requires a deeper pullback before entering long.
- **RSI reversal threshold:** `> 65` → `> 80` — counter-trend entries only on extreme RSI exhaustion.
- **Volume filter added:** current candle volume must exceed 50% of 20-period average — filters low-conviction moves.
- **Stop loss widened:** `0.5%` → `0.75%` — 3 of 5 prior SL exits were between 0.52–0.61%, within normal 5m noise.
- **Take profit raised:** `1.0%` → `1.5%` — maintains 2:1 R:R with the wider SL.

---

## Environment Variables (Full)

| Variable | Current Value | Description |
|---|---|---|
| `TAKE_PROFIT_PCT` | `1.5` | Take profit % above entry |
| `STOP_LOSS_PCT` | `0.75` | Stop loss % below entry |
| `SHEET_WEBHOOK_URL` | *(set)* | Google Sheets webhook endpoint |
| `DATA_DIR` | `/data` | Persistent volume path on Railway |
| `TIMEFRAME` | `5m` | Chart timeframe |
| `SYMBOL` | `BTCUSDT` | Trading pair |
| `PAPER_TRADING` | `true` | Paper mode — no real orders placed |
| `PORTFOLIO_VALUE_USD` | `500` | Portfolio size for position sizing |
| `MAX_TRADE_SIZE_USD` | `50` | Hard cap per trade |
| `MAX_TRADES_PER_DAY` | `3` | Daily trade limit |
| `TELEGRAM_BOT_TOKEN` | *(set)* | Telegram bot token for digest messages |
| `TELEGRAM_CHAT_ID` | `204857812` | Telegram chat ID to deliver digests to |

---

## Files (Runtime)

| File | Location | Purpose |
|---|---|---|
| `position.json` | `/data/position.json` | Tracks open position across cron runs |
| `trades.csv` | `/data/trades.csv` | Full trade log (BUY, SELL, BLOCKED rows) |
| `safety-check-log.json` | `/data/safety-check-log.json` | Decision log with indicator values per run |

---

## Paper Trading Performance (All Closed Trades to Date)

| Date | Entry | Exit | Reason | P&L |
|---|---|---|---|---|
| 2026-05-12 | $80,690 | $80,245 | Stop Loss | -$0.03 |
| 2026-05-12 | $80,390 | $79,972 | Stop Loss | -$0.03 |
| 2026-05-12 | $80,108 | $80,920 | **Take Profit** ✅ | **+$0.05** |
| 2026-05-13 | $81,060 | $80,567 | Stop Loss | -$0.03 |
| 2026-05-13 | $80,637 | $80,219 | Stop Loss | -$0.03 |
| 2026-05-13 | $80,252 | $79,789 | Stop Loss | -$0.03 |

**Win rate:** 1/6 = 17% (closed trades only) | **Net P&L:** -$0.09 (price) / -$0.15 (incl. fees)  
**Capital at risk:** $30 (6 × $5 trades) | **Return:** -0.5%  
**Break-even win rate at 2:1 R:R:** 33%

*Note: 14 total paper trades executed as of 2026-05-14 (incl. 2 open/in-progress today). Closed trade count above reflects confirmed exits only. Minimum 30 closed trades required for statistical conclusions.*

---

## Current Strategy (Post-Tuning)

**VWAP + RSI(3) + EMA(8) Scalping** — defined in `rules.json`

**Bullish entry (all must pass):**
- Price above VWAP
- Price above EMA(8)
- RSI(3) below **25** *(tightened from 35)*
- Price within 1.5% of VWAP
- Volume > 50% of 20-period average *(new)*

**Bearish reversal entry (all must pass):**
- Price below VWAP
- Price below EMA(8)
- RSI(3) above **80** *(tightened from 65)*
- Price within 1.5% of VWAP
- Volume > 50% of 20-period average *(new)*

**Exit rules:**
- Take Profit: +1.5% above entry *(raised from 1.0%)*
- Stop Loss: -0.75% below entry *(widened from 0.5%)*
- Risk/reward: 2:1

---

## Known Behaviours / Observations

- RSI(3) occasionally reads `0` or `100` at session open — RSI null-check applied but still observed. Monitor.
- `railway logs` requires a TTY and cannot be piped. Use Railway dashboard or terminal directly.
- `safety-check-log.json` in local repo is stale. Live copy is at `/data/safety-check-log.json` on Railway volume.
- The `computeSummary` function in `server.js` double-counts BUY + SELL quantities — `totalSpentUSD` and `quantityBTC` in `/api/summary` are inflated. Use `/api/trades/download` for accurate P&L.
- Trade frequency will drop with tighter RSI thresholds — this is intentional.

---

## How to Measure Strategy Improvement

| Metric | Target | Where to Check |
|---|---|---|
| Win rate | > 33% (break-even) | `/api/trades/download` |
| Avg loss size | ~$0.04 | trades.csv SELL rows |
| Avg win size | ~$0.08 | trades.csv SELL rows |
| RSI at entry (longs) | < 20 on winners | `/api/log` |
| Sample size | ≥ 30 trades | trades.csv row count |

---

## Recommended Next Steps

- [ ] Run 30+ paper trades before drawing conclusions on the tuned strategy
- [ ] Fix `computeSummary` in `server.js` — net BUY/SELL quantities instead of summing all executions
- [ ] Consider `MAX_HOLD_HOURS` fallback exit for positions that never hit TP or SL
- [ ] Review RSI = 0/100 anomaly at session open — add minimum session candle count guard
- [x] Telegram daily/weekly digest — live as of 2026-05-14
- [x] Volume filter 0% bug fixed — live as of 2026-05-14
- [x] Telegram trade alerts (BUY entry, TP/SL exit, near-entry warning) — live as of 2026-05-14
