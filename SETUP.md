# Censor Me — Setup Guide

## Prerequisites

| Requirement | Notes |
|---|---|
| Python 3.11+ | Check with `python --version` |
| Node.js 20+ | Check with `node --version` |
| ffmpeg | Must be on PATH. [Download](https://ffmpeg.org/download.html) |
| NVIDIA GPU + CUDA | Optional but recommended for fast OCR |

Install package managers if missing:
```bash
pip install uv          # Python package manager
npm install -g pnpm     # Node package manager
```

---

## One-Time Setup

### 1. Create Python virtual environment

```bash
cd "path/to/Censor_me"
uv venv .venv --python 3.12
```

### 2. Install Python dependencies

```bash
VIRTUAL_ENV=".venv" uv pip install -e ".[dev]"

# Install pip into the venv (needed by Presidio to auto-download the spaCy NER model)
VIRTUAL_ENV=".venv" uv pip install pip
```

### 2b. Install PyTorch (required for OCR)

EasyOCR depends on PyTorch, which must be installed separately using the provided scripts.
Run **one** of the following once, after step 2:

```bash
# Windows — CUDA GPU (recommended if you have an NVIDIA GPU):
scripts\install-pytorch.ps1

# Windows — CPU only (no GPU):
scripts\install-pytorch.ps1 -cpu

# Linux / macOS:
bash scripts/install-pytorch.sh
```

> **CPU-only note:** Without a CUDA GPU, OCR will run on CPU and be ~5–10× slower.
> The app still works; scans just take longer.

> **On first startup**, Presidio automatically downloads `en_core_web_lg` (~400 MB)
> for person-name detection. This only happens once; subsequent starts are instant.

### 3. Install frontend dependencies

```bash
cd frontend
pnpm install
cd ..
```

### 4. Copy environment config

```bash
cp .env.example .env
# Edit .env if needed (e.g., set OCR_USE_GPU=false for CPU-only mode)
```

---

## Running the App

**Terminal 1 — Backend:**
```bash
cd "path/to/Censor_me"
SKIP_MODEL_INIT=1 .venv/Scripts/uvicorn backend.main:app --reload --reload-exclude ".venv" --port 8010 --host 127.0.0.1
```

> `SKIP_MODEL_INIT=1` skips model warm-up for fast startup during development.
> Remove it for production — models will load at startup instead of first scan.

**Terminal 2 — Frontend:**
```bash
cd "path/to/Censor_me/frontend"
pnpm dev
```

Open **http://localhost:5173** in your browser.

---

## Workflow

1. Open http://localhost:5173
2. Click **+ New Project**
3. Click **Import Video** — select a video file (MP4, MOV, MKV, AVI, WebM)
4. Wait for proxy generation (shown in the toolbar)
5. Click **Scan** — findings stream onto the timeline in real-time
6. Review findings in the left panel (keyboard: **A** = Accept, **R** = Reject)
7. Click **Export Redacted Video** in the right panel
8. Find the output in `~/censor_me_projects/{project_id}/exports/`

---

## OCR Notes (EasyOCR)

The app uses **EasyOCR** (PyTorch-based) for text detection:
- GPU is auto-detected via CUDA — no manual configuration needed
- First scan downloads OCR models (~100 MB) if not cached
- GPU mode is ~5x faster than CPU mode for OCR
- Compatible NVIDIA GPUs will be used automatically

---

## GPU Export (NVENC)

Your GPU supports NVENC hardware video encoding.
Export will automatically use NVENC for near-realtime encoding.
If NVENC fails for any reason, the app falls back to CPU (libx264) automatically.

---

## Project Structure

```
Censor_me/
├── backend/
│   ├── main.py              # FastAPI entry point
│   ├── config.py            # Project paths, locks
│   ├── api/                 # REST + WebSocket endpoints
│   ├── services/            # Pipeline: OCR, PII, tracking, rendering, face detection
│   ├── models/              # Pydantic data models
│   └── utils/               # GPU detection, scene detection, startup
├── frontend/
│   └── src/
│       ├── components/      # FindingsPanel, VideoPreview, Inspector, Settings, ErrorBoundary
│       ├── hooks/           # useScanProgress, useExportProgress, useKeyboard
│       ├── store/           # Zustand project state
│       ├── api/             # Typed API client
│       ├── styles/          # CSS tokens, animations, component styles
│       ├── types/           # Shared TypeScript types
│       └── utils/           # Formatting helpers
├── pyproject.toml           # Python dependencies (uv)
├── .env.example             # Environment config template
└── SETUP.md                 # This file
```

---

## Running Tests

```bash
# Backend (activate venv first)
.venv\Scripts\activate
pytest

# Frontend type-check
cd frontend && pnpm exec tsc --noEmit
```

---

## API Reference

Browse the interactive API docs at **http://localhost:8010/docs** while the backend is running.
