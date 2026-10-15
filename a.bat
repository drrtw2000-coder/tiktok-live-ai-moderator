@echo off
REM ===========================================================================
REM  a.bat - SINGLE ENTRY POINT: TikTok LIVE + AI moderator (Windows)
REM
REM    a.bat @streamername [--wait] [notunnel] [--demo] [nobrowser]
REM      --wait    not live yet: pause "Press ENTER when LIVE", then connect
REM      notunnel  local/debug only: skip the public tunnel (default is ON:
REM                this stack is used remotely; tunnel URL is printed below)
REM      --tunnel  kept for compatibility: tunnel is already default-ON
REM      --demo    offline test: scripted chat instead of the LIVE bridge
REM                (implies notunnel unless --tunnel is also passed)
REM      nobrowser don't auto-open overlay tabs
REM  Chain: TikTok LIVE --(bridge)--> moderator :3002 --(forward)--> TTLive
REM  Ctrl+C stops everything this script started.
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
title AI Moderator - live stack
cd /d "%~dp0" 2>nul

set "USER="
set "WAIT="
set "WANT_TUNNEL=1"
set "WANT_TUNNEL_EXPLICIT="
set "WANT_DEMO="
set "WANT_BROWSER=1"
set "HAVE_LOCK="
call :take_arg "%~1"
call :take_arg "%~2"
call :take_arg "%~3"
call :take_arg "%~4"
call :take_arg "%~5"
goto argsdone
:take_arg
if "%~1"=="" exit /b 0
if /i "%~1"=="--wait" set "WAIT=1" & exit /b 0
if /i "%~1"=="--tunnel" set "WANT_TUNNEL=1" & set "WANT_TUNNEL_EXPLICIT=1" & exit /b 0
if /i "%~1"=="notunnel" set "WANT_TUNNEL=" & exit /b 0
if /i "%~1"=="local" set "WANT_TUNNEL=" & exit /b 0
if /i "%~1"=="--demo" set "WANT_DEMO=1" & exit /b 0
if /i "%~1"=="nobrowser" set "WANT_BROWSER=" & exit /b 0
if not defined USER set "USER=%~1"
exit /b 0
:argsdone
if defined WANT_DEMO if not defined WANT_TUNNEL_EXPLICIT set "WANT_TUNNEL="

if not defined WANT_DEMO if "%USER%"=="" (
  echo Usage: a.bat @streamername [--wait] [notunnel] [--demo] [nobrowser]
  echo   tunnel is ON by default ^(remote use^). notunnel = local debug only.
  echo Example: a.bat @ahappyspell
  echo          a.bat @ahappyspell --wait
  echo          a.bat --demo notunnel
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
  echo [i] Created upstream\.env - set API_TOKEN (= moderator's^) + TIKTOK_EULER_API_KEY.
)
if not exist "upstream\node_modules" (
  echo [i] Installing upstream dependencies (one-time, ~1 min^)...
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
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("moderator\.env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
)
set "PORT=%PORT: =%"
if "%PORT%"=="" set "PORT=3002"

powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/healthz' -TimeoutSec 2 -UseBasicParsing).StatusCode } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [1/3] Reusing moderator on :%PORT% ...
  goto modup_probe_ok
)
echo [1/3] Starting moderator on :%PORT% ...
start "AI Moderator :%PORT%" /d "%~dp0moderator" cmd /c "%PY% server.py"
timeout /t 2 /nobreak >nul
:modup_probe_ok

set "UP="
for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/healthz' -TimeoutSec 2 -UseBasicParsing).StatusCode } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 set "UP=1"
  if defined UP goto modup
  timeout /t 1 /nobreak >nul
)
:modup
if not defined UP (
  echo [ERROR] Moderator did not answer http://127.0.0.1:%PORT%/healthz - check the moderator window.
  pause
  exit /b 1
)
echo [ok] Moderator up: http://127.0.0.1:%PORT%

