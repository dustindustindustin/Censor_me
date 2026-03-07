"""System status API — used by frontend during startup polling."""

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
