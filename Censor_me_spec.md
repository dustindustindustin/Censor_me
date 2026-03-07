# Censor Me — Product & Technical Specification

Product Name: Censor Me
Version: v0.2 (Active Development)
Status: Active

---

## 1. Product Overview

### Goal

Provide a local application that:

- Automatically detects and redacts on-screen PII (names, phones, emails, IDs, addresses, etc.).
- Lets users manually add, edit, and validate redactions with minimal friction.
- Tracks sensitive regions through motion, scrolling, UI transitions, and camera movement.
- Exports a redacted video at user-selected resolution/quality, without sending any content off-device.

### Non-Goals (v1)

- Perfect semantic understanding of every tool UI field without configuration.
- Audio PII redaction by default (optional module later).
- Real-time redaction while recording (batch processing first).

---

## 2. Primary User Journeys

### 2.1 "One-Click" Auto Redaction

1. User imports a video.
2. User selects a preset (e.g., "Screen Recording PII").
3. User clicks **Scan**.
4. Tool produces:
   - A redacted preview timeline.
   - A list of detected PII events (time ranges, extracted text, confidence, type).
5. User reviews flagged items, accepts/rejects.
6. User exports.

### 2.2 Hybrid Workflow (Auto + Manual)

1. Run Scan.
2. User scrubs to a frame where something sensitive was missed.
3. User selects a region, chooses Redaction type: Blur, Pixelate, Black box.
4. Tool tracks it through the clip segment; user adjusts if tracking drifts.
5. Export.

### 2.3 Batch Workflow

1. User selects folder of videos.
2. Choose preset + output profile.
3. Run batch.
4. Review summary report.
5. Export results.

---

## 3. UI/UX Spec

### 3.1 Layout

**Three-pane layout:**

**Left: Findings Panel**
- Filter by PII type: Phone, Email, Person, Address, Account ID, Custom Regex, Unknown
- Sort by: confidence, time, type
- Each item: timestamp range, snippet of detected text, confidence, "jump to"
- Buttons: Accept, Reject, Convert to manual region, Add rule exception

**Center: Video Preview**
- Timeline scrubber with markers for findings
- Play controls
- Toggle overlays: show OCR boxes, show tracked masks, show redaction areas
- Zoom and pan for UI-heavy screen recordings

**Right: Inspector Panel**
For selected finding/region:
- Detected text (editable)
- Type classification (dropdown)
- Confidence
- Bounding boxes over time (sparkline or keyframes)
- Tracking mode (BBox tracker vs segmentation)
- Redaction style (blur radius / pixel size / box color)
- Apply scope: current segment, entire video, matching text instances
- Actions: split segment, extend range, re-run tracking, delete

### 3.2 Interaction Details

- Markers on timeline for each PII event.
- Hover on marker shows extracted text.
- Click-drag on timeline to create a "range selection" for manual redaction or rescanning.

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| Space | Play/pause |
| J / K / L | Scrub speed |
| A | Accept finding |
| R | Reject finding |
| M | Manual region mode |
| S | Rescan selection |
| Ctrl+Z / Ctrl+Y | Undo/Redo |

### 3.3 Presets

- "Screen Recording PII" (default)
- "Customer Support Chat"
- "Forms and Tables"
- "High Motion / Low OCR"
- Custom presets: saved per user in local config dir (`~/.censor_me/presets/`). Export/import preset files to share with teammates (v2+).

---

## 4. Detection and Redaction Pipeline

### 4.1 Pipeline Stages

The pipeline is divided into seven discrete, independently testable stages:

**Stage 1: Sample**
- Extract frames at a configurable rate (default: every 5 frames at 30 fps = 6 fps OCR).
- Detect scene changes (histogram diff or PySceneDetect) and increase sampling rate around transitions.

**Stage 2: OCR**
- Run EasyOCR on sampled frames.
- Output per frame: list of `{bbox, text, confidence}` results.
- Apply CLAHE contrast enhancement pre-OCR for dark-mode / low-contrast frames.
- Multi-scale retry (1.0x then 1.5x) for small fonts.

