"""Shared fixtures for Censor Me backend tests."""

import pytest

from backend.models.events import BoundingBox, EventStatus, Keyframe, PiiType, RedactionEvent, RedactionStyle, TimeRange
from backend.services.pii_classifier import PiiCandidate


def make_bbox(x: int = 100, y: int = 100, w: int = 80, h: int = 20) -> tuple[int, int, int, int]:
    return (x, y, w, h)


def make_candidate(
    pii_type: PiiType = PiiType.PHONE,
    bbox: tuple[int, int, int, int] | None = None,
    time_ms: int = 0,
    frame: int = 0,
    confidence: float = 0.9,
    text: str = "555-1234",
) -> PiiCandidate:
    return PiiCandidate(
        text=text,
        pii_type=pii_type,
        confidence=confidence,
        bbox=bbox or make_bbox(),
        source_frame=frame,
        source_time_ms=time_ms,
    )


def make_event(
    pii_type: PiiType = PiiType.PHONE,
    keyframes: list[Keyframe] | None = None,
    time_ranges: list[TimeRange] | None = None,
    confidence: float = 0.9,
) -> RedactionEvent:
    if keyframes is None:
        keyframes = [Keyframe(time_ms=0, bbox=BoundingBox(x=100, y=100, w=80, h=20))]
    if time_ranges is None:
        start = keyframes[0].time_ms if keyframes else 0
        end = keyframes[-1].time_ms if keyframes else 0
        time_ranges = [TimeRange(start_ms=start, end_ms=end)]
    return RedactionEvent(
        source="auto",
        pii_type=pii_type,
        confidence=confidence,
        time_ranges=time_ranges,
        keyframes=keyframes,
        status=EventStatus.PENDING,
    )
