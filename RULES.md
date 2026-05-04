# Science Bowl Rules — Grounding Document

This document captures the **National Science Bowl (NSB)** competition format that this app aims to reproduce. The app's game logic conforms to this document; when the two disagree, **this document is the source of truth** and the app is updated.

> **Source:** 2026 National Science Bowl® Official Academic Competition Rules (DOE Office of Science, dated 01-29-2026). All rule citations below (e.g., "Rule 5-2") refer to that document.
> PDF: <https://science.osti.gov/-/media/wdts/nsb/pdf/NSB-Resources/Rules2026.pdf>
> Index: <https://science.osti.gov/wdts/nsb/Regional-Competitions/Resources>

This file was last cross-checked against the 2026 rulebook on 2026-05-02. If a newer rulebook is published, re-cross-check before competition use.

---

## 1. Match structure

| Element | Rule | Detail |
|---|---|---|
| Team size | 1-1 | 4 or 5 student members per team. Only **4 play at any time**; the 5th is a substitute. |
| Officials | — | Moderator, scorekeeper, timekeeper, recognizer (may be one person). |
| Regional match length | 5-1 | **Two 8-minute halves** with a **2-minute break**. Each half begins with a toss-up. |
| Nationals match length | 5-1 | **Two 10-minute halves** (12-min for visual-bonus rounds). |
| Substitutions | 8-1 | Only between halves or before tiebreakers. Captain may also be switched then. |
| Tournament structure | 2-1, 2-2 | Regionals: organizer's choice (round robin, single/double elim). Nationals: 8-division round robin → top 4 per division → 32-team double elim. |

**This app:** Uses a simpler **fixed-25-round** structure for practice. Time-keeper logic and halves are not implemented (deliberate scope cut for v1).

---

## 2. Question pair (toss-up + bonus)

Each round consists of:

1. **Toss-up question** — read first, open to both teams (Rule 3-1).
2. **Bonus question** — read **only** if the toss-up was answered correctly. The team that answered the toss-up correctly gets the bonus; the other team is **ineligible** (Rules 3-1, 5-4).

**Rule 3-2:** No team will have more than one opportunity to answer a toss-up. If neither team answers a toss-up correctly, the moderator proceeds to the next toss-up — **no bonus is played**.

**Rule 3-4:** Once read in its entirety, a question will not be re-read (exception: interrupt penalty causes a re-read; see §5).

---

## 3. Toss-up rules

| Rule | Citation | Detail |
|---|---|---|
| **Point value** | 6-1 | **+4 points** for a correct answer. |
| **Subject area must be read first** | 3-5 | No player may buzz in until AFTER the moderator has identified the subject area. Buzz before subject = invalid; moderator may add time back. |
| **Buzz wins recognition** | 3-5 | First player to buzz earns the right to answer. Player must be **verbally recognized** by their designation (e.g., "A-2", "B-captain") before answering (Rule 4-1). |
| **Conferring** | 3-1, 4-2 | **Non-verbal communication IS allowed** (writing, hand signals). **Audible verbal communication, mouthing words, and audible signals (tapping) are forbidden** — violation forfeits the question. |
| **Buzz window** | 5-2 | **5 seconds** from the moment the moderator finishes reading the question (including all multiple-choice options). |
| **Time to answer after recognition** | 5-3 | After being recognized, player must answer within a **natural pause (up to 2 seconds)**. Stalling = treated as wrong answer. |
| **Multiple-choice answer form** | 3-3 | Either the letter (W, X, Y, Z) **or** the verbal answer. If the player gives both, both must be correct. |
| **First response counts** | 3-7 | Only the first response given counts. Prefacing remarks like "my answer is" or repeating the question = delaying = wrong. Brief "um"/"er" is acceptable. |
| **Wrong (non-interrupt) → other team free shot** | 3-8 | If the question was completely read and the first team answers wrong, the other team gets **5 seconds to buzz in** with no penalty. The question is **not** re-read. |
| **Both miss** | 3-2 | Reveal answer. **No bonus is played.** Move to next toss-up. |

---

## 4. Bonus rules

