@echo off
setlocal
"%SystemRoot%\System32\wscript.exe" "%~dp0Start.vbs"
exit /b %ERRORLEVEL%
