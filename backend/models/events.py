"""
RedactionEvent and related enums/models — the core data model of Censor Me.

Both auto-detected PII and manually-drawn regions share the same ``RedactionEvent``
schema. This single unified model drives the scan pipeline, the UI findings list,
the redaction renderer, and the audit report — avoiding separate code paths for
"auto" vs "manual" regions.

Data flow:
  OcrService → PiiClassifier → EventLinker → [RedactionEvent list]
  → TrackerService (fills keyframes)
  → User review (status: accepted / rejected)
  → RedactionRenderer (accepted only) → exported video
"""

from enum import Enum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field


class PiiType(str, Enum):
    """
    Classification of detected sensitive information.

    High-confidence types (PHONE, EMAIL, SSN, CREDIT_CARD, ACCOUNT_ID,
    POSTAL_CODE) are detected via Presidio regex recognizers and reliably
    match structured patterns.

    Medium-confidence types (PERSON, ADDRESS, USERNAME) rely on spaCy NER
    or contextual heuristics and may require user review to confirm.

    CUSTOM indicates a match from a user-defined regex rule.
    MANUAL indicates a region drawn by the user without any auto-detection.
    UNKNOWN is the fallback when a Presidio entity type has no mapping.
    """

    PHONE = "phone"
    EMAIL = "email"
    PERSON = "person"
    ADDRESS = "address"
    CREDIT_CARD = "credit_card"
    SSN = "ssn"
    ACCOUNT_ID = "account_id"
    EMPLOYEE_ID = "employee_id"
    POSTAL_CODE = "postal_code"
    USERNAME = "username"
    CUSTOM = "custom"
    MANUAL = "manual"
    UNKNOWN = "unknown"


class TrackingMethod(str, Enum):
    """
    How a RedactionEvent's bounding box is tracked between OCR keyframes.

    CSRT    — OpenCV CSRT correlation-filter tracker. Fast and accurate for
              screen recordings with minimal deformation. Default for v0.1.
    SAM2    — Segment Anything Model 2 segmentation tracker. Higher accuracy
              for complex motion or partially occluded regions. Planned v1.0.
    MANUAL  — User manually positioned every keyframe; no automatic tracking.
    NONE    — Static bounding box; applied at a fixed position across the
              entire time range with no tracking (e.g., a single-frame redaction).
    """

    CSRT = "csrt"
    SAM2 = "sam2"
    MANUAL = "manual"
    NONE = "none"


class RedactionStyle(BaseModel):
    """
    Visual style applied to a redacted region during export.

    All three styles irreversibly obscure the underlying content in the
    output video. The ``strength`` field controls intensity:
    - blur: Gaussian kernel size (higher = more blurred)
    - pixelate: block size in pixels (higher = coarser mosaic)
    - solid_box: ``strength`` is unused; ``color`` sets the fill color.
    """

    type: Literal["blur", "pixelate", "solid_box"] = "blur"
    strength: int = Field(
        default=15, ge=1, le=100,
        description="Blur radius (blur), block size (pixelate), or unused (solid_box)."
    )
    color: str = Field(
        default="#000000",
        description="Fill color for solid_box style. Hex string, e.g. '#000000'."
    )


class BoundingBox(BaseModel):
    """
    Axis-aligned bounding box in pixel coordinates relative to the video frame.

    Coordinates are in the *source* video's native resolution, not the proxy.
    The renderer scales them as needed during export.
    """

    x: int = Field(description="Left edge of the box in pixels.")
    y: int = Field(description="Top edge of the box in pixels.")
    w: int = Field(description="Width of the box in pixels.")
    h: int = Field(description="Height of the box in pixels.")


class Keyframe(BaseModel):
    """
    A single bounding box at a specific point in time.

    The TrackerService fills in keyframes between OCR sample points. The
    RedactionRenderer interpolates linearly between adjacent keyframes to
    produce a smooth-moving redaction region in the exported video.
    """

    time_ms: int = Field(description="Timestamp in milliseconds from the start of the video.")
    bbox: BoundingBox


class TimeRange(BaseModel):
    """
    A contiguous time interval [start_ms, end_ms] during which a redaction is active.

    A single RedactionEvent may have multiple time ranges if the same text
    disappears and reappears (e.g., a tooltip that opens and closes). The
    renderer applies redaction only during these intervals.
    """

    start_ms: int = Field(description="Start of the range in milliseconds.")
    end_ms: int = Field(description="End of the range in milliseconds (inclusive).")


class EventStatus(str, Enum):
    """
    User's review decision for a RedactionEvent.

    PENDING  — Not yet reviewed. Shown on the timeline but not included in export.
    ACCEPTED — Confirmed by the user. Included in the exported redacted video.
    REJECTED — Dismissed as a false positive. Excluded from export.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class RedactionEvent(BaseModel):
    """
    The central data model for a single redaction region.

    Represents both automatically-detected PII regions (``source='auto'``) and
    manually-drawn regions (``source='manual'``). Using a unified model ensures
    that the tracker, renderer, and export pipeline handle both identically.

    Fields
    ------
    event_id       : UUID assigned at creation; stable across save/load cycles.
    source         : Whether detected automatically or drawn by the user.
    pii_type       : The type of sensitive data detected (see ``PiiType``).
    confidence     : Detection confidence 0.0–1.0. Always 1.0 for manual regions.
    extracted_text : The actual text that was detected. ``None`` in secure mode.
    time_ranges    : When this redaction is active in the video.
    keyframes      : Bounding box positions at specific timestamps. The renderer
                     interpolates between adjacent keyframes.
    tracking_method: Algorithm used to fill in keyframes between OCR samples.
    redaction_style: Visual appearance of the redaction in the exported video.
    status         : User's accept/reject/pending decision.
    """

    event_id: str = Field(default_factory=lambda: str(uuid4()))
    source: Literal["auto", "manual"] = "auto"
    pii_type: PiiType = PiiType.UNKNOWN
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    extracted_text: str | None = None
    time_ranges: list[TimeRange] = Field(default_factory=list)
    keyframes: list[Keyframe] = Field(default_factory=list)
    tracking_method: TrackingMethod = TrackingMethod.CSRT
    redaction_style: RedactionStyle = Field(default_factory=RedactionStyle)
    status: EventStatus = EventStatus.PENDING

    class Config:
        use_enum_values = True
