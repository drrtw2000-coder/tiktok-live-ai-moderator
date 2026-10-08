@echo off
REM ===========================================================================
REM  a.bat - SINGLE ENTRY POINT: TikTok LIVE + AI moderator (Windows)
REM
REM    a.bat @streamername [--wait] [--tunnel] [--demo] [nobrowser]
REM      --wait    not live yet: pause "Press ENTER when LIVE", then connect
REM      --tunnel  also start cloudflared public tunnel for :3002
REM      --demo    offline test: scripted chat instead of the LIVE bridge
REM      nobrowser don't auto-open overlay tabs
REM  Chain: TikTok LIVE --(bridge)--> moderator :3002 --(forward)--> TTLive
REM  Ctrl+C stops everything this script started.
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
title AI Moderator - live stack
cd /d "%~dp0" 2>nul

set "USER="
set "WAIT="
set "WANT_TUNNEL="
set "WANT_DEMO="
set "WANT_BROWSER=1"
:parseargs
if "%~1"=="" goto argsdone
if /i "%~1"=="--wait" set "WAIT=1"
if /i "%~1"=="--tunnel" set "WANT_TUNNEL=1"
if /i "%~1"=="--demo" set "WANT_DEMO=1"
if /i "%~1"=="nobrowser" set "WANT_BROWSER="
if not "%~1"=="--wait" if not "%~1"=="--tunnel" if not "%~1"=="--demo" if not "%~1"=="nobrowser" if not defined USER set "USER=%~1"
shift
goto parseargs
:argsdone

if not defined WANT_DEMO if "%USER%"=="" (
  echo Usage: a.bat @streamername [--wait] [--tunnel] [--demo] [nobrowser]
  echo Example: a.bat @ahappyspell
  echo          a.bat @ahappyspell --wait --tunnel
  echo          a.bat --demo
  pause
  exit /b 1
)
if "%USER%"=="" set "USER=demo"

set "PY=py"
where py >nul 2>nul || set "PY=python"
where %PY% >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install from https://www.python.org/downloads/
  pause
  exit /b 1
)

if not exist "moderator\.env" (
  copy /y "moderator\.env.example" "moderator\.env" >nul
  echo [i] Created moderator\.env - set API_TOKEN / MOD_TOKEN.
)
if not exist "upstream\.env" (
  copy /y "upstream\.env.example" "upstream\.env" >nul
  echo [i] Created upstream\.env - set API_TOKEN (= moderator's) + TIKTOK_EULER_API_KEY.
)
if not exist "upstream\node_modules" (
  echo [i] Installing upstream dependencies (one-time, ~1 min)...
  pushd upstream >nul
  call npm install
  set "NPMRC=!ERRORLEVEL!"
  popd >nul
  if not "!NPMRC!"=="0" (
    echo [ERROR] npm install failed. Install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
  )
)
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+ from https://nodejs.org/
  pause
  exit /b 1
)

set "PORT=3002"
for /f "usebackq tokens=1,* delims==" %%a in ("moderator\.env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
)
set "PORT=%PORT: =%"
if not defined PORT set "PORT=3002"

echo [1/3] Starting moderator on :%PORT% ...
start "AI Moderator :%PORT%" cmd /c "cd /d "%~dp0moderator" && %PY% server.py"

set "UP="
for /l %%i in (1,1,20) do (

set "TUNNEL_URL="
if defined WANT_TUNNEL (
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo [warn] cloudflared not on PATH - skipping tunnel. See https://cloudflare.com/products/cloudflare-tunnel/
  ) else (
    echo [2/3] Starting public tunnel for :%PORT% ...
    del /q "%~dp0tunnel-url.txt" 2>nul
    start "AI Moderator tunnel" cmd /c "cloudflared tunnel --url http://127.0.0.1:%PORT% 2>&1 | powershell -NoProfile -Command "$l=$input | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($l) { $l.Matches[0].Value | Out-File -FilePath '%~dp0tunnel-url.txt' -Encoding ascii }; $input""
    for /l %%i in (1,1,20) do (
      if exist "%~dp0tunnel-url.txt" goto tunnelup
      timeout /t 1 /nobreak >nul
    )
    :tunnelup
    if exist "%~dp0tunnel-url.txt" (
      set /p TUNNEL_URL=<"%~dp0tunnel-url.txt"
      echo [ok] Tunnel: !TUNNEL_URL!
    ) else (
      echo [warn] Tunnel starting (URL not captured yet) - check the tunnel window.
    )
  )
)
if not defined WANT_TUNNEL echo [2/3] Tunnel skipped (add --tunnel for a public link).

if defined WANT_BROWSER (
  start "" "http://127.0.0.1:%PORT%/overlay/chat"
  timeout /t 1 /nobreak >nul
  start "" "http://127.0.0.1:%PORT%/overlay/mod"
)

if defined WANT_DEMO (
  echo [3/3] Firing scripted demo chat (offline test, no LIVE needed) ...
  pushd moderator >nul
  %PY% demo.py http://127.0.0.1:%PORT%
  popd >nul
  goto links
)

:bridge
if defined WAIT (
  echo.
  echo [i] %USER% is not live yet - ENTER the moment they go live:
  set /p "GO=Press ENTER when %USER% goes LIVE to connect (Ctrl+C to cancel): "
  set "WAIT="
)
echo [3/3] Bridging %USER% -^> moderator :%PORT% (Ctrl+C here stops the bridge) ...
pushd upstream >nul
call npx ts-node bridge-to-ttlive.ts %USER%
set "BRC=!ERRORLEVEL!"
popd >nul
echo.
echo Bridge exited (code !BRC!).
set /p "RETRY=Press ENTER to (re)connect, or type q + ENTER to quit: "
if /i "!RETRY!"=="q" goto links
goto bridge

:links
echo.
echo ============================================================
echo   AI Moderator - http://127.0.0.1:%PORT%
if defined TUNNEL_URL (
  echo   Public chat source (Studio Link / OBS): !TUNNEL_URL!/overlay/chat
  echo   Public mod console (never on stream):  !TUNNEL_URL!/overlay/mod?token=... (MOD_TOKEN in moderator\.env)
) else (
  echo   Local chat source (Studio Link / OBS):  http://127.0.0.1:%PORT%/overlay/chat
  echo   Local mod console:                      http://127.0.0.1:%PORT%/overlay/mod
)
echo   Bridge: %USER% -^> moderator :%PORT% -^> TTLive
echo   Ctrl+C stops. Keep this window open while you stream.
echo ============================================================
echo.
pause

  powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/healthz' -TimeoutSec 2 -UseBasicParsing).StatusCode } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 ( set "UP=1" & goto modup )
  timeout /t 1 /nobreak >nul
)
:modup
if not defined UP (
  echo [ERROR] Moderator did not answer http://127.0.0.1:%PORT%/healthz - check the moderator window.
  pause
  exit /b 1
)
echo [ok] Moderator up: http://127.0.0.1:%PORT%
