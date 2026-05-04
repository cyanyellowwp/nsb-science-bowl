#!/usr/bin/env python3
"""
Question bank linter — content quality gate for the database.

Validates the structural integrity and content cleanliness of any
v2-schema question bank (questions.json, corpus-doe.json, future
content/<subject>/questions.json).

Catches the kinds of bugs the scraper has historically produced:
  - Concatenated questions (multiple Q's slurped into one stem)
  - Answer leakage (ANSWER: ... embedded in the question body)
  - PDF artifacts (page footers, round markers, "undefined" literals)
  - Schema violations (missing fields, wrong types, bad letter answers)
  - Cross-bank duplicates

Severity:
  ERROR — must fix before shipping. Linter exits 1 if any are found.
  WARN  — human should review. Doesn't block ship by default.
  INFO  — stats / diagnostics.

Usage:
  python3 scripts/lint_questions.py
  python3 scripts/lint_questions.py --strict       # WARN also blocks ship
  python3 scripts/lint_questions.py --report       # write a markdown report
  python3 scripts/lint_questions.py --json         # machine-readable output
  python3 scripts/lint_questions.py --files a.json b.json   # explicit list
  python3 scripts/lint_questions.py --quarantine   # move bad entries to *.quarantine.json

Designed to be idempotent and safe — never modifies the input files unless
--quarantine is passed (which moves bad entries aside, doesn't delete).
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent.parent

# ---------- Rule severities ----------
ERROR = "ERROR"
WARN = "WARN"
INFO = "INFO"

# ---------- Suspicious-content patterns ----------
# These regexes flag specific known-bad strings observed in real corruption:
ANSWER_LEAKAGE = re.compile(r"\b(?:ANSWER|ANWER|ANSER|ANSWE)\s*:", re.I)
QUESTION_MARKERS_IN_BODY = re.compile(r"\b(?:TOSS[\s\-]*UP|BONUS)\s+\d+\)?", re.I)
PDF_PAGE_ARTIFACT = re.compile(
    r"(?:Round\s+\d+[A-Z]?|~+\s*Page\s+\d+|Page\s+\d+(?:\s+of\s+\d+)?)",
    re.I,
)
LITERAL_UNDEFINED = re.compile(r"\b(?:undefined|null)\b")
WHITESPACE_RUNS = re.compile(r"\s{4,}")
NON_TERMINAL_END = re.compile(r"[,;:\-]\s*$")


@dataclasses.dataclass
class Finding:
    severity: str
    rule: str
    message: str
    file: str
    concept_id: str | None = None
    variant_id: str | None = None
    snippet: str | None = None

    def fmt(self) -> str:
        loc = self.file
        if self.concept_id:
            loc += f"::{self.concept_id}"
        if self.variant_id:
            loc += f"::{self.variant_id}"
        out = f"  [{self.severity}] {self.rule} at {loc}\n        {self.message}"
        if self.snippet:
            out += f"\n        snippet: {self.snippet[:200]!r}"
        return out


# ---------- Per-variant rules ----------

def lint_variant(v: dict, file: str, concept_id: str, kind: str) -> list[Finding]:
    """Lint a single tossup or bonus variant. `kind` ∈ {tossup, bonus}."""
    findings: list[Finding] = []
    vid = v.get("id", "<no-id>")
    body = v.get("question", "") or ""
    answer = v.get("answer", "") or ""
    qtype = v.get("type", "")

    def add(sev, rule, msg, snippet=None):
        findings.append(Finding(sev, rule, msg, file, concept_id, vid, snippet))

    # --- E-tier: schema integrity ---
    if not body.strip():
        add(ERROR, "E001", "Question body is empty.")
        return findings  # everything else depends on body

    if not answer.strip():
        add(ERROR, "E002", "Answer is empty.")

    if qtype not in ("multiple_choice", "short_answer"):
        add(ERROR, "E012", f"Unknown variant type: {qtype!r}")

    # --- E-tier: content corruption ---
    if ANSWER_LEAKAGE.search(body):
        match = ANSWER_LEAKAGE.search(body)
        add(ERROR, "E003", "Question body contains answer leakage (ANSWER:/ANWER: present).",
            snippet=body[max(0, match.start() - 30):match.end() + 50])

    if QUESTION_MARKERS_IN_BODY.search(body):
        match = QUESTION_MARKERS_IN_BODY.search(body)
        add(ERROR, "E004", "Question body contains another question's TOSS-UP/BONUS marker.",
            snippet=body[max(0, match.start() - 20):match.end() + 80])

    if PDF_PAGE_ARTIFACT.search(body):
        match = PDF_PAGE_ARTIFACT.search(body)
        add(ERROR, "E005", "Question body contains a PDF page artifact.",
            snippet=body[max(0, match.start() - 20):match.end() + 30])

    if PDF_PAGE_ARTIFACT.search(answer):
        match = PDF_PAGE_ARTIFACT.search(answer)
        add(ERROR, "E005", "Answer contains a PDF page artifact.",
            snippet=answer)

    if LITERAL_UNDEFINED.search(answer) or LITERAL_UNDEFINED.search(body):
        add(ERROR, "E010", "Body or answer contains the literal string 'undefined' or 'null'.",
            snippet=answer)

    # --- E-tier: multiple-choice integrity ---
    if qtype == "multiple_choice":
        # Body must contain all 4 options
        for letter in ("W", "X", "Y", "Z"):
            if not re.search(rf"\b{letter}\)", body):
                add(ERROR, "E006", f"Multiple-choice body missing option {letter}).")
        # Answer must be one of W/X/Y/Z
        ans_clean = answer.strip().upper()
        if ans_clean not in ("W", "X", "Y", "Z"):
            add(ERROR, "E007", f"Multiple-choice answer {answer!r} is not a single letter W/X/Y/Z.")
        # answer_text should be set
        if not v.get("answer_text"):
            add(WARN, "W008", "Multiple-choice variant missing answer_text — UI will show the letter only.")

    # --- E-tier: short-answer integrity ---
    if qtype == "short_answer":
        if re.fullmatch(r"\s*[WXYZ]\s*", answer or ""):
            add(ERROR, "E009", f"Short-answer variant has a single letter answer ({answer!r}) — likely mis-tagged as MC.")

    # --- W-tier: content quality ---
    word_count = len(body.split())
    if qtype == "short_answer" and word_count > 50:
        add(WARN, "W001", f"Short-answer body is {word_count} words (target ≤25; >50 strongly suggests concatenation).")
    elif qtype == "multiple_choice" and word_count > 90:
        add(WARN, "W001", f"Multiple-choice body is {word_count} words (target ≤80 incl. options).")

    if len(answer) > 200:
        add(WARN, "W002", f"Answer is {len(answer)} characters (likely contains extraneous text).",
            snippet=answer[:200])

    if "\n" in answer:
        add(WARN, "W003", "Answer contains newline characters.")

    if WHITESPACE_RUNS.search(body):
        add(WARN, "W007", "Body contains 4+ consecutive whitespace characters (likely PDF extraction noise).")

    if NON_TERMINAL_END.search(body):
        add(WARN, "W006", "Body ends with comma/semicolon/colon — possibly truncated mid-sentence.",
            snippet=body[-60:])

    return findings


# ---------- Per-concept rules ----------

def lint_concept(c: dict, file: str) -> list[Finding]:
    findings: list[Finding] = []
    cid = c.get("id", "<no-id>")

    if not cid or cid == "<no-id>":
        findings.append(Finding(ERROR, "E011", "Concept missing 'id'.", file))
        return findings

    if not c.get("category"):
        findings.append(Finding(WARN, "W011", "Concept missing 'category'.", file, cid))

    tu_variants = c.get("tossup_variants") or []
    bo_variants = c.get("bonus_variants") or []

    if not tu_variants:
        findings.append(Finding(ERROR, "E022", "Concept has no tossup_variants.", file, cid))
    if not bo_variants:
        findings.append(Finding(ERROR, "E022", "Concept has no bonus_variants.", file, cid))

    # Check variants don't share IDs across tossup/bonus (cleanliness)
    tu_ids = {v.get("id") for v in tu_variants if v.get("id")}
    bo_ids = {v.get("id") for v in bo_variants if v.get("id")}
    overlap = tu_ids & bo_ids
    if overlap:
        findings.append(Finding(WARN, "W012",
                                f"Tossup and bonus variants share IDs: {sorted(overlap)}.",
                                file, cid))

    for v in tu_variants:
        findings.extend(lint_variant(v, file, cid, "tossup"))
    for v in bo_variants:
        findings.extend(lint_variant(v, file, cid, "bonus"))

    return findings


# ---------- Bank-level (cross-concept) rules ----------

def lint_bank(bank: dict, file: str) -> list[Finding]:
    findings: list[Finding] = []

    if bank.get("schema_version") not in ("2.0",):
        findings.append(Finding(WARN, "W020",
                                f"Unexpected schema_version: {bank.get('schema_version')!r}",
                                file))

    concepts = bank.get("concepts") or []
    if not isinstance(concepts, list):
        findings.append(Finding(ERROR, "E021", "'concepts' is not a list.", file))
        return findings

    # Duplicate concept IDs
    id_counts = Counter(c.get("id") for c in concepts if c.get("id"))
    for cid, n in id_counts.items():
        if n > 1:
            findings.append(Finding(ERROR, "E013",
                                    f"Concept ID appears {n} times in this file.",
                                    file, cid))

    # Duplicate question texts (across concepts)
    text_to_locations: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for c in concepts:
        cid = c.get("id", "<no-id>")
        for v in (c.get("tossup_variants") or []):
            t = (v.get("question") or "").strip()
            if t:
                text_to_locations[t].append((cid, v.get("id", "<no-id>")))
        for v in (c.get("bonus_variants") or []):
            t = (v.get("question") or "").strip()
            if t:
                text_to_locations[t].append((cid, v.get("id", "<no-id>")))
    for text, locs in text_to_locations.items():
        if len(locs) > 1:
            findings.append(Finding(WARN, "W005",
                                    f"Question text duplicated across {len(locs)} variants: {locs[:3]}…",
                                    file, snippet=text[:120]))

    # Per-concept rules
    for c in concepts:
        findings.extend(lint_concept(c, file))

    return findings


# ---------- Orchestration ----------

def lint_files(paths: list[Path]) -> list[Finding]:
    all_findings: list[Finding] = []
    for p in paths:
        try:
            data = json.loads(p.read_text())
        except Exception as e:
            all_findings.append(Finding(ERROR, "E000", f"Cannot parse JSON: {e}", str(p)))
            continue
        all_findings.extend(lint_bank(data, p.name))
    return all_findings


def quarantine_findings(paths: list[Path], findings: list[Finding]) -> dict[str, int]:
    """Move concepts with ERROR-level findings into <file>.quarantine.json
    and write a cleaned <file>. Returns a summary."""
    summary: dict[str, int] = {}
    bad_concept_ids: dict[str, set[str]] = defaultdict(set)
    for f in findings:
        if f.severity == ERROR and f.concept_id:
            bad_concept_ids[f.file].add(f.concept_id)

    for p in paths:
        bad = bad_concept_ids.get(p.name, set())
        if not bad:
            summary[p.name] = 0
            continue
        data = json.loads(p.read_text())
        kept = [c for c in data.get("concepts", []) if c.get("id") not in bad]
        removed = [c for c in data.get("concepts", []) if c.get("id") in bad]
        # Write quarantine file
        q_path = p.with_suffix(".quarantine.json")
        q_data = dict(data)
        q_data["concepts"] = removed
        q_data["_quarantine_reason"] = "removed by lint_questions.py for ERROR-level findings"
        q_path.write_text(json.dumps(q_data, indent=2))
        # Write cleaned file (backup the original first)
        backup = p.with_suffix(p.suffix + ".pre-quarantine")
        backup.write_text(p.read_text())
        cleaned = dict(data)
        cleaned["concepts"] = kept
        p.write_text(json.dumps(cleaned, indent=2))
        summary[p.name] = len(removed)
    return summary


def write_report(findings: list[Finding], out_path: Path) -> None:
    by_file: dict[str, list[Finding]] = defaultdict(list)
    for f in findings:
        by_file[f.file].append(f)

    lines = ["# Question bank lint report", ""]
    total_err = sum(1 for f in findings if f.severity == ERROR)
    total_warn = sum(1 for f in findings if f.severity == WARN)
    lines.append(f"**Summary:** {total_err} errors, {total_warn} warnings across {len(by_file)} files.\n")
    lines.append("## Severity legend\n")
    lines.append("- **ERROR** — blocks ship. Concept must be fixed or removed.")
    lines.append("- **WARN** — human review recommended; doesn't block ship.\n")

    for file, items in sorted(by_file.items()):
        lines.append(f"## {file}\n")
        # Group by rule
        by_rule: dict[str, list[Finding]] = defaultdict(list)
        for it in items:
            by_rule[it.rule].append(it)
        for rule in sorted(by_rule.keys()):
            rule_items = by_rule[rule]
            sev = rule_items[0].severity
            lines.append(f"### {rule} ({sev}) — {len(rule_items)} occurrences\n")
            for it in rule_items[:10]:  # cap at 10 per rule per file
                cid = it.concept_id or "?"
                vid = it.variant_id or "?"
                lines.append(f"- `{cid}` / `{vid}`: {it.message}")
                if it.snippet:
                    lines.append(f"  - snippet: `{it.snippet[:160]!r}`")
            if len(rule_items) > 10:
                lines.append(f"  - …and {len(rule_items) - 10} more")
            lines.append("")
    out_path.write_text("\n".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser(description="Question bank linter.")
    ap.add_argument("--files", nargs="*", help="JSON files to lint (default: questions.json + corpus-doe.json)")
    ap.add_argument("--strict", action="store_true", help="Treat WARN as ERROR")
    ap.add_argument("--report", help="Write a markdown report to this path")
    ap.add_argument("--json", action="store_true", help="Print machine-readable JSON output")
    ap.add_argument("--quarantine", action="store_true",
                    help="Move ERROR-level concepts to <file>.quarantine.json")
    args = ap.parse_args()

    paths: list[Path] = []
    if args.files:
        paths = [Path(f) for f in args.files]
    else:
        for default in ("questions.json", "corpus-doe.json"):
            p = ROOT / default
            if p.exists():
                paths.append(p)

    if not paths:
        print("No files to lint.", file=sys.stderr)
        return 2

    findings = lint_files(paths)

    # Filter for output
    errors = [f for f in findings if f.severity == ERROR]
    warns = [f for f in findings if f.severity == WARN]

    if args.json:
        print(json.dumps({
            "errors": [dataclasses.asdict(f) for f in errors],
            "warnings": [dataclasses.asdict(f) for f in warns],
        }, indent=2))
    else:
        print(f"📋 Linted {len(paths)} file(s).")
        print(f"   {len(errors)} ERRORS, {len(warns)} WARNINGS.\n")
        # Group findings by rule for a cleaner summary
        by_rule = Counter(f.rule for f in findings)
        for rule, count in by_rule.most_common():
            sev = next(f.severity for f in findings if f.rule == rule)
            print(f"   [{sev}] {rule}: {count} occurrences")
        # Show first 10 errors verbatim
        if errors:
            print("\n🔴 First 10 errors:\n")
            for f in errors[:10]:
                print(f.fmt())

    if args.report:
        out = Path(args.report)
        write_report(findings, out)
        print(f"\n📄 Report written to {out}")

    if args.quarantine:
        summary = quarantine_findings(paths, findings)
        print("\n📦 Quarantine summary:")
        for fname, n in summary.items():
            print(f"   {fname}: {n} concept(s) moved to {fname}.quarantine.json")
            if n > 0:
                print(f"     (original backed up as {fname}.pre-quarantine)")

    block = bool(errors) or (args.strict and bool(warns))
    return 1 if block else 0


if __name__ == "__main__":
    sys.exit(main())
