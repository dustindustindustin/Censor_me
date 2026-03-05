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
``_DRIFT_THRESHOLD = 0.45`` was chosen empirically for screen recordings;
values above 0.5 tend to produce false drift alerts on scrolling content.
"""

import cv2
import numpy as np

from backend.models.events import BoundingBox, Keyframe, RedactionEvent


# Bhattacharyya histogram distance above which a tracker is considered to have
# drifted off the original content. Range [0.0, 1.0]; 0.0 = identical histograms.
_DRIFT_THRESHOLD = 0.45


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

    def _track_segment(
        self,
        cap: cv2.VideoCapture,
        fps: float,
        kf_start: Keyframe,
        kf_end: Keyframe,
    ) -> list[Keyframe]:
        """
        Track from ``kf_start`` to ``kf_end``, returning filled keyframes.

        Opens the video at the start keyframe's frame position, initializes a
        CSRT tracker there, then reads frames one-by-one until reaching the
        end keyframe's position. Stops early if the tracker fails or drift
        is detected.

        Args:
            cap:      An open ``cv2.VideoCapture`` positioned anywhere in the video.
            fps:      Frames per second (used to convert time_ms to frame index).
            kf_start: First OCR keyframe (tracker is initialized here).
            kf_end:   Target OCR keyframe (tracking stops at or before here).

        Returns:
            List of ``Keyframe`` objects from ``kf_start`` to wherever tracking
            ended. Always includes ``kf_start`` as the first element.
        """
        start_frame = int((kf_start.time_ms / 1000) * fps)
        end_frame = int((kf_end.time_ms / 1000) * fps)

        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        ret, frame = cap.read()
        if not ret:
            # Video ended or seek failed — return only the start keyframe
            return [kf_start]

        # Initialize CSRT tracker at the start keyframe's position
        bbox_tuple = (kf_start.bbox.x, kf_start.bbox.y, kf_start.bbox.w, kf_start.bbox.h)
        tracker = cv2.TrackerCSRT_create()
        tracker.init(frame, bbox_tuple)

        # Capture reference histogram for drift detection
        roi = frame[
            kf_start.bbox.y: kf_start.bbox.y + kf_start.bbox.h,
            kf_start.bbox.x: kf_start.bbox.x + kf_start.bbox.w,
        ]
        ref_hist = self._compute_hist(roi)

        filled: list[Keyframe] = [kf_start]
        current_frame = start_frame + 1

        while current_frame <= end_frame:
            ret, frame = cap.read()
            if not ret:
                break

            success, tracked_bbox = tracker.update(frame)
            time_ms = int((current_frame / fps) * 1000)

            if success:
                x, y, w, h = [int(v) for v in tracked_bbox]
                # Clamp to frame boundaries to avoid negative coordinates
                x, y = max(0, x), max(0, y)

                # Drift check: compare current ROI histogram to the reference
                roi = frame[y: y + h, x: x + w]
                if roi.size > 0:
                    curr_hist = self._compute_hist(roi)
                    drift = cv2.compareHist(ref_hist, curr_hist, cv2.HISTCMP_BHATTACHARYYA)
                    if drift > _DRIFT_THRESHOLD:
                        # Content has changed significantly — stop tracking this segment.
                        # The renderer will interpolate the remaining gap linearly.
                        break

                filled.append(Keyframe(time_ms=time_ms, bbox=BoundingBox(x=x, y=y, w=w, h=h)))
            else:
                # CSRT tracker lost the target — stop and let renderer interpolate
                break

            current_frame += 1

        return filled

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
