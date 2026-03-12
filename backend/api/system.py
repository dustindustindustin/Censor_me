"""System status API — used by frontend during startup polling."""

import json
import logging
import os
import platform
import signal
import subprocess
from pathlib import Path

from fastapi import APIRouter, Request, WebSocket

from backend.utils.ffmpeg_path import get_ffmpeg_path

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/status")
async def get_system_status(request: Request):
    """
    Returns hardware and model initialization status.
    Frontend polls this on startup until ready=true.
    While models are loading, ready=false and stage indicates current phase:
      "starting" | "loading_ocr" | "loading_nlp" | "ready" | "error"
    """
    gpu = getattr(request.app.state, "gpu", None)
    ready = getattr(request.app.state, "ready", False)
    stage = getattr(request.app.state, "init_stage", "starting")
    torch_available = getattr(request.app.state, "torch_available", None)
    return {
        "ready": ready,
        "stage": stage,
        "torch_available": torch_available,
        "gpu": {
            "gpu_vendor": gpu.gpu_vendor if gpu else "none",
            "gpu_name": gpu.gpu_name if gpu else None,
            "cuda_available": gpu.cuda_available if gpu else False,
            "mps_available": gpu.mps_available if gpu else False,
            "rocm_available": gpu.rocm_available if gpu else False,
            "hw_encoder": gpu.hw_encoder if gpu else None,
            "gpu_available": gpu.gpu_vendor != "none" if gpu else False,
            "nvenc_available": gpu.nvenc_available if gpu else False,
            "display_name": gpu.display_name if gpu else "Unknown",
        },
    }


def _get_vram_info() -> dict | None:
    """Get VRAM usage info via PyTorch (CUDA/ROCm/MPS)."""
    try:
        import torch
        # CUDA and ROCm (HIP uses torch.cuda APIs)
        if torch.cuda.is_available():
            total = torch.cuda.get_device_properties(0).total_mem
            allocated = torch.cuda.memory_allocated(0)
            reserved = torch.cuda.memory_reserved(0)
            return {
                "total_mb": round(total / 1024 / 1024),
                "allocated_mb": round(allocated / 1024 / 1024),
                "reserved_mb": round(reserved / 1024 / 1024),
                "free_mb": round((total - allocated) / 1024 / 1024),
            }
        # Apple MPS — limited memory introspection
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            allocated = torch.mps.current_allocated_memory() if hasattr(torch.mps, "current_allocated_memory") else 0  # noqa: E501
            return {
                "total_mb": None,
                "allocated_mb": round(allocated / 1024 / 1024),
                "reserved_mb": None,
                "free_mb": None,
            }
    except (ImportError, RuntimeError):
        pass
    return None


def _get_pytorch_info() -> dict | None:
    """Get PyTorch version and backend info."""
    try:
        import torch
        return {
            "version": torch.__version__,
            "cuda_version": torch.version.cuda if hasattr(torch.version, "cuda") else None,
            "cudnn_version": str(torch.backends.cudnn.version()) if torch.backends.cudnn.is_available() else None,  # noqa: E501
            "hip_version": getattr(torch.version, "hip", None),
        }
    except ImportError:
        return None


def _get_ffmpeg_info() -> dict | None:
    """Get ffmpeg version and available encoders."""
    try:
        ffmpeg = get_ffmpeg_path()
        result = subprocess.run(
            [ffmpeg, "-version"],
            capture_output=True, text=True, timeout=5,
        )
        version_line = result.stdout.split('\n')[0] if result.returncode == 0 else None

        # Check key encoders
        enc_result = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=5,
        )
        encoders = enc_result.stdout if enc_result.returncode == 0 else ""

        return {
            "version": version_line,
            "h264_nvenc": "h264_nvenc" in encoders,
            "h264_amf": "h264_amf" in encoders,
            "h264_videotoolbox": "h264_videotoolbox" in encoders,
            "libx264": "libx264" in encoders,
        }
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def _get_system_info() -> dict:
    """Get basic system info."""
    ram_gb = None
    try:
        import psutil
        ram_gb = round(psutil.virtual_memory().total / 1024 / 1024 / 1024, 1)
    except Exception:
        pass
    return {
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
        "cpu": platform.processor() or "Unknown",
        "ram_gb": ram_gb,
    }