**Stage 3: Classify**
- Run Microsoft Presidio (local) + spaCy `en_core_web_lg` against OCR text results.
- Apply custom regex rules and allowlist/denylist.
- Output: `{text, pii_type, confidence, source_frame, bbox}` candidates.

**Stage 4: Link**
- Group detections across frames into time-linked events.
- Criteria: same text string reappearing, similar bbox location, UI template similarity.
- Output: list of `RedactionEvent` objects with time ranges and keyframe bboxes.

**Stage 5: Track**
- Fill in bounding boxes between OCR keyframes using OpenCV CSRT tracker.
- Detect drift (appearance embedding comparison); reinitialize tracker if drift exceeds threshold.
- Scene change resets trackers and triggers re-OCR.

**Stage 6: Review**
- User reviews findings in the Findings Panel.
- Accept, reject, or convert each event to a manual region.
- Users can scrub to missed regions and add manual redactions.

**Stage 7: Render**
- Apply selected redaction style per accepted event (blur, pixelate, solid box).
- Compose final frames and encode via ffmpeg (H.264 default, H.265 optional).
- GPU acceleration via NVENC when available; CPU fallback for all operations.

### 4.2 Real-Time Scan Progress (WebSocket)

Before starting a scan, the client opens a WebSocket connection to `/scan/progress/{scan_id}`.

The backend emits JSON messages as each stage completes:

```json
{"stage": "sample", "frame": 42, "total": 1800}
{"stage": "ocr", "frame": 42, "total": 1800, "findings_so_far": 3}
{"stage": "classify", "frame": 42, "total": 1800}
{"stage": "link", "events_found": 5}
{"stage": "track", "event_id": "uuid", "status": "tracked"}
{"stage": "done", "total_findings": 17}
```

The frontend updates timeline markers in real-time as findings are streamed.

---

## 5. Core Features

### 5.1 Automatic Detection

- OCR-based detection of on-screen text via EasyOCR.
- PII rules engine:
  - Regex templates shipped with app (via Presidio).
  - Custom regex per workspace (JSON/YAML rule files).
  - "Mask all numbers longer than N digits" mode (useful for IDs).

### 5.2 Manual Tools

- Rectangle draw.
- Polygon draw (advanced, v0.2+).
- "Click text to redact" — user clicks on a rendered OCR text box.
- "Redact similar occurrences" option.
- Range-based application (only this time segment).

### 5.3 Tracking Robustness

- **Drift detection**: compare appearance embeddings (histogram/feature) of tracked region; if drift exceeds threshold, pause and prompt user OR reinitialize tracker.
- **Scene change detection**: histogram difference between frames; on scene change, reset trackers and re-OCR sooner.

### 5.4 Performance and Scalability

- **Proxy editing**: UI uses 720p proxy video; redactions render on full-res at export.
- **Chunked processing**: process in 30-second segments for long clips.
- **GPU utilization**: EasyOCR on GPU (CUDA); ffmpeg NVENC for encoding.
- **Adaptive knobs**: OCR sample rate, OCR resolution scaling, tracking mode, proxy resolution.

---

## 6. Supported PII Types (Default)

### High Confidence (Regex via Presidio)
- Phone numbers (international-aware)
- Emails
- Credit card-like sequences (Luhn validation optional)
- SSN-like (configurable by locale)
- Postal codes
- Account IDs / ticket IDs (pattern-based presets)

### Medium Confidence (NLP + Context)
- Person names
- Addresses
- Company-specific identifiers (configured)
- Usernames

### Optional Module
- Face and avatar detection/tracking for screen recordings with camera overlays.

---

## 7. Rules Engine

### 7.1 Rule Definition Format

