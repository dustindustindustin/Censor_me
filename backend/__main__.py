"""Entry point for ``python -m backend``.

Used by the Tauri sidecar to launch the backend as a child process.
Configurable via environment variables:
  - CENSOR_ME_PORT: HTTP port (default 8010)
  - CENSOR_ME_PORTABLE: Set to "1" for portable data layout
  - FFMPEG_PATH: Path to bundled ffmpeg binary
"""

import os

import uvicorn

port = int(os.environ.get("CENSOR_ME_PORT", "8010"))

uvicorn.run(
    "backend.main:app",
    host="127.0.0.1",
    port=port,
    log_level="info",
)
