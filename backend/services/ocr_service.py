"""
OcrService — EasyOCR wrapper for text detection in video frames.

Converts raw video frames (numpy arrays) into ``BoxResult`` objects containing
the text, bounding box, and confidence score for each detected text region.

Design notes
------------
- Uses a **lazy singleton** for the EasyOCR reader because model loading takes
  ~5–10 seconds. The reader is shared across all frames and scan runs.
- Applies **CLAHE contrast enhancement** before OCR to improve detection on
  dark-mode UIs and low-contrast screen recordings.
- Attempts a **1.5× upscaled retry** when fewer than 3 text boxes are found,
  which helps with small-font UI elements (e.g., table cells, status bars).
"""

import logging
from dataclasses import dataclass

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Minimum OCR confidence to accept a text box. Lower than the default 0.3 to
# catch genuine PII text in compressed/low-contrast screen recordings. The
# Presidio NLP layer filters non-PII text afterward, so accepting more OCR
# candidates at this stage improves recall without proportionally increasing
# false positives in the final output.
_OCR_MIN_CONFIDENCE = 0.25

# Module-level singleton for the EasyOCR reader.
# Initialized on first call to _get_reader(); shared for the process lifetime.
_reader_instance = None


def _get_reader(use_gpu: bool):
    """
    Return the EasyOCR Reader, initializing it on first call.

    EasyOCR model loading is expensive (~5–10 s), so we use a singleton.
    The ``use_gpu`` flag is respected on the first call and ignored thereafter
    (the reader cannot be re-initialized with a different device at runtime).

    Args:
        use_gpu: Whether to use CUDA for inference.

    Returns:
        An initialized ``easyocr.Reader`` instance.
    """
    global _reader_instance
    if _reader_instance is None:
        import easyocr

        from backend.utils.model_paths import get_easyocr_model_dir

        kwargs: dict = {"lang_list": ["en"], "gpu": use_gpu, "verbose": False}
        model_dir = get_easyocr_model_dir()
        if model_dir:
            kwargs["model_storage_directory"] = model_dir
        _reader_instance = easyocr.Reader(**kwargs)
        device = "GPU" if use_gpu else "CPU"
        logger.info(f"EasyOCR reader initialized on {device}")
    return _reader_instance


@dataclass
class BoxResult:
    """
    A single text detection result from OCR.

    Attributes:
        bbox: Bounding box ``(x, y, w, h)`` in pixels relative to the frame.
        text: The recognized text string (stripped of leading/trailing whitespace).
        confidence: Detection confidence in the range [0.0, 1.0].
    """

    bbox: tuple[int, int, int, int]  # x, y, w, h
    text: str
    confidence: float


class OcrService:
    """
    Wraps EasyOCR to provide per-frame text detection for the scan pipeline.

    Each call to ``process_frame()`` returns a list of ``BoxResult`` objects
    representing all text regions detected in that frame. The results are
    passed to ``PiiClassifier`` to identify sensitive information.
    """

    def __init__(self, use_gpu: bool = False) -> None:
        """
        Args:
            use_gpu: Whether to use CUDA GPU acceleration for OCR inference.
                     Typically 5–10× faster than CPU on supported hardware.
        """
        self._use_gpu = use_gpu
        # Reader loads lazily on first process_frame() call (via _get_reader).
        # Do NOT load here — this runs on the asyncio event loop and would block it.

    def process_frame(self, frame: np.ndarray) -> list[BoxResult]:
        """
        Run text detection on a single video frame.

        Applies CLAHE contrast enhancement, then runs EasyOCR. If fewer than
        3 boxes are detected (likely a frame with small or faint text), retries
        at 1.5× scale and merges unique results.

        Args:
            frame: A BGR image array with shape (H, W, 3).

        Returns:
            List of ``BoxResult`` objects, sorted by bounding box position.
            May be empty if no text is detected.
        """
        enhanced = self._enhance_contrast(frame)
        results = self._run_ocr(enhanced)

        # Sparse result — retry at larger scale to catch small-font text
        if len(results) < 5:
            upscaled = cv2.resize(frame, None, fx=1.5, fy=1.5)
            enhanced_up = self._enhance_contrast(upscaled)
            try:
                # scale_factor=1.5 so that returned bboxes are in original coordinates
                up_results = self._run_ocr(enhanced_up, scale_factor=1.5)
                # Deduplicate by text content to avoid double-counting
                existing_texts = {r.text.lower() for r in results}
                for r in up_results:
                    if r.text.lower() not in existing_texts:
                        results.append(r)
            finally:
                del upscaled, enhanced_up  # free ~64 MB immediately on 4K source

        return results

    def flush_gpu_cache(self) -> None:
        """Release cached (but unused) GPU memory back to the VRAM pool.

        Supports CUDA (NVIDIA), ROCm/HIP (AMD — uses torch.cuda API), and
        MPS (Apple Metal). No-op on CPU-only machines.
        """
        if not self._use_gpu:
            return
        try:
            import torch
            # ROCm uses torch.cuda.empty_cache() via HIP compatibility layer
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            elif hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
                torch.mps.empty_cache()
        except (ImportError, RuntimeError):
            pass

    def _run_ocr(self, frame: np.ndarray, scale_factor: float = 1.0) -> list[BoxResult]:
        """
        Execute EasyOCR on a preprocessed frame and convert output to BoxResults.

        EasyOCR returns polygon points for each text region. We convert these to
        axis-aligned bounding boxes via ``cv2.boundingRect``, then apply the
        inverse scale factor so all coordinates are in the original frame space.

        Args:
            frame: Preprocessed BGR frame to run OCR on.
            scale_factor: If the frame was upscaled, provide the scale so that
                          returned bboxes are in original (pre-scale) coordinates.

        Returns:
            List of ``BoxResult`` objects with confidence >= _OCR_MIN_CONFIDENCE.
        """
        reader = _get_reader(self._use_gpu)
        # detail=1 returns (polygon, text, confidence) tuples
        raw = reader.readtext(frame, detail=1)
        results = []

        for (polygon, text, confidence) in raw:
            if not text.strip() or confidence < _OCR_MIN_CONFIDENCE:
                continue

            # EasyOCR returns polygon as [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
            # Convert to axis-aligned bounding rect [x, y, w, h]
            pts = np.array(polygon, dtype=np.int32)
            x, y, w, h = cv2.boundingRect(pts)

            # Map coordinates back to original (pre-upscale) frame space
            if scale_factor != 1.0:
                x = int(x / scale_factor)
                y = int(y / scale_factor)
                w = int(w / scale_factor)
                h = int(h / scale_factor)

            results.append(BoxResult(bbox=(x, y, w, h), text=text.strip(), confidence=float(confidence)))  # noqa: E501

        return results

    def _enhance_contrast(self, frame: np.ndarray) -> np.ndarray:
        """
        Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) to a frame.

        CLAHE improves OCR accuracy on dark-mode UIs and low-contrast content by
        locally enhancing contrast without blowing out bright regions. Operates on
        the L channel of the LAB color space to preserve hue and saturation.

        Args:
            frame: Input BGR frame.

        Returns:
            Contrast-enhanced BGR frame with the same dimensions.
        """
        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
        l_channel, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l_channel = clahe.apply(l_channel)
        merged = cv2.merge([l_channel, a, b])
        result = cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)
        del lab, l_channel, a, b, merged
        return result