JSON/YAML rule files (local). Rule types:
- `regex`: pattern + label + priority + confidence
- `context`: pattern must appear within N pixels near a label
- `allowlist`: ignore matches
- `denylist`: always redact matches
- `field_label`: if "Phone:" is detected, redact adjacent text box

### 7.2 Rule Precedence

1. Denylist
2. Regex (high precision)
3. Field-label context rules
4. NER-based suggestions
5. Low-confidence heuristics

### 7.3 Rules UI

Rules screen:
- Enable/disable rules.
- Test against sample text.
- Preview impact on loaded video.

---

## 8. Data Model

### 8.1 Project File (Local JSON)

Stores:
- Video reference (path + hash)
- Proxy path
- Output settings
- Findings (list of `RedactionEvent` — see §8.3)
- User decisions (accepted/rejected/manual)

### 8.2 Privacy Controls

- Toggle: store extracted text or store only hashed tokens.
- Toggle: redact logs.
- "Secure mode": zero retained OCR text in project file.

### 8.3 Unified Redaction Event Model

Both auto-detected and manually-added regions use the same `RedactionEvent` schema. This eliminates separate code paths and makes export/tracking uniform.

```json
{
  "event_id": "uuid",
  "source": "auto | manual",
  "pii_type": "phone | email | person | address | custom | manual",
  "confidence": 0.95,
  "extracted_text": "555-1234",
  "time_ranges": [
    {"start_ms": 1200, "end_ms": 4800}
  ],
  "keyframes": [
    {"time_ms": 1200, "bbox": [x, y, w, h]},
    {"time_ms": 4800, "bbox": [x, y, w, h]}
  ],
  "tracking_method": "csrt | sam2 | manual | none",
  "redaction_style": {
    "type": "blur | pixelate | solid_box",
    "strength": 15,
    "color": "#000000"
  },
  "status": "pending | accepted | rejected"
}
```

---

## 9. System Architecture

### 9.1 Tech Stack (Locked)

| Component | Decision | Reason |
|---|---|---|
| UI Framework | FastAPI (Python) + React + TypeScript | Fastest iteration; best ecosystem for video timeline UI |
| Python Package Manager | uv | Fast, modern, reproducible |
| Node Package Manager | pnpm | Fast, efficient |
| OCR | EasyOCR | PyTorch-based; GPU auto-detected via CUDA; good accuracy on UI text |
| PII Detection | Microsoft Presidio (local) + spaCy `en_core_web_lg` | Wraps regex + NER; avoids reimplementing rules engine |
| Video I/O | ffmpeg-python + system ffmpeg | Thin wrapper; leverages NVENC natively |
| CV Tracking | OpenCV CSRT (v0.1), SAM2 (v1.0+) | CSRT is fast and requires no GPU |
| Scene Detection | PySceneDetect or histogram diff | Lightweight; triggers adaptive OCR |
| Frontend State | Zustand | Lightweight, no Redux boilerplate |
| Project Storage | JSON files | Simple, portable, human-readable |
| API Communication | REST + WebSocket | REST for CRUD; WebSocket for real-time scan progress |

### 9.2 Module Boundaries

**Backend (Python):**

| Module | Responsibility |
|---|---|
| `VideoService` | Decode/encode via ffmpeg; proxy generation |
| `FrameSampler` | Adaptive sampling logic, scene change detection |
| `OcrService` | EasyOCR wrapper; returns `BoxResult` list per frame |
| `PiiClassifier` | Presidio + custom regex rules; returns PII candidates |
| `EventLinker` | Groups frame-level detections into time-linked `RedactionEvent` objects |
| `TrackerService` | OpenCV CSRT tracking between OCR keyframes; drift detection |
| `RedactionRenderer` | Apply blur/pixelate/solid box to frames via OpenCV |
| `ProjectStore` | Load/save/autosave project JSON; secure mode |
| `ReportService` | Export JSON and HTML audit reports |

**Frontend (React + TypeScript):**

