# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project Overview

Automated trading bot that pulls live candle data from Binance, runs a technical analysis safety check, and executes trades on BitGet. Deployed to Railway on a cron schedule so it runs 24/7.

## Common Commands

```powershell
node bot.js                        # run the bot once (paper trading by default)
node bot.js --tax-summary          # print trade summary
railway up --detach                # deploy to Railway
railway service status             # check deployment status
railway logs                       # view logs from last run
railway variables                  # list all env vars
railway whoami                     # check Railway login
```

## Project Structure

| File | Purpose |
|------|---------|
| `bot.js` | Main bot — fetches data, runs safety check, executes trades |
| `rules.json` | Trading strategy — indicators and entry conditions |
| `.env` | BitGet credentials and trading config (never commit) |
| `.env.example` | Template for .env |
| `railway.json` | Railway deployment config (cron: every 4 hours) |
| `SETUP.bat` | One-click Windows setup script |
| `trades.csv` | Auto-generated tax log (written to Desktop\Trading Bot\ on Windows) |
| `safety-check-log.json` | Auto-generated decision log for every run |
| `prompts/01-extract-strategy.md` | Build rules.json from trader YouTube transcripts |
| `prompts/02-one-shot-trade.md` | One-shot prompt to run the full trading flow |
| `docs/setup-windows.md` | Windows MCP setup guide |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BITGET_API_KEY` | BitGet API key |
| `BITGET_SECRET_KEY` | BitGet secret key |
| `BITGET_PASSPHRASE` | BitGet API passphrase |
| `BITGET_BASE_URL` | BitGet base URL (default: https://api.bitget.com) |
| `TRADE_MODE` | `spot` or `futures` |
| `PORTFOLIO_VALUE_USD` | Portfolio size used to calculate position size |
| `MAX_TRADE_SIZE_USD` | Hard cap per trade in USD |
| `MAX_TRADES_PER_DAY` | Daily trade limit |
| `SYMBOL` | Trading pair (default: BTCUSDT) |
| `TIMEFRAME` | Chart timeframe (default: 4H) |
| `PAPER_TRADING` | `true` = log only, no real orders |

## Railway Deployment

- **Project**: claude-trading-bot
- **Service**: claude-trading-bot
- **Environment**: production
- **Cron schedule**: `0 */4 * * *` (every 4 hours)
- **Region**: us-west2

Set all env vars in one command:
```powershell
railway variables set KEY=value KEY2=value2 ...
```

## Trading Strategy

Defined in `rules.json` — VWAP + RSI(3) + EMA(8) scalping strategy.

**Bullish entry** (all must pass):
- Price above VWAP
- Price above EMA(8)
- RSI(3) below 30 (pullback in uptrend)
- Price within 1.5% of VWAP

**Bearish entry** (all must pass):
- Price below VWAP
- Price below EMA(8)
- RSI(3) above 70 (bounce in downtrend)
- Price within 1.5% of VWAP

## Trade Logs

- `trades.csv` — written to `Desktop\Trading Bot\trades.csv` on Windows, `./trades.csv` on Linux (Railway)
- `safety-check-log.json` — full decision log with indicator values for every run

## TradingView MCP (Local Mode)

MCP config: `%APPDATA%\Claude\claude_desktop_config.json`

TradingView must be launched with CDP enabled:
```powershell
& "C:\Program Files\WindowsApps\31178TradingViewInc.TradingView_3.1.0.0_x64__q4jpyh43s5mv6\TradingView.exe" --remote-debugging-port=9222
```

Verify with `tv_health_check` — should return `cdp_connected: true`.

## GitHub

- **Fork**: https://github.com/philipobura/claude-tradingview-mcp-trading
- **Upstream**: https://github.com/jackson-video-resources/claude-tradingview-mcp-trading
