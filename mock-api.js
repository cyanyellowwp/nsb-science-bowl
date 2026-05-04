// Mock LLM API — fixture-based fake responses so we can develop and test
// the LLM Judge / Generator / Explanation flows without spending a cent or
// needing a real API key.
//
// When enabled, MockApi.install() patches LLMJudge._callApi so it returns
// hardcoded fixtures based on simple pattern matching on the user prompt.
// Disable with MockApi.uninstall() or by toggling off in setup.
//
// Storage key for the toggle state: `science-bowl-mock-api`.

(() => {
  'use strict';

  const STORAGE_KEY = 'science-bowl-mock-api';

  /**
   * Fixture matchers — each one is a function that inspects the user prompt
   * and returns a faked response if it applies. Order matters; first match
   * wins. Add fixtures here as new flows need testing.
   */
  const fixtures = [
    // Test-key prompt: "Paris" / "Paris" (provider-agnostic — MockApi
    // intercepts at _callApi, so the same fixture serves Anthropic / OpenAI
    // / Google test buttons).
    {
      name: 'testKey-paris',
      match: (p) => /CANONICAL_ANSWER:\s*Paris/i.test(p) && /STUDENT_ANSWER:\s*Paris/i.test(p),
      respond: () => ({
        verdict: 'correct',
        confidence: 1.0,
        matched_part: 'Paris',
        missing: null,
        reasoning: 'Mock: exact match for Paris (covers Gemini / Claude / GPT test calls).',
      }),
    },
    // Generic exact-match short answer
    {
      name: 'judge-exact-match',
      match: (p) => {
        const can = (p.match(/CANONICAL_ANSWER:\s*([^\n]+)/i) || [])[1];
        const stu = (p.match(/STUDENT_ANSWER:\s*([^\n]+)/i) || [])[1];
        if (!can || !stu) return false;
        return can.trim().toLowerCase() === stu.trim().toLowerCase();
      },
      respond: (p) => {
        const can = (p.match(/CANONICAL_ANSWER:\s*([^\n]+)/i) || [, ''])[1].trim();
        return {
          verdict: 'correct',
          confidence: 0.99,
          matched_part: can,
          missing: null,
          reasoning: `Mock: student answer matches canonical "${can}" exactly.`,
        };
      },
    },
    // Multi-part with all parts present (heuristic: comma + 2+ commas in student)
    {
      name: 'judge-multipart-complete',
      match: (p) => {
        const can = (p.match(/CANONICAL_ANSWER:\s*([^\n]+)/i) || [])[1];
        const stu = (p.match(/STUDENT_ANSWER:\s*([^\n]+)/i) || [])[1];
        if (!can || !stu) return false;
        const canParts = can.split(/[,;]| and /i).map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (canParts.length < 2) return false;
        return canParts.every((part) => stu.toLowerCase().includes(part));
      },
      respond: (p) => {
        const can = (p.match(/CANONICAL_ANSWER:\s*([^\n]+)/i) || [, ''])[1].trim();
        return {
          verdict: 'correct',
          confidence: 0.92,
          matched_part: can,
          missing: null,
          reasoning: `Mock: student covered all parts of the multi-part canonical answer.`,
        };
      },
    },
    // MC: student gave the canonical letter
    {
      name: 'judge-mc-correct-letter',
      match: (p) => {
        if (!/QUESTION_TYPE:\s*multiple_choice/i.test(p)) return false;
        const can = (p.match(/CANONICAL_ANSWER:\s*([WXYZ])\b/i) || [])[1];
        const stu = (p.match(/STUDENT_ANSWER:\s*([WXYZ])\b/i) || [])[1];
        return can && stu && can.toUpperCase() === stu.toUpperCase();
      },
      respond: (p) => {
        const letter = (p.match(/CANONICAL_ANSWER:\s*([WXYZ])\b/i) || [, ''])[1].toUpperCase();
        return {
          verdict: 'correct',
          confidence: 1.0,
          matched_part: letter,
          missing: null,
          reasoning: `Mock: student gave the canonical letter ${letter}.`,
        };
      },
    },
    // MC: student gave a wrong letter
    {
      name: 'judge-mc-wrong-letter',
      match: (p) => {
        if (!/QUESTION_TYPE:\s*multiple_choice/i.test(p)) return false;
        const can = (p.match(/CANONICAL_ANSWER:\s*([WXYZ])\b/i) || [])[1];
        const stu = (p.match(/STUDENT_ANSWER:\s*([WXYZ])\b/i) || [])[1];
        return can && stu && can.toUpperCase() !== stu.toUpperCase();
      },
      respond: () => ({
        verdict: 'incorrect',
        confidence: 1.0,
        matched_part: null,
        missing: null,
        reasoning: `Mock: student named a different multiple-choice letter than canonical.`,
      }),
    },
    // Explanation generator (no JSON) — return short narrative
    {
      name: 'explain',
      match: (p) => /STUDENT_WAS_(CORRECT|INCORRECT)/i.test(p) && /Write the brief explanation/i.test(p),
      respond: (p) => {
        const wasCorrect = /STUDENT_WAS_CORRECT/i.test(p);
        const ans = (p.match(/CANONICAL_ANSWER:\s*([^\n]+)/i) || [, ''])[1].trim();
        const text = wasCorrect
          ? `Right — "${ans}" is correct. (Mock explanation: enable the real LLM for richer reasoning.)`
          : `The correct answer is "${ans}". (Mock explanation: enable the real LLM for a fuller explanation.)`;
        return text; // explanation is plain text, not JSON
      },
    },
    // Question generator
    {
      name: 'gen-variant',
      match: (p) => /Write ONE fresh middle-school National Science Bowl question/i.test(p),
      respond: () => ({
        type: 'short_answer',
        question: 'Mock generator output: what is the term for the smallest unit of life capable of self-replication?',
        answer: 'Cell',
      }),
    },
    // Generator validation cross-check
    {
      name: 'gen-cross-check',
      match: (p) => /Is this question answerable with high confidence/i.test(p),
      respond: () => ({
        groundable: true,
        answer_correct: true,
        reason: 'Mock: standard textbook content.',
      }),
    },
    // Default: unsure
    {
      name: 'default-unsure',
      match: () => true,
      respond: () => ({
        verdict: 'unsure',
        confidence: 0.5,
        matched_part: null,
        missing: null,
        reasoning: 'Mock fallback: no matching fixture, returning unsure.',
      }),
    },
  ];

  const MockApi = {
    enabled: false,
    _originalCallApi: null,

    load() {
      try {
        this.enabled = localStorage.getItem(STORAGE_KEY) === 'true';
      } catch (_) { this.enabled = false; }
    },

    save() {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'true' : 'false');
    },

    /**
     * Patch LLMJudge._callApi to return fixture responses. Keeps the
     * original around so we can restore it on uninstall().
     */
    install() {
      if (!window.LLMJudge) return false;
      if (this._originalCallApi) return true; // already installed
      this._originalCallApi = LLMJudge._callApi.bind(LLMJudge);
      LLMJudge._callApi = async (messages, maxTokens, systemOverride) => {
        const userPrompt = (messages.find((m) => m.role === 'user') || {}).content || '';
        const fixture = fixtures.find((f) => f.match(userPrompt));
        const responseObj = fixture.respond(userPrompt);
        const text = typeof responseObj === 'string'
          ? responseObj
          : JSON.stringify(responseObj);
        // Simulate a small network delay so async UI flows behave realistically
        await new Promise((r) => setTimeout(r, 80));
        // Match Anthropic API response shape
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: userPrompt.length / 4, output_tokens: text.length / 4 },
          _mock: true,
          _fixture: fixture.name,
        };
      };
      // Make isReady() always return true so the UI doesn't gate on a key
      this._origIsReady = LLMJudge.isReady.bind(LLMJudge);
      LLMJudge.isReady = () => true;
      this.enabled = true;
      this.save();
      console.info('[MockApi] installed — LLM calls now return fixtures');
      return true;
    },

    uninstall() {
      if (!this._originalCallApi) return;
      LLMJudge._callApi = this._originalCallApi;
      this._originalCallApi = null;
      if (this._origIsReady) {
        LLMJudge.isReady = this._origIsReady;
        this._origIsReady = null;
      }
      this.enabled = false;
      this.save();
      console.info('[MockApi] uninstalled — using real API again');
    },

    /** List the fixtures (handy for debugging which one matched). */
    listFixtures() {
      return fixtures.map((f) => f.name);
    },
  };

  MockApi.load();
  window.MockApi = MockApi;

  // Auto-install on next tick if the user previously enabled it.
  // Wait for LLMJudge to load first.
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (MockApi.enabled && window.LLMJudge) {
        MockApi.install();
      }
    }, 300);
  });
})();
