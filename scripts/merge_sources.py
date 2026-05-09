#!/usr/bin/env python3
"""Merge multiple question-source JSON files into one corpus file.

Usage:
  python3 scripts/merge_sources.py \
    --out corpus-imported.json \
    path/to/source-a.json path/to/source-b.json

Input schema expected: v2-style { concepts: [...] }.
Each concept should include tossup_variants + bonus_variants.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def infer_subject(concept: dict[str, Any]) -> str:
    if concept.get("subject") in {"biology", "physical_science"}:
        return concept["subject"]
    hay = f"{concept.get('category', '')} {' '.join(concept.get('tags', []))}".lower()
    return "physical_science" if "physical" in hay else "biology"


def stable_key(concept: dict[str, Any]) -> str:
    core = {
        "category": concept.get("category", ""),
        "tossup": [v.get("question", "").strip() for v in concept.get("tossup_variants", [])],
        "bonus": [v.get("question", "").strip() for v in concept.get("bonus_variants", [])],
    }
    blob = json.dumps(core, sort_keys=True, ensure_ascii=True)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def load(path: Path) -> list[dict[str, Any]]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    concepts = doc.get("concepts", [])
    if not isinstance(concepts, list):
        return []
    out = []
    for c in concepts:
        if not c.get("tossup_variants") or not c.get("bonus_variants"):
            continue
        c = dict(c)
        c["subject"] = infer_subject(c)
        out.append(c)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="corpus-imported.json")
    ap.add_argument("inputs", nargs="+")
    args = ap.parse_args()

    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for p in args.inputs:
        path = Path(p)
        for c in load(path):
            k = stable_key(c)
            if k in seen:
                continue
            seen.add(k)
            if not c.get("id"):
                c["id"] = f"merged-{k[:12]}"
            merged.append(c)

    out_doc = {
        "schema_version": "2.0",
        "source": "merged-import",
        "generated_by": "scripts/merge_sources.py",
        "concepts": merged,
    }
    Path(args.out).write_text(json.dumps(out_doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {args.out} with {len(merged)} concepts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
