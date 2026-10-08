@echo off
REM ===========================================================================
REM  Upstream bridge - TikTok LIVE -> moderator -> TTLive (Windows)
REM
REM    run.bat @streamername [--wait] [--test | --inject]
REM
REM    default  connect to LIVE, forward every event to the moderator (:3002),
REM             which forwards clean events on to TTLive (:3001)
REM    --wait   streamer NOT live yet? Pause first ("Press ENTER when LIVE"),
REM             then connect. If the bridge drops/exits, ENTER retries, q quits.
REM    --test   read-only capture test (prints events, forwards nothing)
REM    --inject manual chat injector (no LIVE stream needed)
REM
REM  First run copies .env.example -> .env. Set API_TOKEN (= moderator's
REM  API_TOKEN) and TIKTOK_EULER_API_KEY for production stability.
REM ===========================================================================
setlocal EnableExtensions
title Upstream bridge
cd /d "%~dp0" 2>nul

REM -- parse args: username + flags in any order --------------------------------
set "USER="
set "MODE=bridge"
set "WAIT="
:parseargs
if "%~1"=="" goto argsdone
if /i "%~1"=="--wait" set "WAIT=1"
if /i "%~1"=="--test" set "MODE=test"
if /i "%~1"=="--inject" set "MODE=inject"
if not "%~1"=="--wait" if not "%~1"=="--test" if not "%~1"=="--inject" if not defined USER set "USER=%~1"
shift
goto parseargs
:argsdone

if /i "%MODE%"=="inject" goto inject
if "%USER%"=="" (
  echo Usage: run.bat @streamername [--wait] [--test ^| --inject]
  echo Example: run.bat @ahappyspell
  echo          run.bat @ahappyspell --wait   (not live yet: ENTER when live)
  echo          run.bat @ahappyspell --test
  echo          run.bat --inject
  pause
  exit /b 1
)

REM -- first run: create .env from the template --------------------------------
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [i] Created upstream\.env - set API_TOKEN + TIKTOK_EULER_API_KEY.
)

REM -- one-time deps ------------------------------------------------------------
if not exist "node_modules" (
  echo [i] Installing dependencies (one-time, ~1 min)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
  )
)

REM -- preflight: node present + moderator health (fail fast, not 500 forwards) ----
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+ from https://nodejs.org/
  pause
  exit /b 1
)
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:3002/healthz' -TimeoutSec 3 -UseBasicParsing).StatusCode } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Moderator not answering http://127.0.0.1:3002/healthz
  echo         Start it first:  a.bat @streamername   (or run.bat in repo root)
  pause
  exit /b 1
)

if /i "%MODE%"=="test" goto test
goto bridge

:test
echo [i] Read-only capture test for %USER% (forwards nothing)...
call npx ts-node test-tiktok.ts %USER%
goto done

:inject
echo [i] Manual injector - type chat, it posts to TTLIVE_URL/api/comment...
call npx ts-node inject-comments.ts
goto done

:bridge
if defined WAIT (
  echo.
  echo [i] %USER% is not live yet - no problem. Time it yourself for an
  echo     instant connect instead of waiting on slow-poll:
  set /p "GO=Press ENTER when %USER% goes LIVE to connect (Ctrl+C to cancel): "
  set "WAIT="
)
echo [i] Bridging %USER% -^> moderator (TTLIVE_URL from .env)...
call npx ts-node bridge-to-ttlive.ts %USER%
echo.
echo Bridge exited (code %ERRORLEVEL%).
set /p "RETRY=Press ENTER to (re)connect, or type q + ENTER to quit: "
if /i "%RETRY%"=="q" goto done
goto bridge

:done
echo.
echo Bridge stopped.
pause
