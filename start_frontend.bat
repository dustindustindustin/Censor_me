@echo off
chcp 65001 > nul
title Censor Me - Frontend
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

cd /d "%ROOT%\frontend"

if not exist "node_modules\.bin\vite.CMD" (
    echo ERROR: Node modules not installed.
    echo Run:  cd frontend ^&^& pnpm install
    pause
    exit /b 1
)

echo Censor Me - Frontend
echo URL: http://localhost:5173
echo.

node_modules\.bin\vite.CMD --port 5173

pause
