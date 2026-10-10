@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" -Action Start
set "REMOTE_TOKEN_EXIT=%ERRORLEVEL%"
pause
exit /b %REMOTE_TOKEN_EXIT%
