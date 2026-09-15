@echo off
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo Please run npm ci and npm run setup first.
  pause
  exit /b 1
)
call npm.cmd run build
if errorlevel 1 (
  pause
  exit /b 1
)
call npm.cmd start
