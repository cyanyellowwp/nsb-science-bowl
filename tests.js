// Browser test harness — auto-runs `tests/<feature>.test.js` modules
// when the page is loaded with `?tests=1`. Prints a pass/fail table to the
// console and exposes `window.__TESTS__` with the results.
//
// Usage in a test module:
//
//   T.describe('Judge: synonym matching', () => {
//     T.it('accepts "homologies" for "Homologous structures"', () => {
//       const v = Judge.judge('homologies', { type: 'short_answer', answer: 'Homologous structures' });
//       T.assert(v.correct, 'expected correct, got ' + v.reason);
//     });
//   });
//
// To run: open http://localhost:8766/?tests=1 — see results in DevTools console.
// To run programmatically: T.run() from any test file or eval.

(() => {
  'use strict';

  const T = {
    suites: [],
    _currentSuite: null,
    results: null,

    describe(name, fn) {
      const suite = { name, tests: [] };
      this.suites.push(suite);
      this._currentSuite = suite;
      try { fn(); } catch (e) {
        suite.tests.push({ name: '<setup>', pass: false, error: e.message || String(e) });
      } finally {
        this._currentSuite = null;
      }
    },

    it(name, fn) {
      if (!this._currentSuite) throw new Error('T.it() must be inside T.describe()');
      this._currentSuite.tests.push({ name, fn });
    },

    assert(cond, msg) {
      if (!cond) throw new Error(msg || 'assertion failed');
    },

    assertEqual(a, b, msg) {
      const ok = JSON.stringify(a) === JSON.stringify(b);
      if (!ok) throw new Error(msg ? msg + ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}` : `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
    },

    assertContains(haystack, needle, msg) {
      if (!String(haystack).includes(needle)) {
        throw new Error(msg || `expected to contain "${needle}", got "${haystack}"`);
      }
    },

    /** Run all registered suites synchronously; collects + prints results. */
    run() {
      const results = { suites: [], passed: 0, failed: 0, total: 0 };
      console.group('🧪 Test run');
      for (const suite of this.suites) {
        const suiteResult = { name: suite.name, tests: [], passed: 0, failed: 0 };
        console.group(suite.name);
        for (const t of suite.tests) {
          if (t.pass === false) {
            // setup error
            suiteResult.tests.push({ name: t.name, pass: false, error: t.error });
            suiteResult.failed += 1;
            console.error(`  ✗ ${t.name}: ${t.error}`);
            continue;
          }
          try {
            t.fn();
            suiteResult.tests.push({ name: t.name, pass: true });
            suiteResult.passed += 1;
            console.log(`  ✓ ${t.name}`);
          } catch (e) {
            suiteResult.tests.push({ name: t.name, pass: false, error: e.message || String(e) });
            suiteResult.failed += 1;
            console.error(`  ✗ ${t.name}: ${e.message || e}`);
          }
        }
        console.groupEnd();
        results.suites.push(suiteResult);
        results.passed += suiteResult.passed;
        results.failed += suiteResult.failed;
        results.total += suiteResult.tests.length;
      }
      console.groupEnd();
      const summary = `${results.passed}/${results.total} passed${results.failed ? ` · ${results.failed} FAILED` : ''}`;
      if (results.failed) console.error('🧪 ' + summary);
      else console.log('🧪 ' + summary);
      this.results = results;
      window.__TESTS__ = results;
      return results;
    },

    /** Reset state — useful for re-running tests. */
    reset() {
      this.suites = [];
      this._currentSuite = null;
      this.results = null;
    },
  };

  window.T = T;

  // Auto-run on load when ?tests=1 is in the URL.
  document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('tests')) return;
    // Discover registered test modules (each one calls T.describe()).
    // We rely on test scripts being loaded before this auto-run fires.
    // Wait one tick to let any DOM-dependent setup finish.
    await new Promise((r) => setTimeout(r, 100));
    T.run();
    // Render a tiny banner at the top so it's visible in the preview pane
    const r = T.results;
    const div = document.createElement('div');
    div.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      padding: 8px 16px; font-family: ui-monospace, monospace; font-size: 13px;
      background: ${r.failed ? '#e74c3c' : '#2ecc71'}; color: white;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;
    div.textContent = `🧪 ${r.passed}/${r.total} tests passed${r.failed ? ` · ${r.failed} FAILED — see console` : ''}`;
    document.body.prepend(div);
  });
})();
