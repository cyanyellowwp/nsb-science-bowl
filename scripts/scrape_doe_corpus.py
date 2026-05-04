#!/usr/bin/env python3
"""Scrape the DOE NSB Middle School sample question bank.

Two-pass parser:
  1. Pre-clean — strip page footers, round headers, pronunciation guides,
     and other PDF artifacts globally before parsing.
  2. Atomic blocks — split the text on TOSS-UP / BONUS markers so each
     question is a self-contained block. If a block is malformed it gets
     skipped, never slurped into the next question.

Output: corpus-doe.json (v2 schema). Every emitted entry must pass the
content linter (scripts/lint_questions.py) — the scraper validates internally
before adding.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Optional, Tuple, List, Dict

import pypdf

BASE = "https://science.osti.gov"

# Curated selection of past-year sample sets. Keep recent, well-formatted
# years (older sets use inconsistent layouts that need bespoke parsers).
PDFS = [
    # 2022 (Set 16) — older format; parser may yield 0
    ("2022", "Set-16", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-16/2022-MS-1.pdf"),
    ("2022", "Set-16", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-16/2022-MS-3.pdf"),
    ("2022", "Set-16", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-16/2022-MS-5.pdf"),
    ("2022", "Set-16", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-16/2022-MS-7.pdf"),
    ("2022", "Set-16", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-16/2022-MS-9.pdf"),
    # 2021 (Set 15)
    ("2021", "Set-15", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-15/Set-1-MS-2021.pdf"),
    ("2021", "Set-15", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-15/Set-3-MS-2021.pdf"),
    ("2021", "Set-15", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-15/Set-5-MS-2021.pdf"),
    # 2020 (Set 14)
    ("2020", "Set-14", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-14/2020-MS-Rd1.pdf"),
    ("2020", "Set-14", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-14/2020-MS-Rd5.pdf"),
    ("2020", "Set-14", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-14/2020-MS-Rd9.pdf"),
    # 2019 (Set 13)
    ("2019", "Set-13", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-13/2019-NSB-MSR-Round-1A.pdf"),
    ("2019", "Set-13", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-13/2019-NSB-MSR-Round-5A.pdf"),
    ("2019", "Set-13", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-13/2019-NSB-MSR-Round-9A.pdf"),
    # 2018 (Set 12)
    ("2018", "Set-12", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-12/MSRound-1.pdf"),
    ("2018", "Set-12", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-12/MSRound-5.pdf"),
    ("2018", "Set-12", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-12/MSRound-9.pdf"),
    # 2017 (Set 11)
    ("2017", "Set-11", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-set-11/MS_1.pdf"),
    ("2017", "Set-11", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-set-11/MS_5A.pdf"),
    ("2017", "Set-11", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-set-11/MS_9A.pdf"),
    ("2017", "Set-11", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-set-11/MS_13A.pdf"),
    # 2016 (Set 10)
    ("2016", "Set-10", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-10/1A_MS_Reg_2016.pdf"),
    ("2016", "Set-10", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-10/5A_MS_Reg_2016.pdf"),
    ("2016", "Set-10", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-10/9A_MS_Reg_2016.pdf"),
    ("2016", "Set-10", "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-10/13A_MS_Reg_2016.pdf"),
    # 2015 (Set 9)
    ("2015", "Set-9",  "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-9/RegionalMS_1.pdf"),
    ("2015", "Set-9",  "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-9/RegionalMS_5A.pdf"),
    ("2015", "Set-9",  "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-9/RegionalMS_9A.pdf"),
    ("2015", "Set-9",  "/-/media/wdts/nsb/pdf/MS-Sample-Questions/Sample-Set-9/RegionalMS_13A.pdf"),
]

CACHE_DIR = Path("/tmp/doe-nsb-cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

KEEP_CATEGORIES = {"Life Science", "Physical Science"}

# Topics → concept ids (heuristic content tagging for known Campbell Ch 1-2 themes)
CONCEPT_RULES = [
    ("levels-of-organization", ["organization", "hierarchy", "level"]),
    ("emergent-properties", ["emergent", "emerge"]),
    ("darwin-natural-selection", ["darwin", "natural selection"]),
    ("inductive-deductive-reasoning", ["inductive", "deductive"]),
    ("controlled-experiment", ["control group", "controlled experiment", "independent variable", "dependent variable"]),
    ("homeostasis", ["homeostasis", "internal environment"]),
    ("evidence-for-evolution", ["fossil record", "common ancestor", "comparative anatomy", "vestigial"]),
    ("elements-of-life", ["oxygen, carbon, hydrogen", "primary elements"]),
    ("isotopes", ["isotope", "neutron"]),
    ("electron-shells", ["valence shell", "electron shell"]),
    ("covalent-bond", ["covalent"]),
    ("electronegativity", ["electronegativ"]),
    ("ionic-bond", ["ionic bond"]),
    ("hydrogen-bond", ["hydrogen bond"]),
    ("chemical-reactions", ["chemical reaction", "reactant", "product"]),
    ("population", ["population", "species"]),
    ("subatomic-particles", ["proton", "neutron", "electron", "subatomic"]),
    ("noble-gases", ["noble gas", "inert"]),
    ("adaptation", ["adaptation", "wallace"]),
    ("biodiversity", ["biodiversity", "diversity of life"]),
]

# ---------- Pre-clean: strip PDF artifacts globally before parsing ----------

PAGE_FOOTER_PATTERNS = [
    # Multi-line: "01-29-2026 Page N \n 2019 Regional Science Bowl – Round X Page N"
    re.compile(r"\d{2,4}[-/]\d{1,2}[-/]\d{2,4}\s*Page\s+\d+", re.I),
    re.compile(r"\d{4}\s+(?:Regional\s+)?(?:NSB\s+)?Science\s+Bowl\b[^\n]*?Page\s+\d+", re.I),
    re.compile(r"~+\s*Page\s+\d+(?:\s+of\s+\d+)?", re.I),
    re.compile(r"^\s*Page\s+\d+(?:\s+of\s+\d+)?\s*$", re.I | re.M),
    # Lone "Round NA" header that sometimes leaks across pages (e.g., "Round 9A ~ Page 6")
    re.compile(r"\bRound\s+\d+[A-Z]?\s*~\s*Page\s+\d+", re.I),
]

PRONUNCIATION_GUIDE = re.compile(r"\[[^\]]+\]")

# ~~~~~ separator between Q-pairs in some sets
PAIR_SEPARATOR = re.compile(r"^\s*~+\s*$", re.M)


def pre_clean(text: str) -> str:
    """Strip page footers, headers, pronunciation guides, and normalize whitespace."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for pat in PAGE_FOOTER_PATTERNS:
        text = pat.sub(" ", text)
    text = PRONUNCIATION_GUIDE.sub("", text)
    # Collapse any run of 3+ newlines to 2 (preserves paragraph structure but drops noise)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


