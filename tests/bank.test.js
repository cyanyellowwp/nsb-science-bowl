// Tests for the question bank: schema validation, expected concept counts,
// and that the LLM generator (when called) at least returns the right shape.
//
// These rely on App.bank being loaded — they'll skip if the bank isn't ready.

(() => {
  if (typeof T === 'undefined') return;

  T.describe('Question bank: load + merge', () => {
    T.it('exposes a global QuestionBank with concepts', () => {
      T.assert(window.QuestionBank, 'window.QuestionBank must be set after init');
      T.assert(Array.isArray(window.QuestionBank.concepts), 'concepts should be an array');
      T.assert(window.QuestionBank.concepts.length > 0, 'concepts should be non-empty');
    });
    T.it('contains both seed and corpus sources', () => {
      const concepts = window.QuestionBank.concepts;
      const sources = new Set(concepts.map((c) => c._source));
      T.assert(sources.has('seed'), 'expected at least one seed concept');
      T.assert(sources.has('corpus'), 'expected at least one corpus concept');
    });
    T.it('every concept has at least one toss-up and bonus variant', () => {
      const broken = window.QuestionBank.concepts.filter((c) =>
        !c.tossup_variants || !c.tossup_variants.length ||
        !c.bonus_variants || !c.bonus_variants.length
      );
      T.assertEqual(broken.length, 0, `${broken.length} concepts missing variants`);
    });
    T.it('every variant has type and answer', () => {
      const broken = [];
      for (const c of window.QuestionBank.concepts) {
        for (const v of [...(c.tossup_variants || []), ...(c.bonus_variants || [])]) {
          if (!v.type || !v.answer) broken.push({ id: v.id, type: v.type, answer: v.answer });
        }
      }
      T.assertEqual(broken.length, 0, `${broken.length} variants malformed`);
    });
  });

  T.describe('Question bank: seed style guide compliance', () => {
    T.it('no seed toss-up uses "whereby" or "biological hierarchy"', () => {
      const bad = window.QuestionBank.concepts
        .filter((c) => c._source === 'seed')
        .flatMap((c) => c.tossup_variants || [])
        .filter((v) => /\bwhereby\b/i.test(v.question) || /\bbiological hierarchy\b/i.test(v.question));
      T.assertEqual(bad.length, 0, `${bad.length} questions use banned terms`);
    });
    T.it('no short-answer toss-up exceeds 25 words', () => {
      // Multiple-choice questions naturally run longer because of the W/X/Y/Z
      // option text — calibrate against the stem only by checking SA questions.
      const tooLong = window.QuestionBank.concepts
        .filter((c) => c._source === 'seed')
        .flatMap((c) => c.tossup_variants || [])
        .filter((v) => v.type === 'short_answer')
        .filter((v) => v.question.split(/\s+/).filter(Boolean).length > 25);
      T.assertEqual(tooLong.length, 0, `${tooLong.length} short-answer questions exceed 25 words`);
    });
    T.it('no MC toss-up stem exceeds 25 words (excludes W/X/Y/Z options)', () => {
      const tooLong = window.QuestionBank.concepts
        .filter((c) => c._source === 'seed')
        .flatMap((c) => c.tossup_variants || [])
        .filter((v) => v.type === 'multiple_choice')
        .filter((v) => {
          const stem = v.question.split(/W\)/)[0];
          return stem.split(/\s+/).filter(Boolean).length > 25;
        });
      T.assertEqual(tooLong.length, 0, `${tooLong.length} MC stems exceed 25 words`);
    });
  });
})();
