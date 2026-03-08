"""
Batch API — submit, monitor, and cancel multi-video batch jobs.

POST   /batch/submit          — submit a batch of video paths
GET    /batch/                — list all batch jobs
GET    /batch/{batch_id}      — get batch status
POST   /batch/{batch_id}/cancel — cancel a running batch
WS     /batch/progress/{batch_id} — real-time progress stream
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from backend.models.project import OutputSettings, ScanSettings
from backend.services.batch_orchestrator import (
    cancel_batch,
    get_batch,
    list_batches,
    submit_batch,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class BatchSubmitRequest(BaseModel):
    """Request body for batch submission."""
    video_paths: list[str]
    scan_settings: ScanSettings
    output_settings: OutputSettings
    auto_accept: bool = True
    auto_export: bool = True


@router.post("/submit")
async def submit(body: BatchSubmitRequest, request: Request):
    """
    Submit a batch of video file paths for processing.

    Each video gets its own project, scan, and (optionally) export.
    Returns a batch_id immediately. Connect to WS /batch/progress/{batch_id}
    for real-time progress.
    """
    if not body.video_paths:
        raise HTTPException(status_code=422, detail="No video paths provided")

    gpu_info = getattr(request.app.state, "gpu", None)
    use_gpu = gpu_info.gpu_available_for_ocr if gpu_info else False

    job = await submit_batch(
        video_paths=body.video_paths,
        scan_settings=body.scan_settings,
        output_settings=body.output_settings,
        use_gpu=use_gpu,
        auto_accept=body.auto_accept,
        auto_export=body.auto_export,
    )

    return {
        "batch_id": job.batch_id,
        "total": len(job.items),
        "status": job.status,
    }


@router.get("/")
async def list_all():
    """List all batch jobs (running and completed)."""
    return list_batches()


@router.get("/{batch_id}")
async def get_status(batch_id: str):
    """Get the current status of a batch job."""
    job = get_batch(batch_id)
    if not job:
        raise HTTPException(status_code=404, detail="Batch not found")
    return job.summary()


@router.post("/{batch_id}/cancel")
async def cancel(batch_id: str):
    """Cancel a running batch. Already-completed videos are not affected."""
    if not cancel_batch(batch_id):
        raise HTTPException(status_code=404, detail="Batch not found")
    return {"cancelled": batch_id}


@router.websocket("/progress/{batch_id}")
async def batch_progress_ws(websocket: WebSocket, batch_id: str):
    """
    WebSocket endpoint for real-time batch progress.

    Emits JSON events as each video progresses through import/scan/export.
    Connection closes when the batch reaches 'done', 'error', or 'cancelled'.
    """
    await websocket.accept()

    job = get_batch(batch_id)
    if not job:
        await websocket.send_json({"error": "Unknown batch_id"})
        await websocket.close()
        return

    last_sent = 0

    try:
        while job.status in ("queued", "running"):
            current_len = len(job.progress)
            if current_len > last_sent:
                for i in range(last_sent, current_len):
                    await websocket.send_json(job.progress[i])
                last_sent = current_len
            await asyncio.sleep(0.2)

        # Flush remaining events
        for i in range(last_sent, len(job.progress)):
            await websocket.send_json(job.progress[i])

        await websocket.send_json({
            "stage": "batch_complete",
            "status": job.status,
            "summary": job.summary(),
        })

    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass
