# Packaging Censor Me as a Portable Desktop App

## Context

Censor Me needs to be packaged as a portable, zero-install desktop application for internal team distribution across Windows, macOS, and Linux. Users unzip/extract and double-click to run — no Python, Node, or dev tooling required. GPU support available as an optional first-run download to keep the base package small.

The app ships as a native desktop window (Tauri v2) with a splash screen, system tray, and setup wizard — not a browser tab. The backend runs as a sidecar process managed by the Tauri shell.

## Technology Choices

| Component | Technology | Why |
|---|---|---|
| Desktop wrapper + launcher | **Tauri v2** (Rust) | ~5 MB binary, embeds built React frontend, spawns/kills backend sidecar, native window + system tray. Replaces PyInstaller `.exe` and shell script launchers. |
| Portable Python runtime | **python-build-standalone** | Pre-built, fully self-contained Python distributions for all three platforms. Includes pip, same build approach everywhere. |
| Frontend serving (production) | **Tauri embedded** | Tauri serves the built React app directly from its binary — no FastAPI `StaticFiles` mount needed. Backend only serves API endpoints. |
| Frontend serving (dev) | **Vite dev server** | `pnpm dev` with proxy to backend, same as today. |

## Dependency Size Budget

| Dependency | Size | Notes |
|---|---|---|
| Tauri binary (with embedded frontend) | ~7 MB | Desktop shell + built React app |
| PyTorch (CPU-only) | ~200 MB | Base package |
| PyTorch + CUDA | ~2.5 GB | Optional download (first-run wizard) |
| spaCy + en_core_web_lg | ~400 MB | NLP model, pre-bundled |
| EasyOCR + models | ~300 MB | Pre-bundled |
| OpenCV contrib | ~100 MB | Tracking |
| Presidio + deps | ~50 MB | PII detection |
| ffmpeg binary | ~80 MB | Platform-specific |
| Python runtime | ~40 MB | Portable/standalone |

**Base portable package (CPU): ~1.2 GB per platform**

## Platform Matrix

| | Windows | macOS (ARM) | Linux (x64) |
|---|---|---|---|
| Python runtime | python-build-standalone | python-build-standalone | python-build-standalone |
| Archive format | `.zip` | `.tar.gz` | `.tar.gz` |
| Launcher | `CensorMe.exe` (Tauri) | `CensorMe` (Tauri) | `censor-me` (Tauri) |
| ffmpeg | `ffmpeg.exe` (gyan.dev static build) | `ffmpeg` (evermeet.cx static build) | `ffmpeg` (johnvansickle.com static build) |
| GPU (optional) | CUDA or DirectML | Metal/MPS (included in PyTorch by default) | CUDA or ROCm |
| System webview | Edge WebView2 (pre-installed on Win 10/11) | WebKit (built-in) | WebKitGTK (system package) |

---

## Implementation Phases

Each phase builds on the previous. No phase has internal circular dependencies.

### Phase 1: Foundation (Portable Backend)

*No Tauri yet — makes the backend self-contained and portable.*

#### 1.1 Portable Data Directory

All user data stored relative to the app folder for true portability:

```
CensorMe/
  data/              # User projects, config -- created on first run
    projects/
    config.json
```

**Files to modify:**
- `backend/config.py` — resolve data paths relative to app root, not `%APPDATA%` / `~/.config`

#### 1.2 Backend CORS Update

Add Tauri origins to the CORS allow list so the embedded frontend can reach the API.

**Files to modify:**
- `backend/main.py` — add `http://tauri.localhost` and `https://tauri.localhost` to `allow_origins`

#### 1.3 Shutdown Endpoint

The Tauri shell needs a clean way to stop the backend on app close.

**Files to modify:**
- `backend/api/system.py` — add `POST /system/shutdown` (graceful uvicorn shutdown)

---

### Phase 2: Tauri Desktop Shell

*Wraps the app in a native window with splash screen. This is the core desktop experience.*

#### 2.1 Tauri Scaffolding

Create the Tauri project structure:

```
src-tauri/
  Cargo.toml
  tauri.conf.json
  capabilities/
    default.json
  src/
    main.rs
    lib.rs
```

`tauri.conf.json` key settings:
- `productName`: `"CensorMe"`
- `identifier`: `"com.censorme.app"`
- `build.frontendDist`: `"../frontend/dist"`
- `build.devUrl`: `"http://localhost:5173"`
- `app.windows[0].decorations`: `true` (OS-default title bar)
- `app.windows[0].visible`: `false` (hidden until backend is ready)

#### 2.2 App Icons

Generate platform-specific icons from the existing logo SVG.

**Source:** `frontend/src/assets/logo.svg`
**Output:** `src-tauri/icons/` — `icon.ico` (Windows), `icon.icns` (macOS), `icon.png` (Linux), plus required sizes (32x32, 128x128, 256x256, etc.)

