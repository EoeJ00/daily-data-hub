@echo off
setlocal
cd /d "%~dp0"

rem 代理端口由 start-miulx.ps1 自动探测（7890、7891、10809、1080、7897）。

powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-miulx.ps1" -Hidden -Silent
endlocal
