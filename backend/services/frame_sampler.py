"""
FrameSampler — adaptive frame sampling for the OCR pipeline.

Determines which frames should be sent to OCR based on:
- Base interval (default: every 5 frames at 30fps = 6 fps OCR rate)
- Scene change events: doubles the sampling rate in a window after a cut
- Motion detection: increases rate when large regions of the frame change
"""

from pathlib import Path

import cv2
import numpy as np

from backend.utils.scene_detect import is_scene_change


class FrameSampler:
    def __init__(
        self,
        video_path: Path,
        base_interval: int = 5,
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
        Uses scene change detection to insert burst intervals around cuts.
        """
        cap = cv2.VideoCapture(str(self._video_path))
        try:
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

            sample_set: set[int] = set()
            prev_frame: np.ndarray | None = None
            burst_remaining = 0
            frame_idx = 0

            while frame_idx < total:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ret, frame = cap.read()
                if not ret:
                    break

                # Detect scene change
                if prev_frame is not None and is_scene_change(prev_frame, frame):
                    burst_remaining = self._burst_frames

                sample_set.add(frame_idx)
                prev_frame = frame

                if burst_remaining > 0:
                    frame_idx += self._burst_interval
                    burst_remaining -= 1
                else:
                    frame_idx += self._base_interval
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
