"""
RedactionRenderer — applies redaction styles to video frames and encodes output.

Uses a direct ffmpeg pipe approach: processed frames are streamed to ffmpeg's
stdin rather than written to disk as PNG files. This avoids enormous temp disk
usage (a 10-min 1080p video generates ~300 GB of PNGs in the naive approach).

Audio from the source video is copied to the output automatically.

Pipeline:
  source_video → OpenCV frame reader → apply redactions → ffmpeg stdin pipe
  source_video (audio) ──────────────────────────────────────────────────────→ output
"""

import logging
import subprocess
import threading
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from backend.models.events import RedactionEvent
from backend.models.project import OutputSettings
from backend.utils.ffmpeg_path import get_ffmpeg_path
from backend.utils.gpu_detect import GpuInfo

logger = logging.getLogger(__name__)

# Bbox padding: expand each redaction box by this fraction of its size to catch
# OCR boundary noise (text edges peeking around the censor box).
_BBOX_PAD_PCT = 0.20

# Temporal padding: extend redaction coverage before the first keyframe and
# after the last keyframe by this many milliseconds, so the censor box appears
# slightly before text is visible and lingers slightly after it disappears.
_TEMPORAL_PAD_MS = 750

# EMA smoothing alpha: controls how much each frame's bbox moves toward the raw
# tracked position. Lower = smoother but laggier; higher = more responsive.
# 0.65 (was 0.3) — reduces visual trailing lag during fast-scrolling content.
_EMA_ALPHA = 0.65

# Merge proximity: bboxes within this many pixels of each other are merged into
# a single redaction region to avoid thin uncensored strips between adjacent items.
_MERGE_PROXIMITY_PX = 15


