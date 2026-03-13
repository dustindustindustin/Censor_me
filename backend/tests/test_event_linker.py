"""Tests for backend/services/event_linker.py."""

import pytest

from backend.models.events import PiiType
from backend.services.event_linker import link_candidates
from backend.tests.conftest import make_candidate

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
        c2 = make_candidate(time_ms=100, bbox=(102, 101, 80, 20))  # 2px drift, well within tolerance  # noqa: E501
        events = link_candidates([c1, c2])
        assert len(events) == 1
        assert len(events[0].keyframes) == 2

    def test_two_candidates_different_positions_create_separate_events(self):
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=100, bbox=(600, 100, 80, 20))  # 500px apart — far beyond tolerance  # noqa: E501
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
# Spatial tolerance in _find_matching_event
# ---------------------------------------------------------------------------

class TestSpatialTolerance:
    def test_slowly_scrolling_text_merges_across_samples(self):
        """Text moving 20px per sample (well within 80px tolerance) links into one event."""
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=100, bbox=(100, 120, 80, 20))
        c3 = make_candidate(time_ms=200, bbox=(100, 140, 80, 20))
        events = link_candidates([c1, c2, c3])
        assert len(events) == 1, "Slowly scrolling text should merge into one event"

    def test_large_position_jump_creates_separate_event(self):
        """A position jump beyond the 80px spatial tolerance creates a new event."""
        c1 = make_candidate(time_ms=0, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=100, bbox=(100, 120, 80, 20))
        c3 = make_candidate(time_ms=200, bbox=(100, 620, 80, 20))  # 500px from last center
        events = link_candidates([c1, c2, c3])
        assert len(events) == 2, "Position jump beyond spatial tolerance should split"


# ---------------------------------------------------------------------------
# Scene-aware linking
# ---------------------------------------------------------------------------

class TestSceneAwareLinking:
    def test_scene_cut_prevents_merge(self):
        """Candidates on opposite sides of a scene cut must NOT merge."""
        c1 = make_candidate(time_ms=1000, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=2000, bbox=(100, 100, 80, 20))
        events = link_candidates([c1, c2], scene_change_times_ms=[1500])
        assert len(events) == 2, "Scene cut should force split even within time gap"

    def test_no_scene_cut_still_merges(self):
        """Without a cut, candidates within gap+distance still merge."""
        c1 = make_candidate(time_ms=1000, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=2000, bbox=(100, 100, 80, 20))
        events = link_candidates([c1, c2], scene_change_times_ms=[])
        assert len(events) == 1

    def test_scene_cut_before_window_does_not_split(self):
        """A cut that predates both candidates should not affect their merge."""
        c1 = make_candidate(time_ms=2000, bbox=(100, 100, 80, 20))
        c2 = make_candidate(time_ms=3000, bbox=(100, 100, 80, 20))
        events = link_candidates([c1, c2], scene_change_times_ms=[500])
        assert len(events) == 1
