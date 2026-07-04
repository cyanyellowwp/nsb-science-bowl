# NSB Resources

Source materials for generating question banks. Files here are **gitignored** (too large for git) — keep them locally only.

## Folder layout

| Folder | What goes here |
|---|---|
| `textbooks/` | Reference PDFs — Biology, Chemistry, Physics, Earth Science, Astronomy, etc. |
| `images/` | Diagrams, figures, charts referenced in questions |
| `practice-tests/` | Past NSB official practice exams, regional/invitational packets |

## Textbooks available (from NSB-Resources Drive folder)

| File | Subject | Size |
|---|---|---|
| `Biology.pdf` | Biology | 352 MB |
| `Physiology.pdf` | Biology / Physiology | 431 MB |
| `Chemistry.pdf` | Chemistry | 206 MB |
| `Zumdahl Chem 11th edition.pdf` | Chemistry | 98 MB |
| `Conceptual physics.pdf` | Physics | 49 MB |
| `Giancoli Physics.pdf` | Physics | 56 MB |
| `Physics2e.pdf` | Physics | 267 MB |
| `Astronomy 2e.pdf` | Earth & Space | 156 MB |
| `Foundations of Astronomy.pdf` | Earth & Space | 223 MB |
| `Geology.pdf` | Earth Science | 249 MB |
| `Tarbuck.pdf` | Earth Science | 207 MB |

## How these are used

Drop files into the appropriate subfolder. Claude / Codex can then:
1. Read specific chapters/pages from textbooks to generate NSB-style questions
2. Extract diagrams from `images/` for visual question variants
3. Parse past practice tests to build a validated question bank

Generated questions go into `../corpus-<source>.json` at the repo root.
