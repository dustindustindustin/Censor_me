# Censor Me

Local, GPU-accelerated video PII redaction. Automatically detects and blurs sensitive information in screen recordings and video — phones, emails, SSNs, credit cards, and more — without sending any content off your machine.

![Status](https://img.shields.io/badge/status-v0.1_MVP-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Python](https://img.shields.io/badge/python-3.11+-green)

---

## What It Does

1. **Import** a video (MP4, MOV, MKV, AVI, WebM)
2. **Scan** — OCR + PII detection runs on every sampled frame using your GPU
3. **Review** findings in the panel — accept or reject each one (keyboard: `A` / `R`)
4. **Export** a redacted H.264 video with all accepted regions blurred out

All processing is local. No cloud, no API calls, no data leaves your machine.

---

## Features (v0.1)

- GPU-accelerated OCR via EasyOCR (CUDA auto-detected)
- PII detection: phone numbers, email addresses, SSNs, credit card numbers
- NLP-based person/address detection via Microsoft Presidio + spaCy
- CSRT object tracking between sampled frames
- Blur redaction style
- Three-pane UI: Findings Panel · Video Preview · Inspector
- Real-time scan progress over WebSocket
- HTTP range request support for smooth video seeking
- Save/load projects as local JSON
- NVENC hardware export (falls back to libx264 automatically)
- Audit report generation (JSON + HTML)

---

## System Requirements

| Component | Minimum |
|---|---|
| OS | Windows 10/11 64-bit |
| CPU | 4-core, 2.5 GHz+ |
| RAM | 16 GB |
| GPU | NVIDIA GTX 1060 6 GB+ (CUDA 11.8+) — CPU fallback works but is slow |
| Disk | 10 GB free (models + projects) |
| Python | 3.11+ |
| Node.js | 20+ |
| ffmpeg | Must be on PATH |

---

## Setup

### 1. Install prerequisites

- [Python 3.11+](https://www.python.org/downloads/)
- [Node.js 20+](https://nodejs.org/)
- [ffmpeg](https://ffmpeg.org/download.html) — add to PATH
- Package managers:

```bash
pip install uv
npm install -g pnpm
```

### 2. Clone and install

```bash
git clone https://github.com/dustindustindustin/Censor_me.git
cd Censor_me

# Python environment
uv venv .venv --python 3.12
VIRTUAL_ENV=".venv" uv pip install -e ".[dev]"
VIRTUAL_ENV=".venv" uv pip install pip

# Frontend
cd frontend && pnpm install && cd ..
```

> On first scan, EasyOCR downloads its models (~100 MB) and Presidio downloads `en_core_web_sm`. This only happens once.

### 3. Configure

```bash
cp .env.example .env
# Edit .env if needed (e.g. set OCR_USE_GPU=false for CPU-only)
```

---

## Running

**Option A — One launcher (recommended):**

```
start_all.bat
```

This opens the backend and frontend in separate windows and launches your browser.

**Option B — Manual:**

```bash
# Terminal 1 — backend
start_backend.bat

# Terminal 2 — frontend
start_frontend.bat
```

Open **http://localhost:5173** in your browser.

Backend API docs: **http://localhost:8010/docs**

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI + uvicorn |
| Frontend | React 18 + TypeScript + Vite |
| State | Zustand |
| OCR | EasyOCR (PyTorch) |
| PII Detection | Microsoft Presidio + spaCy |
| Video I/O | ffmpeg-python + OpenCV |
| Tracking | OpenCV CSRT |
| Python packaging | uv |
| Node packaging | pnpm |

---

## Project Structure

```
Censor_me/
├── backend/
│   ├── main.py              # FastAPI entry point
│   ├── api/                 # REST + WebSocket endpoints
│   ├── services/            # OCR, PII, tracking, rendering, export
│   ├── models/              # Pydantic data models
│   └── utils/               # GPU detection, startup, scene detection
├── frontend/
│   └── src/
│       ├── components/      # FindingsPanel, VideoPreview, Inspector
│       ├── hooks/           # useScanProgress, useExportProgress, useKeyboard
│       ├── store/           # Zustand project state
│       ├── api/             # Typed API client
│       └── types/           # Shared TypeScript types
├── start_all.bat            # Launch everything
├── start_backend.bat
├── start_frontend.bat
├── pyproject.toml
└── SETUP.md                 # Detailed setup guide
```

---

## Roadmap

- **v0.2** — Polygon draw tool, solid/pixelate redaction styles, custom regex rules UI, batch mode
- **v0.3** — SAM2 segmentation tracking, scene-change detection
- **v1.0** — Packaged installer, macOS support, audio PII redaction

---

## License

See [LICENSE](LICENSE).
