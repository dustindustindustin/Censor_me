"""
Video import and proxy serving API.

POST /video/import/{project_id}  — import a video file into a project
GET  /video/proxy/{project_id}   — serve proxy video with range request support
"""

from pathlib import Path

import aiofiles
from fastapi import APIRouter, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from backend.config import project_dir
from backend.models.project import ProjectFile, VideoMetadata
from backend.services.video_service import VideoService

router = APIRouter()

MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024  # 50 GB


@router.post("/import/{project_id}")
async def import_video(project_id: str, file: UploadFile):
    """
    Save uploaded video to project dir, extract metadata, and generate proxy.
    Proxy generation runs synchronously for now (async task queue in v0.2).
    """
    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    # Validate file extension
    allowed = {".mp4", ".mov", ".mkv", ".avi", ".webm"}
    suffix = Path(file.filename).suffix.lower()
    if suffix not in allowed:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported format '{suffix}'. Allowed: {', '.join(allowed)}"
        )

    # Sanitize filename — use only the basename to prevent path traversal
    safe_name = Path(file.filename).name
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(status_code=422, detail="Invalid filename")

    video_path = proj_dir / safe_name

    # Defense-in-depth: ensure the resolved path stays inside the project directory
    try:
        video_path.resolve().relative_to(proj_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid file path")

    # Stream upload in chunks to avoid loading the entire file into RAM
    total_bytes = 0
    async with aiofiles.open(video_path, "wb") as f:
        while chunk := await file.read(1024 * 1024):  # 1 MB chunks
            total_bytes += len(chunk)
            if total_bytes > MAX_UPLOAD_BYTES:
                await f.close()
                video_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="File too large (max 50 GB)")
            await f.write(chunk)

    # Extract metadata and generate proxy
    svc = VideoService()
    metadata = svc.get_metadata(video_path)
    proxy_path = svc.generate_proxy(video_path, proj_dir)

    # Update project
    project = ProjectFile.load(proj_dir)
    project.video = metadata
    project.proxy_path = str(proxy_path)
    project.save(proj_dir)

    return {
        "video_path": str(video_path),
        "proxy_path": str(proxy_path),
        "metadata": metadata.model_dump(),
    }


@router.get("/proxy/{project_id}")
async def serve_proxy(project_id: str, request: Request):
    """
    Serve the proxy video with HTTP range request support.
    This allows the browser <video> element to seek without buffering the full file.
    """
    proj_dir = project_dir(project_id)
    if not proj_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    project = ProjectFile.load(proj_dir)
    if not project.proxy_path or not Path(project.proxy_path).exists():
        raise HTTPException(status_code=404, detail="Proxy video not found. Import a video first.")

    proxy_path = Path(project.proxy_path)
    file_size = proxy_path.stat().st_size

    range_header = request.headers.get("range")

    if range_header:
        # Parse byte range: "bytes=start-end"
        range_val = range_header.replace("bytes=", "")
        start_str, _, end_str = range_val.partition("-")
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1
        end = min(end, file_size - 1)
        chunk_size = end - start + 1

        async def iter_file():
            async with aiofiles.open(proxy_path, "rb") as f:
                await f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    data = await f.read(min(65536, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            iter_file(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(chunk_size),
            },
        )

    # No range header — serve full file
    async def iter_full():
        async with aiofiles.open(proxy_path, "rb") as f:
            while chunk := await f.read(65536):
                yield chunk

    return StreamingResponse(
        iter_full(),
        media_type="video/mp4",
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
        },
    )