# ---------- Atomic block splitting ----------

# A "block start" is the beginning of a TOSS-UP or BONUS section. We split
# the document at every such marker — guaranteeing each question lives in
# its own block.
BLOCK_START = re.compile(r"^\s*(TOSS-UP|BONUS)\s*$", re.M | re.I)


def split_into_blocks(text: str) -> list[tuple[str, str]]:
    """Split text into [(kind, block_text), ...] pairs, where kind ∈ {TOSS-UP, BONUS}.

    Each block runs from one TOSS-UP/BONUS marker to the next (or end of text).
    No question can span multiple blocks; a malformed block gets skipped, not
    slurped.
    """
    matches = list(BLOCK_START.finditer(text))
    if not matches:
        return []
    blocks = []
    for i, m in enumerate(matches):
        kind = m.group(1).upper().replace(" ", "-")
        # Block content starts immediately AFTER the marker line and runs to
        # the next marker (or end of text).
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block_text = text[start:end].strip()
        if block_text:
            blocks.append((kind, block_text))
    return blocks


# ---------- Per-block parser ----------

# Within a block, expect:
#   N) <Category> – <Type>    <body...>    ANSWER: <answer>
# where N is the question number, category ∈ KEEP_CATEGORIES (or others we skip),
# type ∈ {Short Answer, Multiple Choice}.
# Allow OCR variants: ANSWER, ANWER, ANSER.

BLOCK_HEADER = re.compile(
    r"^\s*(?P<num>\d+)\)\s*"
    r"(?P<category>Life Science|Earth and Space|Math|Energy|Physical Science)"
    r"\s*[–\-—]+\s*"
    r"(?P<qtype>Short Answer|Multiple Choice)\s+",
    re.I,
)

ANSWER_MARKER = re.compile(r"\b(ANSWER|ANWER|ANSER|ANSWE)\s*:\s*", re.I)

MAX_BODY_CHARS = 800       # sanity bound — real questions never exceed this
MAX_ANSWER_CHARS = 250


