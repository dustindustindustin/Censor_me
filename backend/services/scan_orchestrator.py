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
import logging
from pathlib import Path
from typing import Callable

import cv2

from backend.models.events import PiiType, RedactionEvent

logger = logging.getLogger(__name__)
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
        rules: list[dict] | None = None,
        frame_range: tuple[int, int] | None = None,
    ) -> None:
        """
        Args:
            project:     The project being scanned. Provides video path and settings.
            project_dir: The project's directory on disk (for saving results).
            emit:        Callback invoked with a progress dict after each pipeline step.
                         These dicts are forwarded to the frontend via WebSocket.
            use_gpu:     Whether GPU acceleration is available for OCR inference.
            rules:       Serialized Rule dicts from the rules API (default + custom).
                         Passed to PiiClassifier for regex rule evaluation.
            frame_range: Optional (start_frame, end_frame) tuple (inclusive) to limit
                         which frames are OCR-sampled. None means scan the full video.
        """
        self._project = project
        self._project_dir = project_dir
        self._emit = emit
        self._use_gpu = use_gpu
        self._frame_range = frame_range

        self._video_svc = VideoService()
        self._ocr = OcrService(use_gpu=use_gpu)
        self._classifier = PiiClassifier(
            confidence_threshold=project.scan_settings.confidence_threshold,
            entity_confidence_overrides=project.scan_settings.entity_confidence_overrides,
        )
        if rules:
            self._classifier.set_custom_rules(rules)
            logger.info("Loaded %d rules into classifier.", len(rules))
        self._tracker = TrackerService()

        # Face detection (lazy-loaded only if enabled in scan settings)
        self._detect_faces = project.scan_settings.detect_faces
        self._face_detector = None

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
        if not video_path.exists():
            raise FileNotFoundError(
                f"Source video not found at: {video_path}. "
                "The file may have been moved or deleted since it was imported."
            )

        metadata = self._project.video
        interval = self._project.scan_settings.ocr_sample_interval
        scale = self._project.scan_settings.ocr_resolution_scale
        confidence_threshold = self._project.scan_settings.confidence_threshold
        default_style = self._project.scan_settings.default_redaction_style

        logger.info(
            "Scan starting — video: %s | interval: every %d frames | scale: %.1f | threshold: %.2f | GPU: %s",
            video_path.name, interval, scale, confidence_threshold, self._use_gpu,
        )

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

        # Filter to declared frame range if one was specified (range scan mode)
        if self._frame_range:
            start_f, end_f = self._frame_range
            frame_indices = [f for f in frame_indices if start_f <= f <= end_f]

        ocr_frame_count = len(frame_indices)

        self._emit({"stage": "starting", "total_ocr_frames": ocr_frame_count})

        # --- Eagerly warm up Presidio before the OCR loop ---
        # _get_analyzer() loads the spaCy NLP model (~3–5 s). Warming it up here
        # prevents the first OCR frame from stalling while the model initializes,
        # and emits a meaningful stage label the frontend can display.
        self._emit({"stage": "warming_up", "message": "Loading NLP models…"})
        await asyncio.to_thread(self._classifier._get_analyzer)

        # --- Stages 2–3: OCR + PII classification (combined per frame) ---
        all_candidates = []
        processed = 0

        cap = cv2.VideoCapture(str(video_path))
        fps = cap.get(cv2.CAP_PROP_FPS) or metadata.fps
        if not fps or fps <= 0:
            logger.warning("Invalid FPS value (%.2f), defaulting to 30.0", fps or 0)
            fps = 30.0

        for frame_idx in frame_indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()
            if not ret:
                continue

            if scale != 1.0:
                h, w = frame.shape[:2]
                frame = cv2.resize(frame, (int(w * scale), int(h * scale)))

            time_ms = int((frame_idx / fps) * 1000)

            # Stage 2: detect text regions in this frame.
            # Run in a thread pool — EasyOCR is CPU/GPU-bound and would block
            # the asyncio event loop if called directly in a coroutine.
            ocr_results = await asyncio.to_thread(self._ocr.process_frame, frame)

            # If the frame was scaled for OCR, convert bboxes back to source pixel
            # coordinates so that keyframes, tracking, and the renderer all operate
            # in the same coordinate space as the original video.
            if scale != 1.0:
                from backend.services.ocr_service import BoxResult as _BoxResult
                ocr_results = [
                    _BoxResult(
                        bbox=(
                            int(r.bbox[0] / scale),
                            int(r.bbox[1] / scale),
                            int(r.bbox[2] / scale),
                            int(r.bbox[3] / scale),
                        ),
                        text=r.text,
                        confidence=r.confidence,
                    )
                    for r in ocr_results
                ]

            # Stage 3: classify detected text as PII or non-PII
            candidates = self._classifier.classify(ocr_results, frame_idx, time_ms)

            # Stage 3b: face detection (runs on the same frame as OCR)
            if self._detect_faces:
                if self._face_detector is None:
                    from backend.services.face_detector import FaceDetector
                    self._face_detector = FaceDetector()
                face_threshold = self._classifier._entity_overrides.get(
                    "face", self._classifier._threshold
                )
                face_results = await asyncio.to_thread(
                    self._face_detector.detect_faces, frame, face_threshold
                )
                from backend.services.pii_classifier import PiiCandidate
                for fx, fy, fw, fh, fconf in face_results:
                    candidates.append(PiiCandidate(
                        text="[face]",
                        pii_type=PiiType.FACE,
                        confidence=fconf,
                        bbox=(fx, fy, fw, fh),
                        source_frame=frame_idx,
                        source_time_ms=time_ms,
                    ))

            all_candidates.extend(candidates)
            del frame  # release 6–32 MB immediately; don't wait for GC

            processed += 1

            # Periodically flush PyTorch's CUDA allocator cache to keep VRAM
            # usage stable across long scans on lower-VRAM GPUs (4–6 GB).
            if self._use_gpu and processed % 20 == 0:
                self._ocr.flush_gpu_cache()
            self._emit({
                "stage": "ocr",
                "frame": frame_idx,
                "time_ms": time_ms,
                "ocr_boxes": len(ocr_results),
                "findings_so_far": len(all_candidates),
                "progress_pct": int((processed / ocr_frame_count) * 100),
                # Bboxes of PII found on this frame — used by the frontend to seek
                # the video and draw a live scan preview with censor bars.
                "scan_boxes": [
                    {
                        "bbox": list(c.bbox),
                        "pii_type": c.pii_type.value if hasattr(c.pii_type, "value") else str(c.pii_type),
                    }
                    for c in candidates
                ],
            })

            # Yield to the event loop so that WebSocket messages can be flushed
            # between frames. Without this, progress updates would only be sent
            # when the entire scan completes (Python's async scheduler is cooperative).
            await asyncio.sleep(0)

        cap.release()

        logger.info(
            "OCR complete — %d frames processed, %d total candidates found. "
            "If candidates=0, check OCR boxes in progress events and Presidio initialization.",
            processed, len(all_candidates),
        )
        if len(all_candidates) == 0:
            logger.warning(
                "No PII candidates found. Possible causes: "
                "(1) Presidio/spaCy model missing — run: python -m spacy download en_core_web_lg; "
                "(2) OCR found no text — check backend logs for 'ocr_boxes' values; "
                "(3) Confidence threshold %.2f too high — lower it in scan settings; "
                "(4) Video path wrong or file unreadable.",
                confidence_threshold,
            )

        # --- Stage 4: Link per-frame candidates into time-range events ---
        total_candidates = len(all_candidates)
        self._emit({"stage": "linking", "total_candidates": total_candidates})

        def _link_progress(processed: int, total: int) -> None:
            pct = int((processed / total) * 100) if total else 0
            self._emit({
                "stage": "linking",
                "total_candidates": total,
                "progress_pct": min(pct, 100),
            })

        events = link_candidates(all_candidates, on_progress=_link_progress, default_style=default_style)
        self._emit({"stage": "link_done", "events_found": len(events)})

        # --- Stage 4.5: Boundary Refinement ---
        # Sample extra frames near detection boundaries to catch text that
        # appears/disappears between the regular sample interval.
        sampled_set = set(frame_indices)
        boundary_frames: set[int] = set()
        for evt in events:
            for tr in evt.time_ranges:
                start_f = int((tr.start_ms / 1000) * fps)
                end_f = int((tr.end_ms / 1000) * fps)
                for offset in range(1, 11):
                    bf = start_f - offset
                    if bf >= 0 and bf not in sampled_set:
                        boundary_frames.add(bf)
                    ef = end_f + offset
                    if ef not in sampled_set:
                        boundary_frames.add(ef)

        refine_frames = sorted(boundary_frames - sampled_set)
        if 5 <= len(refine_frames) <= 500:
            self._emit({"stage": "refining", "total_refine_frames": len(refine_frames)})
            refine_candidates = []
            cap2 = cv2.VideoCapture(str(video_path))

            for ri, rf_idx in enumerate(refine_frames):
                cap2.set(cv2.CAP_PROP_POS_FRAMES, rf_idx)
                ret, frame = cap2.read()
                if not ret:
                    continue

                if scale != 1.0:
                    h, w = frame.shape[:2]
                    frame = cv2.resize(frame, (int(w * scale), int(h * scale)))

                time_ms = int((rf_idx / fps) * 1000)
                ocr_results = await asyncio.to_thread(self._ocr.process_frame, frame)

                if scale != 1.0:
                    from backend.services.ocr_service import BoxResult as _BoxResult
                    ocr_results = [
                        _BoxResult(
                            bbox=(int(r.bbox[0] / scale), int(r.bbox[1] / scale),
                                  int(r.bbox[2] / scale), int(r.bbox[3] / scale)),
                            text=r.text, confidence=r.confidence,
                        )
                        for r in ocr_results
                    ]

                candidates = self._classifier.classify(ocr_results, rf_idx, time_ms)

                if self._detect_faces and self._face_detector is not None:
                    face_threshold = self._classifier._entity_overrides.get(
                        "face", self._classifier._threshold
                    )
                    face_results = await asyncio.to_thread(
                        self._face_detector.detect_faces, frame, face_threshold
                    )
                    from backend.services.pii_classifier import PiiCandidate
                    for fx, fy, fw, fh, fconf in face_results:
                        candidates.append(PiiCandidate(
                            text="[face]",
                            pii_type=PiiType.FACE,
                            confidence=fconf,
                            bbox=(fx, fy, fw, fh),
                            source_frame=rf_idx,
                            source_time_ms=time_ms,
                        ))

                refine_candidates.extend(candidates)
                del frame

                if (ri + 1) % 10 == 0:
                    pct = int(((ri + 1) / len(refine_frames)) * 100)
                    self._emit({"stage": "refining", "progress_pct": min(pct, 100)})

                await asyncio.sleep(0)

            cap2.release()

            if refine_candidates:
                all_candidates.extend(refine_candidates)
                events = link_candidates(all_candidates, on_progress=_link_progress, default_style=default_style)
                self._emit({"stage": "refine_done", "events_found": len(events),
                             "extra_candidates": len(refine_candidates)})

        # --- Stage 5: Track bboxes between OCR keyframes ---
        # track_all_events() opens the video once and processes all events in a
        # single sequential pass — O(1) video opens vs. O(N_events) in the naive
        # per-event loop. For 50 events this is typically 10–50× faster.
        self._emit({"stage": "tracking", "total_events": len(events)})

        def _track_progress(frames_done: int, total_frames: int, active_trackers: int, time_ms: int) -> None:
            pct = int((frames_done / total_frames) * 100) if total_frames else 0
            self._emit({
                "stage": "track",
                "frames_done": frames_done,
                "total_frames": total_frames,
                "active_trackers": active_trackers,
                "progress_pct": min(pct, 100),
                "time_ms": time_ms,
            })

        tracked_events = await asyncio.to_thread(
            self._tracker.track_all_events, events, str(video_path), fps,
            on_progress=_track_progress,
        )
        self._emit({"stage": "track_done"})

        return tracked_events
