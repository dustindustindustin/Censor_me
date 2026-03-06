"""
Scan API — triggers the OCR + PII detection pipeline.

POST /scan/start/{project_id}    — start a scan (returns scan_id)
WS   /scan/progress/{scan_id}    — real-time progress stream
GET  /scan/status/{scan_id}      — poll status (alternative to WebSocket)
"""

import asyncio
import logging
import os
import uuid
from pathlib import Path

import cv2

logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from backend.api.rules import get_all_rules
from backend.models.project import ProjectFile
from backend.services.scan_orchestrator import ScanOrchestrator

router = APIRouter()

# In-memory scan registry keyed by scan_id
_active_scans: dict[str, dict] = {}

# Tracks which project_ids currently have a scan running (queued or running).
# Prevents duplicate concurrent scans for the same project.
_scanning_projects: set[str] = set()

PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", Path.home() / "censor_me_projects"))


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


@router.post("/start/{project_id}")
async def start_scan(project_id: str, request: Request):
    """Kick off a scan for the given project. Returns a scan_id to track progress."""
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    project = ProjectFile.load(project_dir)
    if not project.video:
        raise HTTPException(status_code=422, detail="No video imported for this project")

    if project_id in _scanning_projects:
        raise HTTPException(status_code=409, detail="A scan is already running for this project")

    # Read GPU availability from app state (set during startup)
    gpu_info = getattr(request.app.state, "gpu", None)
    use_gpu = gpu_info.cuda_available if gpu_info else False

    scan_id = str(uuid.uuid4())
    _active_scans[scan_id] = {
        "project_id": project_id,
        "status": "queued",
        "progress": [],
    }
    _scanning_projects.add(project_id)

    asyncio.create_task(_run_scan(scan_id, project, project_dir, use_gpu))

    return {"scan_id": scan_id}


@router.websocket("/progress/{scan_id}")
async def scan_progress_ws(websocket: WebSocket, scan_id: str):
    """
    WebSocket endpoint for real-time scan progress.
    Emits JSON progress events as each pipeline stage completes.
    """
    await websocket.accept()

    if scan_id not in _active_scans:
        await websocket.send_json({"error": "Unknown scan_id"})
        await websocket.close()
        return

    scan = _active_scans[scan_id]
    last_sent = 0

    try:
        while scan["status"] not in ("done", "error"):
            events = scan["progress"]
            if len(events) > last_sent:
                for event in events[last_sent:]:
                    await websocket.send_json(event)
                last_sent = len(events)
            await asyncio.sleep(0.1)

        # Flush remaining events
        for event in scan["progress"][last_sent:]:
            await websocket.send_json(event)

        await websocket.send_json({"stage": "done", "status": scan["status"]})

    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass  # Client already closed the connection


@router.get("/status/{scan_id}")
async def get_scan_status(scan_id: str):
    """Poll-based alternative to WebSocket for scan status."""
    if scan_id not in _active_scans:
        raise HTTPException(status_code=404, detail="Scan not found")
    scan = _active_scans[scan_id]
    return {
        "scan_id": scan_id,
        "status": scan["status"],
        "progress_events": len(scan.get("progress", [])),
    }


