@echo off
REM Resources — Windows update launcher

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Install from https://nodejs.org first.
  pause
  exit /b 1
)

node update.mjs

echo.
pause