def parse_block(block: str, kind: str, source_meta: dict) -> dict | None:
    """Parse a single TOSS-UP or BONUS block. Returns None if malformed."""
    m = BLOCK_HEADER.match(block)
    if not m:
        return None
    category = m.group("category").strip()
    if category not in KEEP_CATEGORIES:
        return None
    qtype_raw = m.group("qtype").lower()
    qtype = "multiple_choice" if "multiple" in qtype_raw else "short_answer"

    rest = block[m.end():]
    # Find the answer marker — there should be exactly one in a clean block
    am = ANSWER_MARKER.search(rest)
    if not am:
        return None  # missing answer; skip rather than slurp

    body = rest[:am.start()].strip()
    answer = rest[am.end():].strip()

    # Hard length bounds — anything past these is almost certainly two
    # questions concatenated or a parsing failure.
    if len(body) > MAX_BODY_CHARS or len(body) < 15:
        return None
    if len(answer) > MAX_ANSWER_CHARS or not answer:
        # Try to repair: maybe answer has a trailing block we can trim
        answer = answer[:MAX_ANSWER_CHARS]

    body = clean_body(body)
    answer = clean_answer(answer)

    if not body or not answer:
        return None

    item = {
        "kind": "tossup" if kind in ("TOSS-UP", "TOSSUP") else "bonus",
        "category": category,
        "type": qtype,
        "question": body,
        "answer": answer,
        "source": source_meta,
    }

    if qtype == "multiple_choice":
        letter, ans_text = parse_mc_answer(body, answer)
        if not letter:
            return None  # malformed MC — skip
        item["answer"] = letter
        if ans_text:
            item["answer_text"] = ans_text

    return item


