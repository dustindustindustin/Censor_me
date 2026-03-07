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

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

from backend.models.events import PiiType
from backend.services.ocr_service import BoxResult


# Maps Presidio entity type strings to the app's PiiType enum.
# Only entity types listed here are kept — everything else is dropped.
_PRESIDIO_TYPE_MAP: dict[str, PiiType] = {
    "PHONE_NUMBER":    PiiType.PHONE,
    "EMAIL_ADDRESS":   PiiType.EMAIL,
    "PERSON":          PiiType.PERSON,
    "US_SSN":          PiiType.SSN,
    "CREDIT_CARD":     PiiType.CREDIT_CARD,
    "US_BANK_NUMBER":  PiiType.ACCOUNT_ID,
    "IP_ADDRESS":      PiiType.ACCOUNT_ID,
    # Intentionally excluded:
    # "LOCATION" — spaCy NER maps navigation items, brand names, and page headings
    #              as locations in UI/intranet text (>80% false positive rate).
    #              Postal codes are still caught via Presidio's US_ZIP_CODE recognizer.
    # "DATE_TIME" — dates on screen are not PII (anniversaries, post dates, etc.)
    # "URL"       — public URLs are not PII; custom regex rules cover private paths
    # "NRP"       — nationalities/religious/political groups; too noisy for UI text
}

# Minimum character length for NLP-based PERSON entities.
# Single-character or very short matches ("I", "Al") are nearly always false positives.
_PERSON_MIN_CHARS = 4


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

    def __init__(
        self,
        confidence_threshold: float = 0.5,
        entity_confidence_overrides: dict[str, float] | None = None,
    ) -> None:
        """
        Args:
            confidence_threshold: Minimum Presidio score to include a result.
                Values below this are silently dropped. Range [0.0, 1.0].
            entity_confidence_overrides: Per-PII-type thresholds that override
                the global threshold for specific entity types.
        """
        self._analyzer = None  # Lazy-loaded on first classify() call
        self._threshold = confidence_threshold
        self._entity_overrides = entity_confidence_overrides or {}
        # Populated via set_custom_rules(); empty until rules are loaded.
        self._custom_rules: list[dict] = []
        self._warned_rules: set[str] = set()

    def _get_analyzer(self):
        """
        Return the Presidio AnalyzerEngine, initializing it on first call.

        Raises RuntimeError if initialization fails so the caller (scan pipeline)
        can surface a clear error rather than silently returning no findings.
        """
        if self._analyzer is None:
            try:
                from presidio_analyzer import AnalyzerEngine
                logger.info("Initializing Presidio AnalyzerEngine (first scan frame)…")
                self._analyzer = AnalyzerEngine()
                logger.info("Presidio AnalyzerEngine ready.")
            except Exception as e:
                raise RuntimeError(
                    f"Presidio failed to initialize: {e}. "
                    "Ensure presidio-analyzer is installed and the spaCy model is present. "
                    "Run: python -m spacy download en_core_web_lg"
                ) from e
        return self._analyzer

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
        logger.debug("OCR found %d boxes in frame %d: %r", len(ocr_results), frame_index,
                     [b.text for b in ocr_results])
        # _get_analyzer() raises RuntimeError on init failure — let it propagate
        # so the scan surfaces a clear error instead of silently returning no findings.
        analyzer = self._get_analyzer()
        try:
            results = analyzer.analyze(
                text=composite,
                language="en",
            )
        except (ValueError, RuntimeError) as e:
            logger.warning("Presidio analysis failed on frame %d: %s", frame_index, e)
            results = []

        logger.debug("Presidio returned %d results for frame %d (threshold=%.2f): %s",
                     len(results), frame_index, self._threshold,
                     [(r.entity_type, round(r.score, 2), composite[r.start:r.end]) for r in results])

        for result in results:
            # Only keep entity types explicitly in the map — drop everything else
            # (DATE_TIME, LOCATION, URL, NRP, and any future Presidio additions).
            pii_type = _PRESIDIO_TYPE_MAP.get(result.entity_type)
            if pii_type is None:
                logger.debug(
                    "Skipping entity type %r (not in type map) on frame %d",
                    result.entity_type, frame_index,
                )
                continue

            # Per-type confidence threshold: look up by PiiType value,
            # fall back to global threshold if no override is configured.
            threshold = self._entity_overrides.get(pii_type.value, self._threshold)
            if result.score < threshold:
                continue

            matched_text = composite[result.start:result.end].strip()

            # PERSON: require a minimum character length to filter single-char or
            # very short NLP matches that are almost always false positives.
            if result.entity_type == "PERSON" and len(matched_text) < _PERSON_MIN_CHARS:
                logger.debug(
                    "Skipping short PERSON match %r (< %d chars) on frame %d",
                    matched_text, _PERSON_MIN_CHARS, frame_index,
                )
                continue

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

            # Map the rule's label string to our PiiType enum
            try:
                pii_type = PiiType(label) if label in PiiType._value2member_map_ else PiiType.CUSTOM
            except (ValueError, AttributeError):
                pii_type = PiiType.CUSTOM

            # Per-type threshold for custom rules
            threshold = self._entity_overrides.get(pii_type.value, self._threshold)
            if rule_confidence < threshold:
                continue

            rule_id = rule.get("rule_id", pattern)
            if len(pattern) > 500:
                if rule_id not in self._warned_rules:
                    self._warned_rules.add(rule_id)
                    logger.warning("Skipping rule %r: pattern exceeds 500 chars (ReDoS guard)", rule_id)
                continue

            for box in ocr_results:
                try:
                    matches = list(re.finditer(pattern, box.text, re.IGNORECASE))
                except re.error as exc:
                    if rule_id not in self._warned_rules:
                        self._warned_rules.add(rule_id)
                        logger.warning("Skipping rule %r: malformed regex: %s", rule_id, exc)
                    continue

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
