@echo off
REM ===========================================================================
REM  Upstream bridge - TikTok LIVE -> moderator -> TTLive (Windows)
REM
REM    run.bat @streamername [--test | --inject]
REM
REM    default  connect to LIVE, forward every event to the moderator (:3002),
REM             which forwards clean events on to TTLive (:3001)
REM    --test   read-only capture test (prints events, forwards nothing)
REM    --inject manual chat injector (no LIVE stream needed)
REM
REM  First run copies .env.example -> .env. Set API_TOKEN (= moderator's
REM  API_TOKEN) and TIKTOK_EULER_API_KEY for production stability.
REM ===========================================================================
setlocal EnableExtensions
title Upstream bridge
cd /d "%~dp0" 2>nul

if "%~1"=="" (
  echo Usage: run.bat @streamername [--test ^| --inject]
  echo Example: run.bat @someCreator
  echo          run.bat @someCreator --test
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

if /i "%~1"=="--inject" goto inject
if /i "%~2"=="--inject" goto inject
if /i "%~2"=="--test" goto test
if /i "%~1"=="--test" goto test
goto bridge

:test
echo [i] Read-only capture test for %~1 (forwards nothing)...
call npx ts-node test-tiktok.ts %~1
goto done

:inject
echo [i] Manual injector - type chat, it posts to TTLIVE_URL/api/comment...
call npx ts-node inject-comments.ts
goto done

:bridge
echo [i] Bridging %~1 -^> moderator (TTLIVE_URL from .env)...
call npx ts-node bridge-to-ttlive.ts %~1
goto done

:done
echo.
echo Bridge stopped (exit %ERRORLEVEL%).
pause
