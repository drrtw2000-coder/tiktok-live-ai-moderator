@echo off
REM b.bat - quick launch for @ahappyspell (single entry via a.bat).
REM Usage: b.bat  (add flags after it if needed, e.g. b.bat --wait --tunnel)
cd /d "%~dp0" 2>nul
call "%~dp0a.bat" @ahappyspell %*
