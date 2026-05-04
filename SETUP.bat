@echo off
setlocal EnableDelayedExpansion
title Claude Trading Bot — Setup

echo.
echo ===================================================
echo   Claude Trading Bot — Setup
echo ===================================================
echo.

:: ── 1. Node.js ──────────────────────────────────────
echo [1/5] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo  X Node.js not found. Download from https://nodejs.org and re-run this script.
    pause & exit /b 1
)
for /f %%v in ('node --version') do echo  OK Node.js %%v

:: ── 2. npm dependencies ─────────────────────────────
echo.
echo [2/5] Installing dependencies...
call npm install --silent
if errorlevel 1 (
    echo  X npm install failed.
    pause & exit /b 1
)
echo  OK Dependencies installed.

:: ── 3. .env file ────────────────────────────────────
echo.
echo [3/5] Checking .env...
if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo  ! .env created from .env.example — fill in your BitGet credentials.
    echo     Opening .env now...
    start notepad .env
    echo.
    echo     Press any key once you've saved your credentials...
    pause >nul
) else (
    echo  OK .env already exists.
)

:: ── 4. Railway CLI ───────────────────────────────────
echo.
echo [4/5] Checking Railway CLI...
railway --version >nul 2>&1
if errorlevel 1 (
    echo  ! Railway CLI not found. Installing...
    call npm install -g @railway/cli
    if errorlevel 1 (
        echo  X Failed to install Railway CLI.
        pause & exit /b 1
    )
)
for /f %%v in ('railway --version') do echo  OK Railway CLI %%v

:: ── 5. Railway login ─────────────────────────────────
echo.
echo [5/5] Checking Railway login...
railway whoami >nul 2>&1
if errorlevel 1 (
    echo  ! Not logged in to Railway. Opening login...
    railway login
    railway whoami >nul 2>&1
    if errorlevel 1 (
        echo  X Railway login failed. Run 'railway login' manually and re-run this script.
        pause & exit /b 1
    )
)
for /f "delims=" %%u in ('railway whoami') do echo  OK Logged in as %%u

:: ── Done ─────────────────────────────────────────────
echo.
echo ===================================================
echo   Setup complete! Next steps:
echo.
echo   Run locally:   node bot.js
echo   Deploy:        railway up --detach
echo   Check status:  railway service status
echo   View logs:     railway logs
echo ===================================================
echo.
pause
