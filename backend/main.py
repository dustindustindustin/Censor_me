"""
Censor Me — FastAPI Backend Entry Point

Startup sequence:
1. Detect GPU/CUDA availability
2. Verify ffmpeg on PATH
3. Lazy-initialize EasyOCR + Presidio models on first scan (SKIP_MODEL_INIT=1 default)
4. Mount API routers
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.api import batch, export, presets, projects, rules, scan, system, video
from backend.utils.gpu_detect import detect_gpu
from backend.utils.startup import initialize_models

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup checks and model initialization before accepting requests."""
    gpu_info = detect_gpu()
    app.state.gpu = gpu_info

    await initialize_models(gpu_info)

    yield

    # Cleanup on shutdown (if needed)


app = FastAPI(
    title="Censor Me",
    description="Local GPU-accelerated video PII redaction API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],  # Vite dev server
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch unhandled exceptions and return structured JSON instead of bare 500s."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "type": type(exc).__name__},
    )


# API routers
app.include_router(system.router, prefix="/system", tags=["system"])
app.include_router(projects.router, prefix="/projects", tags=["projects"])
app.include_router(video.router, prefix="/video", tags=["video"])
app.include_router(scan.router, prefix="/scan", tags=["scan"])
app.include_router(export.router, prefix="/export", tags=["export"])
app.include_router(rules.router, prefix="/rules", tags=["rules"])
app.include_router(presets.router, prefix="/presets", tags=["presets"])
app.include_router(batch.router, prefix="/batch", tags=["batch"])
