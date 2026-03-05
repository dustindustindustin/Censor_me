"""
Projects API — CRUD endpoints for Censor Me project files.

A project is a directory on disk containing:
- ``project.json``   — serialized ``ProjectFile`` model
- ``.proxy/``        — 720p preview video
- ``exports/``       — exported redacted video files

All projects live under ``PROJECTS_DIR`` (default: ``~/censor_me_projects/``).
Each project gets its own sub-directory named after its UUID.
"""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.models.project import ProjectFile

router = APIRouter()

PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", Path.home() / "censor_me_projects"))


def _project_dir(project_id: str) -> Path:
    """Return the directory path for a project given its ID."""
    return PROJECTS_DIR / project_id


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
    project_dir = _project_dir(project.project_id)
    project_dir.mkdir(parents=True, exist_ok=True)
    project.save(project_dir)
    return {"project_id": project.project_id}


@router.get("/{project_id}")
async def get_project(project_id: str) -> ProjectFile:
    """
    Load and return a complete project by ID.

    Returns the full ``ProjectFile`` model including all events and settings.
    Used by the frontend after import, scan, and on project open.
    """
    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectFile.load(project_dir)


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    """
    Permanently delete a project directory and all its contents.

    This removes the source video copy (if stored locally), the proxy, all
    exports, and the project.json. This operation is not reversible.
    """
    import shutil

    project_dir = _project_dir(project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    shutil.rmtree(project_dir)
    return {"deleted": project_id}


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

    project_dir = _project_dir(project_id)
    project = ProjectFile.load(project_dir)

    for event in project.events:
        if event.event_id == event_id:
            event.status = status
            project.save(project_dir)
            return {"event_id": event_id, "status": status}

    raise HTTPException(status_code=404, detail="Event not found")
