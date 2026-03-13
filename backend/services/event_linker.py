"""
EventLinker — groups per-frame PII candidates into time-linked RedactionEvents.

Linking criteria:
- Same text string (case-insensitive) reappearing across frames
- Similar bounding box location (within a spatial tolerance)

Output: list of RedactionEvent with time ranges and keyframes populated.
"""

import bisect
from typing import Callable

from backend.models.events import (
    BoundingBox,
    EventStatus,
    Keyframe,
    RedactionEvent,
    RedactionStyle,
    TimeRange,
)
from backend.services.pii_classifier import PiiCandidate

# Two detections are considered "the same region" if their bbox centers are within this many pixels.
_SPATIAL_TOLERANCE_PX = 80

# Gap between frames (ms) smaller than this threshold is bridged (same event continues)
_TIME_GAP_THRESHOLD_MS = 4000  # 4 seconds — increased from 2s to reduce split events


def _bbox_center(bbox: tuple[int, int, int, int]) -> tuple[float, float]:
    x, y, w, h = bbox
    return (x + w / 2, y + h / 2)


def _center_distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def _has_scene_cut_between(t_start: int, t_end: int, scene_cuts: list[int]) -> bool:
    """Return True if any scene cut timestamp falls strictly between t_start and t_end."""
    if not scene_cuts:
        return False
    idx = bisect.bisect_right(scene_cuts, t_start)
    return idx < len(scene_cuts) and scene_cuts[idx] < t_end


def link_candidates(
    candidates: list[PiiCandidate],
    on_progress: Callable[[int, int], None] | None = None,
    default_style: RedactionStyle | None = None,
    scene_change_times_ms: list[int] | None = None,
) -> list[RedactionEvent]:
    """
    Group PII candidates from all frames into time-linked RedactionEvents.
    Returns a list of events sorted by start time.
    """
    scene_cuts = sorted(scene_change_times_ms) if scene_change_times_ms else []

    # Sort candidates by time
    sorted_candidates = sorted(candidates, key=lambda c: c.source_time_ms)
    total = len(sorted_candidates)

    # Build events greedily
    events: list[RedactionEvent] = []

    for i, candidate in enumerate(sorted_candidates):
        matched_event = _find_matching_event(candidate, events, scene_cuts)

        if matched_event:
            _extend_event(matched_event, candidate)
        else:
            events.append(_create_event(candidate, default_style))

        if on_progress and (i + 1) % 50 == 0:
            on_progress(i + 1, total)

    if on_progress:
        on_progress(total, total)

    return sorted(events, key=lambda e: e.time_ranges[0].start_ms if e.time_ranges else 0)


def _find_matching_event(
    candidate: PiiCandidate,
    events: list[RedactionEvent],
    scene_cuts: list[int] = [],
) -> RedactionEvent | None:
    """
    Find an existing event that this candidate should be merged into.

    Matches on: same PII type + spatial proximity + time proximity.

    Text matching was intentionally removed. OCR is noisy and the same text
    region is frequently read differently across frames ("555-1234" vs
    "S55-1234" vs "555 1234"). Strict text equality caused the same visible
    element to produce dozens of separate single-keyframe events, each covering
    only one frame of redaction. Linking by position + type is sufficient and
    robust: two different items of the same PII type rarely appear within
    _SPATIAL_TOLERANCE_PX of each other.
    """
    candidate_center = _bbox_center(candidate.bbox)

    for event in events:
        if not event.keyframes:
            continue

        # Must be the same PII type (phone, email, etc.)
        if event.pii_type != candidate.pii_type:
            continue

        # Check time proximity: is the last keyframe within the gap threshold?
        last_kf_time = event.keyframes[-1].time_ms
        if candidate.source_time_ms - last_kf_time > _TIME_GAP_THRESHOLD_MS:
            continue

        # Reject merge if a scene cut falls between the last keyframe and this candidate.
        if _has_scene_cut_between(last_kf_time, candidate.source_time_ms, scene_cuts):
            continue

        # Check spatial proximity against the raw last keyframe center.
        last_bbox = event.keyframes[-1].bbox
        last_center = _bbox_center((last_bbox.x, last_bbox.y, last_bbox.w, last_bbox.h))

        if _center_distance(candidate_center, last_center) <= _SPATIAL_TOLERANCE_PX:
            return event

    return None


def _create_event(candidate: PiiCandidate, default_style: RedactionStyle | None = None) -> RedactionEvent:  # noqa: E501
    """Create a new RedactionEvent from a PII candidate."""
    x, y, w, h = candidate.bbox
    kwargs: dict = dict(
        source="auto",
        pii_type=candidate.pii_type,
        confidence=candidate.confidence,
        extracted_text=candidate.text,
        time_ranges=[TimeRange(start_ms=candidate.source_time_ms, end_ms=candidate.source_time_ms)],
        keyframes=[Keyframe(time_ms=candidate.source_time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h))],  # noqa: E501
        status=EventStatus.PENDING,
    )
    if default_style is not None:
        kwargs["redaction_style"] = default_style
    return RedactionEvent(**kwargs)


def _extend_event(event: RedactionEvent, candidate: PiiCandidate) -> None:
    """Extend an existing event's time range and add a new keyframe."""
    x, y, w, h = candidate.bbox

    # Extend the last time range's end
    if event.time_ranges:
        event.time_ranges[-1].end_ms = candidate.source_time_ms
    else:
        event.time_ranges.append(
            TimeRange(start_ms=candidate.source_time_ms, end_ms=candidate.source_time_ms)
        )

    # Add keyframe
    event.keyframes.append(
        Keyframe(time_ms=candidate.source_time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h))
    )

    # Update confidence to the running maximum
    event.confidence = max(event.confidence, candidate.confidence)


