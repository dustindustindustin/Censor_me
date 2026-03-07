"""
BatchOrchestrator — processes multiple videos with shared settings.

Each batch job creates a separate project per video, runs the full
scan pipeline, then (optionally) auto-exports accepted events.

Processing is sequential (one video at a time) to avoid GPU contention.
The orchestrator emits progress events so the frontend can show per-video
status in real time via WebSocket.

Lifecycle:
  submit → queued → [for each video: importing → scanning → exporting → done] → batch_done
  Any video failure is recorded but does not abort the remaining queue.
"""

import asyncio
import logging
import time
import uuid
from pathlib import Path
from typing import Any

from backend.api.rules import get_all_rules
from backend.config import PROJECTS_DIR, get_project_lock, project_dir
from backend.models.project import ProjectFile, OutputSettings, ScanSettings
from backend.services.scan_orchestrator import ScanOrchestrator
from backend.services.video_service import VideoService

logger = logging.getLogger(__name__)


class BatchJob:
    """State container for a single batch job."""

    def __init__(
        self,
        batch_id: str,
        video_paths: list[str],
        scan_settings: ScanSettings,
        output_settings: OutputSettings,
        auto_accept: bool = True,
        auto_export: bool = True,
    ) -> None:
        self.batch_id = batch_id
        self.video_paths = video_paths
        self.scan_settings = scan_settings
        self.output_settings = output_settings
        self.auto_accept = auto_accept
        self.auto_export = auto_export

        self.status: str = "queued"  # queued | running | done | error | cancelled
        self.created_at: float = time.time()
        self.current_index: int = 0
        self.cancelled: bool = False

        # Per-video status tracking
        self.items: list[dict[str, Any]] = [
            {
                "filename": Path(p).name,
                "video_path": p,
                "project_id": None,
                "status": "queued",  # queued | importing | scanning | exporting | done | error | skipped
                "error": None,
                "events_found": 0,
                "scan_pct": 0,
                "export_pct": 0,
            }
            for p in video_paths
        ]

        # Progress event buffer for WebSocket streaming
        self.progress: list[dict] = []

    def emit(self, event: dict) -> None:
        """Append a progress event to the buffer."""
        self.progress.append(event)

    def summary(self) -> dict:
        """Return a JSON-serializable summary of this batch job."""
        return {
            "batch_id": self.batch_id,
            "status": self.status,
            "total": len(self.items),
            "current_index": self.current_index,
            "items": self.items,
            "created_at": self.created_at,
        }


# Global registry of batch jobs
_batch_jobs: dict[str, BatchJob] = {}
_batch_lock = asyncio.Lock()


def get_batch(batch_id: str) -> BatchJob | None:
    return _batch_jobs.get(batch_id)


def list_batches() -> list[dict]:
    return [job.summary() for job in _batch_jobs.values()]


async def submit_batch(
    video_paths: list[str],
    scan_settings: ScanSettings,
    output_settings: OutputSettings,
    use_gpu: bool = False,
    auto_accept: bool = True,
    auto_export: bool = True,
) -> BatchJob:
    """Create and enqueue a new batch job. Returns immediately."""
    batch_id = str(uuid.uuid4())

    job = BatchJob(
        batch_id=batch_id,
        video_paths=video_paths,
        scan_settings=scan_settings,
        output_settings=output_settings,
        auto_accept=auto_accept,
        auto_export=auto_export,
    )

    async with _batch_lock:
        _batch_jobs[batch_id] = job

    asyncio.create_task(_run_batch(job, use_gpu))
    return job


def cancel_batch(batch_id: str) -> bool:
    """Request cancellation of a running batch. Returns False if not found."""
    job = _batch_jobs.get(batch_id)
    if not job:
        return False
    job.cancelled = True
    # Mark remaining queued items as skipped
    for item in job.items:
        if item["status"] == "queued":
            item["status"] = "skipped"
    return True


