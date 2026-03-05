@echo off
title Censor Me
setlocal

rem Capture the project root directory safely, even with spaces in the path.
rem %~dp0 includes a trailing backslash — strip it for clean concatenation.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo ==========================================
echo           Censor Me — Starting
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

rem Launch backend in a new window.
rem The full path to uvicorn is used to avoid working-directory issues.
echo Starting backend on http://localhost:8010 ...
start "Censor Me — Backend" cmd /k "cd /d "%ROOT%" && set SKIP_MODEL_INIT=1 && "%ROOT%\.venv\Scripts\uvicorn.exe" backend.main:app --reload --port 8010 --host 127.0.0.1 --log-level warning"

rem Give uvicorn a moment to bind to the port before launching the browser
echo Waiting 4 seconds for backend to start...
timeout /t 4 /nobreak > nul

rem Launch frontend in a new window
echo Starting frontend on http://localhost:5173 ...
start "Censor Me — Frontend" cmd /k "cd /d "%ROOT%\frontend" && node_modules\.bin\vite.CMD --port 5173"

rem Wait another moment, then open the browser
timeout /t 3 /nobreak > nul
echo Opening browser...
start http://localhost:5173
