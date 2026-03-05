"""
Export API — render redacted video and generate audit report.

POST /export/{project_id}           — start export (returns export_id)
WS   /export/progress/{export_id}   — real-time frame progress
GET  /export/{project_id}/download  — download latest export
GET  /export/{project_id}/report    — audit report (json or html)
"""

import asyncio
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from backend.models.project import OutputSettings, ProjectFile
from backend.services.redaction_renderer import RedactionRenderer
from backend.services.report_service import ReportService

router = APIRouter()

# In-memory export progress registry
_active_exports: dict[str, dict] = {}

PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", Path.home() / "censor_me_projects"))


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


@router.post("/{project_id}")
async def start_export(
    project_id: str,
    request: Request,
    output_settings: OutputSettings | None = None,
):
    """
    Start exporting a redacted video in the background.
    Returns an export_id — connect to WS /export/progress/{export_id} for progress.
    """
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    project = ProjectFile.load(project_dir)
    if not project.video:
        raise HTTPException(status_code=422, detail="No video in project")

    if output_settings:
        project.output_settings = output_settings

    accepted_events = [e for e in project.events if e.status == "accepted"]
    if not accepted_events:
        raise HTTPException(status_code=422, detail="No accepted redaction events to export")

    gpu_info = getattr(request.app.state, "gpu", None)
    gpu_available = gpu_info.nvenc_available if gpu_info else False

    export_id = str(uuid.uuid4())
    _active_exports[export_id] = {
        "project_id": project_id,
        "status": "running",
        "current_frame": 0,
        "total_frames": 0,
        "output_path": None,
        "error": None,
    }

    asyncio.create_task(
        _run_export(export_id, project, project_dir, accepted_events, gpu_available)
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
async def get_export_status(project_id: str, export_id: str):
    """Poll-based alternative to WebSocket."""
    if export_id not in _active_exports:
        raise HTTPException(status_code=404, detail="Export not found")
    return _active_exports[export_id]


@router.get("/{project_id}/download")
async def download_export(project_id: str):
    """Download the most recent exported video for a project."""
    project_dir = _project_dir(project_id)
    exports_dir = project_dir / "exports"

    if not exports_dir.exists():
        raise HTTPException(status_code=404, detail="No exports found")

    exports = sorted(exports_dir.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not exports:
        raise HTTPException(status_code=404, detail="No export files found")

    return FileResponse(exports[0], media_type="video/mp4", filename=exports[0].name)


@router.get("/{project_id}/report")
async def get_report(project_id: str, format: str = "json"):
    """Generate and return an audit report (json or html)."""
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    project = ProjectFile.load(project_dir)
    svc = ReportService()

    if format == "html":
        return {"format": "html", "content": svc.generate_html(project)}
    return svc.generate_json(project)


async def _run_export(
    export_id: str,
    project: ProjectFile,
    project_dir: Path,
    accepted_events: list,
    gpu_available: bool,
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
            output_dir=project_dir / "exports",
            gpu_available=gpu_available,
            on_progress=on_progress,
        )
        export["status"] = "done"
        export["output_path"] = str(output_path)
    except Exception as e:
        export["status"] = "error"
        export["error"] = str(e)
