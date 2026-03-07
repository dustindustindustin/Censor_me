"""Centralized configuration for the Censor Me backend."""

import asyncio
import os
from collections import defaultdict
from pathlib import Path

PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", Path.home() / "censor_me_projects"))


def project_dir(project_id: str) -> Path:
    """Return the on-disk directory for a given project UUID."""
    return PROJECTS_DIR / project_id


# Per-project asyncio locks to serialize load-modify-save operations on
# project.json, preventing lost updates from concurrent requests.
_project_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def get_project_lock(project_id: str) -> asyncio.Lock:
    """Return the asyncio.Lock for the given project_id (created on first use)."""
    return _project_locks[project_id]
