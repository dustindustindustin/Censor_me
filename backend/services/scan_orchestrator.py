"""
ScanOrchestrator — coordinates the full 7-stage detection pipeline.

This is the top-level service called by ``POST /scan/start/{project_id}``.
It runs all pipeline stages in sequence, emitting progress events after each
frame so the frontend can update the timeline in real time via WebSocket.

Pipeline stages (this module handles stages 1–5):
  1. Sample  — FrameSampler determines which frames to OCR (adaptive sampling).
  2. OCR     — OcrService detects text regions in each sampled frame.
  3. Classify — PiiClassifier identifies PII in the detected text.
  4. Link    — EventLinker groups frame-level candidates into time-linked events.
  5. Track   — TrackerService fills bbox positions between OCR keyframes.
  6. Review  — (UI) User accepts/rejects events in the FindingsPanel.
  7. Render  — (export) RedactionRenderer applies redactions at full resolution.

Progress events
---------------
The ``emit`` callback is called after each OCR frame with a JSON-serializable
dict. These are collected by the scan API endpoint and streamed to the frontend
via WebSocket (``WS /scan/progress/{scan_id}``).
"""

import asyncio
from pathlib import Path
from typing import Callable

import cv2

from backend.models.events import RedactionEvent
from backend.models.project import ProjectFile
from backend.services.event_linker import link_candidates
from backend.services.frame_sampler import FrameSampler
from backend.services.ocr_service import OcrService
from backend.services.pii_classifier import PiiClassifier
from backend.services.tracker_service import TrackerService
from backend.services.video_service import VideoService


class ScanOrchestrator:
    """
    Runs the full PII detection pipeline for a single project.

    Instantiated per scan request. Holds references to all pipeline services
    and the ``emit`` callback used to stream progress to the frontend.
    """

    def __init__(
        self,
        project: ProjectFile,
        project_dir: Path,
        emit: Callable[[dict], None],
        use_gpu: bool = False,
    ) -> None:
        """
        Args:
            project:     The project being scanned. Provides video path and settings.
            project_dir: The project's directory on disk (for saving results).
            emit:        Callback invoked with a progress dict after each pipeline step.
                         These dicts are forwarded to the frontend via WebSocket.
            use_gpu:     Whether GPU acceleration is available for OCR inference.
        """
        self._project = project
        self._project_dir = project_dir
        self._emit = emit
        self._use_gpu = use_gpu

        self._video_svc = VideoService()
        self._ocr = OcrService(use_gpu=use_gpu)
        self._classifier = PiiClassifier(
            confidence_threshold=project.scan_settings.confidence_threshold
        )
        self._tracker = TrackerService()

    async def run(self) -> list[RedactionEvent]:
        """
        Execute all pipeline stages and return the final list of RedactionEvents.

        The caller (``_run_scan`` in ``api/scan.py``) saves the returned events
        to the project file and emits the final ``stage='done'`` progress event.

        Returns:
            List of ``RedactionEvent`` objects with ``status=PENDING``, ready
            for user review in the FindingsPanel.

        Raises:
            Any exception from the pipeline stages propagates up to ``_run_scan``,
            which catches it, sets scan status to 'error', and emits an error event.
        """
        video_path = Path(self._project.video.path)
        metadata = self._project.video
        interval = self._project.scan_settings.ocr_sample_interval
        scale = self._project.scan_settings.ocr_resolution_scale

        # --- Stage 1: Plan adaptive frame sampling ---
        # FrameSampler uses scene-change detection to insert burst sampling
        # intervals around UI transitions, improving detection near scene cuts.
        sampler = FrameSampler(
            video_path,
            base_interval=interval,
            burst_frames=8,
            burst_interval=max(1, interval // 2),
        )
        frame_indices = sampler.plan()
        ocr_frame_count = len(frame_indices)

        self._emit({"stage": "starting", "total_ocr_frames": ocr_frame_count})

        # --- Stages 2–3: OCR + PII classification (combined per frame) ---
        all_candidates = []
        processed = 0

        cap = cv2.VideoCapture(str(video_path))
        fps = cap.get(cv2.CAP_PROP_FPS) or metadata.fps

        for frame_idx in frame_indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                continue

            if scale != 1.0:
                h, w = frame.shape[:2]
                frame = cv2.resize(frame, (int(w * scale), int(h * scale)))

            time_ms = int((frame_idx / fps) * 1000)

            # Stage 2: detect text regions in this frame
            ocr_results = self._ocr.process_frame(frame)

            # Stage 3: classify detected text as PII or non-PII
            candidates = self._classifier.classify(ocr_results, frame_idx, time_ms)
            all_candidates.extend(candidates)

            processed += 1
            self._emit({
                "stage": "ocr",
                "frame": frame_idx,
                "time_ms": time_ms,
                "ocr_boxes": len(ocr_results),
                "findings_so_far": len(all_candidates),
                "progress_pct": int((processed / ocr_frame_count) * 100),
            })

            # Yield to the event loop so that WebSocket messages can be flushed
            # between frames. Without this, progress updates would only be sent
            # when the entire scan completes (Python's async scheduler is cooperative).
            await asyncio.sleep(0)

        cap.release()

        # --- Stage 4: Link per-frame candidates into time-range events ---
        self._emit({"stage": "linking", "total_candidates": len(all_candidates)})
        events = link_candidates(all_candidates)
        self._emit({"stage": "link_done", "events_found": len(events)})

        # --- Stage 5: Track bboxes between OCR keyframes ---
        self._emit({"stage": "tracking", "total_events": len(events)})
        tracked_events = []
        for event in events:
            tracked = self._tracker.track_event(event, str(video_path), fps)
            tracked_events.append(tracked)
            self._emit({"stage": "track", "event_id": tracked.event_id})
            # Yield to event loop so WebSocket remains responsive during tracking
            await asyncio.sleep(0)

        return tracked_events
