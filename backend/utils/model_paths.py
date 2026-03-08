"""Helpers for locating ML model files in portable and dev modes.

In portable mode, models are stored alongside the app binary rather than
scattered in user-profile directories. In dev mode, the defaults apply
(EasyOCR uses ``~/.EasyOCR``, spaCy uses its own cache).
"""

import os
from pathlib import Path


def get_easyocr_model_dir() -> str | None:
    """Return the EasyOCR model storage directory, or None for default.

    Checks ``EASYOCR_MODEL_STORAGE`` env var first. In portable mode, falls
    back to ``{app_root}/models/easyocr/``.
    """
    explicit = os.environ.get("EASYOCR_MODEL_STORAGE")
    if explicit:
        return explicit

    if os.environ.get("CENSOR_ME_PORTABLE") == "1":
        app_root = Path(__file__).resolve().parent.parent.parent
        return str(app_root / "models" / "easyocr")

    return None


def get_spacy_model_path() -> str | None:
    """Return the path to the spaCy model, or None for default.

    Checks ``SPACY_MODEL_PATH`` env var first. In portable mode, falls
    back to ``{app_root}/models/spacy/en_core_web_lg``.
    """
    explicit = os.environ.get("SPACY_MODEL_PATH")
    if explicit:
        return explicit

    if os.environ.get("CENSOR_ME_PORTABLE") == "1":
        app_root = Path(__file__).resolve().parent.parent.parent
        model_path = app_root / "models" / "spacy" / "en_core_web_lg"
        if model_path.exists():
            return str(model_path)

    return None