@router.get("/test-frame/{project_id}")
async def test_frame(project_id: str, request: Request, frame_index: int = 0):
    """
    Diagnostic endpoint: run OCR + Presidio on a single frame and return raw results.

    Use this to verify the pipeline is working before running a full scan.
    Returns every OCR box and every Presidio result regardless of confidence threshold,
    so you can see exactly what the scan sees.

    Query params:
        frame_index: Which frame to sample (default: 0). Try 30, 60, 90, etc.
    """
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    project = ProjectFile.load(project_dir)
    if not project.video:
        raise HTTPException(status_code=422, detail="No video imported for this project")

    video_path = Path(project.video.path)
    if not video_path.exists():
        raise HTTPException(
            status_code=422,
            detail=f"Source video not found at: {video_path}. File may have been moved."
        )

    gpu_info = getattr(request.app.state, "gpu", None)
    use_gpu = gpu_info.cuda_available if gpu_info else False

    def _run() -> dict:
        from backend.services.ocr_service import OcrService
        from backend.services.pii_classifier import PiiClassifier

        cap = cv2.VideoCapture(str(video_path))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or project.video.fps

        safe_idx = min(frame_index, max(0, total_frames - 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, safe_idx)
        ret, frame = cap.read()
        cap.release()

        if not ret or frame is None:
            return {
                "error": f"Could not read frame {safe_idx} from video (total frames: {total_frames})",
                "total_frames": total_frames,
                "fps": fps,
            }

        time_ms = int((safe_idx / fps) * 1000)

        # --- OCR ---
        ocr = OcrService(use_gpu=use_gpu)
        ocr_results = ocr.process_frame(frame)

        # --- Presidio: two-pass for full diagnostic visibility ---
        # Pass 1: raw Presidio output with NO filtering (all entity types, all scores)
        # Pass 2: through the real PiiClassifier (applies type map + quality filters)
        presidio_error = None
        raw_results = []
        classifier_candidates = []
        try:
            from presidio_analyzer import AnalyzerEngine
            from backend.services.pii_classifier import PiiClassifier, _PRESIDIO_TYPE_MAP, _PERSON_MIN_CHARS

            # Build composite text the same way PiiClassifier does
            separator = "\n"
            composite = ""
            for box in ocr_results:
                composite += box.text.strip() + separator

            analyzer = AnalyzerEngine()
            threshold = project.scan_settings.confidence_threshold
            presidio_raw = analyzer.analyze(text=composite, language="en")

            for r in presidio_raw:
                matched = composite[r.start:r.end].strip()
                mapped_type = _PRESIDIO_TYPE_MAP.get(r.entity_type)
                # Determine why a result would be excluded
                if mapped_type is None:
                    skip_reason = f"entity type '{r.entity_type}' not in type map"
                elif r.entity_type == "PERSON" and len(matched) < _PERSON_MIN_CHARS:
                    skip_reason = f"PERSON too short ({len(matched)} < {_PERSON_MIN_CHARS} chars)"
                elif r.score < threshold:
                    skip_reason = f"confidence {r.score:.2f} < threshold {threshold:.2f}"
                else:
                    skip_reason = None

                raw_results.append({
                    "entity_type": r.entity_type,
                    "text": matched,
                    "confidence": round(r.score, 3),
                    "mapped_pii_type": mapped_type.value if mapped_type else None,
                    "skip_reason": skip_reason,
                    "would_appear_in_scan": skip_reason is None,
                })

            # Pass 2: run through actual classifier (Presidio + regex rules) for the
            # authoritative candidate list — same code path as the real scan.
            rules = [r.model_dump() for r in get_all_rules()]
            classifier = PiiClassifier(confidence_threshold=threshold)
            classifier.set_custom_rules(rules)
            classifier_candidates = [
                {
                    "text": c.text,
                    "pii_type": c.pii_type.value if hasattr(c.pii_type, "value") else str(c.pii_type),
                    "confidence": round(c.confidence, 3),
                    "bbox": c.bbox,
                }
                for c in classifier.classify(ocr_results, safe_idx, time_ms)
            ]

        except Exception as e:
            presidio_error = str(e)

        kept = [r for r in raw_results if r["would_appear_in_scan"]]

        return {
            "frame_index": safe_idx,
            "time_ms": time_ms,
            "total_frames": total_frames,
            "fps": fps,
            "video_path": str(video_path),
            "use_gpu": use_gpu,
            "ocr": {
                "box_count": len(ocr_results),
                "boxes": [
                    {"text": b.text, "confidence": round(b.confidence, 3), "bbox": b.bbox}
                    for b in ocr_results
                ],
            },
            "presidio": {
                "error": presidio_error,
                "active_threshold": project.scan_settings.confidence_threshold,
                "raw_count": len(raw_results),
                "kept_count": len(kept),
                "filtered_count": len(raw_results) - len(kept),
                "candidates": classifier_candidates,
                "raw": raw_results,
            },
        }

    result = await asyncio.to_thread(_run)
    return result


@router.post("/track-event/{project_id}/{event_id}")
async def track_manual_event(project_id: str, event_id: str):
    """
    Run CSRT tracking forward from a manually-drawn single-keyframe event.

    After a user draws a box on the canvas, that event has only one keyframe
    at the drawn frame. This endpoint runs the tracker forward from that keyframe
    until drift, failure, or video end, densifying the keyframes so the redaction
    follows the on-screen content.

    Returns the updated RedactionEvent with densified keyframes and time_ranges.
    """
    from backend.services.tracker_service import TrackerService

    project_dir = PROJECTS_DIR / project_id
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    project = ProjectFile.load(project_dir)
    if not project.video:
        raise HTTPException(status_code=422, detail="No video in project")

    event = next((e for e in project.events if e.event_id == event_id), None)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")

    video_path = Path(project.video.path)
    if not video_path.exists():
        raise HTTPException(status_code=422, detail=f"Source video not found: {video_path}")

    fps = project.video.fps
    tracker = TrackerService()

    tracked = await asyncio.to_thread(tracker.track_forward, event, str(video_path), fps)

    # Persist the updated event
    for i, e in enumerate(project.events):
        if e.event_id == event_id:
            project.events[i] = tracked
            break
    project.save(project_dir)

    return tracked.model_dump()


async def _run_scan(
    scan_id: str,
    project: ProjectFile,
    project_dir: Path,
    use_gpu: bool,
) -> None:
    """Execute the full detection pipeline and push progress events."""
    scan = _active_scans[scan_id]
    scan["status"] = "running"

    def emit(event: dict) -> None:
        scan["progress"].append(event)

    try:
        rules = [r.model_dump() for r in get_all_rules()]
        orchestrator = ScanOrchestrator(project, project_dir, emit, use_gpu=use_gpu, rules=rules)
        events = await orchestrator.run()

        # Save results to project
        project.events = events
        project.save(project_dir)

        scan["status"] = "done"
        emit({"stage": "done", "total_findings": len(events)})

    except Exception as e:
        logger.exception("Scan %s failed: %s", scan_id, e)
        scan["status"] = "error"
        emit({"stage": "error", "message": str(e)})
    finally:
        _scanning_projects.discard(scan["project_id"])
