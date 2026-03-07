@echo off
chcp 65001 > nul
title Censor Me - Backend
setlocal

rem %~dp0 is the directory of this bat file (may contain spaces - handled via setlocal)
set "ROOT=%~dp0"

rem Strip trailing backslash so paths concatenate cleanly
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

cd /d "%ROOT%"

if not exist ".venv\Scripts\uvicorn.exe" (
    echo ERROR: Virtual environment not found.
    echo Run setup first:
    echo   uv venv .venv --python 3.12
    echo   VIRTUAL_ENV=.venv uv pip install -e .[dev]
    echo   VIRTUAL_ENV=.venv uv pip install pip
    pause
    exit /b 1
)

rem Kill any process already holding port 8010 (stale previous run)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('Stopping stale process on port 8010 (PID ' + $_.OwningProcess + ')...'); Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo Censor Me - Backend
echo URL:      http://localhost:8010
echo API docs: http://localhost:8010/docs
echo.
echo Models load on first scan (SKIP_MODEL_INIT=1 is set for fast startup).
echo Remove that line in this file to pre-load models at startup instead.
echo.

set SKIP_MODEL_INIT=1
"%ROOT%\.venv\Scripts\uvicorn.exe" backend.main:app --reload --reload-exclude ".venv" --port 8010 --host 127.0.0.1 --log-level debug

pause