@router.get("/diagnostics")
async def get_system_diagnostics(request: Request):
    """Return detailed GPU diagnostics for the settings panel."""
    gpu = getattr(request.app.state, "gpu", None)

    diagnostics = {
        "gpu": {
            "vendor": gpu.gpu_vendor if gpu else "none",
            "name": gpu.gpu_name if gpu else None,
            "display_name": gpu.display_name if gpu else "Unknown",
            "cuda_available": gpu.cuda_available if gpu else False,
            "cuda_version": gpu.cuda_version if gpu else None,
            "mps_available": gpu.mps_available if gpu else False,
            "rocm_available": gpu.rocm_available if gpu else False,
            "directml_available": gpu.directml_available if gpu else False,
            "hw_encoder": gpu.hw_encoder if gpu else None,
            "nvenc_available": gpu.nvenc_available if gpu else False,
        },
        "vram": _get_vram_info(),
        "pytorch": _get_pytorch_info(),
        "ffmpeg": _get_ffmpeg_info(),
        "system": _get_system_info(),
    }
    return diagnostics


@router.post("/shutdown")
async def shutdown():
    """Gracefully shut down the backend process.

    Used by the Tauri shell to stop the sidecar when the desktop app closes.
    Sends SIGTERM to self, which uvicorn handles for a clean shutdown.
    """
    logger.info("Shutdown requested via /system/shutdown")
    pid = os.getpid()
    if hasattr(signal, "SIGTERM"):
        os.kill(pid, signal.SIGTERM)
    else:
        os.kill(pid, signal.SIGINT)
    return {"status": "shutting_down"}


# ── First-Run Setup ──────────────────────────────────────────────────────────

def _setup_config_path() -> Path:
    """Path to the setup completion marker file."""
    if os.environ.get("CENSOR_ME_PORTABLE") == "1":
        app_root = Path(__file__).resolve().parent.parent.parent
        return app_root / "data" / "config.json"
    return Path.home() / ".censor_me" / "config.json"


def _is_setup_complete() -> bool:
    """Check if first-run setup has been completed."""
    config_path = _setup_config_path()
    if not config_path.exists():
        return False
    try:
        data = json.loads(config_path.read_text())
        return data.get("setup_complete", False)
    except (json.JSONDecodeError, OSError):
        return False


@router.get("/setup/status")
async def get_setup_status(request: Request):
    """Check whether first-run setup has been completed."""
    gpu = getattr(request.app.state, "gpu", None)
    return {
        "complete": _is_setup_complete(),
        "gpu_detected": gpu.gpu_vendor != "none" if gpu else False,
        "gpu_vendor": gpu.gpu_vendor if gpu else "none",
        "gpu_name": gpu.gpu_name if gpu else None,
    }


@router.websocket("/setup/install-gpu")
async def install_gpu_ws(websocket: WebSocket, provider: str = "cpu"):
    """
    Install the correct PyTorch variant for the user's GPU.

    Streams pip install progress over WebSocket. Provider options:
    cuda, rocm, directml, mps (no-op), cpu (no-op — CPU PyTorch is bundled).
    """
    await websocket.accept()

    try:
        from backend.services.gpu_installer import install_gpu_provider
        await install_gpu_provider(provider, websocket)
        await websocket.send_json({"stage": "done", "provider": provider})
    except Exception as e:
        logger.exception("GPU provider install failed: %s", e)
        await websocket.send_json({"stage": "error", "message": str(e)})
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass


@router.post("/setup/complete")
async def complete_setup():
    """Mark first-run setup as complete."""
    config_path = _setup_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)

    data = {}
    if config_path.exists():
        try:
            data = json.loads(config_path.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    data["setup_complete"] = True
    config_path.write_text(json.dumps(data, indent=2))
    return {"status": "ok"}
