"""Centralized ffmpeg binary path resolution.

All backend code that spawns ffmpeg should call ``get_ffmpeg_path()`` instead of
hardcoding ``"ffmpeg"``. This allows the Tauri desktop build to set ``FFMPEG_PATH``
to a bundled static binary, while falling back to the system PATH for development.
"""

import os
import shutil

_cached_path: str | None = None
_cached_probe_path: str | None = None


def get_ffmpeg_path() -> str:
    """Return the path to the ffmpeg binary.

    Resolution order:
    1. ``FFMPEG_PATH`` environment variable (set by Tauri sidecar launcher).
    2. ``shutil.which("ffmpeg")`` (system PATH lookup).
    3. Bare ``"ffmpeg"`` as a last-resort fallback (will fail with a clear
       FileNotFoundError if ffmpeg is not installed).
    """
    global _cached_path
    if _cached_path is not None:
        return _cached_path

    _cached_path = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or "ffmpeg"
    return _cached_path


def get_ffprobe_path() -> str:
    """Return the path to the ffprobe binary, derived from ffmpeg's location."""
    global _cached_probe_path
    if _cached_probe_path is not None:
        return _cached_probe_path

    ffmpeg = get_ffmpeg_path()
    if ffmpeg == "ffmpeg":
        _cached_probe_path = "ffprobe"
    else:
        # Replace the last occurrence of "ffmpeg" in the path with "ffprobe"
        base = ffmpeg.rsplit("ffmpeg", 1)
        _cached_probe_path = "ffprobe".join(base)
    return _cached_probe_path
