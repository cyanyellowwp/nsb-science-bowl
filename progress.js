// Progress tracking module — per-match and per-attempt history,
// persisted to localStorage. Computes longitudinal aggregates for the dashboard.
//
// Storage shape (schema v1):
// {
//   schema_version: 1,
//   player_id: 'default',
//   matches: [
//     {
//       id: 'm-...',
//       started_at: ISO,
//       ended_at: ISO | null,
//       mode: 'solo' | 'two-team',
//       player_name: string | null,
//       team_names: { 1: string, 2: string } | null,
//       team_scores: { 1: number, 2: number } | null,
//       final_score: number,
//       completed: bool,
//       attempts: [
//         {
//           round_idx, concept_id, variant_id,
//           category, subcategory, tags,
//           phase: 'tossup' | 'bonus',
//           question_type: 'multiple_choice' | 'short_answer',
//           response: string,
//           correct: bool,
//           needs_review: bool,
//           confidence: number,
//           source: 'llm' | 'rule' | 'manual',
//           team: 1 | 2 | null,
//           recorded_at: ISO,
//         }
//       ]
//     }
//   ]
// }

(() => {
  'use strict';

  const STORAGE_KEY = 'science-bowl-progress';
  const SCHEMA_VERSION = 1;

  const Progress = {
    data: null,

    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          this.data = JSON.parse(raw);
          if (!this.data || typeof this.data !== 'object' || !Array.isArray(this.data.matches)) {
            throw new Error('invalid stored shape');
          }
          // Future: schema migrations here
        } else {
          this._reset();
        }
      } catch (e) {
        console.warn('Progress: corrupt or missing data, resetting:', e.message);
        this._reset();
      }
    },

    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      } catch (e) {
        console.warn('Progress: save failed (storage full?)', e);
      }
    },

    _reset() {
      this.data = { schema_version: SCHEMA_VERSION, player_id: 'default', matches: [] };
    },

    /** Begin a new match. Returns the match id. */
    startMatch(opts) {
      this.load(); // refresh in case another tab wrote
      const id = 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const match = {
        id,
        started_at: new Date().toISOString(),
        ended_at: null,
        mode: opts.mode,
        player_name: opts.playerName || null,
        team_names: opts.teamNames || null,
        team_scores: opts.teamNames ? { 1: 0, 2: 0 } : null,
        final_score: 0,
        completed: false,
        attempts: [],
      };
      this.data.matches.push(match);
      this.save();
      return id;
    },

    /** Record one answer attempt during an active match. */
    recordAttempt(matchId, attempt) {
      if (!matchId) return;
      const match = this._findMatch(matchId);
      if (!match) return;
      match.attempts.push({
        ...attempt,
        recorded_at: new Date().toISOString(),
      });
      this.save();
    },

    /** Mark a match complete and persist final state. */
    endMatch(matchId, finalState) {
      if (!matchId) return;
      const match = this._findMatch(matchId);
      if (!match) return;
      match.ended_at = new Date().toISOString();
      match.completed = true;
      Object.assign(match, finalState || {});
      this.save();
    },

    _findMatch(id) {
      return this.data.matches.find((m) => m.id === id);
    },

    // ---------------- Aggregations (read-only, computed on demand) -----------

    overallStats() {
      const completed = this.data.matches.filter((m) => m.completed);
      const allAttempts = completed.flatMap((m) => m.attempts);
      const correct = allAttempts.filter((a) => a.correct).length;
      const tossups = allAttempts.filter((a) => a.phase === 'tossup');
      const bonuses = allAttempts.filter((a) => a.phase === 'bonus');
      return {
        totalMatches: completed.length,
        soloMatches: completed.filter((m) => m.mode === 'solo').length,
        twoTeamMatches: completed.filter((m) => m.mode === 'two-team').length,
        totalAttempts: allAttempts.length,
        correct,
        accuracy: allAttempts.length ? correct / allAttempts.length : 0,
        tossupAccuracy: tossups.length ? tossups.filter((a) => a.correct).length / tossups.length : 0,
        bonusAccuracy: bonuses.length ? bonuses.filter((a) => a.correct).length / bonuses.length : 0,
        bestScore: Math.max(0, ...completed.map((m) => m.final_score || 0)),
        firstPlayed: completed.length ? completed[0].started_at : null,
        lastPlayed: completed.length ? completed[completed.length - 1].started_at : null,
      };
    },

    accuracyByCategory() {
      const map = new Map();
      for (const m of this.data.matches) {
        for (const a of m.attempts) {
          const key = a.category || 'Unknown';
          const s = map.get(key) || { category: key, attempts: 0, correct: 0 };
          s.attempts += 1;
          if (a.correct) s.correct += 1;
          map.set(key, s);
        }
      }
      return [...map.values()]
        .map((s) => ({ ...s, accuracy: s.attempts ? s.correct / s.attempts : 0 }))
        .sort((a, b) => b.attempts - a.attempts);
    },

    accuracyByConcept() {
      const map = new Map();
      for (const m of this.data.matches) {
        for (const a of m.attempts) {
          const key = a.concept_id || 'unknown';
          const s = map.get(key) || {
            concept_id: key,
            category: a.category,
            subcategory: a.subcategory,
            tags: a.tags || [],
            attempts: 0,
            correct: 0,
            recent: [],
            last_attempted: null,
            last_response: null,
          };
          s.attempts += 1;
          if (a.correct) s.correct += 1;
          s.recent.push(a.correct);
          if (s.recent.length > 5) s.recent.shift();
          s.last_attempted = a.recorded_at || m.ended_at || m.started_at;
          s.last_response = a.response;
          map.set(key, s);
        }
      }
      return [...map.values()].map((s) => ({
        ...s,
        accuracy: s.attempts ? s.correct / s.attempts : 0,
        mastery: this._calcMastery(s),
      }));
    },

    /**
     * Mastery taxonomy:
     * - mastered:   ≥3 attempts AND last 3 all correct
     * - learning:   ≥1 correct AND not mastered
     * - needs_work: ≥2 attempts AND <50% accuracy
     * - struggling: ≥1 attempt AND 0 correct
     * - untouched:  never seen
     */
    _calcMastery(s) {
      if (s.attempts >= 3 && s.recent.slice(-3).every((c) => c === true)) return 'mastered';
      if (s.attempts >= 2 && s.correct / s.attempts < 0.5 && s.correct > 0) return 'needs_work';
      if (s.attempts >= 1 && s.correct === 0) return 'struggling';
      if (s.correct >= 1) return 'learning';
      return 'untouched';
    },

    /**
     * Cross-reference with the loaded question bank to surface concepts the
     * kid has never attempted (so the dashboard can show "untouched" too).
     */
    conceptsWithBank(bankConcepts) {
      const stats = new Map(this.accuracyByConcept().map((c) => [c.concept_id, c]));
      for (const c of bankConcepts || []) {
        if (!stats.has(c.id)) {
          stats.set(c.id, {
            concept_id: c.id,
            category: c.category,
            subcategory: c.subcategory,
            tags: c.tags || [],
            attempts: 0,
            correct: 0,
            accuracy: 0,
            recent: [],
            last_attempted: null,
            last_response: null,
            mastery: 'untouched',
          });
        }
      }
      return [...stats.values()];
    },

    /** Last N completed matches, oldest first (suited for trend charts). */
    matchTrend(n) {
      const completed = this.data.matches.filter((m) => m.completed);
      const recent = completed.slice(-Math.max(1, n || 10));
      return recent.map((m) => {
        const total = m.attempts.length;
        const correct = m.attempts.filter((a) => a.correct).length;
        const score = m.final_score || (m.team_scores ? Math.max(...Object.values(m.team_scores)) : 0);
        return {
          id: m.id,
          started_at: m.started_at,
          mode: m.mode,
          accuracy: total ? correct / total : 0,
          score,
          attempts: total,
        };
      });
    },

    /** Last N completed matches, newest first (suited for a list view). */
    recentMatches(n) {
      return this.data.matches.filter((m) => m.completed).slice(-Math.max(1, n || 10)).reverse();
    },

    clear() {
      this._reset();
      this.save();
    },

    exportJson() {
      return JSON.stringify(this.data, null, 2);
    },

    importJson(text) {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.matches)) throw new Error('invalid file');
      this.data = parsed;
      this.save();
    },
  };

  Progress.load();
  window.Progress = Progress;
})();
