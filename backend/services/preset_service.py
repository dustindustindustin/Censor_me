"""
PresetService — manages role-based scan presets.

Presets are named configurations that tune OCR sampling rate, confidence
thresholds, and enabled PII types for different use cases (e.g., screen
recordings, customer support chats, forms/tables).

Built-in presets are shipped as JSON files in ``backend/data/presets/``.
Users can also save custom presets to their projects directory.
"""

import json
import logging
from pathlib import Path

from backend.config import PROJECTS_DIR

logger = logging.getLogger(__name__)

_BUILTIN_PRESETS_DIR = Path(__file__).parent.parent / "data" / "presets"
_CUSTOM_PRESETS_FILE = PROJECTS_DIR / "custom_presets.json"


def _load_builtin_presets() -> list[dict]:
    """Load all built-in preset JSON files from the data directory."""
    presets = []
    if not _BUILTIN_PRESETS_DIR.exists():
        return presets
    for f in sorted(_BUILTIN_PRESETS_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            data["builtin"] = True
            presets.append(data)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("Failed to load preset %s: %s", f.name, exc)
    return presets


def _load_custom_presets() -> list[dict]:
    """Load user-defined presets from the custom presets file."""
    if not _CUSTOM_PRESETS_FILE.exists():
        return []
    try:
        data = json.loads(_CUSTOM_PRESETS_FILE.read_text())
        for p in data:
            p["builtin"] = False
        return data
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Failed to load custom presets: %s", exc)
        return []


def _save_custom_presets(presets: list[dict]) -> None:
    """Persist custom presets to disk."""
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    # Strip the builtin flag before saving
    clean = [{k: v for k, v in p.items() if k != "builtin"} for p in presets]
    _CUSTOM_PRESETS_FILE.write_text(json.dumps(clean, indent=2))


def list_presets() -> list[dict]:
    """Return all presets (built-in + custom)."""
    return _load_builtin_presets() + _load_custom_presets()


def get_preset(preset_id: str) -> dict | None:
    """Look up a single preset by ID."""
    for p in list_presets():
        if p.get("preset_id") == preset_id:
            return p
    return None


def save_custom_preset(preset: dict) -> None:
    """Save a user-defined preset (creates or overwrites by preset_id)."""
    presets = _load_custom_presets()
    # Upsert by preset_id
    presets = [p for p in presets if p.get("preset_id") != preset.get("preset_id")]
    presets.append(preset)
    _save_custom_presets(presets)


def delete_custom_preset(preset_id: str) -> bool:
    """Delete a custom preset. Returns True if found and deleted."""
    presets = _load_custom_presets()
    before = len(presets)
    presets = [p for p in presets if p.get("preset_id") != preset_id]
    if len(presets) == before:
        return False
    _save_custom_presets(presets)
    return True
