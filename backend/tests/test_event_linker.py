"""Tests for backend/services/event_linker.py."""

import pytest

from backend.models.events import BoundingBox, Keyframe, PiiType, TimeRange
from backend.services.event_linker import _merge_nearby_events, link_candidates
from backend.tests.conftest import make_candidate, make_event


# ---------------------------------------------------------------------------
# link_candidates — initial greedy linking
# ---------------------------------------------------------------------------

class TestLinkCandidates:
    def test_single_candidate_creates_one_event(self):
        c = make_candidate(time_ms=0)
        events = link_candidates([c])
        assert len(events) == 1
        assert events[0].pii_type == PiiType.PHONE

    def test_two_candidates_at_same_position_merge(self):
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=100, bbox=(102, 101, 80, 20))  # 2px drift, well within tolerance
        events = link_candidates([c1, c2])
        assert len(events) == 1
        assert len(events[0].keyframes) == 2

    def test_two_candidates_different_positions_create_separate_events(self):
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=100, bbox=(600, 100, 80, 20))  # 500px apart — far beyond tolerance
        events = link_candidates([c1, c2])
        assert len(events) == 2

    def test_different_pii_types_at_same_position_are_separate_events(self):
        c1 = make_candidate(pii_type=PiiType.PHONE, time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(pii_type=PiiType.EMAIL, time_ms=100, bbox=(100, 100, 80, 20))
        events = link_candidates([c1, c2])
        assert len(events) == 2

    def test_time_gap_beyond_threshold_creates_separate_event(self):
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=5000, bbox=(100, 100, 80, 20))  # 5-second gap > 4s threshold
        events = link_candidates([c1, c2])
        assert len(events) == 2

    def test_time_gap_within_threshold_merges(self):
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=3000, bbox=(100, 100, 80, 20))  # 3 seconds, within 4s threshold
        events = link_candidates([c1, c2])
        assert len(events) == 1

    def test_events_sorted_by_start_time(self):
        c1 = make_candidate(time_ms=500, bbox=(100, 100, 80, 20))
        c2 = make_candidate(pii_type=PiiType.EMAIL, time_ms=0, bbox=(300, 300, 80, 20))
        events = link_candidates([c1, c2])
        start_times = [e.time_ranges[0].start_ms for e in events]
        assert start_times == sorted(start_times)

    def test_confidence_updated_to_maximum(self):
        c1 = make_candidate(time_ms=0, confidence=0.6, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=100, confidence=0.9, bbox=(100, 100, 80, 20))
        events = link_candidates([c1, c2])
        assert len(events) == 1
        assert events[0].confidence == pytest.approx(0.9)


# ---------------------------------------------------------------------------
# Velocity extrapolation in _find_matching_event
# ---------------------------------------------------------------------------

class TestVelocityExtrapolation:
    def test_scrolling_text_merges_when_within_extrapolated_position(self):
        """Text moving at 200 px/s downward should link across 3 samples."""
        # 3 candidates simulating text scrolling at ~200 px/s
        # Sample interval = 100ms, so text moves ~20px per sample
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=100, bbox=(100, 120, 80, 20))   # moved 20px down
        c3 = make_candidate(time_ms=200, bbox=(100, 140, 80, 20))   # moved another 20px
        events = link_candidates([c1, c2, c3])
        assert len(events) == 1, "Scrolling text at consistent velocity should merge into one event"

    def test_implausibly_fast_jump_creates_separate_event(self):
        """A position jump inconsistent with velocity should create a new event."""
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=100, bbox=(100, 120, 80, 20))   # 20px/100ms = 200px/s
        # Next candidate at 100ms later but 500px away — far from extrapolated 140
        c3 = make_candidate(time_ms=200, bbox=(100, 620, 80, 20))
        events = link_candidates([c1, c2, c3])
        assert len(events) == 2, "Large position jump beyond extrapolated position should split"


# ---------------------------------------------------------------------------
# _merge_nearby_events — post-linking merge pass
# ---------------------------------------------------------------------------

class TestMergeNearbyEvents:
    def test_overlapping_events_merge(self):
        """Events with IoU > 0.3 and within time gap should merge."""
        e1 = make_event(
            keyframes=[Keyframe(time_ms=0, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=0, end_ms=100)],
        )
        e2 = make_event(
            keyframes=[Keyframe(time_ms=200, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=200, end_ms=300)],
        )
        result = _merge_nearby_events([e1, e2])
        assert len(result) == 1

    def test_non_overlapping_different_types_do_not_merge(self):
        """Events of different PII types are never merged."""
        e1 = make_event(
            pii_type=PiiType.PHONE,
            keyframes=[Keyframe(time_ms=0, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=0, end_ms=100)],
        )
        e2 = make_event(
            pii_type=PiiType.EMAIL,
            keyframes=[Keyframe(time_ms=200, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=200, end_ms=300)],
        )
        result = _merge_nearby_events([e1, e2])
        assert len(result) == 2

    def test_scrolled_text_merges_when_velocity_plausible(self):
        """Two same-type events with IoU=0 but slow positional change should merge."""
        # e1 ends at y=100, e2 starts at y=200 — 100px change in 500ms = 200 px/s (scroll)
        e1 = make_event(
            keyframes=[Keyframe(time_ms=0, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=0, end_ms=100)],
        )
        e2 = make_event(
            keyframes=[Keyframe(time_ms=600, bbox=BoundingBox(x=100, y=200, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=600, end_ms=700)],
        )
        result = _merge_nearby_events([e1, e2])
        assert len(result) == 1, "Scrolled text within plausible velocity range should merge"

    def test_too_fast_position_change_does_not_merge(self):
        """Two same-type events with velocity above the limit should NOT merge."""
        # e1 ends at y=100, e2 starts at y=800 — 700px in 100ms = 7000 px/s (too fast)
        e1 = make_event(
            keyframes=[Keyframe(time_ms=0, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=0, end_ms=100)],
        )
        e2 = make_event(
            keyframes=[Keyframe(time_ms=200, bbox=BoundingBox(x=100, y=800, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=200, end_ms=300)],
        )
        result = _merge_nearby_events([e1, e2])
        assert len(result) == 2, "Position change above velocity limit should not merge"

    def test_time_gap_beyond_threshold_does_not_merge(self):
        """Events separated by > 4 seconds are never merged, regardless of position."""
        e1 = make_event(
            keyframes=[Keyframe(time_ms=0, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=0, end_ms=100)],
        )
        e2 = make_event(
            keyframes=[Keyframe(time_ms=5000, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=5000, end_ms=5100)],
        )
        result = _merge_nearby_events([e1, e2])
        assert len(result) == 2

    def test_merge_combines_keyframes_and_time_ranges(self):
        """After merging, the result event spans both input time ranges."""
        e1 = make_event(
            keyframes=[Keyframe(time_ms=0, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=0, end_ms=100)],
        )
        e2 = make_event(
            keyframes=[Keyframe(time_ms=200, bbox=BoundingBox(x=100, y=100, w=80, h=20))],
            time_ranges=[TimeRange(start_ms=200, end_ms=300)],
        )
        result = _merge_nearby_events([e1, e2])
        merged = result[0]
        assert merged.time_ranges[0].start_ms == 0
        assert merged.time_ranges[0].end_ms == 300
        assert len(merged.keyframes) == 2
