# Censor Me

Local, GPU-accelerated video PII redaction. Automatically detects and blurs sensitive information in screen recordings and video — phones, emails, SSNs, credit cards, employee IDs, and more — without sending any content off your machine.

![Status](https://img.shields.io/badge/status-v0.2-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Python](https://img.shields.io/badge/python-3.11+-green)

---

## What It Does

1. **Import** a video (MP4, MOV, MKV, AVI, WebM)
2. **Test Frame** — run OCR + PII detection on a single frame to verify detection before a full scan; results appear as a cyan overlay on the live video
3. **Scan** — full OCR + PII detection runs on every sampled frame using your GPU
4. **Review** findings in the panel — accept or reject each one (keyboard: `A` / `R`); click any box on the video to select it; resize boxes with drag handles
5. **Draw** custom redaction boxes directly on the video; they auto-track the content forward
6. **Export** a redacted H.264 video with all accepted regions blurred out

All processing is local. No cloud, no API calls, no data leaves your machine.

---

## Features

### Detection
- GPU-accelerated OCR via EasyOCR (CUDA auto-detected, CPU fallback)
- PII detection: phone numbers, email addresses, SSNs, credit card numbers, **employee IDs (6-digit)**
- NLP-based person name detection via Microsoft Presidio + spaCy
- Smart filtering: DATE_TIME, LOCATION, and URL entities excluded (too noisy for UI/intranet text)
- Default confidence threshold 0.35 (tuned for screen recordings)
- CSRT object tracking between sampled frames with drift detection and auto-reinitialize
- Scene-change detection with adaptive sampling rate
- Face detection via OpenCV DNN (ResNet-10 SSD)
- Three redaction styles: Gaussian blur, pixelate, and solid box (configurable per event)

### UI
- **Video controls bar** — play/pause, time display, volume, playback speed (0.25×–2×)
- **Zoom** — 1×–4× video zoom with `+`/`−` controls; overlay stays aligned
- **Test Frame modal** — OCR + Presidio results for a single frame; cyan overlay on live video shows detected regions; checkboxes to add individual findings to the censor list
- **Draw Box** — click-drag to draw a manual redaction rectangle on the video; CSRT tracking follows the content forward automatically
- **Resize handles** — select any finding, drag the 8 corner/edge handles to resize its bounding box; persisted to disk immediately
- **Click-to-select** — click any visible box on the video to select it in the Inspector
- **Settings modal** — configure scan settings, output settings, and default redaction style
- Immediate "Starting…" feedback when scan is clicked (no gap waiting for WebSocket)
- Real-time scan progress bar over WebSocket
- Three-pane UI: Findings Panel · Video Preview · Inspector
- HTTP range request support for smooth video seeking
- Save/load projects as local JSON
- NVENC hardware export (falls back to libx264 automatically)
- Audit report generation (JSON + HTML)

### Rules
- Built-in regex rules: US phone, email, SSN, credit card, 6-digit employee ID
- Custom regex rules via `/rules` API (UI in roadmap)
- Rules applied during both full scans and the test-frame diagnostic

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
| opencv-contrib-python | Required (not bare opencv-python) — needed for CSRT tracker |

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

> On first scan, EasyOCR downloads its models (~100 MB) and Presidio initializes the spaCy NER model. This only happens once per machine.

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

This polls the backend until it responds, then opens the frontend and browser automatically.

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

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `J` | Step back 5 seconds |
| `K` | Pause |
| `L` | Step forward 5 seconds |
| `A` | Accept selected finding |
| `R` | Reject selected finding |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/system/status` | Backend readiness + GPU info |
| `GET` | `/projects/` | List all projects |
| `POST` | `/projects/` | Create new project |
| `GET` | `/projects/{id}` | Load project |
| `DELETE` | `/projects/{id}` | Delete project |
| `POST` | `/projects/{id}/events` | Add a single RedactionEvent |
| `PATCH` | `/projects/{id}/events/{eid}/style` | Update event redaction style |
| `PATCH` | `/projects/{id}/events/{eid}/keyframes` | Update event keyframes (resize) |
| `PATCH` | `/projects/{id}/events/{eid}/status` | Accept / reject event |
| `PATCH` | `/projects/{id}/events/bulk-status` | Bulk accept / reject / reset events |
| `PATCH` | `/projects/{id}/events/bulk-style` | Apply style to multiple events |
| `PATCH` | `/projects/{id}/settings` | Update scan / output settings |
| `POST` | `/video/import/{id}` | Import video + generate proxy |
| `GET` | `/video/proxy/{id}` | Stream proxy video |
| `POST` | `/scan/start/{id}` | Start full scan |
| `WS` | `/scan/progress/{scan_id}` | Real-time scan progress |
| `GET` | `/scan/active/{id}` | Get running scan ID for project |
| `GET` | `/scan/status/{scan_id}` | Poll scan status |
| `GET` | `/scan/test-frame/{id}` | Single-frame OCR + PII diagnostic |
| `POST` | `/scan/frame/{id}` | Scan single frame and save events |
| `POST` | `/scan/range/{id}` | Partial scan (time range) |
| `POST` | `/scan/track-event/{id}/{eid}` | CSRT-track a manual box forward |
| `POST` | `/export/{id}` | Start export |
| `WS` | `/export/progress/{export_id}` | Real-time export progress |
| `GET` | `/export/{id}/status/{export_id}` | Poll export status |
| `GET` | `/export/{id}/download` | Download exported video |
| `GET` | `/export/{id}/report` | Generate audit report (JSON / HTML) |
| `GET` | `/rules/` | List all rules |
| `POST` | `/rules/custom` | Add custom regex rule |
| `PATCH` | `/rules/custom/{rule_id}` | Update custom rule |
| `DELETE` | `/rules/custom/{rule_id}` | Delete custom rule |
| `POST` | `/rules/test` | Test a regex pattern against sample text |

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
| Tracking | OpenCV CSRT (`cv2.legacy.TrackerCSRT_create`) |
| Python packaging | uv |
| Node packaging | pnpm |

---

## Project Structure

```
Censor_me/
├── backend/
│   ├── main.py              # FastAPI entry point
│   ├── config.py            # Project paths, async locks
│   ├── api/                 # REST + WebSocket endpoints
│   │   ├── projects.py      # Project CRUD + event management
│   │   ├── scan.py          # Scan pipeline + test-frame + manual tracking
│   │   ├── video.py         # Import + proxy serving
│   │   ├── export.py        # Redacted video export + audit reports
│   │   ├── rules.py         # PII detection rules
│   │   └── system.py        # Hardware status
│   ├── services/            # OCR, PII, tracking, rendering, export
│   │   ├── ocr_service.py       # EasyOCR wrapper (lazy singleton)
│   │   ├── pii_classifier.py    # Presidio + custom regex rules
│   │   ├── scan_orchestrator.py # 7-stage pipeline coordinator
│   │   ├── tracker_service.py   # CSRT tracking + manual box tracking
│   │   ├── event_linker.py      # Groups detections into time-linked events
│   │   ├── frame_sampler.py     # Adaptive frame sampling
│   │   ├── redaction_renderer.py # Renders redacted video frames
│   │   ├── video_service.py     # Metadata extraction, proxy generation
│   │   ├── project_store.py     # Project file I/O
│   │   └── report_service.py    # Audit report generation
│   ├── models/              # Pydantic data models
│   │   ├── events.py        # RedactionEvent, BoundingBox, Keyframe, PiiType
│   │   ├── project.py       # ProjectFile, VideoMetadata, ScanSettings
│   │   └── rules.py         # Rule, RuleSet, RuleType
│   └── utils/               # GPU detection, startup, scene detection
│       ├── gpu_detect.py    # CUDA / NVENC probing
│       ├── startup.py       # Model initialization checks
│       └── scene_detect.py  # Histogram-based scene change detection
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── VideoPreview/
│       │   │   ├── VideoPreview.tsx    # Player, controls, zoom, toolbar
│       │   │   ├── OverlayCanvas.tsx   # Interactive canvas (draw, resize, overlay)
│       │   │   ├── FrameTestModal.tsx  # Single-frame diagnostic modal
│       │   │   └── Timeline.tsx        # Scrubber with event markers
│       │   ├── FindingsPanel/          # Event list with accept/reject
│       │   ├── Inspector/              # Event detail + export controls
│       │   ├── Settings/               # Settings modal
│       │   └── ErrorBoundary.tsx       # React error boundary
│       ├── hooks/           # useScanProgress, useExportProgress, useKeyboard
│       ├── store/           # Zustand project state
│       ├── api/             # Typed API client
│       ├── types/           # Shared TypeScript types
│       ├── styles/          # CSS tokens, animations, component styles, fonts
│       └── utils/           # Formatting helpers
├── start_all.bat            # Launch everything (polls backend before opening browser)
├── start_backend.bat
├── start_frontend.bat
├── pyproject.toml
└── SETUP.md                 # Detailed setup guide
```

---

## Roadmap

### Remaining v0.2
- Custom regex rules UI (backend API ready)
- Rescan selection range UI (backend API ready)
- Undo/Redo for all edits

### v0.3 — Robustness
- Batch mode (multi-video processing)
- Polygon draw tool (advanced manual regions)
- Context rules logic (field-label adjacency)

### v1.0 — Production
- Role-based presets
- SAM2 segmentation tracking (difficult cases)
- Packaged installer (Windows); macOS `.app` bundle
- GPU diagnostics UI
- Audio PII redaction (optional module)

---

## License

See [LICENSE](LICENSE).
