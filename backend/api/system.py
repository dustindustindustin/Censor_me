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
            "cuda_available": gpu.cuda_available if gpu else False,
            "gpu_name": gpu.gpu_name if gpu else None,
            "nvenc_available": gpu.nvenc_available if gpu else False,
            "display_name": gpu.display_name if gpu else "Unknown",
        },
    }
