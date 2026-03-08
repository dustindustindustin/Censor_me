"""Centralized configuration for the Censor Me backend."""

import asyncio
import os
from collections import defaultdict
from pathlib import Path


def _resolve_projects_dir() -> Path:
    """Determine the projects directory based on environment configuration.

    In portable mode (``CENSOR_ME_PORTABLE=1``), data lives relative to the app
    root so the entire folder can be moved without breaking paths. Otherwise,
    uses the user's home directory (or an explicit ``PROJECTS_DIR`` override).
    """
    explicit = os.environ.get("PROJECTS_DIR")
    if explicit:
        return Path(explicit)

    if os.environ.get("CENSOR_ME_PORTABLE") == "1":
        # App root is the parent of the backend/ package directory
        app_root = Path(__file__).resolve().parent.parent
        return app_root / "data" / "projects"

    return Path.home() / "censor_me_projects"


PROJECTS_DIR = _resolve_projects_dir()


def project_dir(project_id: str) -> Path:
    """Return the on-disk directory for a given project UUID."""
    return PROJECTS_DIR / project_id


# Per-project asyncio locks to serialize load-modify-save operations on
# project.json, preventing lost updates from concurrent requests.
_project_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def get_project_lock(project_id: str) -> asyncio.Lock:
    """Return the asyncio.Lock for the given project_id (created on first use)."""
    return _project_locks[project_id]
