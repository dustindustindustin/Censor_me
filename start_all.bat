@echo off
chcp 65001 > nul
title Censor Me
setlocal

rem Capture the project root directory safely, even with spaces in the path.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo ==========================================
echo           Censor Me - Starting
echo ==========================================
echo.

rem Verify the venv exists before trying to launch
if not exist "%ROOT%\.venv\Scripts\uvicorn.exe" (
    echo ERROR: Virtual environment not found at %ROOT%\.venv
    echo.
    echo Run setup first:
    echo   cd "%ROOT%"
    echo   uv venv .venv --python 3.12
    echo   VIRTUAL_ENV=.venv uv pip install -e .[dev]
    echo   VIRTUAL_ENV=.venv uv pip install pip
    echo   cd frontend ^&^& pnpm install
    pause
    exit /b 1
)

rem Launch backend in its own window (start_backend.bat handles port cleanup and pause)
echo Starting backend on http://localhost:8010 ...
start "Censor Me - Backend" cmd /k ""%ROOT%\start_backend.bat""

rem Poll backend until it responds (up to 60 seconds) before launching the frontend
echo Waiting for backend to be ready on http://localhost:8010 ...
powershell -NoProfile -Command "$deadline = (Get-Date).AddSeconds(60); $ready = $false; while ((Get-Date) -lt $deadline) { try { $r = Invoke-WebRequest -Uri 'http://localhost:8010/system/status' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {} Start-Sleep -Seconds 1 }; if (-not $ready) { Write-Host 'WARNING: backend did not respond within 60 s — launching frontend anyway.' }"

rem Launch frontend in its own window
echo Starting frontend on http://localhost:5173 ...
start "Censor Me - Frontend" cmd /k ""%ROOT%\start_frontend.bat""

rem Wait for Vite to spin up, then open the browser
timeout /t 3 /nobreak > nul
echo Opening browser...
start http://localhost:5173
