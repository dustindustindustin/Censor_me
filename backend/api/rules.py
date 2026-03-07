"""Rules management API."""

import asyncio
import concurrent.futures
import json
import logging
import os
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.config import PROJECTS_DIR
from backend.models.rules import Rule, RuleSet, RuleUpdate

MAX_PATTERN_LEN = 500
MAX_SAMPLE_LEN = 10_000

router = APIRouter()

_log = logging.getLogger(__name__)

_rules_lock = asyncio.Lock()


def _rules_file() -> Path:
    return PROJECTS_DIR / "custom_rules.json"


def _load_custom_rules() -> list[Rule]:
    f = _rules_file()
    if not f.exists():
        return []
    try:
        return [Rule.model_validate(r) for r in json.loads(f.read_text())]
    except (json.JSONDecodeError, ValueError, KeyError) as exc:
        _log.warning("Failed to load custom_rules.json (%s), starting empty", exc)
        return []


def _save_custom_rules() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    dest = _rules_file()
    fd, tmp = tempfile.mkstemp(dir=str(PROJECTS_DIR), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump([r.model_dump() for r in _custom_rules], f, indent=2)
        os.replace(tmp, str(dest))
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# Default built-in rules (shipped with app)
_DEFAULT_RULES: list[Rule] = [
    Rule(
        rule_id="phone_us",
        name="US Phone Number",
        type="regex",
        pattern=r"\b(\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b",
        label="phone",
        priority=10,
        confidence=0.95,
    ),
    Rule(
        rule_id="email",
        name="Email Address",
        type="regex",
        pattern=r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b",
        label="email",
        priority=10,
        confidence=0.95,
    ),
    Rule(
        rule_id="ssn",
        name="US Social Security Number",
        type="regex",
        pattern=r"\b\d{3}-\d{2}-\d{4}\b",
        label="ssn",
        priority=5,
        confidence=0.98,
    ),
    Rule(
        rule_id="credit_card",
        name="Credit Card Number",
        type="regex",
        pattern=r"\b(?:\d[ -]?){13,16}\b",
        label="credit_card",
        priority=5,
        confidence=0.85,
    ),
    Rule(
        rule_id="employee_id_6digit",
        name="Employee ID (6-digit)",
        type="regex",
        # Matches a 6-digit number optionally wrapped in parentheses.
        # Covers "Name (139168)" and bare "139168" formats.
        # Word boundaries prevent matching fragments of longer numbers.
        pattern=r"\(?\b\d{6}\b\)?",
        label="employee_id",
        priority=8,
        confidence=0.90,
        description="6-digit employee/badge ID, e.g. (139168) or 139168.",
    ),
    Rule(
        rule_id="ipv4_address",
        name="IPv4 Address",
        type="regex",
        # Matches valid IPv4 addresses (0.0.0.0 – 255.255.255.255).
        # Excludes common non-PII addresses via negative lookahead:
        # 127.0.0.1 (loopback), 0.0.0.0 (unspecified), 255.255.255.255 (broadcast).
        pattern=r"\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?!255\.255\.255\.255\b)(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b",
        label="account_id",
        priority=8,
        confidence=0.85,
        description="IPv4 address (excludes loopback, unspecified, broadcast).",
    ),
    Rule(
        rule_id="url_credentials",
        name="URL with Credentials",
        type="regex",
        # Matches URLs containing embedded username:password before the host.
        pattern=r"https?://[^\s:@]+:[^\s:@]+@[^\s/]+",
        label="account_id",
        priority=5,
        confidence=0.95,
        description="URL with embedded credentials, e.g. https://user:pass@host.",
    ),
    Rule(
        rule_id="bank_account_us",
        name="US Bank Account Number",
        type="regex",
        # Matches 12-digit numbers with optional separators (dashes or spaces).
        # More specific than bare \d{8,17} to avoid excessive false positives.
        pattern=r"\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b",
        label="account_id",
        priority=8,
        confidence=0.75,
        description="12-digit bank account number with optional separators.",
    ),
    Rule(
        rule_id="routing_number_aba",
        name="ABA Routing Number",
        type="regex",
        # Matches 9-digit numbers starting with 0-3 (valid ABA prefix range).
        pattern=r"\b[0-3]\d{8}\b",
        label="account_id",
        priority=8,
        confidence=0.80,
        description="9-digit ABA routing number (first digit 0\u20133).",
    ),
    # --- Context / field-label rules ---
    # These flag text adjacent to known labels (e.g. "Phone:", "Email:") as PII,
    # even when the adjacent text doesn't match a regex pattern on its own.
    Rule(
        rule_id="ctx_phone_label",
        name="Phone Label Context",
        type="field_label",
        pattern=r"(?i)\b(?:phone|tel|mobile|cell|fax)\b",
        label="phone",
        priority=30,
        confidence=0.80,
        context_pixels=200,
        description="Flag text adjacent to phone-related labels.",
    ),
    Rule(
        rule_id="ctx_email_label",
        name="Email Label Context",
        type="field_label",
        pattern=r"(?i)\b(?:email|e-mail)\b",
        label="email",
        priority=30,
        confidence=0.80,
        context_pixels=200,
        description="Flag text adjacent to email-related labels.",
    ),
    Rule(
        rule_id="ctx_ssn_label",
        name="SSN Label Context",
        type="field_label",
        pattern=r"(?i)\b(?:ssn|social\s*security)\b",
        label="ssn",
        priority=30,
        confidence=0.85,
        context_pixels=200,
        description="Flag text adjacent to SSN-related labels.",
    ),
    Rule(
        rule_id="ctx_name_label",
        name="Name Label Context",
        type="field_label",
        pattern=r"(?i)\b(?:name|customer|patient|employee|applicant)\b",
        label="person",
        priority=30,
        confidence=0.70,
        context_pixels=200,
        description="Flag text adjacent to name-related labels.",
    ),
    Rule(
        rule_id="ctx_account_label",
        name="Account Label Context",
        type="field_label",
        pattern=r"(?i)\b(?:account|acct|routing|bank)\b",
        label="account_id",
        priority=30,
        confidence=0.80,
        context_pixels=200,
        description="Flag text adjacent to account-related labels.",
    ),
]

_custom_rules: list[Rule] = _load_custom_rules()


def get_all_rules() -> list[Rule]:
    """Return all active rules: built-in defaults + user-defined custom rules."""
    return _DEFAULT_RULES + _custom_rules


@router.get("/")
async def get_rules() -> dict:
    """Return all rules (default + custom)."""
    return {
        "default": [r.model_dump() for r in _DEFAULT_RULES],
        "custom": [r.model_dump() for r in _custom_rules],
    }


@router.post("/custom")
async def add_custom_rule(rule: Rule) -> dict:
    """Add a custom rule."""
    async with _rules_lock:
        _custom_rules.append(rule)
        _save_custom_rules()
    return {"added": rule.rule_id}


@router.delete("/custom/{rule_id}")
async def delete_custom_rule(rule_id: str) -> dict:
    """Delete a custom rule by ID."""
    global _custom_rules
    async with _rules_lock:
        before = len(_custom_rules)
        _custom_rules = [r for r in _custom_rules if r.rule_id != rule_id]
        if len(_custom_rules) == before:
            raise HTTPException(status_code=404, detail="Rule not found")
        _save_custom_rules()
    return {"deleted": rule_id}


@router.patch("/custom/{rule_id}")
async def update_custom_rule(rule_id: str, body: RuleUpdate) -> dict:
    """Patch a custom rule (e.g. toggle enabled, update name/pattern)."""
    async with _rules_lock:
        for i, rule in enumerate(_custom_rules):
            if rule.rule_id == rule_id:
                merged = rule.model_dump() | body.model_dump(exclude_unset=True)
                updated = Rule.model_validate(merged)
                _custom_rules[i] = updated
                _save_custom_rules()
                return updated.model_dump()
    raise HTTPException(status_code=404, detail="Rule not found")


@router.post("/test")
async def test_rule(pattern: str, sample_text: str) -> dict:
    """Test a regex pattern against sample text."""
    if len(pattern) > MAX_PATTERN_LEN:
        raise HTTPException(status_code=422, detail=f"Pattern too long (max {MAX_PATTERN_LEN} chars)")
    if len(sample_text) > MAX_SAMPLE_LEN:
        raise HTTPException(status_code=422, detail=f"Sample text too long (max {MAX_SAMPLE_LEN} chars)")

    try:
        compiled = re.compile(pattern)
    except re.error as e:
        raise HTTPException(status_code=422, detail=f"Invalid regex: {e}")

    def _run() -> list:
        return compiled.findall(sample_text)

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            matches = executor.submit(_run).result(timeout=2.0)
    except concurrent.futures.TimeoutError:
        raise HTTPException(status_code=422, detail="Regex timed out — pattern may be too complex")

    return {"matches": matches, "count": len(matches)}
