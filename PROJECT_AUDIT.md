# PROJECT AUDIT — Claude Trading Bot
**Last updated:** 2026-05-13  
**Audited by:** Claude Code

---

## Project Overview

Automated trading bot deployed on Railway. Pulls live OHLCV data from Binance, runs a VWAP + RSI(3) + EMA(8) safety check against `rules.json`, and executes trades on BitGet. Runs on a 5-minute cron. Currently in **Paper Trading mode**.

---

## Deployment

| Setting | Value |
|---|---|
| Platform | Railway |
| Project | claude-trading-bot |
| Service | claude-trading-bot |
| Region | us-west2 |
| Cron | every 5 minutes (changed from 4H on 2026-05-11) |
| Start command | `node server.js` |
| Restart policy | ON_FAILURE (max 3 retries) |
| Volume mount | `/data` — persists `position.json`, `trades.csv`, `safety-check-log.json` |

---

## Changes Made (Post-Initial Build)

### 2026-05-11 — DATA_DIR Persistence + Cron Fix (`4d156eb`, `f1d9700`)
- Added `DATA_DIR` env var support so `trades.csv` and `safety-check-log.json` survive Railway container restarts between cron runs.
- `POSITION_FILE`, `LOG_FILE`, and `CSV_FILE` now resolve to `DATA_DIR` when set.
- Changed Railway cron from `0 */4 * * *` (every 4H) to `*/5 * * * *` (every 5 minutes) in `railway.json`.
- Added Binance mirror fallback for candle fetching and RSI null-check fix.

### 2026-05-12 — Google Sheets Webhook Integration (`815d1d2`)
- Added `postToSheet()` function — posts every trade decision (blocked or executed) to a Google Sheet via webhook POST.
- Controlled by `SHEET_WEBHOOK_URL` env var; silently no-ops when unset.
- Payload includes: date, time, exchange, symbol, side, quantity, price, total, fee, order ID, mode (PAPER/LIVE), notes.
- Added `"type": "module"` to `package.json` to suppress Node.js ESM warning.

### 2026-05-12 — Take Profit & Stop Loss Exit Logic (`a0d9e73`)
- **Position tracking:** Open position now saved to `position.json` on entry, cleared on exit. Persists across cron runs via `DATA_DIR` volume mount.
- **TP/SL check runs first:** On every cron tick, bot loads `position.json` before evaluating new entries. If a position is open, it checks TP/SL and skips the entry logic entirely.
- **TP:** +1.0% above entry price (configurable via `TAKE_PROFIT_PCT` env var)
- **SL:** -0.5% below entry price (configurable via `STOP_LOSS_PCT` env var)
- **Risk/reward:** 2:1
- **On exit:** Logs SELL row to `trades.csv`, posts exit event to Google Sheet (with P&L), clears `position.json`.
- **Paper mode:** Prints `📋 PAPER SELL` with P&L; skips BitGet API call.
- **Live mode:** Places a market SELL order on BitGet on TP/SL trigger.

### 2026-05-13 — Timeframe Variable Update (today)
- Set `TIMEFRAME=5m` via `railway variables --set` before deploying.
- Redeployed with `railway up --detach`.

---

## New Environment Variables Added

| Variable | Default | Description |
|---|---|---|
| `TAKE_PROFIT_PCT` | `1.0` | Take profit % above entry |
| `STOP_LOSS_PCT` | `0.5` | Stop loss % below entry |
| `SHEET_WEBHOOK_URL` | *(unset)* | Google Sheets webhook endpoint |
| `DATA_DIR` | *(unset)* | Path for persistent volume (Railway: `/data`) |
| `TIMEFRAME` | `4H` | Chart timeframe — currently set to `5m` |

---

## New Files Added

| File | Location | Purpose |
|---|---|---|
| `position.json` | `DATA_DIR` or project root | Tracks open position across cron runs |

---

## Current Live Status (2026-05-13)

| Field | Value |
|---|---|
| Mode | Paper Trading |
| Symbol | BTCUSDT |
| Timeframe | 5m |
| Trades today | 2 / 3 |
| Google Sheet sync | ✅ Active |

### Trade 1 (closed)
| Field | Value |
|---|---|
| Side | LONG |
| Entry | $81,060.01 |
| Exit | $80,567.29 |
| Reason | Stop Loss hit |
| P&L | -$0.03 (-0.61%) |

### Trade 2 (open as of last log ~11:35 UTC)
| Field | Value |
|---|---|
| Side | LONG |
| Entry | $80,637.35 |
| Size | $5.00 |
| Take Profit | $81,443.72 (+1.0%) |
| Stop Loss | $80,234.16 (-0.5%) |
| Last price | $80,663.47 |
| Status | ⏳ Holding |

---

## Strategy (unchanged)

**VWAP + RSI(3) + EMA(8) Scalping** — defined in `rules.json`

**Bullish entry (all must pass):**
- Price above VWAP
- Price above EMA(8)
- RSI(3) below 30 (pullback in uptrend)
- Price within 1.5% of VWAP

**Bearish entry (all must pass):**
- Price below VWAP
- Price below EMA(8)
- RSI(3) above 65 (bounce in downtrend)
- Price within 1.5% of VWAP

---

## Known Behaviours / Observations

- RSI(3) occasionally reads `0` — RSI null-check fix applied (May 11) but worth monitoring.
- `railway logs` cannot be piped or captured non-interactively (requires TTY). Use Railway dashboard or terminal directly.
- Bot restarts container on each cron tick (`Mounting volume... Starting Container` visible in logs) — this is normal Railway behaviour for cron services, not a crash loop.
- `safety-check-log.json` in the local repo is stale (last local write: 2026-05-12). Live logs are written to `/data/safety-check-log.json` on the Railway volume.

---

## Recommended Next Steps

- [ ] Monitor Trade 2 — price approaching SL zone (~$80,234)
- [ ] Confirm `SHEET_WEBHOOK_URL` is set in Railway env vars (Google Sheet updates showing ✅ in logs, so it is active)
- [ ] Consider adding a `MAX_HOLD_HOURS` fallback exit in case TP/SL are never triggered on a slow 5m candle
- [ ] Review RSI(3) = 0 anomaly — may need a minimum candle count guard before RSI calculation
