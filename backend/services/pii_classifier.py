"""
PiiClassifier — identifies sensitive information in OCR text results.

Runs Microsoft Presidio's local NLP analysis engine against the text detected
by ``OcrService`` and maps findings back to individual bounding boxes.

Key design decisions
--------------------
**Batched Presidio call (one per frame, not one per box)**
  Presidio loads a spaCy NER model and is expensive to invoke repeatedly.
  Instead of calling it once per OCR text box, we join all boxes into a
  single composite string, analyze the whole thing, then use character-offset
  mapping to attribute each finding back to its source bounding box.
  This is ~10× faster on frames with many text regions (tables, spreadsheets).

**Custom regex rules**
  User-defined rules from the ``/rules`` API are applied independently (per box)
  using Python's ``re`` module. They run after Presidio so that denylist rules
  can capture patterns Presidio's recognizers miss.

**Presidio entity → PiiType mapping**
  Presidio uses its own entity type names (e.g., ``PHONE_NUMBER``, ``US_SSN``).
  ``_PRESIDIO_TYPE_MAP`` translates these to the app's ``PiiType`` enum values.
  Unmapped types fall back to ``PiiType.UNKNOWN``.
"""

import re
from dataclasses import dataclass

from presidio_analyzer import AnalyzerEngine, RecognizerResult

from backend.models.events import PiiType
from backend.services.ocr_service import BoxResult


# Maps Presidio entity type strings to the app's PiiType enum.
# Add entries here to handle additional Presidio recognizers.
_PRESIDIO_TYPE_MAP: dict[str, PiiType] = {
    "PHONE_NUMBER":    PiiType.PHONE,
    "EMAIL_ADDRESS":   PiiType.EMAIL,
    "PERSON":          PiiType.PERSON,
    "LOCATION":        PiiType.ADDRESS,
    "US_SSN":          PiiType.SSN,
    "CREDIT_CARD":     PiiType.CREDIT_CARD,
    "US_BANK_NUMBER":  PiiType.ACCOUNT_ID,
    "IP_ADDRESS":      PiiType.ACCOUNT_ID,
    "URL":             PiiType.UNKNOWN,
    "DATE_TIME":       PiiType.UNKNOWN,
}


@dataclass
class PiiCandidate:
    """
    A single PII detection candidate produced by ``PiiClassifier.classify()``.

    Candidates are consumed by ``EventLinker``, which groups them across frames
    into time-linked ``RedactionEvent`` objects.

    Attributes:
        text:          The matched text string (e.g., "555-867-5309").
        pii_type:      The type of sensitive data detected.
        confidence:    Detection confidence [0.0, 1.0].
        bbox:          Bounding box ``(x, y, w, h)`` in the source frame.
        source_frame:  Index of the video frame this was detected in.
        source_time_ms: Timestamp of that frame in milliseconds.
    """

    text: str
    pii_type: PiiType
    confidence: float
    bbox: tuple[int, int, int, int]
    source_frame: int
    source_time_ms: int