:tunnel
if not defined WANT_TUNNEL goto notunnel
where cloudflared >nul 2>nul
if not errorlevel 1 goto havetunnel
echo [warn] cloudflared not on PATH - skipping tunnel. See https://cloudflare.com/products/cloudflare-tunnel/
goto notunnel
:havetunnel
echo [2/3] Starting public tunnel for :%PORT% ...
del /q "%~dp0moderator\.tunnel-url" 2>nul
del /q "%~dp0moderator\tunnel.log" 2>nul
start "AI Moderator tunnel" cmd /c "cloudflared tunnel --url http://127.0.0.1:%PORT% > "%~dp0moderator\tunnel.log" 2>&1"
set "TUNNEL_URL="
for /l %%t in (1,1,20) do (
  powershell -NoProfile -Command "$m = Select-String -Path '%~dp0moderator\tunnel.log' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $m.Matches[0].Value | Out-File -FilePath '%~dp0moderator\.tunnel-url' -Encoding ascii -NoNewline } " >nul 2>nul
  if exist "%~dp0moderator\.tunnel-url" (
    set /p "TUNNEL_URL=" < "%~dp0moderator\.tunnel-url"
  )
  if defined TUNNEL_URL goto tunneldone
  timeout /t 1 /nobreak >nul
)
:tunneldone
if defined TUNNEL_URL (
  echo [ok] Tunnel: !TUNNEL_URL! ^(chat: !TUNNEL_URL!/overlay/chat^)
  echo !TUNNEL_URL!/overlay/chat > "%~dp0public-link.txt"
) else (
  echo [warn] Tunnel starting (URL not captured yet^) - check the tunnel window.
)
goto browsers
:notunnel
del /q "%~dp0moderator\.tunnel-url" 2>nul
del /q "%~dp0public-link.txt" 2>nul
echo [2/3] Tunnel skipped (local debug mode).
:browsers

if defined WANT_BROWSER (
  start "" "http://127.0.0.1:%PORT%/overlay/chat"
)

if defined WANT_DEMO (
  echo [3/3] Firing scripted demo chat (offline test, no LIVE needed^) ...
  pushd moderator >nul
  %PY% demo.py http://127.0.0.1:%PORT%
  popd >nul
  goto links
)

:bridge
if defined HAVE_LOCK goto bridge_loop
set "LOCKFILE=upstream\.bridge-%USER:@=%.lock"
if exist "%LOCKFILE%" (
  echo.
  echo [warn] Another window may already bridge %USER%.
  echo        Lock contents:
  type "%LOCKFILE%" 2^>nul
  echo        A stale lock after a crash/kill is expected — press ENTER to
  echo        take over here, or close the other bridge window first.
  set /p "TAKEOVER=Press ENTER to take over here, or type q + ENTER to quit: "
  if /i "!TAKEOVER!"=="q" goto links
)
echo %DATE% %TIME% %COMPUTERNAME% %USERNAME% > "%LOCKFILE%"
set "HAVE_LOCK=1"
:bridge_loop
if defined WAIT (
  echo.
  echo [i] %USER% is not live yet - ENTER the moment they go live:
  set /p "GO=Press ENTER when %USER% goes LIVE to connect [Ctrl+C to cancel]: "
  set "WAIT="
)
echo [3/3] Bridging %USER% -^> moderator :%PORT% (Ctrl+C here stops the bridge) ...
pushd upstream >nul
call npx ts-node bridge-to-ttlive.ts "%USER%"
set "BRC=!ERRORLEVEL!"
popd >nul
echo.
echo Bridge exited (code !BRC!).
set /p "RETRY=Press ENTER to (re)connect, or type q + ENTER to quit: "
if /i "!RETRY!"=="q" goto links
goto bridge

:links
if defined LOCKFILE del /q "%LOCKFILE%" 2>nul
set "HAVE_LOCK="
set "LOCKFILE="
echo.
echo ============================================================
echo   AI Moderator - http://127.0.0.1:%PORT%
if defined TUNNEL_URL (
  echo   Public gift overlay: !TUNNEL_URL!/overlay/chat
  echo   Overlay control (never on stream^): !TUNNEL_URL!/overlay/admin?token=MOD_TOKEN ^(see moderator/.env^)
  goto links_done
)
if defined WANT_TUNNEL (
  echo   Public gift overlay: copy the https URL from the tunnel window + /overlay/chat
  echo   Overlay control (never on stream^): same https URL + /overlay/admin?token=MOD_TOKEN ^(see moderator/.env^)
  goto links_done
)
  echo   Local gift overlay (Studio Link / OBS^):  http://127.0.0.1:%PORT%/overlay/chat
  echo   Overlay control:                          http://127.0.0.1:%PORT%/overlay/admin?token=MOD_TOKEN ^(see moderator/.env^)
:links_done
echo   Bridge: %USER% -^> moderator :%PORT% -^> TTLive
echo   Ctrl+C stops. Keep this window open while you stream.
echo ============================================================
echo.
pause

REM -- end of script (labels below are jump targets only) --
exit /b 0
