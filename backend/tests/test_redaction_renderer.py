"""Tests for pure helper functions in backend/services/redaction_renderer.py."""

import pytest

from backend.models.events import BoundingBox, EventStatus, Keyframe, PiiType, RedactionEvent, TimeRange
from backend.services.redaction_renderer import RedactionRenderer


# ---------------------------------------------------------------------------
# _lerp_bbox
# ---------------------------------------------------------------------------

class TestLerpBbox:
    def test_t_zero_returns_first_bbox(self):
        a = (10, 20, 100, 50)
        b = (50, 80, 200, 100)
        result = RedactionRenderer._lerp_bbox(a, b, 0.0)
        assert result == (10, 20, 100, 50)

    def test_t_one_returns_second_bbox(self):
        a = (10, 20, 100, 50)
        b = (50, 80, 200, 100)
        result = RedactionRenderer._lerp_bbox(a, b, 1.0)
        assert result == (50, 80, 200, 100)

    def test_t_half_returns_midpoint(self):
        a = (0, 0, 100, 100)
        b = (100, 100, 200, 200)
        result = RedactionRenderer._lerp_bbox(a, b, 0.5)
        assert result == (50, 50, 150, 150)

    def test_identical_bboxes_returns_same(self):
        a = (10, 20, 100, 50)
        result = RedactionRenderer._lerp_bbox(a, a, 0.5)
        assert result == a


# ---------------------------------------------------------------------------
# _pad_bbox
# ---------------------------------------------------------------------------

class TestPadBbox:
    def setup_method(self):
        self.renderer = RedactionRenderer()

    def test_padding_stays_within_frame(self):
        # 15% padding on a 100x100 bbox near the edge should be clamped
        x, y, w, h = self.renderer._pad_bbox((0, 0, 50, 50), frame_w=100, frame_h=100)
        assert x >= 0
        assert y >= 0
        assert x + w <= 100
        assert y + h <= 100

    def test_central_bbox_is_expanded(self):
        orig = (100, 100, 100, 50)
        x, y, w, h = self.renderer._pad_bbox(orig, frame_w=1920, frame_h=1080)
        # Should be larger than the original
        assert w > 100
        assert h > 50

    def test_zero_size_bbox_does_not_go_negative(self):
        x, y, w, h = self.renderer._pad_bbox((0, 0, 0, 0), frame_w=1920, frame_h=1080)
        assert x >= 0
        assert y >= 0
        assert w >= 0
        assert h >= 0


# ---------------------------------------------------------------------------
# _merge_overlapping
# ---------------------------------------------------------------------------

class TestMergeOverlapping:
    def _make_entry(self, x, y, w, h, confidence=0.9):
        event = RedactionEvent(
            source="auto",
            pii_type=PiiType.PHONE,
            confidence=confidence,
            time_ranges=[TimeRange(start_ms=0, end_ms=1000)],
            keyframes=[Keyframe(time_ms=0, bbox=BoundingBox(x=x, y=y, w=w, h=h))],
            status=EventStatus.PENDING,
        )
        return (event, (x, y, w, h), None)

    def test_single_entry_returned_unchanged(self):
        entries = [self._make_entry(10, 10, 80, 20)]
        result = RedactionRenderer._merge_overlapping(entries)
        assert len(result) == 1

    def test_overlapping_bboxes_merge_into_union(self):
        e1 = self._make_entry(10, 10, 100, 50)
        e2 = self._make_entry(50, 10, 100, 50)  # overlaps e1 horizontally
        result = RedactionRenderer._merge_overlapping([e1, e2])
        assert len(result) == 1
        _, bbox, _ = result[0]
        # Union should cover both: x=10 to x=150, y=10 to y=60
        assert bbox[0] == 10       # x
        assert bbox[1] == 10       # y
        assert bbox[0] + bbox[2] == 150  # right edge

    def test_non_overlapping_bboxes_stay_separate(self):
        e1 = self._make_entry(10, 10, 50, 20)
        e2 = self._make_entry(200, 10, 50, 20)  # far apart
        result = RedactionRenderer._merge_overlapping([e1, e2])
        assert len(result) == 2

    def test_proximity_threshold_merges_close_bboxes(self):
        # Boxes 5px apart — within the 10px merge proximity threshold
        e1 = self._make_entry(10, 10, 50, 20)
        e2 = self._make_entry(65, 10, 50, 20)  # gap = 65 - (10+50) = 5px < 10px
        result = RedactionRenderer._merge_overlapping([e1, e2])
        assert len(result) == 1

    def test_polygon_entries_are_never_merged(self):
        event = RedactionEvent(
            source="auto",
            pii_type=PiiType.PHONE,
            confidence=0.9,
            time_ranges=[TimeRange(start_ms=0, end_ms=1000)],
            keyframes=[Keyframe(time_ms=0, bbox=BoundingBox(x=10, y=10, w=80, h=20))],
            status=EventStatus.PENDING,
        )
        poly = [[10, 10], [90, 10], [90, 30], [10, 30]]
        e1 = (event, (10, 10, 80, 20), poly)
        e2 = (event, (10, 10, 80, 20), poly)
        result = RedactionRenderer._merge_overlapping([e1, e2])
        # Polygon entries should be passed through untouched
        assert len(result) == 2
