"""
EventLinker — groups per-frame PII candidates into time-linked RedactionEvents.

Linking criteria:
- Same text string (case-insensitive) reappearing across frames
- Similar bounding box location (within a spatial tolerance)

Output: list of RedactionEvent with time ranges and keyframes populated.
"""

from typing import Callable

from backend.models.events import BoundingBox, EventStatus, Keyframe, PiiType, RedactionEvent, RedactionStyle, TimeRange
from backend.services.pii_classifier import PiiCandidate


# Two detections are considered "the same region" if their bbox centers are within this many pixels
_SPATIAL_TOLERANCE_PX = 50

# Gap between frames (ms) smaller than this threshold is bridged (same event continues)
_TIME_GAP_THRESHOLD_MS = 4000  # 4 seconds — increased from 2s to reduce split events

# IoU threshold for merging nearby events of the same PII type
_MERGE_IOU_THRESHOLD = 0.3


def _bbox_iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    """Compute Intersection over Union of two (x, y, w, h) bounding boxes."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    inter_x = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    inter_y = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = inter_x * inter_y
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0


def _bbox_center(bbox: tuple[int, int, int, int]) -> tuple[float, float]:
    x, y, w, h = bbox
    return (x + w / 2, y + h / 2)


def _center_distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def link_candidates(
    candidates: list[PiiCandidate],
    on_progress: Callable[[int, int], None] | None = None,
    default_style: RedactionStyle | None = None,
) -> list[RedactionEvent]:
    """
    Group PII candidates from all frames into time-linked RedactionEvents.
    Returns a list of events sorted by start time.
    """
    # Sort candidates by time
    sorted_candidates = sorted(candidates, key=lambda c: c.source_time_ms)
    total = len(sorted_candidates)

    # Build events greedily
    events: list[RedactionEvent] = []

    for i, candidate in enumerate(sorted_candidates):
        matched_event = _find_matching_event(candidate, events)

        if matched_event:
            _extend_event(matched_event, candidate)
        else:
            events.append(_create_event(candidate, default_style))

        if on_progress and (i + 1) % 50 == 0:
            on_progress(i + 1, total)

    if on_progress:
        on_progress(total, total)

    # Post-merge pass: combine events of the same PII type that overlap spatially
    # and are close in time but were linked separately (e.g., same text that briefly
    # disappeared and reappeared beyond the gap threshold during initial linking).
    events = _merge_nearby_events(events)

    return sorted(events, key=lambda e: e.time_ranges[0].start_ms if e.time_ranges else 0)


def _find_matching_event(
    candidate: PiiCandidate,
    events: list[RedactionEvent],
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

        # Check spatial proximity to last keyframe
        last_bbox = event.keyframes[-1].bbox
        last_center = _bbox_center((last_bbox.x, last_bbox.y, last_bbox.w, last_bbox.h))
        if _center_distance(candidate_center, last_center) <= _SPATIAL_TOLERANCE_PX:
            return event

    return None


def _create_event(candidate: PiiCandidate, default_style: RedactionStyle | None = None) -> RedactionEvent:
    """Create a new RedactionEvent from a PII candidate."""
    x, y, w, h = candidate.bbox
    kwargs: dict = dict(
        source="auto",
        pii_type=candidate.pii_type,
        confidence=candidate.confidence,
        extracted_text=candidate.text,
        time_ranges=[TimeRange(start_ms=candidate.source_time_ms, end_ms=candidate.source_time_ms)],
        keyframes=[Keyframe(time_ms=candidate.source_time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h))],
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


def _merge_nearby_events(events: list[RedactionEvent]) -> list[RedactionEvent]:
    """
    Post-linking merge: combine events of the same PII type that are close in
    time and overlap spatially (IoU > threshold). This catches cases where the
    same text briefly disappears and reappears, creating separate events that
    should logically be one continuous redaction.
    """
    if len(events) < 2:
        return events

    merged = True
    while merged:
        merged = False
        for i in range(len(events)):
            for j in range(i + 1, len(events)):
                ev_a, ev_b = events[i], events[j]

                if ev_a.pii_type != ev_b.pii_type:
                    continue

                # Check time proximity: gap between the two events
                a_end = max(tr.end_ms for tr in ev_a.time_ranges) if ev_a.time_ranges else 0
                b_start = min(tr.start_ms for tr in ev_b.time_ranges) if ev_b.time_ranges else 0
                b_end = max(tr.end_ms for tr in ev_b.time_ranges) if ev_b.time_ranges else 0
                a_start = min(tr.start_ms for tr in ev_a.time_ranges) if ev_a.time_ranges else 0

                gap = min(abs(b_start - a_end), abs(a_start - b_end))
                if gap > _TIME_GAP_THRESHOLD_MS:
                    continue

                # Check spatial overlap using nearest keyframes
                if not ev_a.keyframes or not ev_b.keyframes:
                    continue

                # Compare the closest keyframes in time
                best_iou = 0.0
                for kf_a in [ev_a.keyframes[0], ev_a.keyframes[-1]]:
                    for kf_b in [ev_b.keyframes[0], ev_b.keyframes[-1]]:
                        iou = _bbox_iou(
                            (kf_a.bbox.x, kf_a.bbox.y, kf_a.bbox.w, kf_a.bbox.h),
                            (kf_b.bbox.x, kf_b.bbox.y, kf_b.bbox.w, kf_b.bbox.h),
                        )
                        best_iou = max(best_iou, iou)

                if best_iou < _MERGE_IOU_THRESHOLD:
                    continue

                # Merge b into a: combine keyframes, extend time_ranges, take max confidence
                ev_a.keyframes.extend(ev_b.keyframes)
                ev_a.keyframes.sort(key=lambda kf: kf.time_ms)

                # Merge time ranges into a single span covering both
                all_starts = [tr.start_ms for tr in ev_a.time_ranges] + [tr.start_ms for tr in ev_b.time_ranges]
                all_ends = [tr.end_ms for tr in ev_a.time_ranges] + [tr.end_ms for tr in ev_b.time_ranges]
                ev_a.time_ranges = [TimeRange(start_ms=min(all_starts), end_ms=max(all_ends))]

                ev_a.confidence = max(ev_a.confidence, ev_b.confidence)

                events.pop(j)
                merged = True
                break
            if merged:
                break

    return events