| Component | Responsibility |
|---|---|
| `FindingsPanel` | Left pane: PII event list, filter, sort, accept/reject |
| `VideoPreview` | Center pane: `<video>` element + `OverlayCanvas` for bbox drawing |
| `Timeline` | Scrubber + PII event markers (child of VideoPreview) |
| `OverlayCanvas` | Canvas overlay for OCR boxes and redaction region drawing |
| `Inspector` | Right pane: selected event details and controls |
| `useScanProgress` | WebSocket hook for real-time scan progress |
| `useKeyboard` | Keyboard shortcut handler |
| `projectStore` | Zustand store for all project state |

### 9.3 Proxy Video Serving

- The backend generates a 720p proxy via ffmpeg at import time.
- Proxy is stored in `{project_dir}/.proxy/`.
- FastAPI serves the proxy with **HTTP range request support** (`Accept-Ranges: bytes`) so the browser `<video>` element can seek without buffering the full file.
- API endpoint: `GET /video/proxy/{project_id}` with range header support.

### 9.4 Startup Initialization Sequence

On launch, the backend performs the following checks before accepting requests:

1. Detect GPU/CUDA availability → log result and expose via `GET /system/status`.
2. Verify ffmpeg is on PATH → surface error to UI with download guidance if missing.
3. Initialize EasyOCR models (auto-download on first run, ~100 MB).
4. Initialize Presidio + spaCy `en_core_web_lg` (auto-download on first run).
5. Report ready status → frontend shows "New Project / Open Project" screen.

The frontend polls `GET /system/status` until backend reports ready, showing a loading screen during model initialization.

---

## 10. Performance Targets

### 10.1 Minimum System Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 (64-bit) | Windows 11 |
| CPU | 4-core modern CPU | 8-core |
| RAM | 8 GB | 16 GB |
| GPU | None (CPU fallback) | NVIDIA RTX series |
| CUDA | N/A | 11.8+ |
| Storage | 10 GB free | 20 GB free |
| ffmpeg | Required (on PATH) | Bundled (packaged version) |
| Python | 3.11+ | 3.12+ |

macOS support is best-effort (no NVENC, MPS acceleration for OCR may be added later).

### 10.2 Throughput Targets

Target hardware: NVIDIA GPU (e.g., RTX series); CPU fallback supported.

For 1080p screen recording, 10 minutes:
- **Scan stage**: under 3–8 minutes depending on OCR sampling rate and GPU.
- **Export stage**: near real-time with NVENC; 2–4x slower on CPU.

### 10.3 Adaptive Performance Knobs

- OCR sample rate (frames/second of OCR)
- OCR resolution scaling (1.0x, 1.5x, 2.0x)
- Tracking mode (CSRT vs SAM2)
- Proxy resolution (480p, 720p, 1080p)

---

## 11. Error Handling and Edge Cases

### OCR Failure Modes

| Failure | Mitigation |
|---|---|
| Small font | Multi-scale OCR (1.0x then 1.5x); user can zoom in preview |
| Dark mode / low contrast | CLAHE adaptive contrast enhancement pre-OCR |
| Motion blur | Scene change detection; increase OCR frequency |
| Missed text | User "click to redact" override via OCR box selection |

### Tracking Failure Modes

| Failure | Mitigation |
|---|---|
| UI transitions / popups | Drift detection triggers reinitialize |
| Scrolling lists | Treat as "scene motion"; increase OCR frequency |
| Partial occlusion | Allow splitting event by time segment |

---

## 12. Export Spec

### Output Options

- **Codec**: H.264 (default), H.265 (optional)
- **Resolution**: match input | 720p | 1080p | 4K | custom
- **Quality**: CRF mode or bitrate mode
- **Watermark**: "Redacted" overlay (optional)

### Reports

- **JSON**: structured audit report for tooling pipelines
- **HTML/PDF**: human-readable summary report (optional)
- **Safety toggle**: omit extracted PII strings from report

---

## 13. Testing Plan

### Test Corpus