async def _run_batch(job: BatchJob, use_gpu: bool) -> None:
    """Process each video in the batch sequentially."""
    job.status = "running"
    job.emit({"stage": "batch_start", "total": len(job.items)})

    video_svc = VideoService()

    for idx, item in enumerate(job.items):
        if job.cancelled:
            job.emit({"stage": "batch_cancelled", "completed": idx})
            break

        job.current_index = idx
        item["status"] = "importing"
        job.emit({
            "stage": "video_start",
            "index": idx,
            "filename": item["filename"],
        })

        try:
            # --- Create project for this video ---
            project = ProjectFile(name=f"Batch — {item['filename']}")
            project.scan_settings = job.scan_settings.model_copy()
            project.output_settings = job.output_settings.model_copy()

            proj_dir = project_dir(project.project_id)
            proj_dir.mkdir(parents=True, exist_ok=True)

            item["project_id"] = project.project_id

            # --- Import video (copy + metadata + proxy) ---
            src = Path(item["video_path"])
            if not src.exists():
                raise FileNotFoundError(f"Video file not found: {src}")

            dest = proj_dir / src.name
            # Copy file to project directory
            import shutil
            await asyncio.to_thread(shutil.copy2, str(src), str(dest))

            metadata = await asyncio.to_thread(video_svc.get_metadata, dest)
            proxy_path = await asyncio.to_thread(video_svc.generate_proxy, dest, proj_dir)

            project.video = metadata
            project.proxy_path = str(proxy_path)
            project.save(proj_dir)

            job.emit({
                "stage": "video_imported",
                "index": idx,
                "filename": item["filename"],
                "project_id": project.project_id,
            })

            # --- Scan ---
            item["status"] = "scanning"

            def make_scan_emit(idx_: int, item_: dict):
                def _emit(event: dict) -> None:
                    # Forward scan progress with batch context
                    if event.get("stage") == "ocr":
                        item_["scan_pct"] = event.get("progress_pct", 0)
                    elif event.get("stage") == "done":
                        item_["events_found"] = event.get("total_findings", 0)
                    job.emit({
                        **event,
                        "batch_stage": "scanning",
                        "index": idx_,
                        "filename": item_["filename"],
                    })
                return _emit

            rules = [r.model_dump() for r in get_all_rules()]
            orchestrator = ScanOrchestrator(
                project, proj_dir, make_scan_emit(idx, item),
                use_gpu=use_gpu, rules=rules,
            )
            events = await orchestrator.run()

            # Save scan results
            async with get_project_lock(project.project_id):
                fresh = ProjectFile.load(proj_dir)
                fresh.events = events
                fresh.save(proj_dir)

            item["events_found"] = len(events)
            item["scan_pct"] = 100

            job.emit({
                "stage": "scan_done",
                "index": idx,
                "filename": item["filename"],
                "events_found": len(events),
            })

            # --- Auto-accept ---
            if job.auto_accept and events:
                async with get_project_lock(project.project_id):
                    fresh = ProjectFile.load(proj_dir)
                    for ev in fresh.events:
                        ev.status = "accepted"
                    fresh.save(proj_dir)

            # --- Auto-export ---
            if job.auto_export and events:
                item["status"] = "exporting"

                async with get_project_lock(project.project_id):
                    fresh = ProjectFile.load(proj_dir)

                accepted = [e for e in fresh.events if e.status == "accepted"]
                if accepted:
                    from backend.services.redaction_renderer import RedactionRenderer

                    renderer = RedactionRenderer()

                    def make_export_progress(idx_: int, item_: dict):
                        def _on_progress(current: int, total: int) -> None:
                            pct = int(current / total * 100) if total else 0
                            item_["export_pct"] = pct
                            job.emit({
                                "stage": "export_progress",
                                "index": idx_,
                                "filename": item_["filename"],
                                "current_frame": current,
                                "total_frames": total,
                                "pct": pct,
                            })
                        return _on_progress

                    await renderer.render(
                        source_video=Path(fresh.video.path),
                        events=accepted,
                        output_settings=fresh.output_settings,
                        output_dir=proj_dir / "exports",
                        gpu_info=None,
                        on_progress=make_export_progress(idx, item),
                    )
                    item["export_pct"] = 100

            item["status"] = "done"
            job.emit({
                "stage": "video_done",
                "index": idx,
                "filename": item["filename"],
                "events_found": item["events_found"],
            })

        except Exception as e:
            logger.exception("Batch %s: video %d (%s) failed: %s", job.batch_id, idx, item["filename"], e)
            item["status"] = "error"
            item["error"] = str(e)
            job.emit({
                "stage": "video_error",
                "index": idx,
                "filename": item["filename"],
                "error": str(e),
            })

    # Batch complete
    completed = sum(1 for i in job.items if i["status"] == "done")
    failed = sum(1 for i in job.items if i["status"] == "error")

    job.status = "cancelled" if job.cancelled else "done"
    job.emit({
        "stage": "batch_done",
        "total": len(job.items),
        "completed": completed,
        "failed": failed,
    })
