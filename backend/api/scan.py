"""
Scan API — triggers the OCR + PII detection pipeline.

POST /scan/start/{project_id}    — start a scan (returns scan_id)
WS   /scan/progress/{scan_id}    — real-time progress stream
GET  /scan/status/{scan_id}      — poll status (alternative to WebSocket)
"""

import asyncio
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from backend.models.project import ProjectFile
from backend.services.scan_orchestrator import ScanOrchestrator

router = APIRouter()

# In-memory scan registry keyed by scan_id
_active_scans: dict[str, dict] = {}

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

    # Read GPU availability from app state (set during startup)
    gpu_info = getattr(request.app.state, "gpu", None)
    use_gpu = gpu_info.cuda_available if gpu_info else False

    scan_id = str(uuid.uuid4())
    _active_scans[scan_id] = {
        "project_id": project_id,
        "status": "queued",
        "progress": [],
    }

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
        await websocket.close()


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
        orchestrator = ScanOrchestrator(project, project_dir, emit, use_gpu=use_gpu)
        events = await orchestrator.run()

        # Save results to project
        project.events = events
        project.save(project_dir)

        scan["status"] = "done"
        emit({"stage": "done", "total_findings": len(events)})

    except Exception as e:
        scan["status"] = "error"
        emit({"stage": "error", "message": str(e)})
