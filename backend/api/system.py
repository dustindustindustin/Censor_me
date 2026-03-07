"""System status API — used by frontend during startup polling."""

import platform
import subprocess

from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/status")
async def get_system_status(request: Request):
    """
    Returns hardware and model initialization status.
    Frontend polls this on startup until ready=true.
    """
    gpu = getattr(request.app.state, "gpu", None)
    return {
        "ready": True,
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
    """Get VRAM usage info via PyTorch CUDA."""
    try:
        import torch
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
            "cudnn_version": str(torch.backends.cudnn.version()) if torch.backends.cudnn.is_available() else None,
            "hip_version": getattr(torch.version, "hip", None),
        }
    except ImportError:
        return None


def _get_ffmpeg_info() -> dict | None:
    """Get ffmpeg version and available encoders."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True, text=True, timeout=5,
        )
        version_line = result.stdout.split('\n')[0] if result.returncode == 0 else None

        # Check key encoders
        enc_result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
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