- UI-heavy recordings: tables, forms, chat panels, dashboards
- Dark mode vs light mode
- Stress cases: rapid scrolling, zoom changes, popups and tooltips, partial occlusion

### Metrics

- Detection precision/recall for phones/emails
- Tracking drift rate (manual corrections per minute)
- Export quality regression tests

### End-to-End Verification (v0.1)

1. **Import**: Load a 1080p MP4 — proxy appears in UI within 30 seconds, video is seekable.
2. **Scan**: Run scan on a test recording with an email and phone — both appear as findings.
3. **Accept/Reject**: Accept one finding, reject another — only accepted appear in export.
4. **Export**: Open exported video in VLC, confirm blur is applied and text is unreadable.
5. **Project persistence**: Save, close, reopen — findings and decisions persist.
6. **GPU detection**: Status bar shows GPU name; OCR is faster than CPU baseline.
7. **CPU fallback**: Disable CUDA — app runs without errors, OCR uses CPU.

---

## 14. Milestones

### v0.1 — Core MVP (COMPLETE)

| # | Feature | Status |
|---|---|---|
| 1 | Import MP4/MOV/MKV (auto-detect metadata via ffprobe) | Done |
| 2 | Proxy generation (720p, stored in `.proxy/`) | Done |
| 3 | Video preview + seekable timeline | Done |
| 4 | OCR scan with real-time WebSocket progress | Done |
| 5 | Regex PII detection — phone + email (via Presidio) | Done |
| 6 | Temporal event linking | Done |
| 7 | BBox tracking (CSRT) | Done |
| 8 | Findings panel — list, accept/reject, jump to timestamp | Done |
| 9 | Blur redaction (Gaussian) | Done |
| 10 | Export H.264 (NVENC if available) | Done |
| 11 | Save/load project (JSON) | Done |
| 12 | Keyboard shortcuts (Space, A, R, J/K/L) | Done |

### v0.2 — Hybrid Power (COMPLETE)

| Feature | Status |
|---|---|
| Manual region redact (rectangle draw) + tracking | Done |
| Solid box and pixelate redaction styles | Done |
| Rescan selection range | Done |
| Custom regex rules UI | Done |
| Undo/Redo for all edits | Done |

### v0.3 — Robustness

| Feature | Status |
|---|---|
| NER suggestions for person names | Done (implemented early) |
| Drift detection and tracker reinitialize | Done (implemented early) |
| Scene-change detection + adaptive sampling | Done (implemented early) |
| Face detection (OpenCV DNN) | Done (implemented early) |
| Context rules (field-label adjacency) | Done |
| Batch mode | Done |
| Polygon draw (advanced manual regions) | Done |

### v1.0 — Production

| Feature | Status |
|---|---|
| Audit report output (JSON + HTML) | Done (implemented early) |
| Role-based presets | Done |
| Segmentation tracking (SAM2) for difficult cases | Not started (enum defined) |
| Packaging: Windows installer; macOS `.app` bundle | Not started |
| GPU diagnostics screen | Done |
| Telemetry: OFF by default | N/A (no telemetry code) |

---

## 15. Implementation Notes

- Use **EasyOCR** for screen text — PyTorch-based, GPU auto-detected via CUDA, handles varied fonts and sizes.
- Use **Microsoft Presidio (local)** for PII detection — ships with regex patterns for all common PII types and integrates spaCy NER without reimplementing.
- Use **ffmpeg + NVENC** for export on NVIDIA hardware to keep rendering fast.
- Start with **CSRT bbox tracking**; add SAM2 segmentation tracking in v1.0 for "hard cases".
- Treat **person names as suggestions** unless context rules strongly indicate a name field — prevents annoying false positives.
- All modules should be independently testable with mock inputs — the 7-stage pipeline should be runnable stage-by-stage from the command line for debugging.
- The frontend communicates with the backend exclusively via the REST + WebSocket API — no shared memory or subprocess IPC. This keeps the door open for Electron packaging later.
