// Tests for the rule-based Judge in agent.js
// These cover the bio/chem thesaurus, stemming, abbreviations, number-word
// equivalence, and explicit-rejection cases that surfaced during the build.

(() => {
  if (typeof T === 'undefined' || typeof Judge === 'undefined') return;

  T.describe('Judge: synonym matching', () => {
    T.it('accepts "homologies" for "Homologous structures"', () => {
      const v = Judge.judge('homologies', { type: 'short_answer', answer: 'Homologous structures' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
    T.it('accepts "darwinian selection" for "Natural selection"', () => {
      const v = Judge.judge('darwinian selection', { type: 'short_answer', answer: 'Natural selection' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
    T.it('accepts "internal regulation" for "Homeostasis"', () => {
      const v = Judge.judge('internal regulation', { type: 'short_answer', answer: 'Homeostasis' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
    T.it('accepts "inert gases" for "Noble gases"', () => {
      const v = Judge.judge('inert gases', { type: 'short_answer', answer: 'Noble gases' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
    T.it('accepts "wallace" for "Alfred Russel Wallace" (last-name shortcut)', () => {
      const v = Judge.judge('wallace', { type: 'short_answer', answer: 'Alfred Russel Wallace' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
  });

  T.describe('Judge: number words ↔ digits', () => {
    T.it('accepts "eight" for "8"', () => {
      const v = Judge.judge('eight', { type: 'short_answer', answer: '8' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
    T.it('accepts "8" for "eight"', () => {
      const v = Judge.judge('8', { type: 'short_answer', answer: 'eight' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
    T.it('accepts "ten" for "10"', () => {
      const v = Judge.judge('ten', { type: 'short_answer', answer: '10' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
  });

  T.describe('Judge: abbreviations', () => {
    T.it('accepts "DNA" for "deoxyribonucleic acid"', () => {
      const v = Judge.judge('DNA', { type: 'short_answer', answer: 'deoxyribonucleic acid' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
  });

  T.describe('Judge: singular/plural and stems', () => {
    T.it('accepts "isotope" for "Isotopes"', () => {
      const v = Judge.judge('isotope', { type: 'short_answer', answer: 'Isotopes' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
    T.it('accepts "covalent" for "Covalent bond"', () => {
      const v = Judge.judge('covalent', { type: 'short_answer', answer: 'Covalent bond' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
  });

  T.describe('Judge: explicit rejections (anti-cheat)', () => {
    T.it('rejects "genetic drift" as "Natural selection"', () => {
      const v = Judge.judge('genetic drift', { type: 'short_answer', answer: 'Natural selection' });
      T.assert(!v.correct, `expected incorrect, got correct (${v.reason})`);
    });
    T.it('rejects "analogous" as "Homologous structures"', () => {
      const v = Judge.judge('analogous', { type: 'short_answer', answer: 'Homologous structures' });
      T.assert(!v.correct, `expected incorrect, got correct (${v.reason})`);
    });
  });

  T.describe('Judge: multiple choice', () => {
    T.it('accepts the correct letter', () => {
      const v = Judge.judge('X', { type: 'multiple_choice', answer: 'X', answer_text: 'Molecule' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
    T.it('rejects a wrong letter', () => {
      const v = Judge.judge('W', { type: 'multiple_choice', answer: 'X', answer_text: 'Molecule' });
      T.assert(!v.correct, `expected incorrect, got correct`);
    });
    T.it('accepts verbal answer matching answer_text', () => {
      const v = Judge.judge('molecule', { type: 'multiple_choice', answer: 'X', answer_text: 'Molecule' });
      T.assert(v.correct, `expected correct, got ${v.reason}`);
    });
  });
})();
