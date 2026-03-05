"""
Rule engine data models — define how custom PII detection rules are structured.

Rules extend the built-in Presidio recognizers with user-defined patterns.
They are stored as JSON/YAML files on disk and loaded at startup or via the
``/rules`` API endpoints.

Rule precedence (highest to lowest):
  1. denylist  — always redact regardless of other rules
  2. regex     — high-precision pattern match
  3. field_label — context-aware: redact adjacent text next to a label
  4. context   — spatial proximity rules
  5. allowlist — suppress a match that other rules would catch
"""

from enum import Enum

from pydantic import BaseModel, Field


class RuleType(str, Enum):
    """
    The mechanism by which a rule identifies PII.

    REGEX       — Match text against a regular expression. Highest precision.
    CONTEXT     — Match text that appears within N pixels of a label string
                  (e.g., the word "Phone" near a number).
    ALLOWLIST   — Suppress redaction of matching text (exception list).
    DENYLIST    — Always redact matching text, overriding other rules.
    FIELD_LABEL — If a field label (e.g., "Customer:") is detected, redact
                  the adjacent text box to its right or below it.
    """

    REGEX = "regex"
    CONTEXT = "context"
    ALLOWLIST = "allowlist"
    DENYLIST = "denylist"
    FIELD_LABEL = "field_label"


class Rule(BaseModel):
    """
    A single PII detection rule.

    Rules are evaluated against OCR text results after Presidio's built-in
    recognizers run. Custom rules can add new patterns (``regex``), suppress
    false positives (``allowlist``), or force-redact specific values (``denylist``).

    Example — always redact any occurrence of "Acme Corp"::

        Rule(
            rule_id="denylist_acme",
            name="Acme Corp denylist",
            type=RuleType.DENYLIST,
            pattern="Acme Corp",
            label="company",
            priority=1,
        )
    """

    rule_id: str = Field(description="Unique identifier for this rule.")
    name: str = Field(description="Human-readable name shown in the rules UI.")
    type: RuleType = Field(description="Detection mechanism (see RuleType).")
    enabled: bool = Field(
        default=True,
        description="Whether this rule is active. Disabled rules are stored but not applied."
    )
    pattern: str | None = Field(
        default=None,
        description=(
            "Regex pattern (for 'regex' type) or exact text (for allowlist/denylist). "
            "None for field_label rules."
        )
    )
    label: str | None = Field(
        default=None,
        description=(
            "PII type label to assign to matches (e.g. 'phone', 'email'). "
            "Should correspond to a PiiType value."
        )
    )
    priority: int = Field(
        default=50,
        description=(
            "Evaluation priority. Lower numbers run first. "
            "Use low values (0–10) for denylist/regex rules, "
            "higher values (40–60) for heuristic rules."
        )
    )
    confidence: float = Field(
        default=0.9, ge=0.0, le=1.0,
        description="Confidence score assigned to matches from this rule."
    )
    context_pixels: int | None = Field(
        default=None,
        description=(
            "For 'context' type only: maximum pixel distance from a label "
            "at which a value is considered adjacent."
        )
    )
    description: str = Field(
        default="",
        description="Optional explanation of what this rule detects and why."
    )


class RuleSet(BaseModel):
    """
    A named, versioned collection of rules — typically a preset or workspace config.

    RuleSets can be exported as JSON/YAML files and shared between users.
    The built-in ``screen_recording_pii`` preset is a RuleSet shipped with the app.
    """

    name: str = Field(description="Display name for this rule set.")
    version: str = Field(default="1.0", description="Semantic version for compatibility tracking.")
    rules: list[Rule] = Field(default_factory=list, description="Ordered list of rules to apply.")
