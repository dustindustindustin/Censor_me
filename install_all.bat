@echo off
chcp 65001 > nul
title Censor Me - Install All
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

echo ==========================================
echo      Censor Me - One-Time Installer
echo ==========================================
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo ERROR: Python is not installed or not on PATH.
    echo Install Python 3.11+ and re-run this file.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm is not installed or not on PATH.
    echo Install Node.js 20+ and re-run this file.
    pause
    exit /b 1
)

echo [1/7] Ensuring uv is installed...
python -m uv --version >nul 2>nul
if errorlevel 1 (
    python -m pip install --user uv
    if errorlevel 1 (
        echo ERROR: Failed to install uv.
        pause
        exit /b 1
    )
)

echo [2/7] Creating virtual environment (.venv)...
if not exist ".venv\Scripts\python.exe" (
    python -m uv venv .venv --python 3.12
    if errorlevel 1 (
        echo Python 3.12 not found; falling back to default Python...
        python -m uv venv .venv
        if errorlevel 1 (
            echo ERROR: Failed to create virtual environment.
            pause
            exit /b 1
        )
    )
) else (
    echo Virtual environment already exists; reusing it.
)

echo [3/7] Installing backend Python dependencies...
set "VIRTUAL_ENV=.venv"
python -m uv pip install -e ".[dev]"
if errorlevel 1 (
    echo ERROR: Failed to install backend dependencies.
    pause
    exit /b 1
)

echo [4/7] Installing pip into virtual environment...
python -m uv pip install pip
if errorlevel 1 (
    echo ERROR: Failed to install pip in virtual environment.
    pause
    exit /b 1
)

echo [5/7] Installing PyTorch (auto GPU detection)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\install-pytorch.ps1"
if errorlevel 1 (
    echo ERROR: Failed to install PyTorch.
    pause
    exit /b 1
)

echo [6/7] Installing frontend dependencies...
cd /d "%ROOT%\frontend"
npm exec --yes pnpm@latest install
if errorlevel 1 (
    echo ERROR: Failed to install frontend dependencies.
    pause
    exit /b 1
)
cd /d "%ROOT%"

echo [7/7] Creating .env from .env.example if missing...
if not exist ".env" (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo Created .env from .env.example
    ) else (
        echo NOTE: .env.example not found; skipping .env creation.
    )
) else (
    echo .env already exists; leaving it unchanged.
)

echo.
echo ==========================================
echo Install complete.
echo Next step: run start_all.bat
echo ==========================================
pause