| Rule | Citation | Detail |
|---|---|---|
| **Point value** | 6-1 | **+10 points** for a correct answer. |
| **Eligibility** | 3-1 | Only the team that **correctly answered the preceding toss-up** plays. |
| **Conferring** | 3-1, 4-2 | **Both verbal and non-verbal communication allowed** during the time window. |
| **Captain answers (strict)** | 3-9 | The official answer **must come from the team captain**. The moderator **must ignore** any answer from a non-captain. |
| **Time to answer** | 5-4, 5-5 | **20 seconds** from when the moderator finishes reading. Timekeeper announces "**5 SECONDS**" at the 15-second mark and "**TIME**" at 20 seconds. |
| **Begun-before-time-out** | 5-5 | If captain has begun the answer before "TIME", they may complete without stalling. |
| **Missed bonus** | (implicit) | No points. Opposing team **does not** get a chance. Move to next toss-up. |
| **Visual bonus (Nationals)** | 5-4 | 30 seconds instead of 20; "5 SECONDS" warning at 25s. |

---

## 5. Interrupt penalty (Rule 6-2 — single most important penalty)

An **interrupt** = a player buzzes in **before the moderator has completely read the question**.

| Outcome | Result |
|---|---|
| Interrupt + correct answer | **+4 points** to the buzzing team. Bonus follows. (Same as a normal correct toss-up.) |
| Interrupt + incorrect, blurt, or audible communication | **+4 points to the OPPOSING team.** The question is **re-read in its entirety** to the opposing team (if still eligible), who gets a chance to answer it for **another +4**, and if correct, the bonus. |

> **Important correction:** The penalty is **+4 to the opponent**, NOT −4 from the offending team. NSB scores never decrease.

### 5.1 Double-interrupt (Rule 6-3)

If team A interrupts and is penalized (+4 to team B), and during the re-read team B *also* interrupts and is penalized:
- **+4 to team A.**
- Moderator skips to the next toss-up (no further re-read).
- This is the **only** situation in which both teams gain points on a single question.

---

## 6. Question formats

### 6.1 Multiple choice (Rule 3-3)

Read aloud as:

> *"[Subject]. [Question stem]? W) [option 1]; X) [option 2]; Y) [option 3]; Z) [option 4]."*

- Valid answers: **W, X, Y, Z** (never A/B/C/D), or the exact verbal text of the option.
- For mathematical expressions, common alternates accepted (e.g., "square root of 2" = "square root 2"; "sine x" = "sine of x").
- If multiple options are equally correct, any of them is accepted.
- If all options are equally incorrect, the question is discarded.

### 6.2 Short answer (Rule 3-3, Appendix A-2)

Player gives the answer verbatim or in a substantively equivalent form, subject to detailed conventions (numerical form, simplest form, irrationals exact, IUPAC chemical naming, etc.). See Appendix A-1, A-2 of the rulebook for the full list.

---

## 7. Categories (Rule 3-1)

Both middle school and high school NSB use these six categories:

- **Biology**
- **Chemistry**
- **Earth and Space Science**
- **Energy**
- **Mathematics**
- **Physics**

**This app currently scopes to:** Biology only, sourced from **Campbell Biology Ch. 1–2** (themes, evolution, scientific inquiry, atomic chemistry, bonding).

---

## 8. Behavior rules (selected)

| Rule | Citation | Detail |
|---|---|---|
| Blurt (answer without recognition) | 4-1 | No points awarded; team disqualified from this toss-up; question offered to opposing team (re-read if not yet fully read). |
| Audible verbal communication | 4-2 | Treated as a blurt — team forfeits the question. |
| Distraction by non-playing team | 3-10 | Opposing team awarded the question's full points (4 for toss-up + bonus opportunity, or 10 for bonus). One "accidental" buzz per game per team is permitted. |
| Notes / electronic devices | 8-4, 8-5 | No notes, calculators, periodic tables, phones, etc. Scratch paper provided. |
| Audience interference | 8-2 | If audience shouts an answer and is identifiable as associated with a team, that team forfeits. |

---

## 9. Challenges (Rule 7 — summary)

Teams may challenge:
- **Scientific content** (whether an answer is scientifically correct).
- **Rule administration** (whether a rule was correctly applied).

Teams **may not** challenge **judgment calls** — including whether a question was interrupted, whether 5/20 seconds elapsed, whether a stall/blurt occurred, etc. (Rule 7-2 lists ~15 specific judgment calls.)

- Limit: **2 unsuccessful scientific challenges per team per round** (Rule 7-3).
- Must be raised before the next question's subject area is read (Rule 7-1).

---

## 10. Tiebreakers (Rule 6-4)

For elimination games tied at the end:
- **5-toss-up tiebreaker match.** All normal toss-up rules apply. **No bonuses, no game clock.**
- If still tied: additional 5-question rounds until broken.

For round-robin advancement: head-to-head record first, then 5-question tiebreaker (2 teams) or simultaneous 5-question test (3+ teams). At round-robin tiebreakers: **no interrupt penalties** (Rules 9-1(iii), 10-2(iii)).

