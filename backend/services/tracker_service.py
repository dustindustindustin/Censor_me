"""
TrackerService — fills bounding box positions between OCR keyframes.

OCR only runs on sampled frames (e.g., every 5th frame). Between samples, the
detected text is still visible on screen and must be redacted. This service uses
OpenCV's CSRT (Channel and Spatial Reliability Tracker) to propagate bounding
boxes forward in time from each OCR keyframe to the next, producing a dense
set of keyframes for smooth redaction in the exported video.

Drift detection
---------------
If the appearance of the tracked region changes significantly between frames
(e.g., the user scrolled and a different element is now in the same position),
the tracker is considered to have "drifted". Tracking stops at that point
rather than continuing to cover the wrong region.

Drift is measured using Bhattacharyya distance between grayscale histograms
of the tracked region at initialization vs. the current frame.
``_DRIFT_THRESHOLD = 0.55`` (softened from 0.45) with ``_DRIFT_CONFIRM_FRAMES = 3``
consecutive-frame confirmation prevents premature tracking termination.
"""

from typing import Callable

import cv2
import numpy as np

from backend.models.events import BoundingBox, Keyframe, RedactionEvent
from backend.utils.scene_detect import compute_histogram, histogram_diff


# Bhattacharyya histogram distance above which a tracker is considered to have
# drifted off the original content. Range [0.0, 1.0]; 0.0 = identical histograms.
_DRIFT_THRESHOLD = 0.55

# Drift must be detected for this many consecutive frames before tracking stops.
# Prevents single-frame false-positive drift triggers.
_DRIFT_CONFIRM_FRAMES = 3

# Maximum frames to hold the last known bbox position on tracking failure.
# Prevents single-frame unredacted gaps when CSRT briefly loses the target.
_MAX_HOLD_FRAMES = 5

# Blend the reference histogram every N frames to prevent staleness as content
# appearance gradually changes (e.g., scrolling, lighting shifts).
_REF_HIST_BLEND_INTERVAL = 15
_REF_HIST_BLEND_ALPHA = 0.2


def _create_csrt_tracker() -> cv2.Tracker:
    """
    Create a CSRT tracker, handling API differences across OpenCV versions.

    The tracker API has moved between releases of opencv-contrib-python:
      - ≤ 4.4:  cv2.TrackerCSRT_create()         (module-level factory)
      - 4.5–4.7: cv2.legacy.TrackerCSRT_create()  (moved to legacy)
      - 4.8+:   cv2.legacy.TrackerCSRT.create()   (class method on the class)
      - some:   cv2.TrackerCSRT.create()           (non-legacy class method)

    Raises RuntimeError if none of the known APIs are present, which typically
    means opencv-contrib-python is not installed (only opencv-python is).
    """
    for factory in (
        lambda: cv2.legacy.TrackerCSRT_create(),  # 4.5–4.7 contrib
        lambda: cv2.legacy.TrackerCSRT.create(),  # 4.8+ contrib
        lambda: cv2.TrackerCSRT_create(),          # ≤ 4.4
        lambda: cv2.TrackerCSRT.create(),          # some non-legacy builds
    ):
        try:
            return factory()
        except AttributeError:
            continue
    raise RuntimeError(
        "CSRT tracker not available. "
        "Install opencv-contrib-python: uv pip install opencv-contrib-python"
    )


