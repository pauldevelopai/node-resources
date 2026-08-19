@echo off
REM Resources — Windows launcher
REM Double-click this file to start the app.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js isn't installed yet.
  echo Go to https://nodejs.org and download the LTS version.
  echo Then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First-time setup: installing the app's parts...
  call npm install
)

echo.
echo Starting Resources...
echo.

start "" http://localhost:3000

call npm start
