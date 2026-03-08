"""
Export API — render redacted video and generate audit report.

POST /export/{project_id}           — start export (returns export_id)
WS   /export/progress/{export_id}   — real-time frame progress
GET  /export/{project_id}/download  — download latest export
GET  /export/{project_id}/report    — audit report (json or html)
"""

import asyncio
import logging
import shutil
import uuid
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.config import PROJECTS_DIR, project_dir
from backend.models.project import OutputSettings, ProjectFile
from backend.services.redaction_renderer import RedactionRenderer
from backend.services.report_service import ReportService

logger = logging.getLogger(__name__)

router = APIRouter()

# In-memory export progress registry
_active_exports: dict[str, dict] = {}


@router.post("/{project_id}")
async def start_export(
    project_id: UUID,
    request: Request,
    output_settings: OutputSettings | None = None,
):
    """
    Start exporting a redacted video in the background.
    Returns an export_id — connect to WS /export/progress/{export_id} for progress.
    """
    pid = str(project_id)
    proj_dir = project_dir(pid)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    project = ProjectFile.load(proj_dir)
    if not project.video:
        raise HTTPException(status_code=422, detail="No video in project")

    if output_settings:
        project.output_settings = output_settings

    accepted_events = [e for e in project.events if e.status == "accepted"]
    if not accepted_events:
        raise HTTPException(status_code=422, detail="No accepted redaction events to export")

    gpu_info = getattr(request.app.state, "gpu", None)

    export_id = str(uuid.uuid4())
    _active_exports[export_id] = {
        "project_id": pid,
        "status": "running",
        "current_frame": 0,
        "total_frames": 0,
        "output_path": None,
        "error": None,
    }

    asyncio.create_task(
        _run_export(export_id, project, proj_dir, accepted_events, gpu_info)
    )

    return {"export_id": export_id, "status": "running"}


@router.websocket("/progress/{export_id}")
async def export_progress_ws(websocket: WebSocket, export_id: str):
    """WebSocket for real-time export progress (frame count)."""
    await websocket.accept()

    if export_id not in _active_exports:
        await websocket.send_json({"error": "Unknown export_id"})
        await websocket.close()
        return

    export = _active_exports[export_id]

    try:
        while export["status"] == "running":
            await websocket.send_json({
                "stage": "encoding",
                "current_frame": export["current_frame"],
                "total_frames": export["total_frames"],
                "pct": (
                    int(export["current_frame"] / export["total_frames"] * 100)
                    if export["total_frames"] > 0 else 0
                ),
            })
            await asyncio.sleep(0.5)

        if export["status"] == "done":
            await websocket.send_json({
                "stage": "done",
                "output_path": export["output_path"],
            })
        else:
            await websocket.send_json({
                "stage": "error",
                "message": export.get("error", "Unknown error"),
            })

    except WebSocketDisconnect:
        pass
    finally:
        await websocket.close()


@router.get("/{project_id}/status/{export_id}")
async def get_export_status(project_id: UUID, export_id: str):
    """Poll-based alternative to WebSocket."""
    if export_id not in _active_exports:
        raise HTTPException(status_code=404, detail="Export not found")
    return _active_exports[export_id]


@router.get("/{project_id}/download")
async def download_export(project_id: UUID):
    """Download the most recent exported video for a project."""
    proj_dir = project_dir(str(project_id))
    exports_dir = proj_dir / "exports"

    if not exports_dir.exists():
        raise HTTPException(status_code=404, detail="No exports found")

    # Only serve completed (non-temp) files
    exports = sorted(
        [p for p in exports_dir.glob("*.mp4") if not p.name.endswith(".tmp")],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not exports:
        raise HTTPException(status_code=404, detail="No export files found")

    return FileResponse(exports[0], media_type="video/mp4", filename=exports[0].name)


class _CopyToRequest(BaseModel):
    destination: str


@router.post("/{project_id}/copy-to")
async def copy_export_to(project_id: UUID, body: _CopyToRequest):
    """Copy the latest exported video to a user-chosen path (used by Tauri save dialog)."""
    proj_dir = project_dir(str(project_id))
    exports_dir = proj_dir / "exports"
    if not exports_dir.exists():
        raise HTTPException(status_code=404, detail="No exports found")

    # Only copy completed (non-temp) files
    exports = sorted(
        [p for p in exports_dir.glob("*.mp4") if not p.name.endswith(".tmp")],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not exports:
        raise HTTPException(status_code=404, detail="No export files found")

    # --- Path traversal protection ---
    dest = Path(body.destination).resolve()

    # Destination must be an absolute path (the Tauri save dialog always provides one)
    if not dest.is_absolute():
        raise HTTPException(status_code=400, detail="Destination must be an absolute path")

    # Prevent writing inside the projects data directory
    try:
        dest.relative_to(PROJECTS_DIR.resolve())
        raise HTTPException(
            status_code=400,
            detail="Destination must be outside the projects directory",
        )
    except ValueError:
        pass  # Good — destination is outside PROJECTS_DIR

    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exports[0], dest)
    return {"saved_to": str(dest)}


@router.get("/{project_id}/report")
async def get_report(project_id: UUID, format: str = "json"):
    """Generate and return an audit report (json or html)."""
    proj_dir = project_dir(str(project_id))
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    project = ProjectFile.load(proj_dir)
    svc = ReportService()

    if format == "html":
        return {"format": "html", "content": svc.generate_html(project)}
    return svc.generate_json(project)


async def _run_export(
    export_id: str,
    project: ProjectFile,
    proj_dir: Path,
    accepted_events: list,
    gpu_info,
) -> None:
    """Background export task."""
    export = _active_exports[export_id]

    def on_progress(current_frame: int, total_frames: int) -> None:
        export["current_frame"] = current_frame
        export["total_frames"] = total_frames

    try:
        source_video = Path(project.video.path)
        if not source_video.is_file():
            raise ValueError(f"Source video not found: {source_video}")
        try:
            source_video.resolve().relative_to(PROJECTS_DIR.resolve())
        except ValueError:
            raise ValueError("Source video path is outside the projects directory")

        renderer = RedactionRenderer()
        output_path = await renderer.render(
            source_video=source_video,
            events=accepted_events,
            output_settings=project.output_settings,
            output_dir=proj_dir / "exports",
            gpu_info=gpu_info,
            on_progress=on_progress,
        )
        export["status"] = "done"
        export["output_path"] = str(output_path)
    except Exception as e:
        logger.exception("Export %s failed: %s", export_id, e)
        export["status"] = "error"
        export["error"] = str(e)