---

## 11. Question writing conventions (NSB-MS calibrated)

These conventions were calibrated against the [official 2019 DOE NSB Middle School sample bank](https://science.osti.gov/wdts/nsb/Regional-Competitions/Resources/MS-Sample-Questions). All questions in `questions.json` must conform.

### 11.1 Style rules — middle school audience

| Rule | Rationale |
|---|---|
| **Word count: 15–22 per question** (hard cap 25) | NSB-MS Round 1A 2019 averaged 17 words. Long questions punish reading speed, not science knowledge. |
| **No formal connectives** | "whereby", "thereby", "wherein", "thereof", "whence" — none appear in NSB-MS. Use plain English: "in which", "where", "that". |
| **At most one nested subordinate clause** | Long subject–verb distance forces re-reading. The kid loses the buzzer race for the wrong reason. |
| **Technical jargon belongs in the answer, not the stem** | A toss-up about "homologous structures" should not have "transient asymmetries" or "aqueous biological context" in the stem. |
| **Use textbook-standard middle school vocabulary** | "Levels of biological organization" not "biological hierarchy". "Living and non-living components" not "biotic and abiotic". |
| **Don't reference the textbook** | NSB never says "as emphasized in Campbell". Strip textbook-specific framing. |
| **Anchor abstract concepts with concrete examples** | "such as sneezing or blinking" or "like the forelimbs of humans, cats, and bats". Mirrors NSB-MS pattern. |
| **Avoid recursive definitions** | Don't define "property" using "property". Pick a different framing. |

### 11.2 Format conventions

- **Multiple choice:** 4 options labeled `W, X, Y, Z` (never A/B/C/D). Stem ends with a clear interrogative. One unambiguous best answer.
- **Short answer:** elicits a single term, name, number, or short phrase. "accept:" alternates listed in parentheses where reasonable variants exist.
- **Difficulty curve:** Toss-ups generally easier than bonuses. Bonuses may be multi-part ("Name all three…").
- **Source-grounded:** every question must be answerable from cited source material (currently Campbell Bio Ch. 1–2).
- **Subject prefix in real NSB:** the moderator reads "Biology — Multiple Choice —" before each question. The app shows category in the UI rather than reading it; this is acceptable.

### 11.3 Reference: real NSB-MS phrasing

Five toss-ups from 2019 Round 1A, life science:
1. *"What is the term for chemicals that are used to transmit impulses from one neuron to another?"* (17 words)
2. *"What is the term for the point on a stem at which a leaf is attached?"* (16 words)
3. *"What is the term for an automatic response to a stimulus, such as sneezing or blinking?"* (17 words)
4. *"What region in the eukaryotic nucleus is the site of initial rRNA synthesis?"* (12 words, bonus)
5. *"Satellites that stay above the same spot on Earth while in orbit are in what type of orbit?"* (17 words)

The pattern: **"What is the term for [direct, concrete description, often with examples]?"**

### 11.4 Question bank schema (v2.0)

`questions.json` uses a concept + variants structure:

```json
{
  "schema_version": "2.0",
  "concepts": [
    {
      "id": "emergent-properties",
      "category": "Biology - General",
      "subcategory": "Themes / Hierarchy",
      "tags": ["ch1", "themes", "organization"],
      "tossup_variants": [
        { "id": "tu-emp-1", "type": "short_answer", "question": "...", "answer": "..." }
      ],
      "bonus_variants": [
        { "id": "bo-emp-1", "type": "multiple_choice", "question": "...", "answer": "X", "answer_text": "..." }
      ]
    }
  ]
}
```

Each concept can grow multiple variants (different phrasings of the same underlying idea). The app currently picks the first variant of each concept; future work: randomize across variants for spaced practice.

---

## 12. App compliance matrix

✅ = matches rule | ⚠️ = partial / simplified | ❌ = not implemented (gap)

| Rule | Citation | App status | Notes |
|---|---|---|---|
| Toss-up = 4 pts | 6-1 | ✅ | `TOSSUP_POINTS = 4` |
| Bonus = 10 pts | 6-1 | ✅ | `BONUS_POINTS = 10` |
| Toss-up buzz window = 5 sec | 5-2 | ⚠️ | Implemented as 5 sec, but starts on "Read" click — not "after read finishes." Need a "✓ Done reading" moderator button. |
| Bonus = 20 sec | 5-4 | ✅ | `BONUS_SECONDS = 20` |
| 5-second warning on bonus | 5-5 | ❌ | No "5 SECONDS" callout at 15s. |
| Bonus only to TU winner | 3-1 | ✅ | `state.tossupOwner` gates bonus. |
| Wrong TU (post-read) → other team free shot | 3-8 | ✅ | `onIncorrect` re-prompts opposing team (no clock implemented for the free shot — should be 5 sec). |
| Both miss TU → no bonus | 3-2 | ✅ | Reveal + advance. |
| Wrong bonus → no rebound | (3-1) | ✅ | Bonus is closed after one attempt. |
| **Interrupt penalty: +4 to opponent + re-read** | **6-2** | ❌ | **Major gap.** App doesn't distinguish during-read vs after-read. Adding requires moderator-controlled "Done reading" signal. |
| **Double-interrupt rule** | 6-3 | ❌ | Tied to interrupt penalty. |
| Subject area must be read first | 3-5 | ❌ | App treats whole question as one block. |
| Captain-only bonus answer | 3-9 | ❌ | App accepts moderator's judgment regardless of speaker. |
| Non-verbal conferring allowed on TU | 3-1, 4-2 | ⚠️ | Not modeled — moderator's judgment. (App can't observe team behavior anyway.) |
| Natural-pause stall rule (≤2s after recognition) | 5-3 | ❌ | Not modeled. |
| Multi-choice: letter or verbal | 3-3 | ✅ (LLM) / ⚠️ (rule) | When LLM judge is enabled, both forms accepted with semantic matching. Rule-based mode accepts the letter only. |
| Distraction by non-playing team | 3-10 | ❌ | Not modeled. |
| Challenges | 7 | ❌ | Not modeled (would need a "Challenge" button + dispute UI). |
| Tiebreaker (5-Q match) | 6-4 | ❌ | Match ends in tie on results screen. |
| Two 8-min halves vs fixed Q count | 5-1 | ❌ (by design) | App uses 25 rounds for practice simplicity. |

