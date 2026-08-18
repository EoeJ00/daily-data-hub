@echo off
setlocal
cd /d "%~dp0"
title MIULX 日报系统启动器

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-miulx.ps1"

if errorlevel 1 (
  echo.
  echo 启动失败，请查看上面的错误信息。
  pause
)

endlocal
