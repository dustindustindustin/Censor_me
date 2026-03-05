"""
Scene change detection via histogram difference.

Used by FrameSampler to increase OCR frequency around scene transitions,
UI popups, and scroll events.
"""

import cv2
import numpy as np


def compute_histogram(frame: np.ndarray) -> np.ndarray:
    """Compute a normalized grayscale histogram for a frame."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
    cv2.normalize(hist, hist)
    return hist


def histogram_diff(hist_a: np.ndarray, hist_b: np.ndarray) -> float:
    """
    Return histogram difference score (0.0 = identical, 1.0 = completely different).
    Uses Bhattacharyya distance.
    """
    return cv2.compareHist(hist_a, hist_b, cv2.HISTCMP_BHATTACHARYYA)


def is_scene_change(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    threshold: float = 0.35,
) -> bool:
    """
    Return True if the two frames represent a significant scene change.
    Threshold of 0.35 works well for screen recordings; tune per preset.
    """
    hist_a = compute_histogram(frame_a)
    hist_b = compute_histogram(frame_b)
    diff = histogram_diff(hist_a, hist_b)
    return diff > threshold