class PiiClassifier:
    """
    Classifies OCR text boxes as PII or non-PII using Presidio and custom rules.

    Call ``classify()`` once per video frame with the list of OCR results.
    Returns ``PiiCandidate`` objects for all detections above the confidence
    threshold, ready to be consumed by ``EventLinker``.
    """

    def __init__(self, confidence_threshold: float = 0.5) -> None:
        """
        Args:
            confidence_threshold: Minimum Presidio score to include a result.
                Values below this are silently dropped. Range [0.0, 1.0].
        """
        self._analyzer = AnalyzerEngine()
        self._threshold = confidence_threshold
        # Populated via set_custom_rules(); empty until rules are loaded.
        self._custom_rules: list[dict] = []

    def set_custom_rules(self, rules: list[dict]) -> None:
        """
        Load user-defined regex rules to apply in addition to Presidio.

        Args:
            rules: List of rule dicts from the ``/rules`` API. Only rules with
                   ``type='regex'`` and ``enabled=True`` are used.
        """
        self._custom_rules = [r for r in rules if r.get("type") == "regex" and r.get("enabled", True)]

    def classify(
        self,
        ocr_results: list[BoxResult],
        frame_index: int,
        time_ms: int,
    ) -> list[PiiCandidate]:
        """
        Detect PII in all OCR text boxes from a single frame.

        Strategy:
        1. Join all OCR text into one string, recording each box's character range.
        2. Run Presidio analysis once against the composite string.
        3. Map each Presidio result back to its source bounding box via offset lookup.
        4. Apply custom regex rules individually against each box's text.

        Args:
            ocr_results: Text boxes detected in this frame by ``OcrService``.
            frame_index: The frame number in the source video (for timestamping).
            time_ms:     The timestamp of this frame in milliseconds.

        Returns:
            List of ``PiiCandidate`` objects. May be empty if no PII is found
            or all results fall below ``confidence_threshold``.
        """
        if not ocr_results:
            return []

        candidates = []

        # --- Build composite text for batched Presidio analysis ---
        #
        # We join all OCR boxes with a newline separator and record each box's
        # [start, end) character offsets in the composite string. This lets us
        # attribute Presidio results (which use character offsets) back to the
        # correct bounding box on screen.
        separator = "\n"
        offsets: list[tuple[int, int, BoxResult]] = []  # (start, end, box)
        composite = ""

        for box in ocr_results:
            start = len(composite)
            composite += box.text.strip()
            end = len(composite)
            offsets.append((start, end, box))
            composite += separator  # separator is NOT included in [start, end)

        # --- Presidio analysis (single call for the whole frame) ---
        try:
            results: list[RecognizerResult] = self._analyzer.analyze(
                text=composite,
                language="en",
            )
        except Exception:
            # Presidio can fail on malformed input; degrade gracefully.
            results = []

        for result in results:
            if result.score < self._threshold:
                continue

            pii_type = _PRESIDIO_TYPE_MAP.get(result.entity_type, PiiType.UNKNOWN)
            matched_text = composite[result.start:result.end]

            # Find which OCR box's text span overlaps with this result
            box = self._find_box(result.start, result.end, offsets)
            if box is None:
                continue

            candidates.append(PiiCandidate(
                text=matched_text,
                pii_type=pii_type,
                confidence=result.score,
                bbox=box.bbox,
                source_frame=frame_index,
                source_time_ms=time_ms,
            ))

        # --- Custom regex rules (applied per-box) ---
        for rule in self._custom_rules:
            pattern = rule.get("pattern", "")
            label = rule.get("label", "custom")
            rule_confidence = float(rule.get("confidence", 0.9))

            if rule_confidence < self._threshold:
                continue

            # Map the rule's label string to our PiiType enum
            try:
                pii_type = PiiType(label) if label in PiiType._value2member_map_ else PiiType.CUSTOM
            except (ValueError, AttributeError):
                pii_type = PiiType.CUSTOM

            if len(pattern) > 500:
                continue  # Silently skip oversized patterns (ReDoS guard)

            for box in ocr_results:
                try:
                    matches = list(re.finditer(pattern, box.text, re.IGNORECASE))
                except re.error:
                    continue  # Silently skip malformed regex patterns

                for match in matches:
                    candidates.append(PiiCandidate(
                        text=match.group(),
                        pii_type=pii_type,
                        confidence=rule_confidence,
                        bbox=box.bbox,
                        source_frame=frame_index,
                        source_time_ms=time_ms,
                    ))

        return candidates

    @staticmethod
    def _find_box(
        start: int,
        end: int,
        offsets: list[tuple[int, int, BoxResult]],
    ) -> BoxResult | None:
        """
        Find the OCR box whose text span overlaps with the character range [start, end).

        Args:
            start: Start character offset in the composite string.
            end:   End character offset in the composite string.
            offsets: List of (box_start, box_end, BoxResult) tuples.

        Returns:
            The first ``BoxResult`` whose span overlaps with [start, end),
            or ``None`` if no match is found (can happen when a Presidio result
            spans the separator between two boxes).
        """
        for box_start, box_end, box in offsets:
            if start < box_end and end > box_start:
                return box
        return None
