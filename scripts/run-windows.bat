@echo off
setlocal
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0run-windows.ps1"
pause
