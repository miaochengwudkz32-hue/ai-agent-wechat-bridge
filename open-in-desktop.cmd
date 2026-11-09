@echo off
rem Double-click: open the current WeChat conversation in the Claude desktop app.
cd /d "%~dp0"
node wake.js --open
if errorlevel 1 pause
