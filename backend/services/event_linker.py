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


# Two detections are considered "the same region" if their bbox centers are within this many pixels.
# Applied against the velocity-extrapolated expected position, not the raw last keyframe position.
_SPATIAL_TOLERANCE_PX = 80

# Gap between frames (ms) smaller than this threshold is bridged (same event continues)
_TIME_GAP_THRESHOLD_MS = 4000  # 4 seconds — increased from 2s to reduce split events

# IoU threshold for merging nearby events of the same PII type
_MERGE_IOU_THRESHOLD = 0.3

# In _merge_nearby_events, a secondary merge path allows same-type adjacent events with IoU=0
# to merge if the positional change is consistent with a scroll speed at or below this limit.
# 2000 px/s ≈ a very fast scroll on a 1080p screen; faster than this is likely separate content.
_MAX_MERGE_VELOCITY_PX_S = 2000


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

        # Check spatial proximity, extrapolating the event's expected position using velocity.
        # For scrolling content, text moves predictably between OCR samples. Checking against
        # the raw last-keyframe position fails when text has scrolled >50px since the last sample.
        last_bbox = event.keyframes[-1].bbox
        last_center = _bbox_center((last_bbox.x, last_bbox.y, last_bbox.w, last_bbox.h))

        extrapolated_center = last_center
        if len(event.keyframes) >= 2:
            kf_prev = event.keyframes[-2]
            kf_last = event.keyframes[-1]
            dt = kf_last.time_ms - kf_prev.time_ms
            if dt > 0:
                elapsed = candidate.source_time_ms - kf_last.time_ms
                vx = (kf_last.bbox.x - kf_prev.bbox.x) / dt
                vy = (kf_last.bbox.y - kf_prev.bbox.y) / dt
                extrapolated_center = (
                    last_center[0] + vx * elapsed,
                    last_center[1] + vy * elapsed,
                )

        if _center_distance(candidate_center, extrapolated_center) <= _SPATIAL_TOLERANCE_PX:
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

    Algorithm: O(N log N) single greedy pass after sorting by (pii_type, start_ms).
    Two events can only merge if they are the same type and temporally adjacent,
    so sorting eliminates all cross-type and temporally-distant comparisons.
    """
    if len(events) < 2:
        return events

    def _event_start(e: RedactionEvent) -> int:
        return min((tr.start_ms for tr in e.time_ranges), default=0)

    def _event_end(e: RedactionEvent) -> int:
        return max((tr.end_ms for tr in e.time_ranges), default=0)

    # Sort by pii_type then start time so mergeable candidates are adjacent
    events.sort(key=lambda e: (str(e.pii_type), _event_start(e)))

    result: list[RedactionEvent] = []

    for ev in events:
        if not result:
            result.append(ev)
            continue

        prev = result[-1]

        # Different PII type → never merge
        if prev.pii_type != ev.pii_type:
            result.append(ev)
            continue

        # Time gap check — only the immediately preceding event needs to be checked
        # because the list is sorted by start time
        gap = _event_start(ev) - _event_end(prev)
        if gap > _TIME_GAP_THRESHOLD_MS:
            result.append(ev)
            continue

        # Spatial overlap check using boundary keyframes
        if not prev.keyframes or not ev.keyframes:
            result.append(ev)
            continue

        best_iou = 0.0
        for kf_a in [prev.keyframes[0], prev.keyframes[-1]]:
            for kf_b in [ev.keyframes[0], ev.keyframes[-1]]:
                iou = _bbox_iou(
                    (kf_a.bbox.x, kf_a.bbox.y, kf_a.bbox.w, kf_a.bbox.h),
                    (kf_b.bbox.x, kf_b.bbox.y, kf_b.bbox.w, kf_b.bbox.h),
                )
                best_iou = max(best_iou, iou)

        if best_iou < _MERGE_IOU_THRESHOLD:
            # Secondary check: IoU is zero for scrolled text (different vertical position),
            # but it's still the same content. Allow merge if the positional change between
            # prev's last keyframe and ev's first keyframe is consistent with plausible scroll
            # velocity. Faster than _MAX_MERGE_VELOCITY_PX_S → treat as separate content.
            gap_ms = max(gap, 1)
            last_kf = prev.keyframes[-1]
            first_kf = ev.keyframes[0]
            dx = first_kf.bbox.x - last_kf.bbox.x
            dy = first_kf.bbox.y - last_kf.bbox.y
            dist = (dx ** 2 + dy ** 2) ** 0.5
            velocity_px_per_s = (dist / gap_ms) * 1000
            if velocity_px_per_s > _MAX_MERGE_VELOCITY_PX_S:
                result.append(ev)
                continue
            # Velocity is within scroll range — fall through to merge

        # Merge ev into prev
        prev.keyframes.extend(ev.keyframes)
        prev.keyframes.sort(key=lambda kf: kf.time_ms)

        all_starts = [tr.start_ms for tr in prev.time_ranges] + [tr.start_ms for tr in ev.time_ranges]
        all_ends = [tr.end_ms for tr in prev.time_ranges] + [tr.end_ms for tr in ev.time_ranges]
        prev.time_ranges = [TimeRange(start_ms=min(all_starts), end_ms=max(all_ends))]
        prev.confidence = max(prev.confidence, ev.confidence)

    return result