class TrackerService:
    """
    Wraps OpenCV CSRT tracking to interpolate bboxes between OCR keyframes.

    For each ``RedactionEvent``, processes the gap between every pair of
    consecutive OCR keyframes by initializing a CSRT tracker at the first
    keyframe and running it forward until it reaches the second keyframe,
    a scene change, or drift is detected.
    """

    def track_event(
        self,
        event: RedactionEvent,
        video_path: str,
        fps: float,
    ) -> RedactionEvent:
        """
        Fill in dense keyframes for a RedactionEvent using CSRT tracking.

        For each consecutive pair of OCR keyframes in ``event.keyframes``,
        opens the source video, seeks to the first keyframe's position,
        initializes a CSRT tracker, and runs it forward frame-by-frame until
        the second keyframe is reached or tracking fails.

        Modifies ``event.keyframes`` in place (replaces sparse OCR keyframes
        with a dense sequence including interpolated positions).

        Args:
            event:      The RedactionEvent to track. Must have at least 2 keyframes.
            video_path: Absolute path to the source video file.
            fps:        Frames per second of the source video.

        Returns:
            The same ``event`` with a densified ``keyframes`` list.
        """
        if len(event.keyframes) < 2:
            # Nothing to interpolate with a single keyframe
            return event

        cap = cv2.VideoCapture(video_path)
        filled_keyframes: list[Keyframe] = []

        for i in range(len(event.keyframes) - 1):
            kf_start = event.keyframes[i]
            kf_end = event.keyframes[i + 1]
            filled = self._track_segment(cap, fps, kf_start, kf_end)
            filled_keyframes.extend(filled)

        cap.release()

        # Replace the original sparse keyframes with the dense tracked sequence
        event.keyframes = filled_keyframes
        return event

    def track_forward(
        self,
        event: RedactionEvent,
        video_path: str,
        fps: float,
    ) -> RedactionEvent:
        """
        Track a single-keyframe event forward to the end of the video.

        Used for manually-drawn boxes: the user draws a box at one point in
        time and this method propagates it forward using CSRT until drift is
        detected or the video ends. Features hold-last, drift confirmation,
        rolling reference blend, and scene-change awareness.
        """
        if not event.keyframes:
            return event

        kf_start = event.keyframes[0]
        start_frame = int((kf_start.time_ms / 1000) * fps)

        cap = cv2.VideoCapture(video_path)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        ret, frame = cap.read()
        if not ret:
            cap.release()
            return event

        bbox_tuple = (kf_start.bbox.x, kf_start.bbox.y, kf_start.bbox.w, kf_start.bbox.h)
        tracker = _create_csrt_tracker()
        tracker.init(frame, bbox_tuple)

        roi = frame[
            kf_start.bbox.y: kf_start.bbox.y + kf_start.bbox.h,
            kf_start.bbox.x: kf_start.bbox.x + kf_start.bbox.w,
        ]
        ref_hist = self._compute_hist(roi)
        prev_scene_hist = compute_histogram(frame)

        filled: list[Keyframe] = [kf_start]
        current_frame = start_frame + 1
        hold_count = 0
        drift_count = 0
        last_good_bbox = bbox_tuple

        while current_frame < total_frames:
            ret, frame = cap.read()
            if not ret:
                break

            # Scene change detection
            curr_scene_hist = compute_histogram(frame)
            if histogram_diff(prev_scene_hist, curr_scene_hist) > 0.35:
                break
            prev_scene_hist = curr_scene_hist

            success, tracked_bbox = tracker.update(frame)
            time_ms = int((current_frame / fps) * 1000)

            if success:
                x, y, w, h = [int(v) for v in tracked_bbox]
                x, y = max(0, x), max(0, y)

                roi = frame[y: y + h, x: x + w]
                if roi.size > 0:
                    curr_hist = self._compute_hist(roi)
                    drift = cv2.compareHist(ref_hist, curr_hist, cv2.HISTCMP_BHATTACHARYYA)
                    if drift > _DRIFT_THRESHOLD:
                        drift_count += 1
                        if drift_count >= _DRIFT_CONFIRM_FRAMES:
                            break
                    else:
                        drift_count = 0

                    # Rolling reference histogram blend
                    frames_since_start = current_frame - start_frame
                    if frames_since_start % _REF_HIST_BLEND_INTERVAL == 0:
                        ref_hist = (1 - _REF_HIST_BLEND_ALPHA) * ref_hist + _REF_HIST_BLEND_ALPHA * curr_hist

                hold_count = 0
                last_good_bbox = (x, y, w, h)
                filled.append(Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h)))
            else:
                hold_count += 1
                if hold_count > _MAX_HOLD_FRAMES:
                    break
                x, y, w, h = last_good_bbox
                filled.append(Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h)))

            current_frame += 1

        cap.release()

        event.keyframes = filled
        if filled:
            if event.time_ranges:
                event.time_ranges[0].end_ms = filled[-1].time_ms
            else:
                from backend.models.events import TimeRange
                event.time_ranges = [TimeRange(start_ms=kf_start.time_ms, end_ms=filled[-1].time_ms)]

        return event

    def track_all_events(
        self,
        events: list[RedactionEvent],
        video_path: str,
        fps: float,
        on_progress: Callable[[int, int, int, int], None] | None = None,
    ) -> list[RedactionEvent]:
        """
        Track all events in a single sequential video pass.

        Opens ``cv2.VideoCapture`` exactly once and processes every tracking job
        by reading frames sequentially from the first job's start frame to the
        last job's end frame. Active CSRT trackers are maintained in a dict and
        updated each frame. This is O(1) video opens vs. the O(N_events) opens
        that result from calling ``track_event()`` per event.

        Events with fewer than 2 keyframes are returned unchanged (same behaviour
        as ``track_event()``).

        Args:
            events:     All RedactionEvents to track.
            video_path: Absolute path to the source video file.
            fps:        Frames per second of the source video.

        Returns:
            The same ``events`` list with densified keyframes for trackable events.
        """

        class _Job:
            __slots__ = ("job_id", "event_idx", "start_frame", "end_frame",
                         "start_bbox", "start_kf", "result_keyframes")

            def __init__(self, job_id, event_idx, start_frame, end_frame, start_bbox, start_kf):
                self.job_id = job_id
                self.event_idx = event_idx
                self.start_frame = start_frame
                self.end_frame = end_frame
                self.start_bbox = start_bbox
                self.start_kf = start_kf
                self.result_keyframes: list[Keyframe] = [start_kf]

        # Build one job per consecutive keyframe pair per event.
        jobs: list[_Job] = []
        trackable: set[int] = set()

        for evt_idx, event in enumerate(events):
            if len(event.keyframes) < 2:
                continue
            trackable.add(evt_idx)
            for pair_idx in range(len(event.keyframes) - 1):
                kf_s = event.keyframes[pair_idx]
                kf_e = event.keyframes[pair_idx + 1]
                jobs.append(_Job(
                    job_id=f"{evt_idx}_{pair_idx}",
                    event_idx=evt_idx,
                    start_frame=int((kf_s.time_ms / 1000) * fps),
                    end_frame=int((kf_e.time_ms / 1000) * fps),
                    start_bbox=(kf_s.bbox.x, kf_s.bbox.y, kf_s.bbox.w, kf_s.bbox.h),
                    start_kf=kf_s,
                ))

        if not jobs:
            return events

        jobs.sort(key=lambda j: j.start_frame)

        cap = cv2.VideoCapture(video_path)
        cap.set(cv2.CAP_PROP_POS_FRAMES, jobs[0].start_frame)

        pending = list(jobs)
        # active: job_id -> (tracker, ref_hist, _Job, fail_count, drift_count, last_bbox)
        active: dict[str, tuple] = {}
        frame_idx = jobs[0].start_frame
        last_frame = max(j.end_frame for j in jobs)
        total_track_frames = last_frame - jobs[0].start_frame
        prev_scene_hist = None

        while cap.isOpened() and (pending or active):
            ret, frame = cap.read()
            if not ret:
                break

            # Scene change detection (once per frame, shared across all trackers)
            curr_scene_hist = compute_histogram(frame)
            scene_changed = (prev_scene_hist is not None and
                             histogram_diff(prev_scene_hist, curr_scene_hist) > 0.35)
            prev_scene_hist = curr_scene_hist

            # Activate any jobs whose start_frame matches the current frame.
            while pending and pending[0].start_frame == frame_idx:
                job = pending.pop(0)
                x, y, w, h = job.start_bbox
                tracker = _create_csrt_tracker()
                tracker.init(frame, (x, y, w, h))
                ref_hist = self._compute_hist(frame[y:y + h, x:x + w])
                active[job.job_id] = (tracker, ref_hist, job, 0, 0, job.start_bbox)

            # On scene change, stop all active trackers cleanly
            if scene_changed:
                for job_id in list(active.keys()):
                    active.pop(job_id)
                frame_idx += 1
                del frame
                continue

            # Update all active trackers and collect those that are done.
            done_ids: list[str] = []
            for job_id, (tracker, ref_hist, job, fail_count, drift_cnt, last_bbox) in list(active.items()):
                ok, tracked_bbox = tracker.update(frame)
                if not ok:
                    fail_count += 1
                    if fail_count > _MAX_HOLD_FRAMES:
                        done_ids.append(job_id)
                        continue
                    # Hold last known position
                    x, y, w, h = last_bbox
                    time_ms = int((frame_idx / fps) * 1000)
                    job.result_keyframes.append(
                        Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h))
                    )
                    active[job_id] = (tracker, ref_hist, job, fail_count, drift_cnt, last_bbox)
                    if frame_idx >= job.end_frame:
                        done_ids.append(job_id)
                    continue

                x, y, w, h = [int(v) for v in tracked_bbox]
                x, y = max(0, x), max(0, y)

                roi = frame[y:y + h, x:x + w]
                if roi.size > 0:
                    curr_hist = self._compute_hist(roi)
                    drift = cv2.compareHist(ref_hist, curr_hist, cv2.HISTCMP_BHATTACHARYYA)
                    if drift > _DRIFT_THRESHOLD:
                        drift_cnt += 1
                        if drift_cnt >= _DRIFT_CONFIRM_FRAMES:
                            done_ids.append(job_id)
                            continue
                    else:
                        drift_cnt = 0

                    # Rolling reference histogram blend
                    frames_since_start = frame_idx - job.start_frame
                    if frames_since_start > 0 and frames_since_start % _REF_HIST_BLEND_INTERVAL == 0:
                        ref_hist = (1 - _REF_HIST_BLEND_ALPHA) * ref_hist + _REF_HIST_BLEND_ALPHA * curr_hist

                time_ms = int((frame_idx / fps) * 1000)
                job.result_keyframes.append(
                    Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h))
                )
                last_bbox = (x, y, w, h)
                active[job_id] = (tracker, ref_hist, job, 0, drift_cnt, last_bbox)

                if frame_idx >= job.end_frame:
                    done_ids.append(job_id)

            for job_id in set(done_ids):
                active.pop(job_id, None)

            del frame
            frame_idx += 1

            if on_progress and total_track_frames > 0 and frame_idx % 30 == 0:
                elapsed = frame_idx - jobs[0].start_frame
                time_ms = int((frame_idx / fps) * 1000)
                on_progress(elapsed, total_track_frames, len(active), time_ms)

        cap.release()

        # Merge job results back into events, sorting and deduplicating by time_ms.
        event_kf_map: dict[int, list[Keyframe]] = {i: [] for i in trackable}
        for job in jobs:
            event_kf_map[job.event_idx].extend(job.result_keyframes)

        for evt_idx in trackable:
            kfs = event_kf_map[evt_idx]
            kfs.sort(key=lambda k: k.time_ms)
            seen: set[int] = set()
            deduped: list[Keyframe] = []
            for kf in kfs:
                if kf.time_ms not in seen:
                    seen.add(kf.time_ms)
                    deduped.append(kf)
            events[evt_idx].keyframes = deduped

        return events

    def _track_segment(
        self,
        cap: cv2.VideoCapture,
        fps: float,
        kf_start: Keyframe,
        kf_end: Keyframe,
    ) -> list[Keyframe]:
        """
        Track from ``kf_start`` to ``kf_end``, returning filled keyframes.

        Features:
        - Hold-last-position on tracking failure (up to _MAX_HOLD_FRAMES)
        - Consecutive-frame drift confirmation (_DRIFT_CONFIRM_FRAMES)
        - Rolling reference histogram blend to prevent staleness
        - Scene-change-aware: stops cleanly at scene cuts
        """
        start_frame = int((kf_start.time_ms / 1000) * fps)
        end_frame = int((kf_end.time_ms / 1000) * fps)

        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        ret, frame = cap.read()
        if not ret:
            return [kf_start]

        bbox_tuple = (kf_start.bbox.x, kf_start.bbox.y, kf_start.bbox.w, kf_start.bbox.h)
        tracker = _create_csrt_tracker()
        tracker.init(frame, bbox_tuple)

        roi = frame[
            kf_start.bbox.y: kf_start.bbox.y + kf_start.bbox.h,
            kf_start.bbox.x: kf_start.bbox.x + kf_start.bbox.w,
        ]
        ref_hist = self._compute_hist(roi)
        prev_scene_hist = compute_histogram(frame)

        filled: list[Keyframe] = [kf_start]
        current_frame = start_frame + 1
        hold_count = 0
        drift_count = 0
        last_good_bbox = bbox_tuple

        while current_frame <= end_frame:
            ret, frame = cap.read()
            if not ret:
                break

            # Scene change detection — stop cleanly at cuts
            curr_scene_hist = compute_histogram(frame)
            if histogram_diff(prev_scene_hist, curr_scene_hist) > 0.35:
                break
            prev_scene_hist = curr_scene_hist

            success, tracked_bbox = tracker.update(frame)
            time_ms = int((current_frame / fps) * 1000)

            if success:
                x, y, w, h = [int(v) for v in tracked_bbox]
                x, y = max(0, x), max(0, y)

                roi = frame[y: y + h, x: x + w]
                if roi.size > 0:
                    curr_hist = self._compute_hist(roi)
                    drift = cv2.compareHist(ref_hist, curr_hist, cv2.HISTCMP_BHATTACHARYYA)
                    if drift > _DRIFT_THRESHOLD:
                        drift_count += 1
                        if drift_count >= _DRIFT_CONFIRM_FRAMES:
                            break
                    else:
                        drift_count = 0

                    # Rolling reference histogram blend
                    frames_since_start = current_frame - start_frame
                    if frames_since_start % _REF_HIST_BLEND_INTERVAL == 0:
                        ref_hist = (1 - _REF_HIST_BLEND_ALPHA) * ref_hist + _REF_HIST_BLEND_ALPHA * curr_hist

                hold_count = 0
                last_good_bbox = (x, y, w, h)
                filled.append(Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h)))
            else:
                hold_count += 1
                if hold_count > _MAX_HOLD_FRAMES:
                    break
                # Hold last known position
                x, y, w, h = last_good_bbox
                filled.append(Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h)))

            current_frame += 1

        return filled

    def track_backward(
        self,
        event: RedactionEvent,
        video_path: str,
        fps: float,
    ) -> RedactionEvent:
        """
        Track a single-keyframe event backward from its first keyframe to frame 0.

        Used for manually-drawn boxes: after track_forward(), this method
        propagates the box backward in time using CSRT (via random-access seeking)
        until drift, scene change, or the start of the video.
        """
        if not event.keyframes:
            return event

        kf_start = event.keyframes[0]
        start_frame = int((kf_start.time_ms / 1000) * fps)

        if start_frame <= 0:
            return event

        cap = cv2.VideoCapture(video_path)

        # Initialize tracker at the first keyframe
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        ret, frame = cap.read()
        if not ret:
            cap.release()
            return event

        bbox_tuple = (kf_start.bbox.x, kf_start.bbox.y, kf_start.bbox.w, kf_start.bbox.h)
        tracker = _create_csrt_tracker()
        tracker.init(frame, bbox_tuple)

        roi = frame[
            kf_start.bbox.y: kf_start.bbox.y + kf_start.bbox.h,
            kf_start.bbox.x: kf_start.bbox.x + kf_start.bbox.w,
        ]
        ref_hist = self._compute_hist(roi)
        prev_scene_hist = compute_histogram(frame)

        backward_kfs: list[Keyframe] = []
        hold_count = 0
        drift_count = 0
        last_good_bbox = bbox_tuple

        current_frame = start_frame - 1
        while current_frame >= 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame)
            ret, frame = cap.read()
            if not ret:
                break

            # Scene change detection
            curr_scene_hist = compute_histogram(frame)
            if histogram_diff(prev_scene_hist, curr_scene_hist) > 0.35:
                break
            prev_scene_hist = curr_scene_hist

            # Re-init tracker for backward step (CSRT can't step backward natively)
            tracker = _create_csrt_tracker()
            tracker.init(frame, last_good_bbox)
            success, tracked_bbox = tracker.update(frame)
            time_ms = int((current_frame / fps) * 1000)

            if success:
                x, y, w, h = [int(v) for v in tracked_bbox]
                x, y = max(0, x), max(0, y)

                roi = frame[y: y + h, x: x + w]
                if roi.size > 0:
                    curr_hist = self._compute_hist(roi)
                    drift = cv2.compareHist(ref_hist, curr_hist, cv2.HISTCMP_BHATTACHARYYA)
                    if drift > _DRIFT_THRESHOLD:
                        drift_count += 1
                        if drift_count >= _DRIFT_CONFIRM_FRAMES:
                            break
                    else:
                        drift_count = 0

                hold_count = 0
                last_good_bbox = (x, y, w, h)
                backward_kfs.append(Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h)))
            else:
                hold_count += 1
                if hold_count > _MAX_HOLD_FRAMES:
                    break
                x, y, w, h = last_good_bbox
                backward_kfs.append(Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h)))

            current_frame -= 1

        cap.release()

        if backward_kfs:
            backward_kfs.reverse()
            # Prepend backward keyframes to existing ones
            event.keyframes = backward_kfs + event.keyframes
            # Extend time range to cover backward-tracked frames
            if event.time_ranges:
                event.time_ranges[0].start_ms = backward_kfs[0].time_ms
            else:
                from backend.models.events import TimeRange
                event.time_ranges = [TimeRange(
                    start_ms=backward_kfs[0].time_ms,
                    end_ms=event.keyframes[-1].time_ms,
                )]

        return event

    def _compute_hist(self, roi: np.ndarray) -> np.ndarray:
        """
        Compute a normalized grayscale histogram for a region of interest.

        Used for drift detection: comparing the histogram at initialization
        with the histogram at subsequent frames reveals content changes.

        Args:
            roi: A BGR image patch (the tracked region).

        Returns:
            A normalized 256-bin grayscale histogram as a float32 array.
            Returns a zero histogram for empty ROIs.
        """
        if roi.size == 0:
            return np.zeros((256, 1), dtype=np.float32)
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
        cv2.normalize(hist, hist)
        return hist
