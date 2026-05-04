// Tests for the Progress module: storage, aggregations, mastery taxonomy.
// Each test scopes its work into a sandbox by saving & restoring the storage
// key so it doesn't pollute real practice data.

(() => {
  if (typeof T === 'undefined' || typeof Progress === 'undefined') return;

  const STORAGE_KEY = 'science-bowl-progress';
  let savedRaw;

  function setup() {
    savedRaw = localStorage.getItem(STORAGE_KEY);
    Progress.clear();
  }
  function teardown() {
    if (savedRaw) localStorage.setItem(STORAGE_KEY, savedRaw);
    else localStorage.removeItem(STORAGE_KEY);
    Progress.load();
  }

  T.describe('Progress: storage round-trip', () => {
    T.it('starts a match and records attempts', () => {
      setup();
      try {
        const id = Progress.startMatch({ mode: 'solo', playerName: 'Test' });
        T.assert(id, 'startMatch should return an id');
        Progress.recordAttempt(id, {
          concept_id: 'levels-of-organization', category: 'Biology',
          phase: 'tossup', question_type: 'multiple_choice',
          response: 'X', correct: true,
        });
        Progress.endMatch(id, { final_score: 4 });
        const stats = Progress.overallStats();
        T.assertEqual(stats.totalMatches, 1);
        T.assertEqual(stats.totalAttempts, 1);
        T.assertEqual(stats.correct, 1);
      } finally {
        teardown();
      }
    });
  });

  T.describe('Progress: mastery taxonomy', () => {
    T.it('marks 3-correct-in-a-row as mastered', () => {
      setup();
      try {
        const id = Progress.startMatch({ mode: 'solo' });
        for (let i = 0; i < 3; i++) {
          Progress.recordAttempt(id, {
            concept_id: 'levels-of-organization', category: 'Biology',
            phase: 'tossup', response: 'X', correct: true,
          });
        }
        Progress.endMatch(id, { final_score: 12 });
        const concepts = Progress.accuracyByConcept();
        const c = concepts.find((x) => x.concept_id === 'levels-of-organization');
        T.assert(c, 'concept should be present');
        T.assertEqual(c.mastery, 'mastered');
      } finally {
        teardown();
      }
    });
    T.it('marks 0/2 as struggling', () => {
      setup();
      try {
        const id = Progress.startMatch({ mode: 'solo' });
        for (let i = 0; i < 2; i++) {
          Progress.recordAttempt(id, {
            concept_id: 'emergent-properties', category: 'Biology',
            phase: 'tossup', response: 'banana', correct: false,
          });
        }
        Progress.endMatch(id, { final_score: 0 });
        const concepts = Progress.accuracyByConcept();
        const c = concepts.find((x) => x.concept_id === 'emergent-properties');
        T.assertEqual(c.mastery, 'struggling');
      } finally {
        teardown();
      }
    });
    T.it('marks 1/3 (33%) as needs_work', () => {
      setup();
      try {
        const id = Progress.startMatch({ mode: 'solo' });
        Progress.recordAttempt(id, { concept_id: 'darwin-natural-selection', phase: 'tossup', correct: true, response: 'darwin' });
        Progress.recordAttempt(id, { concept_id: 'darwin-natural-selection', phase: 'tossup', correct: false, response: 'mendel' });
        Progress.recordAttempt(id, { concept_id: 'darwin-natural-selection', phase: 'tossup', correct: false, response: 'lamarck' });
        Progress.endMatch(id, { final_score: 4 });
        const c = Progress.accuracyByConcept().find((x) => x.concept_id === 'darwin-natural-selection');
        T.assertEqual(c.mastery, 'needs_work');
      } finally {
        teardown();
      }
    });
  });

  T.describe('Progress: untouched concepts via bank cross-reference', () => {
    T.it('reports concepts in the bank that have no attempts', () => {
      setup();
      try {
        const id = Progress.startMatch({ mode: 'solo' });
        Progress.recordAttempt(id, { concept_id: 'A', category: 'X', phase: 'tossup', correct: true });
        Progress.endMatch(id, { final_score: 4 });
        const bank = [{ id: 'A', category: 'X' }, { id: 'B', category: 'X' }, { id: 'C', category: 'X' }];
        const all = Progress.concceptsWithBank(bank);
        T.assertEqual(all.length, 3);
        const untouched = all.filter((c) => c.mastery === 'untouched').map((c) => c.concept_id).sort();
        T.assertEqual(untouched, ['B', 'C']);
      } finally {
        teardown();
      }
    });
  });

  T.describe('Progress: trend chart data', () => {
    T.it('returns last N completed matches in chronological order', () => {
      setup();
      try {
        for (let i = 0; i < 4; i++) {
          const id = Progress.startMatch({ mode: 'solo' });
          Progress.recordAttempt(id, { concept_id: 'A', phase: 'tossup', correct: i % 2 === 0 });
          Progress.endMatch(id, { final_score: i * 4 });
        }
        const trend = Progress.matchTrend(3);
        T.assertEqual(trend.length, 3);
        T.assert(trend[0].started_at <= trend[2].started_at, 'should be chronological');
      } finally {
        teardown();
      }
    });
  });
})();
