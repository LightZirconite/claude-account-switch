@echo off
setlocal
rem Launch the Claude + Codex Account Switcher from anywhere (path-independent).
cd /d "%~dp0"

if not exist "node_modules" (
  echo [switch] Installing dependencies ^(first run^)...
  call npm install || goto :error
)
if not exist "dist\cli.js" (
  echo [switch] Building ^(first run^)...
  call npm run build || goto :error
)

node "%~dp0dist\cli.js" %*
goto :eof

:error
echo [switch] Setup failed. See messages above.
exit /b 1