Use `cargo tauri icon` or manual conversion.

#### 2.3 Splash Screen

A borderless window shown immediately on launch while the backend starts.

**File:** `src-tauri/splash.html`
- Inline SVG logo (no external assets to load)
- Background: `#0F0F14` (matches app theme)
- CSS shimmer/pulse animation on the logo
- Status text area updated via Tauri events: "Starting backend...", "Loading models...", "Ready"

Configured in `tauri.conf.json` as a second window:
```json
{
  "label": "splash",
  "url": "splash.html",
  "width": 400,
  "height": 300,
  "decorations": false,
  "resizable": false,
  "center": true,
  "alwaysOnTop": true
}
```

#### 2.4 Sidecar Management

Rust code in `main.rs` handles the backend lifecycle:

1. **On app start:** Spawn `python/bin/python -m backend.main` as a child process, capturing stdout/stderr
2. **Health polling:** Poll `GET /system/status` every 500ms until the backend responds
3. **On backend ready:** Close splash window, show + focus main window
4. **On app close:** Send `POST /system/shutdown`, wait up to 5s, then force-kill the process
5. **Console hiding:** The Python process is spawned with `CREATE_NO_WINDOW` on Windows (no terminal flash)

#### 2.5 API Client Dual-Mode

The frontend API client needs to work in both dev (Vite proxy) and desktop (direct URL) modes.

**File to modify:** `frontend/src/api/client.ts`

```typescript
const IS_TAURI = '__TAURI_INTERNALS__' in window;
const API_BASE = IS_TAURI ? 'http://127.0.0.1:23990' : '';
const WS_BASE = IS_TAURI ? 'ws://127.0.0.1:23990' : `ws://${window.location.host}`;
```

- In dev mode: relative URLs proxied by Vite (no change from today)
- In Tauri mode: absolute URLs to the backend's port

#### 2.6 Frontend Dependencies

Add Tauri client libraries to the frontend.

**File to modify:** `frontend/package.json`

```
@tauri-apps/api
@tauri-apps/plugin-dialog
@tauri-apps/plugin-shell
```

These are tree-shaken — they add negligible size to the built frontend and are no-ops when `__TAURI_INTERNALS__` is absent (dev mode still works in browser).

---

### Phase 3: Premium Touches

*Polish the desktop experience with native integrations.*

#### 3.1 System Tray

Tray icon with a context menu:
- **Show** — bring window to front
- **About** — open about dialog
- **Quit** — shut down backend and exit

Close button = quit (no minimize-to-tray behavior). Keeps the mental model simple.

**Tauri plugin:** `tauri-plugin-tray` (built-in to Tauri v2 core)

#### 3.2 Single Instance

Prevent multiple instances from fighting over the backend port.

If a second instance is launched, focus the existing window instead.

**Tauri plugin:** `tauri-plugin-single-instance`

#### 3.3 Window State Persistence

Save and restore window size + position across sessions.

**Tauri plugin:** `tauri-plugin-window-state`

#### 3.4 Native File Dialogs

Replace `<input type="file">` with native OS file pickers via Tauri's dialog plugin. The selected path is sent directly to the backend — no browser upload needed.

**Frontend changes:**
- Import dialog from `@tauri-apps/plugin-dialog`
- On file select, call `POST /video/import-path/{project_id}` with the local file path
- Fall back to `<input type="file">` when not in Tauri (dev mode)

**Backend changes:**
- `backend/api/video.py` — add `POST /video/import-path/{project_id}` that reads directly from disk instead of receiving an upload

#### 3.5 About Dialog

A modal accessible from the system tray "About" menu and a Help menu in the UI.

Content:
- App logo
- Version number (from `package.json` or `tauri.conf.json`)
- Detected GPU and acceleration status
- Build info (commit hash, build date)

**File:** `frontend/src/components/AboutDialog/AboutDialog.tsx`

---

### Phase 4: First-Run Setup Wizard

*Interactive GPU configuration on first launch. Replaces the old "settings page button" approach.*

#### 4.1 Setup Backend Endpoints

**File to modify:** `backend/api/system.py`

| Endpoint | Purpose |
|---|---|
| `GET /setup/status` | Returns `{ "complete": bool, "gpu_detected": string, "gpu_provider": string }` |
| `POST /setup/install-gpu` | Accepts `{ "provider": "cuda" \| "directml" \| "rocm" \| "cpu" }`, streams download progress via WebSocket |
| `POST /setup/complete` | Marks setup as done, writes to `data/config.json` |

#### 4.2 Setup Wizard UI

**File:** `frontend/src/components/SetupWizard/SetupWizard.tsx` + `SetupWizard.css`

Multi-step flow:

1. **Welcome** — Logo, app name, "Let's get set up" message
2. **GPU Detection** — Auto-detect GPU hardware, show what was found
3. **GPU Selection** — User picks: use detected GPU, pick a different provider, or CPU-only
4. **Download Progress** — Progress bar for PyTorch GPU variant download (~2.5 GB for CUDA). Skip if CPU-only or MPS.
5. **Complete** — "You're ready to go" confirmation

#### 4.3 App.tsx Integration

After the backend is ready (splash screen dismissed), check `GET /setup/status`:
- If `complete: false` → render `<SetupWizard />` instead of the main app
- If `complete: true` → render the normal app

**File to modify:** `frontend/src/App.tsx`

---

### Phase 5: Build & Distribution

*Package everything into portable archives.*

#### 5.1 Build Script

**File:** `scripts/build-portable.py`

Steps:
1. Detect current OS
2. Download `python-build-standalone` for that OS
3. `pip install` all dependencies into the standalone Python
4. `pnpm build` — compile frontend to `frontend/dist/`
5. `cargo tauri build` — produces Tauri binary with embedded frontend
6. Pre-download ML models:
   - EasyOCR: English text detection + recognition models
   - spaCy: `en_core_web_lg`
7. Download static ffmpeg binary for current OS
8. Assemble output folder:
   - Tauri binary (launcher + embedded frontend)
   - `python/` (standalone runtime + all packages)
   - `backend/` (FastAPI source)
   - `models/` (EasyOCR, spaCy)
   - `bin/ffmpeg`
9. Package: `.zip` (Windows), `.tar.gz` (Mac/Linux)

**Output:**
```
dist/
  CensorMe-0.2.0-windows-x64.zip
  CensorMe-0.2.0-macos-arm64.tar.gz
  CensorMe-0.2.0-linux-x64.tar.gz
