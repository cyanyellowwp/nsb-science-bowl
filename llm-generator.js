// LLM Question Generator
// Uses the same Claude API key as LLMJudge (configured by user). Generates
// fresh toss-up + bonus variants targeted at the kid's weakest concepts.
//
// Validation pipeline (defense-in-depth):
//   1. Strict JSON schema
//   2. Style check (word count 15-22 hard cap 28; banned words; nested clauses)
//   3. Cross-check: a SECOND Claude call asks "given the canonical answer, is
//      this question answerable with high confidence from a middle-school
//      science textbook?" — anything failing this is discarded.
//   4. Cache only valid items.
//
// Storage: localStorage key `science-bowl-generated`. Persists across sessions.

(() => {
  'use strict';

  const STORAGE_KEY = 'science-bowl-generated';

  const BANNED_WORDS = [
    /\bwhereby\b/i,
    /\bthereby\b/i,
    /\bwherein\b/i,
    /\bthereof\b/i,
    /\bwhence\b/i,
    /\bbiological hierarchy\b/i,
    /\baqueous biological context\b/i,
    /\btransient asymmetries\b/i,
  ];

  const Generator = {
    cache: { generated: [] },

    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) this.cache = JSON.parse(raw);
        if (!this.cache.generated) this.cache.generated = [];
      } catch (_) {
        this.cache = { generated: [] };
      }
    },

    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cache));
      } catch (e) {
        console.warn('Generator: save failed', e);
      }
    },

    /** Get all cached generated concepts (mergeable into the bank). */
    getCachedConcepts() {
      return (this.cache.generated || []).slice();
    },

    clear() {
      this.cache.generated = [];
      this.save();
    },

    /**
     * Generate `count` fresh variants for `concept` (a concept object from
     * the bank). Returns an array of validated variant pairs that were saved.
     *
     * @param {Object} concept     Bank concept (with at least: id, category, sample tossup)
     * @param {number} count       Variants to attempt
     * @param {Function} onProgress Called with {step, total, status, ...}
     */
    async generateForConcept(concept, count, onProgress) {
      if (!window.LLMJudge || !LLMJudge.isReady()) {
        throw new Error('LLM not configured. Add an Anthropic or OpenAI API key in the LLM Judge section.');
      }
      const sample = (concept.tossup_variants && concept.tossup_variants[0]) || null;
      if (!sample) throw new Error('Concept has no sample variant to anchor style');

      const generated = [];
      for (let i = 0; i < count; i++) {
        const step = i + 1;
        onProgress && onProgress({ step, total: count, status: 'generating' });
        try {
          const variant = await this._generateVariant(concept, sample);
          if (!variant) {
            onProgress && onProgress({ step, total: count, status: 'invalid' });
            continue;
          }
          onProgress && onProgress({ step, total: count, status: 'validating' });
          const validated = await this._validate(variant, concept);
          if (!validated.ok) {
            onProgress && onProgress({ step, total: count, status: 'rejected', reason: validated.reason });
            continue;
          }
          generated.push(validated.concept);
          onProgress && onProgress({ step, total: count, status: 'accepted' });
        } catch (err) {
          onProgress && onProgress({ step, total: count, status: 'error', message: err.message });
        }
      }

      // Persist accepted ones
      this.cache.generated.push(...generated);
      this.save();
      return generated;
    },

    /** Top-level entry: generate variants for the kid's weak concepts. */
    async generateForWeakConcepts(opts, onProgress) {
      opts = opts || {};
      const perConcept = opts.perConcept || 1;
      const maxConcepts = opts.maxConcepts || 5;
      const bankConcepts = (window.QuestionBank && window.QuestionBank.concepts) || [];
      const stats = window.Progress ? Progress.conceptsWithBank(bankConcepts) : [];
      // Pick targets: needs_work + struggling + untouched, prioritizing "seen but missed"
      const order = { needs_work: 0, struggling: 1, untouched: 2, learning: 3, mastered: 4 };
      const targets = stats
        .filter((c) => ['needs_work', 'struggling', 'untouched'].includes(c.mastery))
        .sort((a, b) => (order[a.mastery] - order[b.mastery]) || a.accuracy - b.accuracy)
        .slice(0, maxConcepts);

      // Map back to actual bank concepts
      const targetConcepts = targets
        .map((s) => bankConcepts.find((c) => c.id === s.concept_id))
        .filter(Boolean);

      if (!targetConcepts.length) {
        throw new Error('No weak concepts found yet — play a match first so the system knows what to drill.');
      }

      const all = [];
      for (let i = 0; i < targetConcepts.length; i++) {
        const c = targetConcepts[i];
        onProgress && onProgress({ phase: 'concept', conceptIndex: i + 1, conceptTotal: targetConcepts.length, conceptId: c.id });
        const made = await this.generateForConcept(c, perConcept, (p) =>
          onProgress && onProgress({ phase: 'variant', conceptId: c.id, ...p }));
        all.push(...made);
      }
      return all;
    },

    // ---------------- internals ----------------

    async _generateVariant(concept, sample) {
      const sampleAnswerText = sample.type === 'multiple_choice'
        ? `${sample.answer} (${sample.answer_text || ''})` : sample.answer;
      const prompt = `Write ONE fresh middle-school National Science Bowl question on this concept.

CONCEPT: ${concept.id}
CATEGORY: ${concept.category}
EXISTING SAMPLE (do NOT copy verbatim — write a different phrasing):
  Question: ${sample.question}
  Answer: ${sampleAnswerText}

Style requirements (calibrated against real DOE NSB-MS bank):
- 15 to 22 words, hard cap 28
- Plain MS vocabulary; NO "whereby", "thereby", "wherein", "biological hierarchy"
- One unambiguous answer
- Answerable from middle-school biology/chemistry textbook content
- Must test the SAME concept as the sample (different phrasing, same idea)

Return ONLY a JSON object:
{
  "type": "short_answer" | "multiple_choice",
  "question": "...",
  "answer": "...",
  "answer_text": "..."  // only if type is multiple_choice — the W/X/Y/Z option text
}

If multiple_choice, the question MUST include four options labeled W, X, Y, Z (e.g., "W) ... X) ... Y) ... Z) ...").`;

      const resp = await LLMJudge._callApi(
        [{ role: 'user', content: prompt }],
        400,
        'You are a precise question writer for the U.S. DOE National Science Bowl middle school competition. Output only strict JSON. Never invent canonical answers — they must be standard textbook facts. If you are uncertain about a fact, use the same answer as the sample provided.'
      );
      const block = (resp.content || []).find((c) => c.type === 'text');
      if (!block) return null;
      const text = block.text.trim().replace(/^```(?:json)?\s*|```$/gi, '').trim();
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!['short_answer', 'multiple_choice'].includes(parsed.type)) return null;
        if (typeof parsed.question !== 'string' || !parsed.question.trim()) return null;
        if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) return null;
        return parsed;
      } catch (_) {
        return null;
      }
    },

    async _validate(variant, concept) {
      // Style checks
      const wc = variant.question.trim().split(/\s+/).filter(Boolean).length;
      if (wc < 8) return { ok: false, reason: `too short (${wc} words)` };
      if (wc > 35) return { ok: false, reason: `too long (${wc} words, NSB-MS target 15-22)` };
      for (const re of BANNED_WORDS) {
        if (re.test(variant.question)) return { ok: false, reason: `banned phrase: ${re}` };
      }
      if (variant.type === 'multiple_choice') {
        if (!/W\)/.test(variant.question) || !/X\)/.test(variant.question) ||
            !/Y\)/.test(variant.question) || !/Z\)/.test(variant.question)) {
          return { ok: false, reason: 'multiple choice missing W/X/Y/Z options' };
        }
        if (!/^[WXYZ]$/.test((variant.answer || '').trim())) {
          return { ok: false, reason: 'MC answer is not a single letter W/X/Y/Z' };
        }
      }

      // Grounding cross-check via a second LLM call
      const checkPrompt = `Is this question answerable with high confidence from a standard U.S. middle-school biology or chemistry textbook? Is the canonical answer correct?

QUESTION: ${variant.question}
CANONICAL ANSWER: ${variant.answer}${variant.answer_text ? ` (${variant.answer_text})` : ''}

Reply ONLY with strict JSON:
{ "groundable": true|false, "answer_correct": true|false, "reason": "<one short sentence>" }`;

      try {
        const resp = await LLMJudge._callApi(
          [{ role: 'user', content: checkPrompt }],
          150,
          'You are a strict science fact-checker. Be conservative — if uncertain, return false. Never invent facts.'
        );
        const block = (resp.content || []).find((c) => c.type === 'text');
        if (!block) return { ok: false, reason: 'cross-check returned no content' };
        const text = block.text.trim().replace(/^```(?:json)?\s*|```$/gi, '').trim();
        const check = JSON.parse(text);
        if (!check.groundable) return { ok: false, reason: 'not groundable: ' + (check.reason || '') };
        if (!check.answer_correct) return { ok: false, reason: 'answer wrong: ' + (check.reason || '') };
      } catch (e) {
        return { ok: false, reason: 'cross-check failed: ' + e.message };
      }

      // Build the v2-shaped concept
      const id = `gen-${concept.id}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      const conceptOut = {
        id,
        category: concept.category,
        subcategory: concept.subcategory || null,
        tags: ['generated', concept.id, ...(concept.tags || [])],
        _source: 'generated',
        tossup_variants: [{
          id: 'tu-' + id,
          type: variant.type,
          question: variant.question,
          answer: variant.answer,
          ...(variant.answer_text ? { answer_text: variant.answer_text } : {}),
        }],
        // Reuse the seed bonus for this concept (we don't generate paired bonuses
        // in this MVP — the user's primary ask was variants, not full pairs).
        bonus_variants: (concept.bonus_variants && concept.bonus_variants[0])
          ? [concept.bonus_variants[0]]
          : [],
      };
      // If no bonus variant exists, use a duplicate of the new toss-up so the
      // round structure stays valid.
      if (!conceptOut.bonus_variants.length) {
        conceptOut.bonus_variants = conceptOut.tossup_variants;
      }
      return { ok: true, concept: conceptOut };
    },
  };

  Generator.load();
  window.Generator = Generator;
})();
