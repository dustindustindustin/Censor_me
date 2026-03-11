"""
FrameSampler — adaptive frame sampling for the OCR pipeline.

Determines which frames should be sent to OCR based on:
- Base interval (default: every 3 frames at 30fps = 10 fps OCR rate)
- Scene change events: doubles the sampling rate in a window after a cut
- Motion detection: increases rate when large regions of the frame change
  (catches scrolling content that has no global scene-cut signal)
"""

from pathlib import Path

import cv2
import numpy as np

from backend.utils.scene_detect import is_scene_change

# Mean absolute pixel difference (grayscale) above which a frame is considered
# to have significant motion vs. the previous sampled frame. Scrolling a
# typical UI generates a MAD of ~10–30; static screens stay below ~3.
_MOTION_MAD_THRESHOLD = 8.0


class FrameSampler:
    def __init__(
        self,
        video_path: Path,
        base_interval: int = 3,
        burst_frames: int = 10,
        burst_interval: int = 2,
    ):
        """
        Args:
            video_path: Source video to sample from.
            base_interval: Normal sampling — 1 frame every N frames.
            burst_frames: How many extra frames to sample after a scene change.
            burst_interval: Sampling interval during a burst window.
        """
        self._video_path = video_path
        self._base_interval = base_interval
        self._burst_frames = burst_frames
        self._burst_interval = burst_interval

    def plan(self) -> list[int]:
        """
        Return the list of frame indices to sample.

        Uses two signals to insert burst-sampling windows:
        - Scene change: global histogram shift (e.g., tab switch, cut)
        - Motion: mean absolute pixel difference between consecutive sampled
          frames exceeds _MOTION_MAD_THRESHOLD (catches scrolling, which has
          no global histogram shift but large local pixel change).

        The final frame of the video is always included so the last segment
        is never skipped due to an uneven interval remainder.
        """
        cap = cv2.VideoCapture(str(self._video_path))
        try:
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            if total <= 0:
                return []

            sample_set: set[int] = set()
            prev_gray: np.ndarray | None = None
            prev_frame: np.ndarray | None = None
            burst_remaining = 0
            frame_idx = 0

            while frame_idx < total:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ret, frame = cap.read()
                if not ret:
                    break

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

                if prev_gray is not None:
                    # Scene change detection (global histogram shift).
                    # is_scene_change expects BGR frames, so pass `frame` directly.
                    if is_scene_change(prev_frame, frame):
                        burst_remaining = self._burst_frames
                    # Motion detection (per-pixel MAD on grayscale — catches scrolling,
                    # which has no global histogram shift but large local pixel change).
                    elif burst_remaining == 0:
                        mad = float(np.mean(np.abs(gray.astype(np.int16) - prev_gray.astype(np.int16))))
                        if mad >= _MOTION_MAD_THRESHOLD:
                            burst_remaining = self._burst_frames

                sample_set.add(frame_idx)
                prev_gray = gray
                prev_frame = frame

                if burst_remaining > 0:
                    frame_idx += self._burst_interval
                    burst_remaining -= 1
                else:
                    frame_idx += self._base_interval

            # Guarantee the last frame is always sampled
            last_frame = total - 1
            sample_set.add(last_frame)
        finally:
            cap.release()

        return sorted(sample_set)

    @staticmethod
    def estimate_total(video_path: Path, base_interval: int = 5) -> int:
        """Estimate how many frames will be OCR'd (for progress bars)."""
        cap = cv2.VideoCapture(str(video_path))
        try:
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        finally:
            cap.release()
        return max(1, total // base_interval)
