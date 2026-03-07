"""Rules management API."""

import concurrent.futures
import json
import logging
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.models.rules import Rule, RuleSet

MAX_PATTERN_LEN = 500
MAX_SAMPLE_LEN = 10_000

router = APIRouter()

PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", Path.home() / "censor_me_projects"))

_log = logging.getLogger(__name__)


def _rules_file() -> Path:
    return PROJECTS_DIR / "custom_rules.json"


def _load_custom_rules() -> list[Rule]:
    f = _rules_file()
    if not f.exists():
        return []
    try:
        return [Rule.model_validate(r) for r in json.loads(f.read_text())]
    except Exception:
        _log.warning("Failed to load custom_rules.json, starting empty")
        return []


def _save_custom_rules() -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    _rules_file().write_text(json.dumps([r.model_dump() for r in _custom_rules], indent=2))


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
    _custom_rules.append(rule)
    _save_custom_rules()
    return {"added": rule.rule_id}


@router.delete("/custom/{rule_id}")
async def delete_custom_rule(rule_id: str) -> dict:
    """Delete a custom rule by ID."""
    global _custom_rules
    before = len(_custom_rules)
    _custom_rules = [r for r in _custom_rules if r.rule_id != rule_id]
    if len(_custom_rules) == before:
        raise HTTPException(status_code=404, detail="Rule not found")
    _save_custom_rules()
    return {"deleted": rule_id}


@router.patch("/custom/{rule_id}")
async def update_custom_rule(rule_id: str, body: dict) -> dict:
    """Patch a custom rule (e.g. toggle enabled, update name/pattern)."""
    for i, rule in enumerate(_custom_rules):
        if rule.rule_id == rule_id:
            merged = rule.model_dump() | {k: v for k, v in body.items() if k != "rule_id"}
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
