"""
Startup initialization: verify dependencies and warm up models.
Called once during FastAPI lifespan startup.
"""

import logging

from backend.utils.ffmpeg_path import get_ffmpeg_path

logger = logging.getLogger(__name__)


class StartupError(Exception):
    """Raised when a required dependency is missing."""


async def initialize_models(gpu_info) -> None:
    """
    Verify required system dependencies and warm up ML models.
    Raises StartupError if a hard requirement is not met.

    Set SKIP_MODEL_INIT=1 to skip model warm-up during development
    (first scan will be slower but startup is instant).
    """
    import os
    if os.environ.get("SKIP_MODEL_INIT") == "1":
        logger.warning("SKIP_MODEL_INIT=1: skipping model warm-up. First scan will load models.")
        _check_ffmpeg()
        return

    _check_ffmpeg()
    await _init_easyocr(gpu_info.gpu_available_for_ocr)
    await _init_presidio()
    logger.info("All models initialized. Ready to accept requests.")


def _check_ffmpeg() -> None:
    """Verify ffmpeg is available on PATH or FFMPEG_PATH env var."""
    import shutil
    ffmpeg_path = get_ffmpeg_path()
    if ffmpeg_path == "ffmpeg" and not shutil.which("ffmpeg"):
        raise StartupError(
            "ffmpeg not found. Install ffmpeg and add it to PATH, "
            "or set FFMPEG_PATH in .env. "
            "Download: https://ffmpeg.org/download.html"
        )
    logger.info(f"ffmpeg found at: {ffmpeg_path}")


async def _init_easyocr(use_gpu: bool) -> None:
    """Initialize EasyOCR reader (downloads models on first run ~100MB)."""
    try:
        from backend.services.ocr_service import _get_reader
        logger.info(f"Initializing EasyOCR (GPU={use_gpu}) — may download models on first run…")
        _get_reader(use_gpu)
        logger.info("EasyOCR initialized.")
    except ImportError:
        raise StartupError("easyocr is not installed. Run: uv pip install easyocr")


async def _init_presidio() -> None:
    """Initialize Microsoft Presidio + spaCy NER model."""
    try:
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider

        from backend.utils.model_paths import get_spacy_model_path

        logger.info("Initializing Presidio analyzer…")
        model_path = get_spacy_model_path()
        if model_path:
            logger.info("Using explicit spaCy model path: %s", model_path)
            config = {
                "nlp_engine_name": "spacy",
                "models": [{"lang_code": "en", "model_name": model_path}],
            }
            provider = NlpEngineProvider(nlp_configuration=config)
            _analyzer = AnalyzerEngine(nlp_engine=provider.create_engine())
        else:
            _analyzer = AnalyzerEngine()
        logger.info("Presidio initialized.")
    except ImportError:
        raise StartupError("presidio-analyzer not installed. Run: uv pip install presidio-analyzer")
    except OSError as e:
        if "en_core_web" in str(e):
            raise StartupError(
                "spaCy model 'en_core_web_lg' not found. "
                "Run: python -m spacy download en_core_web_lg"
            )
        raise
