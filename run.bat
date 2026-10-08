@echo off
REM ===========================================================================
REM  AI Moderator - quick run (Windows)
REM
REM    run.bat              start moderator + open overlays in browser
REM    run.bat demo         ... and fire scripted chat/gift/spam afterwards
REM    run.bat nobrowser    start without opening browser tabs
REM    run.bat demo nobrowser
REM
REM  First run copies moderator\.env.example -> moderator\.env. Edit .env to
REM  set API_TOKEN (same value as the bridge) and UPSTREAM_TTLIVE_URL.
REM ===========================================================================
setlocal EnableExtensions
title AI Moderator
cd /d "%~dp0moderator" 2>nul
if not exist "server.py" (
  echo [ERROR] "moderator\server.py" not found next to this script.
  pause
  exit /b 1
)

REM -- python launcher: prefer the "py" launcher -------------------------------
set "PY=py"
where py >nul 2>nul || set "PY=python"
where %PY% >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install from https://www.python.org/downloads/
  echo         Tick "Add python.exe to PATH" in the installer.
  pause
  exit /b 1
)

REM -- first run: create .env from the template --------------------------------
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [i] Created moderator\.env - edit API_TOKEN / UPSTREAM_TTLIVE_URL if needed.
)

REM -- read PORT from .env (default 3002) --------------------------------------
set "PORT=3002"
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="PORT" set "PORT=%%b"
)
set "PORT=%PORT: =%"
if not defined PORT set "PORT=3002"

REM -- warn when token auth is off ---------------------------------------------
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if /i "%%a"=="API_TOKEN" if "%%b"=="" echo [i] API_TOKEN empty in .env - token auth is OFF.
  if /i "%%a"=="API_TOKEN" if /i "%%b"=="changeme-use-same-value-in-bridge-env" echo [i] API_TOKEN is still the template placeholder - change it for production.
)

REM -- flags: demo | nobrowser --------------------------------------------------
set "WANT_DEMO="
set "WANT_BROWSER=1"
:parseargs
if "%~1"=="" goto argsdone
if /i "%~1"=="demo" set "WANT_DEMO=1"
if /i "%~1"=="nobrowser" set "WANT_BROWSER="
shift
goto parseargs
:argsdone

REM -- open the overlays once the server is up ---------------------------------
if defined WANT_BROWSER start "" /min powershell -NoProfile -Command "Start-Sleep 3; Start-Process 'http://127.0.0.1:%PORT%/overlay/chat'; Start-Process 'http://127.0.0.1:%PORT%/overlay/mod'"

REM -- optional: fire the scripted demo after the server is up ------------------
if defined WANT_DEMO start "" /min cmd /c "timeout /t 4 /nobreak >nul & %PY% demo.py http://127.0.0.1:%PORT%"

echo.
echo ============================================================
echo   AI Moderator - http://127.0.0.1:%PORT%
echo     overlay      (Studio "Link" / OBS Browser Source)  /overlay/chat
echo     mod console  (second screen only)                  /overlay/mod
echo     demo chat:   run.bat demo
echo   Ctrl+C stops. Keep this window open while you stream.
echo ============================================================
echo.

%PY% server.py
set "RC=%ERRORLEVEL%"
echo.
echo Moderator stopped (exit %RC%).
pause
exit /b %RC%