---

## 13. LLM Judge (added 2026-05-02)

The app now supports an optional **LLM-based answer judge** powered by Claude (Haiku 4.5 / Sonnet 4.6 / Opus 4.7). It runs alongside the rule-based judge and uses 8 anti-hallucination guardrails:

1. **Strict JSON schema validation** — invalid response falls back to rule-based.
2. **Anti-hallucination system prompt** — judge is forbidden from using external knowledge; must use only the canonical answer provided.
3. **Temperature 0** — deterministic outputs.
4. **Cross-check with rule-based judge** — both run; agreement boosts confidence, disagreement flags for human review.
5. **Confidence threshold 0.7** — verdicts below threshold are downgraded to "needs review", not "correct".
6. **Multi-part requirement** — system prompt enforces all components for "name all three" / "list four" answers; no partial credit.
7. **MC letter integrity** — wrong W/X/Y/Z is wrong, even if student names a real concept.
8. **Audit trail** — reasoning shown to user with override buttons; every judgment is appealable.

The system prompt includes 10 calibration examples (synonym match, multi-part incomplete, wrong concept, MC letter, ambiguous transcription, true-but-off-target, outdated-classification anti-hallucination test).

API access: browser-direct to `api.anthropic.com` with `anthropic-dangerous-direct-browser-access: true`. User supplies their own key, stored in localStorage. **Personal use only — do not deploy with a shared key.**

## 14. Open decisions for user

- [ ] Add interrupt penalty + re-read flow (highest-impact NSB-rules gap; requires "Done reading" moderator button).
- [ ] Add 5-second bonus warning (audio beep or visual flash).
- [ ] Enforce captain designation per team (per Rule 3-9).
- [ ] Switch from 25-round fixed format to two 8-minute halves with proper clock.
- [ ] Add tiebreaker mode if scores end tied.
- [ ] Read subject area as a separate phase before the question body.
- [ ] Expand question bank to other NSB categories or other Campbell chapters.
- [ ] Move LLM API call behind a thin proxy server if this app is ever deployed beyond a single user.

---

## 15. Cross-check log

| Date | Source | Reviewer | Result |
|---|---|---|---|
| 2026-05-02 | Rules2026.pdf (DOE) | Claude (Opus 4.7) | Replaced earlier draft; corrected interrupt penalty (was −4, actually +4 to opponent), captain-only bonus rule (was "not enforced/optional", actually strict), conferring rules (non-verbal IS allowed on TU), added Rule 3-5 subject-area requirement, added double-interrupt (6-3), distraction (3-10), tiebreakers (6-4), challenge framework (7), and exact half timings (5-1). |

*This file should be re-cross-checked when DOE publishes updated rules. Edit the cross-check log above when re-verifying.*
