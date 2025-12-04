@echo off
setlocal
cd /d "%~dp0"

:: Launch browser first
start "" http://localhost:8080

:: Run server in this console (closing window stops server)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$env:PORT=8080; node \"$PWD/server.js\""