def clean_body(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    # Strip any trailing "ANSWER:" residue (paranoia — should already be cut)
    s = re.split(r"\b(?:ANSWER|ANWER|ANSER)\s*:", s, flags=re.I, maxsplit=1)[0].strip()
    return s


def clean_answer(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    # Cut off at the next obvious section boundary
    s = re.split(r"\b(?:TOSS[\s\-]*UP|BONUS)\b", s, flags=re.I, maxsplit=1)[0].strip()
    # Strip page artifacts that may have re-leaked despite pre-clean
    s = re.sub(
        r"(?:Round\s+\d+[A-Z]?|~+\s*Page\s+\d+|Page\s+\d+(?:\s+of\s+\d+)?|\d{4}\s+Regional[^,)]*)",
        "",
        s,
        flags=re.I,
    ).strip()
    # Trim trailing punctuation that's now orphaned
    s = re.sub(r"[\s,;:]+$", "", s)
    return s


MC_LETTER_LINE = re.compile(r"\b([WXYZ])\)\s*([^\n]+?)(?=\s*\b[WXYZ]\)|$)", re.I)


def parse_mc_answer(question_text: str, raw_answer: str) -> tuple[str | None, str | None]:
    """Given a question containing W/X/Y/Z options and the raw answer text,
    return (letter, option_text). Skip if the answer doesn't start with one of W/X/Y/Z."""
    m = re.match(r"^\s*([WXYZ])(?:\)|\b)?\s*(.*)$", raw_answer, re.I)
    if not m:
        return None, None
    letter = m.group(1).upper()
    rest = m.group(2).strip(" )-,.")
    # Look up the option text from the question for the matching letter
    options = {L.upper(): T.strip() for L, T in MC_LETTER_LINE.findall(question_text)}
    text = options.get(letter, rest)
    return letter, text


def parse_questions(text: str, source_meta: dict) -> list[dict]:
    """Parse the entire PDF text into a list of question items."""
    text = pre_clean(text)
    blocks = split_into_blocks(text)
    out = []
    for kind, block in blocks:
        item = parse_block(block, kind, source_meta)
        if item:
            out.append(item)
    return out


# ---------- Concept tagging ----------

def assign_concept(item: dict) -> str | None:
    t = (item["question"] + " " + item["answer"]).lower()
    for cid, keywords in CONCEPT_RULES:
        for kw in keywords:
            if kw in t:
                return cid
    return None


# ---------- Internal lint (gate before emit) ----------

ANSWER_LEAKAGE = re.compile(r"\b(?:ANSWER|ANWER|ANSER|ANSWE)\s*:", re.I)
QUESTION_MARKERS = re.compile(r"\b(?:TOSS[\s\-]*UP|BONUS)\s+\d+\)?", re.I)
PDF_PAGE = re.compile(r"(?:Round\s+\d+[A-Z]?|~+\s*Page\s+\d+|Page\s+\d+(?:\s+of\s+\d+)?)", re.I)


def is_clean(item: dict) -> bool:
    """Last-line defense: never emit an item that would fail the linter."""
    body = item["question"]
    answer = item["answer"]
    if ANSWER_LEAKAGE.search(body): return False
    if QUESTION_MARKERS.search(body): return False
    if PDF_PAGE.search(body) or PDF_PAGE.search(answer): return False
    if "undefined" in answer.lower() or "undefined" in body.lower(): return False
    if item["type"] == "multiple_choice":
        for letter in "WXYZ":
            if not re.search(rf"\b{letter}\)", body):
                return False
        if (item.get("answer") or "").strip().upper() not in {"W", "X", "Y", "Z"}:
            return False
    return True


# ---------- Fetching + extraction ----------

def fetch(url: str) -> Path:
    name = url.split("/")[-1]
    cache_path = CACHE_DIR / name
    if cache_path.exists() and cache_path.stat().st_size > 0:
        return cache_path
    print(f"  fetching {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 NSB-corpus-builder"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        cache_path.write_bytes(resp.read())
    return cache_path


def extract_pdf_text(path: Path) -> str:
    reader = pypdf.PdfReader(str(path))
    return "\n".join(p.extract_text() or "" for p in reader.pages)


# ---------- Main pipeline ----------

def main() -> int:
    print(f"Fetching {len(PDFS)} PDFs...", file=sys.stderr)
    raw_questions = []
    rejected_count = 0

    for year, set_name, path in PDFS:
        try:
            local = fetch(BASE + path)
            text = extract_pdf_text(local)
            src = {
                "kind": "doe-nsb-ms",
                "year": year,
                "set": set_name,
                "round_pdf": path.split("/")[-1],
                "url": BASE + path,
            }
            qs = parse_questions(text, src)
            # Internal lint — drop anything that wouldn't pass the linter
            clean = []
            for q in qs:
                if is_clean(q):
                    clean.append(q)
                else:
                    rejected_count += 1
            print(f"  {set_name}/{path.split('/')[-1]}: {len(clean)} clean ({len(qs) - len(clean)} rejected)", file=sys.stderr)
            raw_questions.extend(clean)
        except Exception as e:
            print(f"  ERR fetching/parsing {path}: {e}", file=sys.stderr)

    # Group toss-ups + bonuses into pairs by source PDF (consecutive in the file)
    pairs = []
    seen_pairs = set()
    by_src: dict[str, list[dict]] = {}
    for q in raw_questions:
        by_src.setdefault(q["source"]["round_pdf"], []).append(q)

    for src_key, items in by_src.items():
        i = 0
        while i < len(items):
            q = items[i]
            if q["kind"] == "tossup":
                bonus = None
                for j in range(i + 1, min(i + 3, len(items))):
                    if items[j]["kind"] == "bonus":
                        bonus = items[j]
                        break
                if bonus:
                    pair_key = (q["question"][:60], bonus["question"][:60])
                    if pair_key not in seen_pairs:
                        pairs.append((q, bonus))
                        seen_pairs.add(pair_key)
                    i += 2
                    continue
            i += 1

    # Emit v2-shaped concepts
    concepts = []
    cat_map = {"Life Science": "Biology - General", "Physical Science": "Chemistry - General"}
    subj_map = {"Life Science": "biology", "Physical Science": "physical_science"}

    for idx, (tu, bo) in enumerate(pairs):
        concept_id = assign_concept(tu) or f"doe-{tu['source']['year']}-{idx + 1:03d}"
        category = cat_map.get(tu["category"], tu["category"])
        subject = subj_map.get(tu["category"], "other")

        tu_v = {"id": f"tu-{concept_id}-{idx}", "type": tu["type"], "question": tu["question"], "answer": tu["answer"]}
        if "answer_text" in tu:
            tu_v["answer_text"] = tu["answer_text"]
        bo_v = {"id": f"bo-{concept_id}-{idx}", "type": bo["type"], "question": bo["question"], "answer": bo["answer"]}
        if "answer_text" in bo:
            bo_v["answer_text"] = bo["answer_text"]

        concepts.append({
            "id": f"{concept_id}-doe-{idx}",
            "category": category,
            "subcategory": tu["category"],
            "subject": subject,
            "tags": ["doe-corpus", tu["source"]["year"], "ms-nsb", subject],
            "source": tu["source"],
            "tossup_variants": [tu_v],
            "bonus_variants": [bo_v],
        })

    out = {
        "schema_version": "2.0",
        "source": "U.S. DOE National Science Bowl Middle School Sample Question Bank",
        "audience": "middle_school_nsb",
        "license": "U.S. Government work product, public domain",
        "url": "https://science.osti.gov/wdts/nsb/Regional-Competitions/Resources/MS-Sample-Questions",
        "scraped_at": "2026-05-04",
        "categories": ["Biology - General", "Chemistry - General"],
        "concepts": concepts,
    }
    print(f"\nTotal: {len(concepts)} clean round-pairs (rejected {rejected_count} malformed parses)", file=sys.stderr)

    out_path = Path(__file__).parent.parent / "corpus-doe.json"
    out_path.write_text(json.dumps(out, indent=2))
    print(f"Wrote {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
