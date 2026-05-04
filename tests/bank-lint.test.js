// Browser-side bank lint tests.
//
// Runs the same content-quality checks as scripts/lint_questions.py against
// the LIVE merged bank in the browser. Catches regressions that slip past
// the build-time linter (e.g., an LLM-generated variant added at runtime
// that has answer leakage).
//
// Each test is a structural check on window.QuestionBank — fails if the
// bank contains corrupted entries.

(() => {
  if (typeof T === 'undefined') return;

  // Keep these patterns in sync with scripts/lint_questions.py
  const ANSWER_LEAKAGE = /\b(?:ANSWER|ANWER|ANSER|ANSWE)\s*:/i;
  const QUESTION_MARKERS = /\b(?:TOSS[\s-]*UP|BONUS)\s+\d+\)?/i;
  const PDF_PAGE = /(?:Round\s+\d+[A-Z]?|~+\s*Page\s+\d+|Page\s+\d+(?:\s+of\s+\d+)?)/i;
  const LITERAL_UNDEF = /\b(?:undefined|null)\b/;

  function eachVariant(bank, fn) {
    const out = [];
    for (const c of (bank.concepts || [])) {
      for (const v of (c.tossup_variants || [])) out.push(fn(v, c, 'tossup'));
      for (const v of (c.bonus_variants || [])) out.push(fn(v, c, 'bonus'));
    }
    return out.flat().filter(Boolean);
  }

  T.describe('Bank lint — live quality checks', () => {
    T.it('window.QuestionBank is loaded', () => {
      T.assert(window.QuestionBank, 'QuestionBank not exposed on window');
      T.assert(Array.isArray(window.QuestionBank.concepts), 'concepts must be an array');
      T.assert(window.QuestionBank.concepts.length > 0, 'no concepts loaded');
    });

    T.it('no question body contains ANSWER:/ANWER: leakage', () => {
      const bad = eachVariant(window.QuestionBank, (v, c) => {
        if (ANSWER_LEAKAGE.test(v.question || '')) {
          return { concept: c.id, variant: v.id, snippet: (v.question || '').slice(0, 100) };
        }
      });
      T.assertEqual(bad.length, 0, `Found ${bad.length} variants with answer-leakage in body. First: ${JSON.stringify(bad[0])}`);
    });

    T.it('no question body contains another TOSS-UP/BONUS marker', () => {
      const bad = eachVariant(window.QuestionBank, (v, c) => {
        if (QUESTION_MARKERS.test(v.question || '')) {
          return { concept: c.id, variant: v.id, snippet: (v.question || '').slice(0, 100) };
        }
      });
      T.assertEqual(bad.length, 0, `Found ${bad.length} variants with concatenated questions. First: ${JSON.stringify(bad[0])}`);
    });

    T.it('no answer contains PDF page artifacts', () => {
      const bad = eachVariant(window.QuestionBank, (v, c) => {
        if (PDF_PAGE.test(v.answer || '')) {
          return { concept: c.id, variant: v.id, snippet: v.answer };
        }
      });
      T.assertEqual(bad.length, 0, `Found ${bad.length} variants with PDF artifacts in answer. First: ${JSON.stringify(bad[0])}`);
    });

    T.it('no body or answer contains literal "undefined" or "null"', () => {
      const bad = eachVariant(window.QuestionBank, (v, c) => {
        if (LITERAL_UNDEF.test(v.question || '') || LITERAL_UNDEF.test(v.answer || '')) {
          return { concept: c.id, variant: v.id, q: (v.question || '').slice(0, 50), a: v.answer };
        }
      });
      T.assertEqual(bad.length, 0, `Found ${bad.length} variants with literal undefined/null. First: ${JSON.stringify(bad[0])}`);
    });

    T.it('every multiple-choice variant has all four W/X/Y/Z options in body', () => {
      const bad = eachVariant(window.QuestionBank, (v, c) => {
        if (v.type !== 'multiple_choice') return null;
        const body = v.question || '';
        const missing = ['W', 'X', 'Y', 'Z'].filter((L) => !new RegExp(`\\b${L}\\)`).test(body));
        if (missing.length) return { concept: c.id, variant: v.id, missing };
      });
      T.assertEqual(bad.length, 0, `${bad.length} MC variants missing options. First: ${JSON.stringify(bad[0])}`);
    });

    T.it('every multiple-choice answer is a single letter W/X/Y/Z', () => {
      const bad = eachVariant(window.QuestionBank, (v, c) => {
        if (v.type !== 'multiple_choice') return null;
        if (!/^[WXYZ]$/.test((v.answer || '').trim().toUpperCase())) {
          return { concept: c.id, variant: v.id, answer: v.answer };
        }
      });
      T.assertEqual(bad.length, 0, `${bad.length} MC answers aren't W/X/Y/Z. First: ${JSON.stringify(bad[0])}`);
    });

    T.it('no concept has 0 tossup_variants or 0 bonus_variants', () => {
      const bad = (window.QuestionBank.concepts || []).filter((c) =>
        !(c.tossup_variants && c.tossup_variants.length) ||
        !(c.bonus_variants && c.bonus_variants.length)
      );
      T.assertEqual(bad.length, 0, `${bad.length} concepts missing variants`);
    });

    T.it('no answer is unreasonably long (>200 chars suggests garbage)', () => {
      const bad = eachVariant(window.QuestionBank, (v, c) => {
        if ((v.answer || '').length > 200) {
          return { concept: c.id, variant: v.id, len: v.answer.length };
        }
      });
      T.assertEqual(bad.length, 0, `${bad.length} variants with absurdly long answers. First: ${JSON.stringify(bad[0])}`);
    });
  });
})();
