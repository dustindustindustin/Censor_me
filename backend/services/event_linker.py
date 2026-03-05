"""
EventLinker — groups per-frame PII candidates into time-linked RedactionEvents.

Linking criteria:
- Same text string (case-insensitive) reappearing across frames
- Similar bounding box location (within a spatial tolerance)

Output: list of RedactionEvent with time ranges and keyframes populated.
"""

from backend.models.events import BoundingBox, EventStatus, Keyframe, PiiType, RedactionEvent, TimeRange
from backend.services.pii_classifier import PiiCandidate


# Two detections are considered "the same region" if their bbox centers are within this many pixels
_SPATIAL_TOLERANCE_PX = 50

# Gap between frames (ms) smaller than this threshold is bridged (same event continues)
_TIME_GAP_THRESHOLD_MS = 2000  # 2 seconds


def _bbox_center(bbox: tuple[int, int, int, int]) -> tuple[float, float]:
    x, y, w, h = bbox
    return (x + w / 2, y + h / 2)


def _center_distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def link_candidates(candidates: list[PiiCandidate]) -> list[RedactionEvent]:
    """
    Group PII candidates from all frames into time-linked RedactionEvents.
    Returns a list of events sorted by start time.
    """
    # Sort candidates by time
    sorted_candidates = sorted(candidates, key=lambda c: c.source_time_ms)

    # Build events greedily
    events: list[RedactionEvent] = []

    for candidate in sorted_candidates:
        matched_event = _find_matching_event(candidate, events)

        if matched_event:
            _extend_event(matched_event, candidate)
        else:
            events.append(_create_event(candidate))

    return sorted(events, key=lambda e: e.time_ranges[0].start_ms if e.time_ranges else 0)


def _find_matching_event(
    candidate: PiiCandidate,
    events: list[RedactionEvent],
) -> RedactionEvent | None:
    """
    Find an existing event that this candidate should be merged into.
    Matches on: same text (case-insensitive) + spatial proximity + time proximity.
    """
    candidate_center = _bbox_center(candidate.bbox)
    candidate_text = candidate.text.lower().strip()

    for event in events:
        if not event.keyframes:
            continue

        # Check time proximity: is the last keyframe within the gap threshold?
        last_kf_time = event.keyframes[-1].time_ms
        if candidate.source_time_ms - last_kf_time > _TIME_GAP_THRESHOLD_MS:
            continue

        # Check text match
        event_text = (event.extracted_text or "").lower().strip()
        if event_text != candidate_text:
            continue

        # Check spatial proximity to last keyframe
        last_bbox = event.keyframes[-1].bbox
        last_center = _bbox_center((last_bbox.x, last_bbox.y, last_bbox.w, last_bbox.h))
        if _center_distance(candidate_center, last_center) <= _SPATIAL_TOLERANCE_PX:
            return event

    return None


def _create_event(candidate: PiiCandidate) -> RedactionEvent:
    """Create a new RedactionEvent from a PII candidate."""
    x, y, w, h = candidate.bbox
    return RedactionEvent(
        source="auto",
        pii_type=candidate.pii_type,
        confidence=candidate.confidence,
        extracted_text=candidate.text,
        time_ranges=[TimeRange(start_ms=candidate.source_time_ms, end_ms=candidate.source_time_ms)],
        keyframes=[Keyframe(time_ms=candidate.source_time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h))],
        status=EventStatus.PENDING,
    )


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
