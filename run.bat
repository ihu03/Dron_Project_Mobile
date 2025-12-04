@echo off
setlocal
cd /d "%~dp0"

:: Launch browser first
start "" http://localhost:8080

:: Run server in this console (closing window stops server)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; ^
   Set-Location \"$PSScriptRoot\"; ^
   Write-Host 'Starting server on http://localhost:8080'; ^
   $env:PORT=8080; ^
   try { node \"$PSScriptRoot\\server.js\" } ^
   catch { Write-Host 'Error:' $_; } ^
   finally { Write-Host 'Server stopped. Press Enter to close...'; Read-Host }"
