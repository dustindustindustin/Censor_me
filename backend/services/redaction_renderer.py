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

import subprocess
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from backend.models.events import RedactionEvent
from backend.models.project import OutputSettings


class RedactionRenderer:
    async def render(
        self,
        source_video: Path,
        events: list[RedactionEvent],
        output_settings: OutputSettings,
        output_dir: Path,
        gpu_available: bool = False,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> Path:
        """
        Render the redacted video by streaming frames through ffmpeg.

        Args:
            source_video: Path to the original full-resolution video.
            events: Accepted RedactionEvents to apply.
            output_settings: Codec, quality, resolution settings.
            output_dir: Where to write the output file.
            gpu_available: Whether NVENC is available for encoding.
            on_progress: Optional callback(frame, total) for progress reporting.

        Returns:
            Path to the output redacted video file.
        """
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{source_video.stem}_redacted.mp4"

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
        ffmpeg_cmd = self._build_ffmpeg_cmd(
            source_video=source_video,
            output_path=output_path,
            output_settings=output_settings,
            fps=fps,
            width=out_width,
            height=out_height,
            gpu_available=gpu_available,
        )

        # Build frame-to-redaction lookup
        frame_map = self._build_frame_map(events, fps)

        # Start ffmpeg process (receives raw BGR frames on stdin)
        proc = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

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
                    for event, bbox in frame_map[frame_idx]:
                        # Scale bbox if resolution changed
                        if (out_width, out_height) != (width, height):
                            sx = out_width / width
                            sy = out_height / height
                            bbox = (
                                int(bbox[0] * sx),
                                int(bbox[1] * sy),
                                int(bbox[2] * sx),
                                int(bbox[3] * sy),
                            )
                        frame = self._apply_redaction(frame, bbox, event.redaction_style)

                proc.stdin.write(frame.tobytes())

                if on_progress and frame_idx % 30 == 0:
                    on_progress(frame_idx, total_frames)

                frame_idx += 1
        finally:
            cap.release()
            proc.stdin.close()

        _, stderr = proc.communicate()
        if proc.returncode != 0:
            # Try CPU fallback if NVENC failed
            if gpu_available and b"nvenc" in stderr.lower():
                return await self.render(
                    source_video, events, output_settings, output_dir,
                    gpu_available=False, on_progress=on_progress
                )
            raise RuntimeError(f"ffmpeg encoding failed: {stderr.decode()[-2000:]}")

        return output_path

    def _build_ffmpeg_cmd(
        self,
        source_video: Path,
        output_path: Path,
        output_settings: OutputSettings,
        fps: float,
        width: int,
        height: int,
        gpu_available: bool,
    ) -> list[str]:
        """Construct the ffmpeg command for encoding."""
        use_nvenc = gpu_available and output_settings.use_nvenc

        cmd = [
            "ffmpeg", "-y",
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

        if use_nvenc:
            cmd += [
                "-vcodec", "h264_nvenc",
                "-preset", "p4",
                "-rc:v", "vbr",
                "-cq:v", str(output_settings.crf),  # NVENC quality equivalent
            ]
        else:
            cmd += [
                "-vcodec", "libx264",
                "-preset", "fast",
                "-crf", str(output_settings.crf),
            ]

        cmd += [
            "-acodec", "aac",  # re-encode audio to ensure container compatibility
            "-movflags", "+faststart",
            str(output_path),
        ]

        return cmd

    def _build_frame_map(
        self,
        events: list[RedactionEvent],
        fps: float,
    ) -> dict[int, list[tuple[RedactionEvent, tuple[int, int, int, int]]]]:
        """
        Build frame_index → [(event, bbox)] mapping using keyframe interpolation.
        Only builds entries for frames that have at least one active redaction.
        """
        frame_map: dict[int, list] = {}

        for event in events:
            if not event.keyframes:
                continue

            keyframes = event.keyframes
            for i, kf in enumerate(keyframes):
                frame_idx = int((kf.time_ms / 1000) * fps)
                bbox = (kf.bbox.x, kf.bbox.y, kf.bbox.w, kf.bbox.h)
                frame_map.setdefault(frame_idx, []).append((event, bbox))

                # Interpolate to next keyframe
                if i < len(keyframes) - 1:
                    kf_next = keyframes[i + 1]
                    next_idx = int((kf_next.time_ms / 1000) * fps)
                    steps = next_idx - frame_idx

                    for step in range(1, steps):
                        t = step / steps
                        interp = self._lerp_bbox(
                            (kf.bbox.x, kf.bbox.y, kf.bbox.w, kf.bbox.h),
                            (kf_next.bbox.x, kf_next.bbox.y, kf_next.bbox.w, kf_next.bbox.h),
                            t,
                        )
                        frame_map.setdefault(frame_idx + step, []).append((event, interp))

        return frame_map

    def _apply_redaction(
        self,
        frame: np.ndarray,
        bbox: tuple[int, int, int, int],
        style,
    ) -> np.ndarray:
        """Apply blur, pixelate, or solid_box redaction to a region."""
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
            redacted = cv2.resize(small, (roi.shape[1], roi.shape[0]), interpolation=cv2.INTER_NEAREST)

        else:  # solid_box
            color_hex = getattr(style, "color", "#000000").lstrip("#")
            r, g, b = int(color_hex[0:2], 16), int(color_hex[2:4], 16), int(color_hex[4:6], 16)
            redacted = np.full_like(roi, (b, g, r))  # OpenCV uses BGR

        frame[y:y2, x:x2] = redacted
        return frame

    def _resolve_output_size(
        self,
        src_w: int,
        src_h: int,
        settings: OutputSettings,
    ) -> tuple[int, int]:
        """Calculate output dimensions based on resolution setting."""
        res = settings.resolution
        if res == "match_input":
            return src_w, src_h
        if res == "720p":
            scale = 720 / src_h
            return int(src_w * scale), 720
        if res == "1080p":
            scale = 1080 / src_h
            return int(src_w * scale), 1080
        if res == "4K":
            scale = 2160 / src_h
            return int(src_w * scale), 2160
        if res == "custom" and settings.custom_width and settings.custom_height:
            return settings.custom_width, settings.custom_height
        return src_w, src_h

    @staticmethod
    def _lerp_bbox(
        a: tuple[int, int, int, int],
        b: tuple[int, int, int, int],
        t: float,
    ) -> tuple[int, int, int, int]:
        return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))
