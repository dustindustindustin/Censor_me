"""
Projects API — CRUD endpoints for Censor Me project files.

A project is a directory on disk containing:
- ``project.json``   — serialized ``ProjectFile`` model
- ``.proxy/``        — 720p preview video
- ``exports/``       — exported redacted video files

All projects live under ``PROJECTS_DIR`` (default: ``~/censor_me_projects/``).
Each project gets its own sub-directory named after its UUID.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.config import PROJECTS_DIR, get_project_lock, project_dir
from backend.models.project import ProjectFile

router = APIRouter()


@router.get("/")
async def list_projects():
    """
    List all projects saved in PROJECTS_DIR.

    Returns a summary list sorted by most recently modified. Corrupted or
    partially-created project directories are silently skipped.
    """
    if not PROJECTS_DIR.exists():
        return []

    projects = []
    for d in PROJECTS_DIR.iterdir():
        if d.is_dir() and (d / "project.json").exists():
            try:
                p = ProjectFile.load(d)
                projects.append({
                    "project_id": p.project_id,
                    "name": p.name,
                    "updated_at": p.updated_at.isoformat(),
                    "video_path": p.video.path if p.video else None,
                    "video": p.video.model_dump() if p.video else None,
                })
            except Exception:
                # Skip directories with invalid project.json (e.g., from older versions)
                pass

    return sorted(projects, key=lambda x: x["updated_at"], reverse=True)


@router.post("/")
async def create_project(name: str = "Untitled Project") -> dict:
    """
    Create a new empty project and save it to disk.

    Returns the new project's UUID so the client can immediately open it
    and begin importing a video.
    """
    project = ProjectFile(name=name)
    proj_dir = project_dir(project.project_id)
    proj_dir.mkdir(parents=True, exist_ok=True)
    project.save(proj_dir)
    return {"project_id": project.project_id}


@router.get("/{project_id}")
async def get_project(project_id: str) -> ProjectFile:
    """
    Load and return a complete project by ID.

    Returns the full ``ProjectFile`` model including all events and settings.
    Used by the frontend after import, scan, and on project open.
    """
    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectFile.load(proj_dir)


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    """
    Permanently delete a project directory and all its contents.

    This removes the source video copy (if stored locally), the proxy, all
    exports, and the project.json. This operation is not reversible.
    """
    import shutil

    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    shutil.rmtree(proj_dir)
    return {"deleted": project_id}


@router.post("/{project_id}/events")
async def add_event(project_id: str, event: dict) -> dict:
    """
    Append a single RedactionEvent to the project.

    Used by the Frame Test modal to manually add a detected finding to
    the project's censor list without running a full scan.
    The event is saved to disk immediately.
    """
    from backend.models.events import RedactionEvent

    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    validated = RedactionEvent.model_validate(event)
    async with get_project_lock(project_id):
        project = ProjectFile.load(proj_dir)
        project.events.append(validated)
        project.save(proj_dir)
    return validated.model_dump()


@router.patch("/{project_id}/events/{event_id}/style")
async def update_event_style(project_id: str, event_id: str, body: dict) -> dict:
    """
    Update the redaction style for a single event.

    Body: { "type": "blur"|"pixelate"|"solid_box", "strength": int, "color": "#rrggbb" }

    The style is applied at export time by RedactionRenderer. Changing it does not
    require re-scanning — only re-exporting.
    """
    from backend.models.events import RedactionStyle

    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    async with get_project_lock(project_id):
        project = ProjectFile.load(proj_dir)
        for event in project.events:
            if event.event_id == event_id:
                event.redaction_style = RedactionStyle.model_validate(body)
                project.save(proj_dir)
                return event.model_dump()

    raise HTTPException(status_code=404, detail="Event not found")


@router.patch("/{project_id}/events/{event_id}/keyframes")
async def update_event_keyframes(project_id: str, event_id: str, body: dict) -> dict:
    """
    Replace a single event's keyframe list.

    Used by the resize-handle interaction in OverlayCanvas when the user
    drags a corner/edge handle to resize a redaction box. The full keyframe
    list is sent so the backend can save the updated positions.

    Body: { "keyframes": [{ "time_ms": int, "bbox": { "x", "y", "w", "h" } }] }
    """
    from backend.models.events import Keyframe

    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    raw_keyframes = body.get("keyframes", [])
    validated_kfs = [Keyframe.model_validate(kf) for kf in raw_keyframes]

    async with get_project_lock(project_id):
        project = ProjectFile.load(proj_dir)
        for event in project.events:
            if event.event_id == event_id:
                event.keyframes = validated_kfs
                project.save(proj_dir)
                return event.model_dump()

    raise HTTPException(status_code=404, detail="Event not found")


@router.patch("/{project_id}/settings")
async def update_settings(project_id: str, body: dict) -> ProjectFile:
    """
    Update scan and/or output settings for a project.

    Body may contain ``scan_settings`` and/or ``output_settings`` keys, each
    being a partial object that is merged into the existing settings.
    """
    from backend.models.project import ScanSettings, OutputSettings

    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    async with get_project_lock(project_id):
        project = ProjectFile.load(proj_dir)
        if "scan_settings" in body:
            merged = project.scan_settings.model_dump() | body["scan_settings"]
            project.scan_settings = ScanSettings.model_validate(merged)
        if "output_settings" in body:
            merged = project.output_settings.model_dump() | body["output_settings"]
            project.output_settings = OutputSettings.model_validate(merged)
        project.save(proj_dir)
    return project


@router.patch("/{project_id}/events/bulk-status")
async def bulk_update_event_status(project_id: str, body: dict):
    """
    Accept, reject, or reset all (or a subset of) events in a single request.

    Body: { "status": "accepted"|"rejected"|"pending", "event_ids": ["id1", ...] | null }

    If event_ids is null, the status is applied to ALL events in the project.
    Loads the project once, updates all matching events in memory, and saves once.

    Returns:
        {"updated": N} where N is the number of events whose status was changed.
    """
    from backend.models.events import EventStatus

    status = body.get("status")
    event_ids: list[str] | None = body.get("event_ids")

    valid_statuses = {s.value for s in EventStatus}
    if status not in valid_statuses:
        raise HTTPException(status_code=422, detail=f"Status must be one of {valid_statuses}")

    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    async with get_project_lock(project_id):
        project = ProjectFile.load(proj_dir)
        event_id_set = set(event_ids) if event_ids is not None else None
        updated = 0
        for event in project.events:
            if event_id_set is None or event.event_id in event_id_set:
                event.status = EventStatus(status)
                updated += 1

        project.save(proj_dir)
    return {"updated": updated}


@router.patch("/{project_id}/events/bulk-style")
async def bulk_update_event_style(project_id: str, body: dict):
    """
    Apply a redaction style to all (or a subset of) events in a single request.

    Body: { "style": { "type": "blur"|"pixelate"|"solid_box", "strength": int, "color": "#rrggbb" },
            "event_ids": ["id1", ...] | null }

    If event_ids is null, applies to ALL events in the project.
    Loads the project once, updates all matching events, and saves once.

    Returns:
        {"updated": N} where N is the number of events whose style was changed.
    """
    from backend.models.events import RedactionStyle

    style_data = body.get("style")
    if not style_data:
        raise HTTPException(status_code=422, detail="Missing 'style' in request body")

    event_ids: list[str] | None = body.get("event_ids")
    style = RedactionStyle.model_validate(style_data)

    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    async with get_project_lock(project_id):
        project = ProjectFile.load(proj_dir)
        event_id_set = set(event_ids) if event_ids is not None else None
        updated = 0
        for event in project.events:
            if event_id_set is None or event.event_id in event_id_set:
                event.redaction_style = style
                updated += 1

        project.save(proj_dir)
    return {"updated": updated}


@router.patch("/{project_id}/events/{event_id}/status")
async def update_event_status(project_id: str, event_id: str, status: str):
    """
    Accept or reject a single redaction event.

    Called by the FindingsPanel when the user clicks Accept or Reject,
    and by the keyboard shortcut handler (A/R keys). Saves the updated
    project immediately after each status change.

    Args:
        status: One of 'accepted', 'rejected', or 'pending'.
    """
    from backend.models.events import EventStatus

    valid_statuses = {s.value for s in EventStatus}
    if status not in valid_statuses:
        raise HTTPException(status_code=422, detail=f"Status must be one of {valid_statuses}")

    proj_dir = project_dir(project_id)

    async with get_project_lock(project_id):
        project = ProjectFile.load(proj_dir)

        for event in project.events:
            if event.event_id == event_id:
                event.status = EventStatus(status)
                project.save(proj_dir)
                return {"event_id": event_id, "status": status}

    raise HTTPException(status_code=404, detail="Event not found")
