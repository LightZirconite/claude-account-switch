@echo off
setlocal
cd /d "%~dp0"
echo [setup] Installing dependencies...
call npm install || goto :error
echo [setup] Building...
call npm run build || goto :error
echo.
echo [setup] Done. Launch the switcher with:  switch.cmd
goto :eof

:error
echo [setup] Failed. See messages above.
exit /b 1