class RedactionRenderer:
    async def render(
        self,
        source_video: Path,
        events: list[RedactionEvent],
        output_settings: OutputSettings,
        output_dir: Path,
        gpu_info: GpuInfo | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> Path:
        """
        Render the redacted video by streaming frames through ffmpeg.

        Args:
            source_video: Path to the original full-resolution video.
            events: Accepted RedactionEvents to apply.
            output_settings: Codec, quality, resolution settings.
            output_dir: Where to write the output file.
            gpu_info: GPU capabilities detected at startup (None = CPU only).
            on_progress: Optional callback(frame, total) for progress reporting.

        Returns:
            Path to the output redacted video file.
        """
        output_dir.mkdir(parents=True, exist_ok=True)
        ext = (
            output_settings.container_format
            if hasattr(output_settings, "container_format") and output_settings.container_format
            else "mp4"
        )
        output_path = output_dir / f"{source_video.stem}_redacted.{ext}"
        # Write to a temp file; rename atomically on success to prevent serving
        # a corrupt/partial file if encoding fails or is interrupted mid-way.
        tmp_path = output_path.parent / (output_path.name + ".tmp")

        # Get video properties
        cap = cv2.VideoCapture(str(source_video))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # Apply resolution scaling if requested
        out_width, out_height = self._resolve_output_size(
            width, height, output_settings
        )

        # Build ffmpeg command
        hw_encoder = gpu_info.hw_encoder if gpu_info else None
        use_hw = bool(hw_encoder and output_settings.use_hw_encoder)

        ffmpeg_cmd = self._build_ffmpeg_cmd(
            source_video=source_video,
            output_path=tmp_path,
            output_settings=output_settings,
            fps=fps,
            width=out_width,
            height=out_height,
            hw_encoder=hw_encoder if use_hw else None,
            container_format=ext,
        )

        # Build frame-to-redaction lookup
        frame_map = self._build_frame_map(events, fps, width, height)
        logger.info(
            "Export starting — source: %s | %dx%d → %dx%d | %.2f fps | %d accepted events | "
            "%d frames have redaction (%.1f%% of %d total)",
            source_video.name, width, height, out_width, out_height, fps,
            len(events), len(frame_map),
            len(frame_map) / total_frames * 100 if total_frames else 0,
            total_frames,
        )

        # Start ffmpeg process (receives raw BGR frames on stdin).
        # stderr is drained by a background thread to prevent the OS pipe
        # buffer (4–64 KB) from filling up and deadlocking the main loop when
        # ffmpeg writes verbose NVENC warnings or error messages.
        proc = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        stderr_chunks: list[bytes] = []

        def _drain_stderr() -> None:
            assert proc.stderr is not None
            for chunk in iter(lambda: proc.stderr.read(4096), b""):
                stderr_chunks.append(chunk)

        stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        stderr_thread.start()

        frame_idx = 0
        try:
            while cap.isOpened():
                ret, frame = cap.read()
                if not ret:
                    break

                # Scale frame if output resolution differs from source
                if (out_width, out_height) != (width, height):
                    frame = cv2.resize(frame, (out_width, out_height))

                # Apply redactions for this frame
                if frame_idx in frame_map:
                    for entry in frame_map[frame_idx]:
                        event, bbox = entry[0], entry[1]
                        poly = entry[2] if len(entry) > 2 else None
                        # Scale bbox (and polygon) if resolution changed
                        if (out_width, out_height) != (width, height):
                            sx = out_width / width
                            sy = out_height / height
                            bbox = (
                                int(bbox[0] * sx),
                                int(bbox[1] * sy),
                                int(bbox[2] * sx),
                                int(bbox[3] * sy),
                            )
                            if poly:
                                poly = [[int(px * sx), int(py * sy)] for px, py in poly]
                        frame = self._apply_redaction(
                            frame, bbox, event.redaction_style, polygon=poly
                        )

                try:
                    proc.stdin.write(frame.tobytes())
                except BrokenPipeError:
                    # ffmpeg exited early (encoding error); stop writing and
                    # let the returncode check below surface the real error.
                    break

                if on_progress and frame_idx % 30 == 0:
                    on_progress(frame_idx, total_frames)

                frame_idx += 1
        finally:
            cap.release()
            try:
                proc.stdin.close()
            except OSError:
                pass

        stderr_thread.join(timeout=30)
        proc.wait()
        stderr = b"".join(stderr_chunks)

        if proc.returncode != 0:
            # Clean up the incomplete temp file before retrying or raising
            tmp_path.unlink(missing_ok=True)
            # Try CPU fallback if hardware encoder failed
            hw_error_markers = [b"nvenc", b"amf", b"videotoolbox", b"hw_encoder"]
            if use_hw and any(m in stderr.lower() for m in hw_error_markers):
                logger.warning("Hardware encoder failed, falling back to CPU (libx264)")
                return await self.render(
                    source_video, events, output_settings, output_dir,
                    gpu_info=None, on_progress=on_progress
                )
            raise RuntimeError(f"ffmpeg encoding failed: {stderr.decode()[-2000:]}")

        # Atomically replace the final output path with the completed temp file
        tmp_path.replace(output_path)

        # Verify the output is a valid, non-empty file
        if not output_path.exists() or output_path.stat().st_size == 0:
            output_path.unlink(missing_ok=True)
            raise RuntimeError(
                "Export produced an empty or missing output file. "
                "Check that ffmpeg succeeded and the disk has sufficient space."
            )

        return output_path

    def _build_ffmpeg_cmd(
        self,
        source_video: Path,
        output_path: Path,
        output_settings: OutputSettings,
        fps: float,
        width: int,
        height: int,
        hw_encoder: str | None,
        container_format: str = "mp4",
    ) -> list[str]:
        """Construct the ffmpeg command for encoding.

        Args:
            hw_encoder: ffmpeg encoder name ("h264_nvenc", "h264_amf",
                        "h264_videotoolbox") or None for CPU (libx264).
        """
        cmd = [
            get_ffmpeg_path(), "-y",
            # Video input: raw BGR frames from stdin
            "-f", "rawvideo",
            "-vcodec", "rawvideo",
            "-s", f"{width}x{height}",
            "-pix_fmt", "bgr24",
            "-r", str(fps),
            "-i", "pipe:0",
            # Original video: used for audio track only
            "-i", str(source_video),
            # Map video from pipe, audio from source (optional)
            "-map", "0:v:0",
            "-map", "1:a:0?",
        ]

        if hw_encoder == "h264_nvenc":
            cmd += [
                "-vcodec", "h264_nvenc",
                "-preset", "p4",
                "-rc:v", "vbr",
                "-cq:v", str(output_settings.crf),
                "-pix_fmt", "yuv420p",
            ]
        elif hw_encoder == "h264_amf":
            cmd += [
                "-vcodec", "h264_amf",
                "-quality", "balanced",
                "-rc", "vbr_peak",
                "-qp_i", str(output_settings.crf),
                "-qp_p", str(output_settings.crf),
                "-pix_fmt", "yuv420p",
            ]
        elif hw_encoder == "h264_videotoolbox":
            cmd += [
                "-vcodec", "h264_videotoolbox",
                "-q:v", "65",
                "-pix_fmt", "yuv420p",
            ]
        else:
            cmd += [
                "-vcodec", "libx264",
                "-preset", "fast",
                "-crf", str(output_settings.crf),
                "-pix_fmt", "yuv420p",
                "-threads", "0",
            ]

        # Map container_format to ffmpeg format name
        _ffmpeg_format = {"mp4": "mp4", "mov": "mov", "mkv": "matroska"}.get(container_format, "mp4")  # noqa: E501
        # movflags +faststart is only meaningful for MP4/MOV; skip for MKV
        extra: list[str] = []
        if container_format in ("mp4", "mov"):
            extra = ["-movflags", "+faststart"]
        cmd += [
            "-acodec", "aac",
            *extra,
            "-f", _ffmpeg_format,
            str(output_path),
        ]

        return cmd

    @staticmethod
    def _pad_bbox(
        bbox: tuple[int, int, int, int],
        frame_w: int,
        frame_h: int,
        pad_pct: float = _BBOX_PAD_PCT,
    ) -> tuple[int, int, int, int]:
        """Expand a bbox by ``pad_pct`` of its size, clamped to frame bounds."""
        x, y, w, h = bbox
        dx = int(w * pad_pct)
        dy = int(h * pad_pct)
        x2 = min(frame_w, x + w + dx)
        y2 = min(frame_h, y + h + dy)
        x = max(0, x - dx)
        y = max(0, y - dy)
        return (x, y, x2 - x, y2 - y)

    def _build_frame_map(
        self,
        events: list[RedactionEvent],
        fps: float,
        frame_w: int = 0,
        frame_h: int = 0,
    ) -> dict[int, list[tuple[RedactionEvent, tuple[int, int, int, int]]]]:
        """
        Build frame_index → [(event, bbox)] mapping using keyframe interpolation.

        Applies bbox padding, temporal padding (pre/post hold), and EMA smoothing.
        Only builds entries for frames that have at least one active redaction
        AND fall within the event's declared time_ranges (with temporal padding).
        """
        frame_map: dict[int, list] = {}
        pad_frames = int((_TEMPORAL_PAD_MS / 1000) * fps)

        for event in events:
            if not event.keyframes:
                continue

            keyframes = event.keyframes

            # --- Core keyframe + interpolation pass ---
            for i, kf in enumerate(keyframes):
                frame_idx = int((kf.time_ms / 1000) * fps)
                bbox = (kf.bbox.x, kf.bbox.y, kf.bbox.w, kf.bbox.h)
                poly = getattr(kf, "polygon", None)
                if frame_w > 0 and frame_h > 0 and not poly:
                    bbox = self._pad_bbox(bbox, frame_w, frame_h)

                if self._in_time_ranges(frame_idx, event.time_ranges, fps, _TEMPORAL_PAD_MS):
                    frame_map.setdefault(frame_idx, []).append((event, bbox, poly))

                # Interpolate to next keyframe
                if i < len(keyframes) - 1:
                    kf_next = keyframes[i + 1]
                    next_idx = int((kf_next.time_ms / 1000) * fps)
                    steps = next_idx - frame_idx

                    for step in range(1, steps):
                        interp_idx = frame_idx + step
                        if self._in_time_ranges(interp_idx, event.time_ranges, fps, _TEMPORAL_PAD_MS):  # noqa: E501
                            t = step / steps
                            interp = self._lerp_bbox(
                                (kf.bbox.x, kf.bbox.y, kf.bbox.w, kf.bbox.h),
                                (kf_next.bbox.x, kf_next.bbox.y, kf_next.bbox.w, kf_next.bbox.h),
                                t,
                            )
                            # Interpolate polygon vertices if both keyframes have polygons
                            interp_poly = None
                            kf_next_poly = getattr(kf_next, "polygon", None)
                            if poly and kf_next_poly and len(poly) == len(kf_next_poly):
                                interp_poly = [
                                    [int(p[0] + (n[0] - p[0]) * t), int(p[1] + (n[1] - p[1]) * t)]
                                    for p, n in zip(poly, kf_next_poly)
                                ]
                            elif poly:
                                interp_poly = poly  # hold polygon shape
                            if frame_w > 0 and frame_h > 0 and not interp_poly:
                                interp = self._pad_bbox(interp, frame_w, frame_h)
                            frame_map.setdefault(interp_idx, []).append((event, interp, interp_poly))  # noqa: E501

            # --- Temporal pre-pad: hold first bbox before first keyframe ---
            first_kf_frame = int((keyframes[0].time_ms / 1000) * fps)
            first_bbox = (keyframes[0].bbox.x, keyframes[0].bbox.y,
                          keyframes[0].bbox.w, keyframes[0].bbox.h)
            first_poly = getattr(keyframes[0], "polygon", None)
            if frame_w > 0 and frame_h > 0 and not first_poly:
                first_bbox = self._pad_bbox(first_bbox, frame_w, frame_h)

            for f in range(max(0, first_kf_frame - pad_frames), first_kf_frame):
                if f not in frame_map or not any(e[0] is event for e in frame_map.get(f, [])):
                    if self._in_time_ranges(f, event.time_ranges, fps, _TEMPORAL_PAD_MS):
                        frame_map.setdefault(f, []).append((event, first_bbox, first_poly))

            # --- Temporal post-pad: hold last bbox after last keyframe ---
            last_kf_frame = int((keyframes[-1].time_ms / 1000) * fps)
            last_bbox = (keyframes[-1].bbox.x, keyframes[-1].bbox.y,
                         keyframes[-1].bbox.w, keyframes[-1].bbox.h)
            last_poly = getattr(keyframes[-1], "polygon", None)
            if frame_w > 0 and frame_h > 0 and not last_poly:
                last_bbox = self._pad_bbox(last_bbox, frame_w, frame_h)

            for f in range(last_kf_frame + 1, last_kf_frame + pad_frames + 1):
                if f not in frame_map or not any(e[0] is event for e in frame_map.get(f, [])):
                    if self._in_time_ranges(f, event.time_ranges, fps, _TEMPORAL_PAD_MS):
                        frame_map.setdefault(f, []).append((event, last_bbox, last_poly))

        # --- EMA smoothing per event ---
        self._smooth_event_bboxes(frame_map, events)

        # --- Merge overlapping bboxes per frame ---
        for fidx in frame_map:
            if len(frame_map[fidx]) > 1:
                frame_map[fidx] = self._merge_overlapping(frame_map[fidx])

        return frame_map

    @staticmethod
    def _in_time_ranges(frame_idx: int, time_ranges: list, fps: float, pad_ms: int = 0) -> bool:
        """
        Return True if frame_idx falls within any of the event's declared time ranges.

        If time_ranges is empty, returns True (backwards-compatible: no declared
        ranges means the redaction is active for the entire video).
        """
        if not time_ranges:
            return True
        for tr in time_ranges:
            start = int(((tr.start_ms - pad_ms) / 1000) * fps)
            end   = int(((tr.end_ms   + pad_ms) / 1000) * fps)
            if start <= frame_idx <= end:
                return True
        return False

    @staticmethod
    def _smooth_event_bboxes(
        frame_map: dict[int, list],
        events: list[RedactionEvent],
    ) -> None:
        """Apply EMA smoothing to each event's bbox sequence in frame_map.

        Polygon entries are skipped (smoothing rectangular approximation
        of a polygon would distort the intended shape).
        """
        for event in events:
            # Collect sorted frame indices where this event appears
            event_frames: list[int] = []
            for fidx in sorted(frame_map.keys()):
                for entry_idx, entry in enumerate(frame_map[fidx]):
                    if entry[0] is event:
                        event_frames.append((fidx, entry_idx))
                        break

            if len(event_frames) < 2:
                continue

            # Skip smoothing for polygon events
            first_entry = frame_map[event_frames[0][0]][event_frames[0][1]]
            if len(first_entry) > 2 and first_entry[2]:
                continue

            # Forward EMA pass
            prev = first_entry[1]
            for fidx, entry_idx in event_frames[1:]:
                entry = frame_map[fidx][entry_idx]
                raw = entry[1]
                poly = entry[2] if len(entry) > 2 else None
                smoothed = tuple(
                    int(_EMA_ALPHA * raw[i] + (1 - _EMA_ALPHA) * prev[i])
                    for i in range(4)
                )
                frame_map[fidx][entry_idx] = (entry[0], smoothed, poly)
                prev = smoothed

    @staticmethod
    def _merge_overlapping(entries: list) -> list:
        """Merge bboxes that overlap or are within _MERGE_PROXIMITY_PX.

        Polygon entries are never merged (they have a custom shape that
        would be destroyed by merging into a rectangular union).
        """
        if len(entries) <= 1:
            return entries

        # Separate polygon entries (never merge) from rect entries
        rect_entries = [e for e in entries if not (len(e) > 2 and e[2])]
        poly_entries = [e for e in entries if len(e) > 2 and e[2]]

        def _close(a: tuple, b: tuple) -> bool:
            ax, ay, aw, ah = a
            bx, by, bw, bh = b
            gap = _MERGE_PROXIMITY_PX
            return not (ax + aw + gap < bx or bx + bw + gap < ax or
                        ay + ah + gap < by or by + bh + gap < ay)

        def _union(a: tuple, b: tuple) -> tuple:
            ax, ay, aw, ah = a
            bx, by, bw, bh = b
            x1 = min(ax, bx)
            y1 = min(ay, by)
            x2 = max(ax + aw, bx + bw)
            y2 = max(ay + ah, by + bh)
            return (x1, y1, x2 - x1, y2 - y1)

        result = list(rect_entries)
        merged = True
        while merged:
            merged = False
            for i in range(len(result)):
                for j in range(i + 1, len(result)):
                    if _close(result[i][1], result[j][1]):
                        union = _union(result[i][1], result[j][1])
                        keep = result[i] if result[i][0].confidence >= result[j][0].confidence else result[j]  # noqa: E501
                        poly = keep[2] if len(keep) > 2 else None
                        result[i] = (keep[0], union, poly)
                        result.pop(j)
                        merged = True
                        break
                if merged:
                    break

        return result + poly_entries

    def _apply_redaction(
        self,
        frame: np.ndarray,
        bbox: tuple[int, int, int, int],
        style,
        polygon: list[list[int]] | None = None,
    ) -> np.ndarray:
        """Apply blur, pixelate, or solid_box redaction to a region.

        If ``polygon`` is provided, the redaction is masked to the polygon shape
        instead of the full rectangular bbox.
        """
        x, y, w, h = bbox
        x, y = max(0, x), max(0, y)
        x2 = min(frame.shape[1], x + w)
        y2 = min(frame.shape[0], y + h)

        if x2 <= x or y2 <= y:
            return frame

        roi = frame[y:y2, x:x2]
        style_type = style.type if hasattr(style, "type") else "blur"
        strength = style.strength if hasattr(style, "strength") else 15

        if style_type == "blur":
            # Ensure kernel size is odd and at least 3
            k = max(3, strength)
            k = k if k % 2 else k + 1
            redacted = cv2.GaussianBlur(roi, (k, k), 0)

        elif style_type == "pixelate":
            block = max(1, strength)
            small_w = max(1, roi.shape[1] // block)
            small_h = max(1, roi.shape[0] // block)
            small = cv2.resize(roi, (small_w, small_h))
            redacted = cv2.resize(small, (roi.shape[1], roi.shape[0]), interpolation=cv2.INTER_NEAREST)  # noqa: E501

        else:  # solid_box
            color_hex = getattr(style, "color", "#000000").lstrip("#")
            r, g, b = int(color_hex[0:2], 16), int(color_hex[2:4], 16), int(color_hex[4:6], 16)
            redacted = np.full(roi.shape, (b, g, r), dtype=roi.dtype)  # OpenCV uses BGR

        # Apply polygon mask if present — blend redacted region only within the polygon
        if polygon and len(polygon) >= 3:
            # Translate polygon vertices to ROI-local coordinates
            local_pts = np.array([[px - x, py - y] for px, py in polygon], dtype=np.int32)
            mask = np.zeros(roi.shape[:2], dtype=np.uint8)
            cv2.fillPoly(mask, [local_pts], 255)
            mask_3ch = mask[:, :, np.newaxis] / 255.0
            blended = (redacted * mask_3ch + roi * (1.0 - mask_3ch)).astype(roi.dtype)
            frame[y:y2, x:x2] = blended
        else:
            frame[y:y2, x:x2] = redacted

        return frame

    def _resolve_output_size(
        self,
        src_w: int,
        src_h: int,
        settings: OutputSettings,
    ) -> tuple[int, int]:
        """Calculate output dimensions based on resolution setting.

        All returned dimensions are rounded to the nearest even integer so that
        libx264/NVENC can produce yuv420p output without 'not divisible by 2' errors.
        """
        def _even(n: float) -> int:
            """Round to the nearest even integer (required by yuv420p)."""
            return max(2, round(n / 2) * 2)

        res = settings.resolution
        if res == "match_input":
            # Source may itself have odd dimensions; clamp just in case.
            return _even(src_w), _even(src_h)
        if res == "720p":
            scale = 720 / src_h
            return _even(src_w * scale), 720
        if res == "1080p":
            scale = 1080 / src_h
            return _even(src_w * scale), 1080
        if res == "4K":
            scale = 2160 / src_h
            return _even(src_w * scale), 2160
        if res == "custom" and settings.custom_width and settings.custom_height:
            return _even(settings.custom_width), _even(settings.custom_height)
        return _even(src_w), _even(src_h)

    @staticmethod
    def _lerp_bbox(
        a: tuple[int, int, int, int],
        b: tuple[int, int, int, int],
        t: float,
    ) -> tuple[int, int, int, int]:
        return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))
