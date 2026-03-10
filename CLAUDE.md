# Censor Me — Claude Context

## What This Is
Local, GPU-accelerated video PII redaction desktop app. Detects and blurs PII (phones, emails,
SSNs, credit cards, employee IDs, names) in screen recordings. All processing is 100% local —
no cloud, no API calls, no data leaves the machine.

## Tech Stack
- **Backend**: Python 3.11+, FastAPI, uvicorn (port 8010)
- **Frontend**: React 18, TypeScript, Vite (port 5173), Zustand, Tauri shell
- **OCR**: EasyOCR (PyTorch-based, CUDA auto-detected)
- **PII Detection**: Microsoft Presidio + spaCy (`en_core_web_lg`)
- **Video**: OpenCV (CSRT tracker), FFmpeg (export)
- **Package manager**: `uv` (Python), `pnpm` (frontend)
- **Linting**: `ruff` (Python), ESLint (frontend)
- **Testing**: pytest + pytest-asyncio (backend), tsc --noEmit (frontend)

## Key Commands

### Backend
```bash
# Activate venv first (Windows)
.venv\Scripts\activate

# Dev server (fast startup, skips model warm-up)
SKIP_MODEL_INIT=1 uvicorn backend.main:app --reload --reload-exclude ".venv" --port 8010 --host 127.0.0.1

# Run tests
pytest

# Lint
ruff check backend/
ruff format backend/
```

### Frontend
```bash
cd frontend
pnpm dev          # Vite dev server (port 5173)
pnpm build        # Production build
pnpm lint         # ESLint
pnpm exec tsc --noEmit  # Type check
```

## Project Structure
```
backend/
├── main.py              # FastAPI entry point
├── config.py            # Project paths, locks, settings
├── api/                 # REST endpoints + WebSocket
├── services/            # Core pipeline:
│   ├── ocr_service.py   #   EasyOCR text detection
│   ├── pii_service.py   #   Presidio PII detection
│   ├── tracking_service.py # CSRT object tracking
│   ├── render_service.py   # Blur/redaction rendering
│   └── face_detection.py   # Face detection
├── models/              # Pydantic data models
└── utils/               # GPU detection, scene detection, startup
frontend/src/
├── App.tsx
├── api/                 # Typed API client (axios)
├── components/          # FindingsPanel, VideoPreview, Inspector, Settings
├── hooks/               # useScanProgress, useExportProgress, useKeyboard
├── store/               # Zustand project state
├── styles/              # CSS tokens, animations
├── types/               # Shared TypeScript types
└── utils/               # Formatting helpers
```

## Critical Architecture Rules
- ALL processing must remain local. Never add cloud API calls for OCR, PII, or export.
- GPU is auto-detected — do not hardcode CUDA. Always fall back to CPU gracefully.
- opencv-contrib-python is required (not opencv-python or opencv-python-headless) — CSRT tracker depends on it.
- The three opencv packages conflict — only contrib variant should be installed (enforced in pyproject.toml overrides).
- Use `uv` for all Python dependency changes, not `pip` directly.
- `SKIP_MODEL_INIT=1` is for dev only — remove for production builds.

## Tauri Notes
- Tauri shell wraps the Vite frontend (not yet deeply integrated — frontend runs standalone via browser too)
- Tauri allowlist should remain minimal
- File system access goes through Tauri plugins, not direct browser APIs

## Testing Notes
- Backend: `pytest` from project root with venv active
- Frontend: `pnpm exec tsc --noEmit` for type checking; no unit test suite yet (gap)
- API docs available at http://localhost:8010/docs when backend is running

## Quality Log
See `QUALITY_LOG.md` (created by `/debt-log` command) for audit history.
