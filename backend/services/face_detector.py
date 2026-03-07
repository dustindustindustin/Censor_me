"""
FaceDetector — detects faces in video frames using OpenCV's DNN module.

Uses the ResNet-10 SSD face detector (res10_300x300_ssd) that ships with
OpenCV's DNN module. The model weights are downloaded once on first use
and cached in the app data directory.

Designed as a lazy singleton: the DNN model is loaded on the first call
to ``detect_faces()`` and reused for all subsequent calls.
"""

import logging
import os
import sys
from pathlib import Path

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# URLs for the OpenCV face detector model files
_PROTOTXT_URL = "https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt"
_CAFFEMODEL_URL = (
    "https://raw.githubusercontent.com/opencv/opencv_3rdparty/"
    "dnn_samples_face_detector_20170830/"
    "res10_300x300_ssd_iter_140000.caffemodel"
)


def _model_dir() -> Path:
    """Return the platform-appropriate directory for cached model files."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache"))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    app_data = base / "censor_me" / "models"
    app_data.mkdir(parents=True, exist_ok=True)
    return app_data


def _download_file(url: str, dest: Path) -> None:
    """Download a file from a URL to a local path."""
    import urllib.request
    logger.info("Downloading face detector model file: %s", dest.name)
    urllib.request.urlretrieve(url, str(dest))
    logger.info("Downloaded %s (%.1f MB)", dest.name, dest.stat().st_size / 1_048_576)


class FaceDetector:
    """
    Detects faces in video frames using OpenCV's DNN face detector.

    The model is loaded lazily on the first call to ``detect_faces()``.
    Thread-safe for sequential calls (not designed for concurrent use).
    """

    def __init__(self) -> None:
        self._net: cv2.dnn.Net | None = None

    def _ensure_model(self) -> cv2.dnn.Net:
        """Load the DNN model, downloading weights if necessary."""
        if self._net is not None:
            return self._net

        model_dir = _model_dir()
        prototxt = model_dir / "deploy.prototxt"
        caffemodel = model_dir / "res10_300x300_ssd_iter_140000.caffemodel"

        if not prototxt.exists():
            _download_file(_PROTOTXT_URL, prototxt)
        if not caffemodel.exists():
            _download_file(_CAFFEMODEL_URL, caffemodel)

        logger.info("Loading OpenCV DNN face detector from %s", model_dir)
        self._net = cv2.dnn.readNetFromCaffe(str(prototxt), str(caffemodel))
        logger.info("Face detector model loaded.")
        return self._net

    def detect_faces(
        self,
        frame: np.ndarray,
        min_confidence: float = 0.5,
    ) -> list[tuple[int, int, int, int, float]]:
        """
        Detect faces in a single video frame.

        Args:
            frame: BGR image as a numpy array (from cv2.VideoCapture).
            min_confidence: Minimum detection confidence [0.0, 1.0].

        Returns:
            List of ``(x, y, w, h, confidence)`` tuples in source pixel
            coordinates, matching the OCR BoxResult bbox format.
        """
        net = self._ensure_model()
        h, w = frame.shape[:2]

        # Prepare the input blob — the model expects 300x300 RGB
        blob = cv2.dnn.blobFromImage(
            frame, scalefactor=1.0, size=(300, 300),
            mean=(104.0, 177.0, 123.0), swapRB=False, crop=False,
        )
        net.setInput(blob)
        detections = net.forward()

        results: list[tuple[int, int, int, int, float]] = []

        for i in range(detections.shape[2]):
            confidence = float(detections[0, 0, i, 2])
            if confidence < min_confidence:
                continue

            # Scale bounding box from normalized [0,1] to pixel coordinates
            x1 = int(detections[0, 0, i, 3] * w)
            y1 = int(detections[0, 0, i, 4] * h)
            x2 = int(detections[0, 0, i, 5] * w)
            y2 = int(detections[0, 0, i, 6] * h)

            # Clamp to frame boundaries
            x1 = max(0, x1)
            y1 = max(0, y1)
            x2 = min(w, x2)
            y2 = min(h, y2)

            bw = x2 - x1
            bh = y2 - y1
            if bw < 10 or bh < 10:
                continue  # Skip tiny detections (noise)

            results.append((x1, y1, bw, bh, confidence))

        return results
