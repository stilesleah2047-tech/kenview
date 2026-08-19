@echo off
REM Starts the reporting server and opens it in your browser.
REM Close this window to stop it.
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get it from https://nodejs.org ^(version 18 or newer^),
  echo   then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "server\.env" (
  echo   First run - creating server\.env
  for /f "usebackq delims=" %%s in (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) do set "SECRET=%%s"
  REM delayed expansion, or SECRET would still be empty inside this block
  powershell -NoProfile -Command "(Get-Content 'server\.env.example') -replace '^SESSION_SECRET=.*', 'SESSION_SECRET=!SECRET!' | Set-Content 'server\.env'"
  echo   A signing secret was generated.
  echo   Add MONGODB_URI to server\.env before you set up real clients.
)

REM The MongoDB driver is only needed once a database is configured.
set NEEDDRIVER=
for /f "usebackq tokens=*" %%l in (`findstr /R "^MONGODB_URI=..*" "server\.env"`) do set NEEDDRIVER=1
if defined NEEDDRIVER if not exist "server\node_modules\mongodb" (
  echo   MongoDB is configured but its driver is missing. Installing it once...
  pushd server
  call npm install --omit=dev --no-audit --no-fund
  popd
  if not exist "server\node_modules\mongodb" (
    echo.
    echo   Could not install the driver. Run this yourself, then start again:
    echo       cd server ^&^& npm install
    echo.
    pause
    exit /b 1
  )
)

start "" "http://localhost:4000/"
node server\src\server.js
if errorlevel 1 pause
