# Packaging Censor Me as a Portable App

## Context

Censor Me needs to be packaged as a portable, zero-install application for internal team distribution across Windows, macOS, and Linux. Users unzip/extract and double-click to run — no Python, Node, or dev tooling required. GPU support available as an optional in-app download to keep the base package small.

## Dependency Size Budget

| Dependency | Size | Notes |
|---|---|---|
| PyTorch (CPU-only) | ~200 MB | Base package |
| PyTorch + CUDA | ~2.5 GB | Optional download |
| spaCy + en_core_web_lg | ~400 MB | NLP model, pre-bundled |
| EasyOCR + models | ~300 MB | Pre-bundled |
| OpenCV contrib | ~100 MB | Tracking |
| Presidio + deps | ~50 MB | PII detection |
| ffmpeg binary | ~80 MB | Platform-specific |
| Python runtime | ~40 MB | Portable/standalone |
| React frontend (built) | ~2 MB | Static files |

**Base portable package (CPU): ~1.2 GB per platform**

## Platform Matrix

| | Windows | macOS (ARM) | Linux (x64) |
|---|---|---|---|
| Python runtime | [python-build-standalone](https://github.com/indygreg/python-build-standalone) | python-build-standalone | python-build-standalone |
| Archive format | `.zip` | `.tar.gz` | `.tar.gz` |
| Launcher | `CensorMe.exe` (compiled Python script) | `CensorMe.command` (shell script) | `censor-me.sh` (shell script) |
| ffmpeg | `ffmpeg.exe` (gyan.dev static build) | `ffmpeg` (evermeet.cx static build) | `ffmpeg` (johnvansickle.com static build) |
| GPU (optional) | CUDA or DirectML | Metal/MPS (included in PyTorch by default) | CUDA or ROCm |

> **python-build-standalone** provides pre-built, fully self-contained Python distributions for all three platforms. Unlike the Windows embeddable zip, it works on Mac/Linux too and includes pip, so the same build approach works everywhere.

## Implementation Steps

### Step 1: Frontend → Static Files Served by FastAPI

- `pnpm build` outputs to `backend/static/`
- FastAPI serves the built frontend via `StaticFiles` mount at `/`
- Eliminates the Node/Vite runtime dependency in production

**Files to modify:**
- `frontend/vite.config.ts` — set `build.outDir` to `../backend/static`
- `backend/main.py` — add `StaticFiles` mount (only when `backend/static/` exists)

### Step 2: Portable Data Directory

All user data stored **relative to the app folder** for true portability:

```
CensorMe/
├── data/              # User projects, config — created on first run
│   ├── projects/
│   └── config.json
```

**Files to modify:**
- `backend/config.py` — resolve data paths relative to app root, not `%APPDATA%` / `~/.config`

### Step 3: Cross-Platform Launcher

**Windows — `launcher.py` compiled to `CensorMe.exe` via PyInstaller (one-file, tiny)**
- Only the launcher is compiled via PyInstaller (trivial script, no ML deps)
- Sets `PYTHONHOME` / `PYTHONPATH` to the bundled Python
- Starts uvicorn, opens default browser
- System tray icon via `pystray` for clean quit

**macOS / Linux — shell script wrapper**
```bash
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONHOME="$DIR/python"
"$DIR/python/bin/python" -m backend.main &
sleep 2 && open "http://localhost:$PORT"  # xdg-open on Linux
wait
```

### Step 4: Build Script (`scripts/build-portable.py`)

Single Python build script that works on all platforms:

1. Detect current OS
2. Download `python-build-standalone` for that OS
3. `pip install` all dependencies into the standalone Python
4. `pnpm build` — compile frontend
5. Pre-download ML models:
   - EasyOCR: English text detection + recognition models
   - spaCy: `en_core_web_lg`
6. Download static ffmpeg binary for current OS
7. Copy backend source, static frontend, models, ffmpeg into output folder
8. Create launcher (compile `.exe` on Windows, write shell script on Mac/Linux)
9. Package: `zip` on Windows, `tar.gz` on Mac/Linux

**Output:**
```
dist/
├── CensorMe-0.2.0-windows-x64.zip
├── CensorMe-0.2.0-macos-arm64.tar.gz
└── CensorMe-0.2.0-linux-x64.tar.gz
```

### Step 5: Folder Structure (All Platforms)

```
CensorMe/
├── CensorMe.exe / censor-me.sh    # Launcher
├── python/                         # Standalone Python + all packages
│   ├── bin/ (or Scripts/)
│   └── lib/ (or Lib/)
├── backend/                        # FastAPI app source
├── static/                         # Built React frontend
├── models/                         # Pre-downloaded ML models
│   ├── easyocr/
│   └── spacy/
├── bin/
│   └── ffmpeg(.exe)                # Platform-specific ffmpeg
├── data/                           # Created on first run
└── README.txt                      # Quick start instructions
```

### Step 6: Optional GPU Support

**In-app approach (recommended for internal):**
- Settings page shows detected GPU hardware
- "Enable GPU Acceleration" button downloads the right PyTorch variant
- Downloads into the bundled Python's site-packages, replacing CPU-only torch
- Progress bar in the UI

**Per-platform GPU options:**
- Windows: CUDA (NVIDIA) or DirectML (AMD/Intel)
- macOS: Metal/MPS — already included in base PyTorch, just needs detection
- Linux: CUDA (NVIDIA) or ROCm (AMD)

## Build Requirements

To build the portable packages, the build machine needs:
- Python 3.11+
- pnpm (for frontend build)
- Internet access (to download python-build-standalone, ffmpeg, ML models)
- ~5 GB free disk space per platform build

Each platform's package must be built **on that platform** (or via CI) since pip installs platform-specific wheels.

## CI/CD Option (GitHub Actions)

A matrix build in GitHub Actions could build all three platforms automatically:
```yaml
strategy:
  matrix:
    os: [windows-latest, macos-latest, ubuntu-latest]
```
Each job runs the build script and uploads the archive as a release artifact. This is the cleanest approach for maintaining all three platforms long-term.

## Estimated Effort

| Task | Time |
|---|---|
| Frontend static serving in FastAPI | 2-3 hours |
| Portable data directory refactor | 1-2 hours |
| Cross-platform launcher | 3-4 hours |
| Build script (python-build-standalone + deps + models + ffmpeg) | 1-2 days |
| GPU download mechanism (in-app) | 4-8 hours |
| Testing per platform | 1 day per platform |
| CI/CD matrix build (optional) | 4-8 hours |
| **Total** | **~5-8 days** |

## Verification Checklist

### Per platform (Windows, macOS, Linux):
- [ ] Extract archive to arbitrary directory
- [ ] Launch — browser opens, UI loads
- [ ] Import a video, run scan, verify OCR + PII detection
- [ ] Export redacted video
- [ ] Close and relaunch — verify projects persist in `data/`
- [ ] Move entire folder to different location — verify still works
- [ ] GPU download (where applicable) — verify acceleration activates

### Windows-specific:
- [ ] Works from path with spaces (e.g., `C:\Users\John Doe\Desktop\CensorMe\`)
- [ ] Works without admin rights

### macOS-specific:
- [ ] Gatekeeper doesn't block (may need `xattr -cr` or ad-hoc signing for internal)
- [ ] Works on Apple Silicon (ARM64)

### Linux-specific:
- [ ] Works on Ubuntu 22.04+ without extra system packages
