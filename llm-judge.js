// LLM Judge — semantic answer judging via Claude / OpenAI / Gemini API.
// Built with anti-hallucination guardrails. See LLMJudge.guardrails for the list.
//
// SECURITY NOTE: This calls api.anthropic.com / api.openai.com /
// generativelanguage.googleapis.com directly from the browser (Anthropic uses
// `anthropic-dangerous-direct-browser-access: true`; Gemini supports browser
// CORS natively). It's intended for personal practice on your own machine. Do
// not deploy this with a shared API key — any visitor could read it from
// localStorage and burn your credits. For a shared deployment, put a thin
// proxy server in front and remove this file.

(() => {
  'use strict';

  const STORAGE_KEY = 'science-bowl-llm-config';
  const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
  const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
  const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const ANTHROPIC_VERSION = '2023-06-01';
  const API_TIMEOUT_MS = 20000;

  // fetch() with a hard timeout. Without this, a flaky provider/network call
  // never settles — the judge/explanation promise hangs forever, freezing the
  // verdict or explanation panel mid-round.
  async function fetchWithTimeout(url, options, ms = API_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`API request timed out after ${Math.round(ms / 1000)}s`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  const MODELS = {
    'gemini-flash': { id: 'gemini-2.5-flash',         provider: 'google',    label: 'Gemini 2.5 Flash (free tier!)', costIn: 0.075, costOut: 0.30 },
    'gemini-pro':   { id: 'gemini-2.5-pro',           provider: 'google',    label: 'Gemini 2.5 Pro (more reasoning)', costIn: 1.25, costOut: 5.00 },
    'haiku':       { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', label: 'Claude Haiku 4.5 (fast, cheap)', costIn: 1.0, costOut: 5.0 },
    'sonnet':      { id: 'claude-sonnet-4-6',         provider: 'anthropic', label: 'Claude Sonnet 4.6 (more accurate)', costIn: 3.0, costOut: 15.0 },
    'opus':        { id: 'claude-opus-4-8',           provider: 'anthropic', label: 'Claude Opus 4.8 (best, slowest)', costIn: 5.0, costOut: 25.0, noSampling: true },
    'gpt-4o-mini': { id: 'gpt-4o-mini',               provider: 'openai',    label: 'GPT-4o mini (cheapest)', costIn: 0.15, costOut: 0.60 },
    'gpt-4o':      { id: 'gpt-4o',                    provider: 'openai',    label: 'GPT-4o', costIn: 2.50, costOut: 10.00 },
  };

  // ---------------- Daily spend guard ----------------
  // Hard cap on LLM spend across ALL providers in a rolling 24h window.
  // Defaults to $2; override via window.SCIENCE_BOWL_CONFIG.llm.dailyBudgetUsd.
  // Spend is tracked in localStorage as [timestampMs, costUsd] entries.
  const SPEND_KEY = 'science-bowl-llm-spend';
  const DEFAULT_DAILY_BUDGET_USD = 2.0;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function dailyBudgetUsd() {
    const cfg = (typeof window !== 'undefined' && window.SCIENCE_BOWL_CONFIG && window.SCIENCE_BOWL_CONFIG.llm) || {};
    const v = Number(cfg.dailyBudgetUsd);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAILY_BUDGET_USD;
  }

  const Budget = {
    _load() {
      try { const r = JSON.parse(localStorage.getItem(SPEND_KEY)); return Array.isArray(r) ? r : []; }
      catch (_) { return []; }
    },
    _recent() {
      const cutoff = Date.now() - DAY_MS;
      return this._load().filter((e) => Array.isArray(e) && e[0] >= cutoff);
    },
    spent24h() {
      return this._recent().reduce((sum, e) => sum + (Number(e[1]) || 0), 0);
    },
    remaining() { return Math.max(0, dailyBudgetUsd() - this.spent24h()); },
    record(costUsd) {
      const c = Number(costUsd);
      if (!Number.isFinite(c) || c <= 0) return;
      const list = this._recent();
      list.push([Date.now(), c]);
      try { localStorage.setItem(SPEND_KEY, JSON.stringify(list)); } catch (_) {}
    },
    recordFromUsage(modelKey, usage) {
      const m = MODELS[modelKey];
      if (!m || !usage) return;
      const cost = ((Number(usage.input_tokens) || 0) / 1e6) * m.costIn
                 + ((Number(usage.output_tokens) || 0) / 1e6) * m.costOut;
      this.record(cost);
    },
    assertUnderLimit() {
      const limit = dailyBudgetUsd();
      const spent = this.spent24h();
      if (spent >= limit) {
        const err = new Error(`Daily LLM spend cap reached ($${spent.toFixed(2)} of $${limit.toFixed(2)} in the last 24h). Falling back to the free rule-based judge until it resets.`);
        err.code = 'BUDGET_EXCEEDED';
        throw err;
      }
    },
  };

  // Guardrail-laden system prompt. Padded to be cacheable (>1024 tokens for Haiku/Sonnet).
  const SYSTEM_PROMPT = `You are a strict judge for the U.S. Department of Energy National Science Bowl practice game. Your ONLY job is to decide whether a STUDENT_ANSWER conveys the same scientific meaning as the CANONICAL_ANSWER for the given QUESTION.

This is a high-stakes academic competition. Hallucinated or sloppy judgments mislead students about what they know. Be precise and conservative.

# Decision rules

1. Judge ONLY whether the student's answer matches the canonical answer's intent. Do NOT consider whether the canonical answer is itself scientifically up-to-date or universally accepted — assume the canonical answer is the ground truth for this question.

2. Use ONLY information present in the question and the canonical answer. Do NOT supplement with your own scientific knowledge. If the canonical answer says "Bacteria, Archaea, and Eukarya" and the student says "Monera, Protista, Fungi, Plantae, Animalia" — that is a different (older) classification and must be marked incorrect, even though it's a real classification scheme. You are not evaluating biology; you are matching to the canonical answer.

3. ACCEPT:
   - Synonyms and equivalent terminology (e.g., "homologous structures" ≈ "homologies"; "natural selection" ≈ "Darwinian selection")
   - Alternate phrasings ("the speed of light" vs "c")
   - Common misspellings or speech-recognition transcription errors where the intent is unambiguous (e.g., "Galapagus" for "Galapagos")
   - Scientific names interchanged with common names where unambiguous (e.g., "arthropoda" ≈ "arthropods")
   - For multiple-choice: the letter (W, X, Y, Z) OR the verbal answer text — both forms are acceptable per NSB Rule 3-3

4. REJECT:
   - Wrong scientific terms (e.g., student says "homologous" when canonical is "analogous")
   - Different concepts that sound similar (e.g., "natural selection" when canonical is "genetic drift")
   - Wrong multiple-choice letter even if the student names a real concept
   - Missing required parts in multi-part canonical answers
   - Answers that are technically true but answer a different question than what was asked

5. MULTI-PART ANSWERS: If the canonical answer requires multiple components (e.g., "name all three domains: Bacteria, Archaea, and Eukarya" or "list the four bases of DNA"), the student MUST include ALL required parts. Missing any required part means INCORRECT (not "unsure" — incorrect). Do not give partial credit.

6. "ACCEPT:" ALTERNATES: When the canonical answer text contains "accept: X, Y, Z" or "(accept: X, Y, Z)", any of the listed alternates is acceptable in addition to the primary answer. The student must match the primary or one of the alternates.

7. UNCERTAIN: If you cannot confidently determine whether the answer is correct (genuinely ambiguous, partial, garbled transcription, or you'd need outside knowledge), return verdict "unsure" with low confidence. Do NOT guess "correct" to be charitable. The cost of marking a wrong answer correct is much higher than the cost of flagging it for human review.

8. NUMERICAL ANSWERS: For numerical answers, accept equivalent forms (e.g., "8" ≡ "eight"; "9π" ≡ "9 pi"; "1/2" ≡ "0.5" if the canonical doesn't require exact form). Reject if magnitudes or units are wrong.

9. NEVER invent canonical answers, alternates, or "accept" lists not present in the input. If the input doesn't say it, don't act as if it did.

10. NEVER use external knowledge to fill in gaps. If the canonical answer is "homeostasis" and the student says "internal regulation", check whether the canonical answer or its accept-list mentions "internal regulation" — if not, the answer is at best "unsure", not "correct".

# Output format

Return ONLY a JSON object with these exact keys, no preamble, no markdown fences, no commentary:

{
  "verdict": "correct" | "incorrect" | "unsure",
  "confidence": <number from 0.0 to 1.0>,
  "matched_part": "<the specific part of the canonical answer the student matched, or null>",
  "missing": "<what's missing if partial multi-part answer, or null>",
  "reasoning": "<one short sentence explaining the judgment, citing the canonical answer>"
}

# Calibration examples

Example 1 — exact:
QUESTION: "What is the term for the diversity of life?"
CANONICAL_ANSWER: "Biodiversity"
STUDENT_ANSWER: "biodiversity"
→ {"verdict":"correct","confidence":1.0,"matched_part":"biodiversity","missing":null,"reasoning":"Exact match to canonical answer."}

Example 2 — synonym:
QUESTION: "What term describes the process by which organisms maintain a stable internal environment?"
CANONICAL_ANSWER: "Homeostasis"
STUDENT_ANSWER: "homeostasis, you know, like keeping things stable"
→ {"verdict":"correct","confidence":0.98,"matched_part":"homeostasis","missing":null,"reasoning":"Student stated 'homeostasis' which matches the canonical answer."}

Example 3 — multi-part incomplete:
QUESTION: "Name all three domains of life."
CANONICAL_ANSWER: "Bacteria, Archaea, and Eukarya"
STUDENT_ANSWER: "Bacteria and Eukarya"
→ {"verdict":"incorrect","confidence":0.95,"matched_part":"Bacteria, Eukarya","missing":"Archaea","reasoning":"Multi-part answer requires all three domains; student omitted Archaea."}

Example 4 — wrong concept:
QUESTION: "Which type of bond results from the transfer of electrons?"
CANONICAL_ANSWER: "Ionic bond"
STUDENT_ANSWER: "covalent bond"
→ {"verdict":"incorrect","confidence":0.99,"matched_part":null,"missing":null,"reasoning":"Student named 'covalent', which is electron sharing, not the canonical 'ionic' (electron transfer)."}

Example 5 — multiple choice letter:
QUESTION: "Which of the following ... W) Cell ... X) Molecule ... Y) Atom ... Z) Tissue ..."
CANONICAL_ANSWER: "X"
ANSWER_TEXT: "Molecule, organelle, cell, tissue"
STUDENT_ANSWER: "X"
→ {"verdict":"correct","confidence":1.0,"matched_part":"X","missing":null,"reasoning":"Student gave the canonical letter X."}

Example 6 — multiple choice wrong letter:
(same question)
STUDENT_ANSWER: "W"
→ {"verdict":"incorrect","confidence":1.0,"matched_part":null,"missing":null,"reasoning":"Student said W; canonical is X. Wrong letter on multiple-choice is incorrect."}

Example 7 — verbal MC answer:
(same question)
STUDENT_ANSWER: "molecule organelle cell tissue"
→ {"verdict":"correct","confidence":0.95,"matched_part":"X (Molecule, organelle, cell, tissue)","missing":null,"reasoning":"Student verbally named the canonical option text for X."}

Example 8 — ambiguous transcription:
QUESTION: "Who proposed natural selection?"
CANONICAL_ANSWER: "Charles Darwin"
STUDENT_ANSWER: "darling"
→ {"verdict":"unsure","confidence":0.4,"matched_part":null,"missing":null,"reasoning":"Transcription appears garbled; could be misheard 'Darwin' but cannot confirm."}

Example 9 — true but off-target:
QUESTION: "What process produces ATP in mitochondria?"
CANONICAL_ANSWER: "Cellular respiration"
STUDENT_ANSWER: "the Krebs cycle"
→ {"verdict":"unsure","confidence":0.5,"matched_part":null,"missing":null,"reasoning":"Krebs is a stage of cellular respiration; not the canonical answer but related. Flagging for human review."}

Example 10 — outdated classification (anti-hallucination test):
QUESTION: "Name the domains of life."
CANONICAL_ANSWER: "Bacteria, Archaea, and Eukarya"
STUDENT_ANSWER: "Monera, Protista, Fungi, Plantae, Animalia"
→ {"verdict":"incorrect","confidence":0.97,"matched_part":null,"missing":"Bacteria, Archaea, Eukarya","reasoning":"Student named the older five-kingdom system, not the three-domain system in the canonical answer."}

Now judge the student answer below using these rules. Return ONLY the JSON object.`;

  const LLMJudge = {
    enabled: false,
    anthropicKey: '',
    openaiKey: '',
    googleKey: '',
    model: 'haiku',
    config: { strictThreshold: 0.7 },

    // Backward-compat alias. Reads from / writes to whichever key matches the
    // currently selected model's provider. Older callers used `apiKey` directly.
    get apiKey() {
      return this._keyForCurrentProvider();
    },
    set apiKey(v) {
      const prov = this._currentProvider();
      const clean = sanitizeKey(v);
      if (prov === 'openai') this.openaiKey = clean;
      else if (prov === 'google') this.googleKey = clean;
      else this.anthropicKey = clean;
    },

    /**
     * Set the key for a specific provider, sanitized. Returns metadata about
     * what was stripped so the UI can warn the user if their paste contained
     * smart quotes / zero-width spaces / etc. that would otherwise blow up
     * the fetch headers (`String contains non ISO-8859-1 code point`).
     */
    setKeyForProvider(prov, v) {
      const before = String(v || '');
      const clean = sanitizeKey(before);
      const stripped = before.length - clean.length;
      if (prov === 'openai') this.openaiKey = clean;
      else if (prov === 'google') this.googleKey = clean;
      else this.anthropicKey = clean;
      this.saveConfig();
      return { clean, stripped, original: before };
    },

    _currentProvider() {
      const m = MODELS[this.model];
      return (m && m.provider) || 'anthropic';
    },

    _keyForCurrentProvider() {
      const prov = this._currentProvider();
      if (prov === 'openai') return this.openaiKey;
      if (prov === 'google') return this.googleKey;
      return this.anthropicKey;
    },

    guardrails: [
      'Strict JSON schema validation; invalid response falls back to rule-based',
      'Anti-hallucination system prompt forbids external knowledge',
      'Temperature 0 for determinism',
      'Cross-check with rule-based judge; disagreement flags for human review',
      'Confidence threshold 0.7; below = "needs review", not "correct"',
      'Multi-part answers require all components — no partial credit',
      'MC: wrong letter is wrong, even if student names a real concept',
      'Audit trail: reasoning shown to user; every judgment overridable',
    ],

    loadConfig() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const c = JSON.parse(raw);
          this.enabled = !!c.enabled;
          this.model = c.model || 'haiku';
          // New shape: per-provider keys.
          this.anthropicKey = c.anthropicKey || '';
          this.openaiKey = c.openaiKey || '';
          this.googleKey = c.googleKey || '';
          // Backward-compat: migrate legacy single `apiKey` into anthropicKey
          // since the prior version was Anthropic-only.
          if (!this.anthropicKey && c.apiKey) {
            this.anthropicKey = c.apiKey;
          }
        }
      } catch (_) {}

      this.loadRuntimeConfig();

      // Validate the loaded model still exists; fall back to haiku.
      if (!MODELS[this.model]) this.model = 'haiku';
    },

    loadRuntimeConfig() {
      try {
        const cfg = (window && window.SCIENCE_BOWL_CONFIG && window.SCIENCE_BOWL_CONFIG.llm) || null;
        if (!cfg) return;
        if (typeof cfg.enabled === 'boolean') this.enabled = cfg.enabled;
        if (typeof cfg.model === 'string' && MODELS[cfg.model]) this.model = cfg.model;
        const keys = cfg.providerKeys || {};
        if (keys.anthropic) this.anthropicKey = sanitizeKey(keys.anthropic);
        if (keys.openai) this.openaiKey = sanitizeKey(keys.openai);
        if (keys.google) this.googleKey = sanitizeKey(keys.google);
      } catch (_) {}
    },

    saveConfig() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        enabled: this.enabled,
        model: this.model,
        anthropicKey: this.anthropicKey,
        openaiKey: this.openaiKey,
        googleKey: this.googleKey,
      }));
    },

    clearKey() {
      // Clear only the key for the currently selected provider so the user
      // can keep the other provider's key intact.
      const prov = this._currentProvider();
      if (prov === 'openai') this.openaiKey = '';
      else if (prov === 'google') this.googleKey = '';
      else this.anthropicKey = '';
      this.enabled = false;
      this.saveConfig();
    },

    clearAllKeys() {
      this.anthropicKey = '';
      this.openaiKey = '';
      this.googleKey = '';
      this.enabled = false;
      this.saveConfig();
    },

    isReady() {
      // Ready when within the daily cap AND we can reach a model: either a local
      // provider key is set, OR a server-side proxy is configured (hosted mode,
      // where the key lives on the Worker, not in the browser).
      const cfg = (typeof window !== 'undefined' && window.SCIENCE_BOWL_CONFIG && window.SCIENCE_BOWL_CONFIG.llm) || {};
      const reachable = !!cfg.proxyUrl || !!this._keyForCurrentProvider();
      return this.enabled && reachable && !this.overBudget();
    },

    /** True once the rolling 24h LLM spend has hit the daily cap. */
    overBudget() {
      return Budget.spent24h() >= dailyBudgetUsd();
    },

    /** { spent, limit, remaining } in USD for the rolling 24h window. */
    budgetStatus() {
      return { spent: Budget.spent24h(), limit: dailyBudgetUsd(), remaining: Budget.remaining() };
    },

    /** User-facing notice when the cap is hit. */
    budgetNotice() {
      const s = this.budgetStatus();
      return `Daily LLM spend cap of $${s.limit.toFixed(2)} reached (~$${s.spent.toFixed(2)} in the last 24h). Judging and explanations use the free rule-based fallback until older spend ages out of the window.`;
    },

    listModels() {
      return Object.entries(MODELS).map(([key, m]) => ({ key, ...m }));
    },

    /**
     * Test the API key with a tiny request.
     */
    async testKey() {
      // Use a real, properly-formatted judge prompt so the system prompt
      // accepts it and runs the actual judging path. (Earlier versions used a
      // short-circuit "reply with exactly..." prompt, which the model
      // correctly refused — its anti-hallucination guardrails were working
      // exactly as intended.)
      const userPrompt = [
        'QUESTION: What is the capital of France?',
        'QUESTION_TYPE: short_answer',
        'CANONICAL_ANSWER: Paris',
        'STUDENT_ANSWER: Paris',
        '',
        'Return ONLY the JSON object.',
      ].join('\n');
      const result = await this._callApi([{ role: 'user', content: userPrompt }], 200);
      const parsed = this._parseResponse(result);
      if (!parsed) {
        const block = (result.content || []).find((c) => c.type === 'text');
        const raw = block ? block.text : JSON.stringify(result).slice(0, 300);
        console.warn('[LLMJudge] Test response failed schema validation. Raw text was:', raw);
        const preview = raw.slice(0, 200).replace(/\n/g, ' ⏎ ');
        throw new Error(`Returned text didn't match expected JSON schema. Got: "${preview}${raw.length > 200 ? '…' : ''}"`);
      }
      if (parsed.verdict !== 'correct') {
        // The model judged "Paris == Paris" as something other than correct — odd, but not fatal
        console.warn('[LLMJudge] Test verdict was not "correct":', parsed);
      }
      return { ok: true, model: MODELS[this.model].label, verdict: parsed.verdict, confidence: parsed.confidence };
    },

    /**
     * Generate a brief, grounded explanation of WHY the canonical answer is correct.
     * Used to help kids learn after each question.
     *
     * Guardrails:
     *  - 60–100 words target, 150 hard cap
     *  - System prompt forbids inventing facts not commonly known
     *  - Must affirm the canonical answer
     *  - If uncertain about a detail, omit it rather than guess
     *  - For multi-part answers, briefly explain each component
     */
    async explain(q, studentAnswer, wasCorrect) {
      if (!this.isReady()) return null;

      const systemPrompt = `You are a science tutor for middle-school National Science Bowl practice. Write a clear explanation of WHY the canonical answer is correct.

STRICT RULES:
1. Treat the canonical answer as ground truth — do NOT contradict or qualify it.
2. Use only widely-accepted, textbook-level scientific facts. Do NOT invent specific dates, statistics, or names not commonly known.
3. If you are uncertain about a specific fact, omit it. A short, factually safe sentence is better than a longer one with a hallucinated detail.
4. Output EXACTLY 2 sentences:
   - Sentence 1 must explain the mechanism (why the canonical answer is true).
   - Sentence 2 must provide either (a) a contrast with a likely wrong answer OR (b) one concrete example.
5. Do NOT restate the question, and do NOT restate the canonical answer verbatim.
6. Do NOT start with words like "Excellent!", "Great!", "Correct!", "Right!" or any congratulatory preamble.
7. Aim at a middle-school audience. Plain language. No jargon dumps.
8. Output ONLY the explanation text — no markdown, no quotes, no preamble.
9. Length target: 60–100 words. Hard cap 150 words. End with proper terminal punctuation.`;

      const userPrompt = [
        `QUESTION: ${q.question}`,
        `CANONICAL_ANSWER: ${q.type === 'multiple_choice' ? `${q.answer} — ${q.answer_text || ''}` : q.answer}`,
        `STUDENT_SAID: ${studentAnswer || '(no answer)'}`,
        `STUDENT_WAS_${wasCorrect ? 'CORRECT' : 'INCORRECT'}.`,
        '',
        'Write the explanation now in exactly two sentences following the strict format.',
      ].join('\n');

      try {
        const resp = await this._callApi(
          [{ role: 'user', content: userPrompt }],
          512, // ample headroom — ~150 words is ~200 tokens, give 2.5× room
          systemPrompt
        );
        const block = (resp.content || []).find((c) => c.type === 'text');
        if (!block) return null;
        let text = block.text.trim();
        // Strip any markdown fences or surrounding quotes
        text = text.replace(/^```[a-z]*\s*|```$/gi, '').trim();
        text = text.replace(/^["']|["']$/g, '').trim();
        // Strip a leading congratulatory word the model adds despite the rule
        text = text.replace(/^(Excellent|Great|Correct|Right|Yes|Perfect|Nice|Good|Awesome|Bravo)[!\.,]?\s+/i, '');
        // Hard cap at ~150 words
        const words = text.split(/\s+/);
        if (words.length > 150) text = words.slice(0, 150).join(' ').replace(/[,;:]?\s*$/, '') + '…';
        // If output was truncated mid-sentence (no terminal punctuation), append a hint
        if (text && !/[.!?…"]\s*$/.test(text)) {
          text = text.replace(/[,;:]?\s*$/, '') + '…';
          console.warn('[LLMJudge.explain] Response appears truncated; check usage:', resp.usage);
        }
        return text || null;
      } catch (err) {
        console.warn('Explain failed:', err);
        return null;
      }
    },

    /**
     * Judge an answer. Hybrid: runs LLM and rule-based in parallel, returns
     * a unified verdict with cross-check metadata.
     *
     * @param {string} spoken — student answer (transcript or typed)
     * @param {Object} q — question {type, question, answer, answer_text?}
     * @returns {Promise<{correct:boolean, confidence:number, reasoning:string, source:string, ...}>}
     */
    async judge(spoken, q) {
      if (!this.isReady()) {
        throw new Error('LLM judge not configured');
      }

      const userPrompt = this._buildUserPrompt(spoken, q);
      const ruleVerdict = window.Judge ? window.Judge.judge(spoken, q) : null;

      let llmRaw;
      try {
        llmRaw = await this._callApi([{ role: 'user', content: userPrompt }], 300);
      } catch (err) {
        // Network/API failure — fall back to rule-based with explicit flag
        return this._fallback(ruleVerdict, 'api_error', err.message);
      }

      const parsed = this._parseResponse(llmRaw);
      if (!parsed) {
        return this._fallback(ruleVerdict, 'parse_error', 'LLM returned malformed JSON');
      }

      // Guardrail 5: confidence threshold downgrade
      let verdict = parsed.verdict;
      let needsReview = false;
      if (parsed.confidence < this.config.strictThreshold && verdict === 'correct') {
        verdict = 'unsure';
        needsReview = true;
      }
      if (verdict === 'unsure') needsReview = true;

      // Guardrail 4: cross-check with rule-based
      const llmCorrect = verdict === 'correct';
      const ruleCorrect = ruleVerdict ? ruleVerdict.correct : null;
      const agreement = ruleVerdict ? (llmCorrect === ruleCorrect) : null;
      if (ruleVerdict && agreement === false) needsReview = true;

      const usage = llmRaw.usage || {};
      const m = MODELS[this.model];
      const cost = usage.input_tokens && usage.output_tokens
        ? (usage.input_tokens / 1_000_000) * m.costIn + (usage.output_tokens / 1_000_000) * m.costOut
        : 0;

      return {
        correct: llmCorrect,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        verdict,
        matchedPart: parsed.matched_part,
        missing: parsed.missing,
        source: 'llm',
        model: m.label,
        agreement,
        ruleVerdict,
        needsReview,
        usage,
        costUsd: cost,
        rawResponse: parsed,
      };
    },

    _fallback(ruleVerdict, reason, detail) {
      if (!ruleVerdict) {
        return { correct: false, confidence: 0, reasoning: `LLM failed (${reason}) and rule-based unavailable: ${detail}`, source: 'fallback_failed', needsReview: true, fallbackReason: reason };
      }
      return {
        correct: ruleVerdict.correct,
        confidence: ruleVerdict.confidence,
        reasoning: `LLM unavailable (${reason}: ${detail}) — fell back to rule-based: ${ruleVerdict.reason}`,
        source: 'rule_fallback',
        needsReview: true,
        fallbackReason: reason,
        ruleVerdict,
      };
    },

    _buildUserPrompt(spoken, q) {
      const lines = [
        `QUESTION: ${q.question}`,
        `QUESTION_TYPE: ${q.type}`,
        `CANONICAL_ANSWER: ${q.answer}`,
      ];
      if (q.type === 'multiple_choice' && q.answer_text) {
        lines.push(`ANSWER_TEXT_FOR_LETTER_${q.answer}: ${q.answer_text}`);
      }
      lines.push(`STUDENT_ANSWER: ${spoken}`);
      lines.push('');
      lines.push('Return ONLY the JSON object.');
      return lines.join('\n');
    },

    async _callApi(messages, maxTokens, systemOverride) {
      const m = MODELS[this.model];
      if (!m) throw new Error('unknown model: ' + this.model);
      // Hard backstop: block the call outright once the daily cap is hit, so
      // no provider key can be charged beyond the budget (covers judge, explain,
      // and the question generator — all route through here).
      Budget.assertUnderLimit();

      const sysText = systemOverride || SYSTEM_PROMPT;

      // Proxy mode (hosted): route every call through the server-side Worker,
      // which holds the API key. Keeps keys out of the browser on a public URL.
      // The Worker returns an Anthropic-shaped { content, usage } for all providers.
      const cfg = (typeof window !== 'undefined' && window.SCIENCE_BOWL_CONFIG && window.SCIENCE_BOWL_CONFIG.llm) || {};
      if (cfg.proxyUrl) {
        const userText = messages.map((msg) => (typeof msg.content === 'string' ? msg.content : '')).join('\n');
        const wantsJson = /Return ONLY the JSON object\./i.test(userText);
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.proxyToken) headers['X-App-Token'] = cfg.proxyToken;
        const res = await fetchWithTimeout(cfg.proxyUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: m.id, maxTokens: maxTokens || 300, system: sysText, messages, noSampling: !!m.noSampling, wantsJson }),
        });
        if (!res.ok) {
          let detail;
          try { detail = (await res.json()).error; } catch (_) { detail = res.statusText; }
          throw new Error(`API ${res.status}: ${detail}`);
        }
        const out = await res.json();
        Budget.recordFromUsage(this.model, out.usage);
        return out;
      }

      if (m.provider === 'openai') {
        // OpenAI Chat Completions. Convert Anthropic-shaped system prompt
        // (a string here) into a standard system message and prepend it.
        if (!this.openaiKey) throw new Error('OpenAI API key not set');
        const body = {
          model: m.id,
          temperature: 0,
          max_tokens: maxTokens || 300,
          messages: [{ role: 'system', content: sysText }, ...messages],
        };
        const res = await fetchWithTimeout(OPENAI_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.openaiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          let detail;
          try { detail = (await res.json()).error?.message; } catch (_) { detail = res.statusText; }
          throw new Error(`API ${res.status}: ${detail}`);
        }
        const json = await res.json();
        // Normalize to Anthropic shape so existing _parseResponse / explain /
        // generator code keeps working unchanged.
        const choice = (json.choices && json.choices[0]) || {};
        const content = (choice.message && choice.message.content) || '';
        const usage = json.usage || {};
        const normUsage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens };
        Budget.recordFromUsage(this.model, normUsage);
        return { content: [{ type: 'text', text: content }], usage: normUsage };
      }

      if (m.provider === 'google') {
        // Google Gemini (Generative Language API). Browser CORS works
        // natively — no special header required. We translate Anthropic-style
        // {role:'user', content:'...'} messages into Gemini's `contents`
        // array, and the system prompt into `systemInstruction`. JSON mode
        // is enabled for judge calls so the response text parses cleanly.
        if (!this.googleKey) throw new Error('Google AI Studio API key not set');
        const contents = messages.map((msg) => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
        }));
        // Detect whether this call expects a JSON response. The judge's user
        // prompt always ends with "Return ONLY the JSON object." — turn on
        // JSON mode in that case. The explanation flow uses plain text.
        const userText = messages.map((msg) => typeof msg.content === 'string' ? msg.content : '').join('\n');
        const wantsJson = /Return ONLY the JSON object\./i.test(userText);
        const body = {
          systemInstruction: { parts: [{ text: sysText }] },
          contents,
          generationConfig: {
            temperature: 0,
            maxOutputTokens: maxTokens || 300,
            // Gemini 2.5 spends part of maxOutputTokens on internal "thinking"
            // tokens, which was truncating our short judge/explain outputs.
            // Disable thinking on Flash (supports budget 0) — these structured
            // tasks don't need it. (Pro can't disable thinking; it has more
            // headroom and is rarely used for this.)
            ...(/flash/i.test(m.id) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            ...(wantsJson ? { responseMimeType: 'application/json' } : {}),
          },
        };
        const url = `${GOOGLE_API_BASE}/${encodeURIComponent(m.id)}:generateContent?key=${encodeURIComponent(this.googleKey)}`;
        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          let detail;
          try { detail = (await res.json()).error?.message; } catch (_) { detail = res.statusText; }
          throw new Error(`API ${res.status}: ${detail}`);
        }
        const json = await res.json();
        // Normalize to Anthropic shape.
        const cand = (json.candidates && json.candidates[0]) || {};
        const parts = (cand.content && cand.content.parts) || [];
        const text = parts.map((p) => p.text || '').join('');
        const usage = json.usageMetadata || {};
        const normUsage = { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount };
        Budget.recordFromUsage(this.model, normUsage);
        return { content: [{ type: 'text', text }], usage: normUsage };
      }

      // Anthropic (default).
      if (!this.anthropicKey) throw new Error('Anthropic API key not set');
      const body = {
        model: m.id,
        max_tokens: maxTokens || 300,
        // Opus 4.7+ (flagged noSampling) reject sampling params like temperature
        // with a 400. Only send temperature for models that still accept it;
        // for the others, the system prompt already enforces deterministic judging.
        ...(m.noSampling ? {} : { temperature: 0 }),
        system: [
          {
            type: 'text',
            text: sysText,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages,
      };

      const res = await fetchWithTimeout(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let detail;
        try { detail = (await res.json()).error?.message; } catch (_) { detail = res.statusText; }
        throw new Error(`API ${res.status}: ${detail}`);
      }

      const json = await res.json();
      Budget.recordFromUsage(this.model, json.usage);
      return json;
    },

    _parseResponse(apiResponse) {
      try {
        const block = (apiResponse.content || []).find((c) => c.type === 'text');
        if (!block) return null;
        const text = block.text.trim();
        // Strip code fences if model emitted them despite the rule
        const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        const obj = JSON.parse(jsonStr);
        // Guardrail 1: schema validation
        if (typeof obj !== 'object' || obj === null) return null;
        if (!['correct', 'incorrect', 'unsure'].includes(obj.verdict)) return null;
        if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) return null;
        if (typeof obj.reasoning !== 'string' || !obj.reasoning) return null;
        // matched_part and missing may be null or string
        if (obj.matched_part != null && typeof obj.matched_part !== 'string') return null;
        if (obj.missing != null && typeof obj.missing !== 'string') return null;
        return obj;
      } catch (e) {
        return null;
      }
    },
  };

  /**
   * Strip everything that isn't a printable ASCII byte. Anthropic and OpenAI
   * keys are alphanumerics, dashes, and underscores — anything else (smart
   * quotes, NBSP, zero-width spaces) breaks the fetch headers. This guards
   * against the common copy-paste accident where a webpage auto-formats the
   * key and the user doesn't notice.
   */
  function sanitizeKey(v) {
    if (!v) return '';
    return String(v)
      .replace(/[^\x21-\x7E]/g, '') // keep only printable ASCII (drops NBSP, smart quotes, ZWSP, etc.)
      .trim();
  }

  LLMJudge.loadConfig();
  window.LLMJudge = LLMJudge;
  window.LLM_MODELS = MODELS;
})();
