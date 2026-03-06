"""
Censor Me — FastAPI Backend Entry Point

Startup sequence:
1. Detect GPU/CUDA availability
2. Verify ffmpeg on PATH
3. Lazy-initialize EasyOCR + Presidio models on first scan (SKIP_MODEL_INIT=1 default)
4. Mount API routers
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api import export, projects, rules, scan, system, video
from backend.utils.gpu_detect import detect_gpu
from backend.utils.startup import initialize_models


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
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routers
app.include_router(system.router, prefix="/system", tags=["system"])
app.include_router(projects.router, prefix="/projects", tags=["projects"])
app.include_router(video.router, prefix="/video", tags=["video"])
app.include_router(scan.router, prefix="/scan", tags=["scan"])
app.include_router(export.router, prefix="/export", tags=["export"])
app.include_router(rules.router, prefix="/rules", tags=["rules"])