```

#### 5.2 Folder Structure (All Platforms)

```
CensorMe/
  CensorMe.exe / censor-me         # Tauri binary (launcher + embedded frontend)
  python/                           # Standalone Python + all packages
    bin/ (or Scripts/)
    lib/ (or Lib/)
  backend/                          # FastAPI app source
  models/                           # Pre-downloaded ML models
    easyocr/
    spacy/
  bin/
    ffmpeg(.exe)                    # Platform-specific ffmpeg
  data/                             # Created on first run
  README.txt                        # Quick start instructions
```

Note: No `static/` directory — the built frontend is embedded in the Tauri binary.

#### 5.3 CI/CD Option (GitHub Actions)

A matrix build in GitHub Actions builds all three platforms automatically:

```yaml
strategy:
  matrix:
    os: [windows-latest, macos-latest, ubuntu-latest]
```

Each job runs the build script and uploads the archive as a release artifact.

---

## Build Requirements

To build the portable packages, the build machine needs:

- Python 3.11+
- Rust toolchain (for Tauri compilation)
- pnpm (for frontend build)
- System webview development libraries:
  - Windows: Edge WebView2 (pre-installed on Win 10/11)
  - macOS: Xcode command line tools
  - Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`
- Internet access (to download python-build-standalone, ffmpeg, ML models)
- ~5 GB free disk space per platform build

Each platform's package must be built **on that platform** (or via CI) since pip installs platform-specific wheels and Tauri compiles platform-specific binaries.

---

## Verification Checklist

### Per platform (Windows, macOS, Linux):
- [ ] Extract archive to arbitrary directory
- [ ] Launch — splash screen appears, then main window opens (no terminal/browser)
- [ ] Import a video, run scan, verify OCR + PII detection
- [ ] Export redacted video
- [ ] Close and relaunch — verify projects persist in `data/`
- [ ] Move entire folder to different location — verify still works
- [ ] Second launch attempt focuses existing window (single instance)
- [ ] Window size/position restored on relaunch
- [ ] System tray icon present with Show/About/Quit menu
- [ ] About dialog shows correct version, GPU status, build info

### First-run setup:
- [ ] Setup wizard appears on first launch
- [ ] GPU hardware is correctly detected
- [ ] GPU provider download completes successfully (where applicable)
- [ ] Wizard does not appear on subsequent launches
- [ ] CPU-only option works without downloading anything extra

### Windows-specific:
- [ ] Works from path with spaces (e.g., `C:\Users\John Doe\Desktop\CensorMe\`)
- [ ] Works without admin rights
- [ ] No terminal window flashes during launch
- [ ] Edge WebView2 detected/used correctly

### macOS-specific:
- [ ] Gatekeeper doesn't block (may need `xattr -cr` or ad-hoc signing for internal)
- [ ] Works on Apple Silicon (ARM64)
- [ ] Native file dialogs match macOS style

### Linux-specific:
- [ ] Works on Ubuntu 22.04+ without extra system packages (beyond WebKitGTK)
- [ ] System tray integrates with desktop environment
