// Science Bowl Practice — Two-team & Solo modes, with optional Agentic Moderator.
// Game rules grounded in RULES.md (DOE 2026 NSB Official Rules).

(() => {
  'use strict';

  const TOSSUP_SECONDS = 5;
  const BONUS_SECONDS = 20;
  const FREESHOT_SECONDS = 5;     // Rule 3-8: opposing team's free shot after wrong toss-up
  const TOSSUP_POINTS = 4;
  const BONUS_POINTS = 10;

  // ---------------- App state ----------------
  const App = {
    rounds: [],            // active match's randomized round list (built at startMatch)
    bank: null,            // merged superset: seed + external sources + generated
    seed: null,            // hand-curated seed bank (questions.json)
    corpora: [],           // loaded source banks from content-sources.json
    sourceMeta: [],        // [{id,label,count}]
    mode: null,            // 'two-team' | 'solo'
    agentEnabled: false,
    agentDriving: false,
    matchOpts: {           // chosen on setup; consumed by buildRoundsFromBank
      source: 'all',       // 'seed' | 'corpus' | 'all'
      length: 25,
      topic: 'all',        // 'all' | 'ch1' | 'ch2' | 'doe-corpus'
      year: 'all',         // 'all' | '2015' .. '2022'
      subject: 'all',      // 'all' | 'biology' | 'physical_science'
    },
    game: null,
  };

  const $ = (id) => document.getElementById(id);

  // ---------------- Boot ----------------
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const v = '?v=' + Date.now();
      const [seedRes, sourcesRes] = await Promise.all([
        fetch('questions.json' + v, { cache: 'no-store' }),
        fetch('content-sources.json' + v, { cache: 'no-store' }).catch(() => null),
      ]);
      App.seed = await seedRes.json();
      const sourceConfig = sourcesRes && sourcesRes.ok ? await sourcesRes.json() : null;
      App.corpora = await loadConfiguredSources(sourceConfig, v);
      App.sourceMeta = App.corpora.map((s) => ({ id: s.id, label: s.label, count: (s.data.concepts || []).length }));
      App.bank = mergeBanks(App.seed, App.corpora);
      window.QuestionBank = App.bank;
      const seedN = (App.seed.concepts || App.seed.rounds || []).length;
      const corpusN = App.corpora.reduce((n, s) => n + ((s.data.concepts || []).length), 0);
      console.info(`Loaded bank: ${seedN} seed + ${corpusN} external = ${App.bank.concepts.length} concepts`);
    } catch (err) {
      console.error('Failed to load questions:', err);
      alert('Could not load question banks. Serve over http (a server is already running).');
      return;
    }

    bindSetup();
    bindAgentOverlay();
  }

  /** Merge the seed (v1 or v2) and external source banks (v2) into one v2 bank. */
  function mergeBanks(seed, sourceBanks) {
    const concepts = [];
    if (seed) {
      if (Array.isArray(seed.concepts)) {
        for (const c of seed.concepts) concepts.push({ ...c, _source: 'seed' });
      } else if (Array.isArray(seed.rounds)) {
        for (const r of seed.rounds) {
          concepts.push({
            id: 'seed-' + r.id,
            category: r.category,
            tags: ['seed'],
            tossup_variants: [{ id: `tu-seed-${r.id}`, ...r.tossup }],
            bonus_variants: [{ id: `bo-seed-${r.id}`, ...r.bonus }],
            _source: 'seed',
          });
        }
      }
    }
    for (const src of sourceBanks || []) {
      if (!src || !src.data || !Array.isArray(src.data.concepts)) continue;
      for (const c of src.data.concepts) {
        concepts.push({
          ...c,
          subject: c.subject || inferSubject(c),
          _source: src.id || 'corpus',
        });
      }
    }
    // Merge any LLM-generated variants the user has accumulated locally
    if (window.Generator) {
      for (const c of Generator.getCachedConcepts()) concepts.push({ ...c, _source: 'generated' });
    }
    return {
      schema_version: '2.0',
      source: 'merged: seed + external corpora + generated',
      concepts,
    };
  }

  /** Re-merge banks (e.g., after Generator adds new variants). */
  function refreshBank() {
    App.bank = mergeBanks(App.seed, App.corpora);
    window.QuestionBank = App.bank;
    updateSourceInfo();
  }

  async function loadConfiguredSources(config, cacheBust) {
    const fallback = [{ id: 'corpus', label: 'DOE NSB corpus', path: 'corpus-doe.json', enabled: true }];
    const sources = config && Array.isArray(config.sources) && config.sources.length ? config.sources : fallback;
    const loaded = [];
    for (const src of sources) {
      if (src && src.enabled === false) continue;
      const id = (src && src.id) || 'corpus';
      const label = (src && src.label) || id;
      const path = (src && src.path) || 'corpus-doe.json';
      try {
        const res = await fetch(path + cacheBust, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = await res.json();
        if (!Array.isArray(data.concepts)) continue;
        loaded.push({ id, label, path, data });
      } catch (_) {}
    }
    return loaded;
  }

  function inferSubject(concept) {
    const hay = `${concept.category || ''} ${(concept.tags || []).join(' ')}`.toLowerCase();
    return hay.includes('physical') ? 'physical_science' : 'biology';
  }

  /**
   * Pick `length` rounds from the merged bank, applying source + topic filters
   * and shuffling. For each chosen concept, randomly select one toss-up and
   * one bonus variant. Returns a flat round list.
   */
  /**
   * Build a Map<conceptId, {attempts, lastAttempted}> from Progress data.
   * Used by buildRoundsFromBank for "unseen first" rotation. If Progress
   * isn't loaded yet, returns an empty Map (everything is "unseen").
   */
  function getSeenMap() {
    if (!window.Progress || !Progress.accuracyByConcept) return new Map();
    const map = new Map();
    try {
      for (const c of Progress.accuracyByConcept()) {
        map.set(c.concept_id, {
          attempts: c.attempts || 0,
          lastAttempted: c.last_attempted || '',
        });
      }
    } catch (e) {
      console.warn('getSeenMap failed:', e);
    }
    return map;
  }

  /**
   * Pick `length` rounds from the bank with "unseen first" rotation.
   *
   * Algorithm:
   *   1. Filter by source/topic/year (existing behavior).
   *   2. Partition the filtered pool into UNSEEN (no attempt history) and
   *      SEEN (attempt history) sub-pools.
   *   3. Shuffle UNSEEN; sort SEEN by (attempts asc, lastAttempted asc).
   *   4. Take from UNSEEN first. If short, fill from SEEN starting with
   *      least-attempted + oldest-attempted.
   *   5. Shuffle the final list so the match order varies.
   *
   * Effect: with a 236-concept bank and 25-round matches, the kid won't see
   * a repeated question until they've completed all 236 (≈9.4 matches). After
   * a full cycle, repeats come back in the order they were first played
   * (oldest first), naturally pacing review.
   */
  function buildRoundsFromBank(bank, opts) {
    opts = opts || {};
    const length = opts.length || 25;
    const source = opts.source || 'all';
    const topic = opts.topic || 'all';
    const year = opts.year || 'all';
    const subject = opts.subject || 'all';

    let pool = bank.concepts.slice();

    if (source === 'seed') pool = pool.filter((c) => c._source === 'seed');
    if (source === 'corpus') pool = pool.filter((c) => c._source !== 'seed');

    if (topic !== 'all') {
      pool = pool.filter((c) => Array.isArray(c.tags) && c.tags.includes(topic));
    }

    // Year filter — applies only to corpus concepts (which have a `source.year` and a year tag)
    if (year !== 'all') {
      pool = pool.filter((c) => Array.isArray(c.tags) && c.tags.includes(year));
    }
    if (subject !== 'all') {
      pool = pool.filter((c) => (c.subject || inferSubject(c)) === subject);
    }

    if (!pool.length) {
      console.warn('No concepts match filters; falling back to full bank');
      pool = bank.concepts.slice();
    }

    // Rotation: prefer unseen concepts, then least-seen / oldest-seen
    const seen = getSeenMap();
    const unseen = pool.filter((c) => !seen.has(c.id));
    const seenPool = pool.filter((c) => seen.has(c.id));

    shuffle(unseen);
    seenPool.sort((a, b) => {
      const sa = seen.get(a.id);
      const sb = seen.get(b.id);
      if (sa.attempts !== sb.attempts) return sa.attempts - sb.attempts;     // less-seen wins
      return (sa.lastAttempted < sb.lastAttempted) ? -1 :                    // older wins
             (sa.lastAttempted > sb.lastAttempted) ? 1 : 0;
    });

    let chosen = unseen.slice(0, length);
    if (chosen.length < length) {
      chosen = chosen.concat(seenPool.slice(0, length - chosen.length));
    }
    // Shuffle final order so the match doesn't predictably start with all-new
    shuffle(chosen);

    return chosen.map((concept, idx) => ({
      id: idx + 1,
      conceptId: concept.id,
      category: concept.category,
      subcategory: concept.subcategory || null,
      tags: concept.tags || [],
      source: concept._source || 'seed',
      tossup: pickRandom(concept.tossup_variants),
      bonus: pickRandom(concept.bonus_variants),
    })).filter((r) => r.tossup && r.bonus);
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pickRandom(arr) {
    if (!arr || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // ---------------- Setup screen ----------------
  function bindSetup() {
    document.querySelectorAll('.mode-card').forEach((card) => {
      card.addEventListener('click', () => selectMode(card.dataset.mode));
    });

    // Agent enable
    const agentCheck = $('agent-enable');
    agentCheck.addEventListener('change', () => {
      App.agentEnabled = agentCheck.checked;
      if (agentCheck.checked) {
        Agent.enable();
        $('agent-voice-controls').classList.remove('hidden');
        populateVoiceList();
        if (window.speechSynthesis) {
          window.speechSynthesis.onvoiceschanged = populateVoiceList;
        }
      } else {
        Agent.disable();
        $('agent-voice-controls').classList.add('hidden');
      }
    });

    bindVoiceControls();
    bindLlmConfig();

    $('start-btn').addEventListener('click', startMatch);
    $('restart-btn').addEventListener('click', () => location.reload());
    const setupDashBtn = $('setup-dashboard-btn');
    if (setupDashBtn) setupDashBtn.addEventListener('click', () => Dashboard.show());
    const resultsDashBtn = $('results-dashboard-btn');
    if (resultsDashBtn) resultsDashBtn.addEventListener('click', () => Dashboard.show());
  }

  function populateVoiceList() {
    const sel = $('agent-voice');
    if (!sel) return;
    const voices = Agent.listVoices();
    if (!voices.length) {
      sel.innerHTML = '<option value="">No voices available</option>';
      $('agent-voice-info').textContent = '⚠ No English voices found in this browser.';
      return;
    }
    const curated = curateTopVoices(voices, 5);
    sel.innerHTML = curated.map((v) => {
      const tags = [];
      if (v.isHighQuality) tags.push('Premium');
      else if (v.isEnhanced) tags.push('Enhanced');
      const tagStr = tags.length ? ` · ${tags.join(', ')}` : '';
      return `<option value="${escapeAttr(v.name)}">${escapeAttr(v.name)} (${v.lang})${tagStr}</option>`;
    }).join('');
    // Honor saved preference, else auto-pick top-ranked
    sel.value = Agent.voiceName || curated[0].name;
    Agent.setVoiceByName(sel.value);
    updateVoiceInfo();
  }

  function curateTopVoices(voices, maxCount) {
    const ranked = voices.slice();
    const picks = [];
    const used = new Set();

    const add = (v) => {
      if (!v || used.has(v.name)) return;
      used.add(v.name);
      picks.push(v);
    };

    // Must-have preference #1: Samantha
    add(ranked.find((v) => /\bSamantha\b/i.test(v.name)));
    // Must-have preference #2: one Google voice
    add(ranked.find((v) => /\bGoogle\b/i.test(v.name)));

    for (const v of ranked) {
      if (picks.length >= maxCount) break;
      add(v);
    }
    return picks.slice(0, maxCount);
  }

  function updateVoiceInfo() {
    const v = Agent.voice;
    if (!v) return;
    const tag = /\b(Premium|Enhanced|Neural|Natural)\b/i.test(v.name)
      ? '✓ Recommended quality'
      : (v.localService ? 'Local voice' : 'Cloud voice');
    $('agent-voice-info').textContent = `Selected: ${v.name} · ${tag}`;
  }

  function bindVoiceControls() {
    const sel = $('agent-voice');
    const rate = $('agent-rate');
    const rateValue = $('agent-rate-value');
    const test = $('agent-test-btn');
    const testMc = $('agent-test-mc-btn');
    if (!sel || !rate) return;

    // Restore saved rate
    Agent.loadPrefs();
    rate.value = Agent.rate;
    rateValue.textContent = Number(Agent.rate).toFixed(2) + '×';

    sel.addEventListener('change', () => {
      Agent.setVoiceByName(sel.value);
      updateVoiceInfo();
    });

    rate.addEventListener('input', () => {
      Agent.setRate(rate.value);
      rateValue.textContent = Number(rate.value).toFixed(2) + '×';
    });

    test.addEventListener('click', async () => {
      Agent.cancel();
      await sleep(120);
      Agent.speak('Hello! I am your Science Bowl moderator. Press Read Question, then buzz in when you know the answer.');
    });

    testMc.addEventListener('click', async () => {
      Agent.cancel();
      await sleep(120);
      const sample = 'Which of the following lists the levels of biological organization in the correct order from smallest to largest? W) Cell, tissue, organ, organism. X) Molecule, organelle, cell, tissue. Y) Atom, organelle, organ, cell. Z) Tissue, cell, organ, population.';
      Agent.speakQuestion(sample);
    });
  }

  function escapeAttr(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function bindLlmConfig() {
    if (!window.LLMJudge) return;

    // Populate model selector, grouped by provider. Order: Google first
    // (free-tier Flash should be the very first option), then Anthropic, then
    // OpenAI.
    const sel = $('llm-model');
    sel.innerHTML = '';
    const models = LLMJudge.listModels();
    const groups = {
      google: 'Google (Gemini)',
      anthropic: 'Anthropic (Claude)',
      openai: 'OpenAI (GPT)',
    };
    Object.keys(groups).forEach((prov) => {
      const list = models.filter((m) => (m.provider || 'anthropic') === prov);
      if (!list.length) return;
      const og = document.createElement('optgroup');
      og.label = groups[prov];
      list.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.key;
        opt.textContent = m.label;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    sel.value = LLMJudge.model;
    updateModelCost();
    updateProviderUi();
    sel.addEventListener('change', () => {
      LLMJudge.model = sel.value;
      LLMJudge.saveConfig();
      updateModelCost();
      updateProviderUi();
    });

    // Restore stored values for all providers.
    $('llm-key-anthropic').value = LLMJudge.anthropicKey || '';
    $('llm-key-openai').value = LLMJudge.openaiKey || '';
    $('llm-key-google').value = LLMJudge.googleKey || '';
    $('llm-enable').checked = LLMJudge.enabled;
    if (LLMJudge.enabled) $('llm-config').classList.remove('hidden');

    // Render guardrails list
    const ol = $('guardrails-list');
    ol.innerHTML = '';
    LLMJudge.guardrails.forEach((g) => {
      const li = document.createElement('li');
      li.textContent = g;
      ol.appendChild(li);
    });

    $('llm-enable').addEventListener('change', (e) => {
      LLMJudge.enabled = e.target.checked;
      LLMJudge.saveConfig();
      $('llm-config').classList.toggle('hidden', !LLMJudge.enabled);
    });

    const handleKeyInput = (prov, inputEl) => {
      const result = LLMJudge.setKeyForProvider(prov, inputEl.value);
      // Reflect the sanitized key back into the UI so the user sees what we'll send
      if (result.clean !== inputEl.value) inputEl.value = result.clean;
      if (result.stripped > 0) {
        setTestResult(
          `Note: stripped ${result.stripped} non-ASCII character(s) from your key (smart quotes / spaces / etc. won't work in HTTP headers). Re-paste from the Anthropic console if "Test key" still fails.`,
          'warn'
        );
      }
    };
    $('llm-key-anthropic').addEventListener('change', (e) => handleKeyInput('anthropic', e.target));
    $('llm-key-openai').addEventListener('change', (e) => handleKeyInput('openai', e.target));
    $('llm-key-google').addEventListener('change', (e) => handleKeyInput('google', e.target));

    $('llm-clear-btn').addEventListener('click', () => {
      // Clears only the key for the currently selected model's provider.
      const prov = providerForCurrentModel();
      LLMJudge.clearKey();
      if (prov === 'openai') $('llm-key-openai').value = '';
      else if (prov === 'google') $('llm-key-google').value = '';
      else $('llm-key-anthropic').value = '';
      $('llm-enable').checked = false;
      $('llm-config').classList.add('hidden');
      setTestResult(`${providerLabel(prov)} key cleared.`, 'success');
    });

    bindMockUi();
    bindGeneratorUi();

    $('llm-test-btn').addEventListener('click', async () => {
      const prov = providerForCurrentModel();
      const inputId = prov === 'openai'
        ? 'llm-key-openai'
        : prov === 'google'
          ? 'llm-key-google'
          : 'llm-key-anthropic';
      const inputEl = $(inputId);
      const result = LLMJudge.setKeyForProvider(prov, inputEl.value);
      if (result.clean !== inputEl.value) inputEl.value = result.clean;
      if (!result.clean) {
        setTestResult(`Enter a ${providerLabel(prov)} key first.`, 'warn');
        return;
      }
      if (result.stripped > 0) {
        setTestResult(`Cleaned ${result.stripped} non-ASCII character(s) before testing…`, 'warn');
      } else {
        setTestResult('Testing…');
      }
      try {
        const r = await LLMJudge.testKey();
        setTestResult(`✓ Connected to ${r.model}.`, 'success');
      } catch (err) {
        setTestResult(`✗ ${err.message}`, 'error');
      }
    });
  }

  function providerLabel(prov) {
    if (prov === 'openai') return 'OpenAI';
    if (prov === 'google') return 'Google';
    return 'Anthropic';
  }

  function providerForCurrentModel() {
    const m = window.LLM_MODELS && window.LLM_MODELS[LLMJudge.model];
    return (m && m.provider) || 'anthropic';
  }

  function updateProviderUi() {
    // Visually de-emphasize the field whose provider isn't currently selected.
    const prov = providerForCurrentModel();
    const aField = $('llm-key-anthropic-field');
    const oField = $('llm-key-openai-field');
    const gField = $('llm-key-google-field');
    if (aField) aField.classList.toggle('inactive-provider', prov !== 'anthropic');
    if (oField) oField.classList.toggle('inactive-provider', prov !== 'openai');
    if (gField) gField.classList.toggle('inactive-provider', prov !== 'google');
  }

  function bindMockUi() {
    const cb = $('mock-enable');
    if (!cb || !window.MockApi) return;
    cb.checked = MockApi.enabled;
    if (MockApi.enabled) decorateMockBadge(true);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        const ok = MockApi.install();
        if (!ok) {
          alert('Mock API could not install — LLMJudge not loaded.');
          cb.checked = false;
          return;
        }
        decorateMockBadge(true);
        setTestResult('🎭 Mock mode ON. LLM calls return fixtures (no spending, no key needed).', 'warn');
      } else {
        MockApi.uninstall();
        decorateMockBadge(false);
        setTestResult('Mock mode off. Using real API.', 'success');
      }
    });
  }

  function decorateMockBadge(on) {
    const llmHeader = document.querySelector('.llm-toggle h3');
    if (!llmHeader) return;
    let badge = llmHeader.querySelector('.mock-active');
    if (on) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mock-active';
        badge.textContent = '🎭 MOCK MODE';
        llmHeader.appendChild(badge);
      }
    } else if (badge) {
      badge.remove();
    }
  }

  function bindGeneratorUi() {
    if (!window.Generator) return;
    const runBtn = $('gen-run-btn');
    const clearBtn = $('gen-clear-btn');
    const status = $('gen-status');
    const results = $('gen-results');
    if (!runBtn) return;

    const updateGeneratorCounts = () => {
      const n = Generator.getCachedConcepts().length;
      results.innerHTML = n
        ? `<div class="gen-summary">📦 ${n} generated variants cached locally · available next match</div>`
        : '';
    };
    updateGeneratorCounts();

    runBtn.addEventListener('click', async () => {
      if (!window.LLMJudge || !LLMJudge.isReady()) {
        status.innerHTML = '<span class="warn">Add an API key (Anthropic or OpenAI) above first.</span>';
        return;
      }
      runBtn.disabled = true;
      const maxConcepts = parseInt($('gen-max-concepts').value, 10);
      const perConcept = parseInt($('gen-per-concept').value, 10);
      const log = [];
      const render = () => {
        status.innerHTML = log.map((l) => `<div class="${l.cls || ''}">${escapeHtml(l.text)}</div>`).join('');
      };
      log.push({ text: `Targeting ${maxConcepts} weakest concepts × ${perConcept} variants each…` });
      render();
      try {
        const made = await Generator.generateForWeakConcepts(
          { maxConcepts, perConcept },
          (p) => {
            if (p.phase === 'concept') {
              log.push({ text: `→ Concept ${p.conceptIndex}/${p.conceptTotal}: ${p.conceptId}` });
            } else if (p.phase === 'variant') {
              if (p.status === 'accepted') log.push({ text: `   ✓ variant ${p.step} accepted`, cls: 'success' });
              else if (p.status === 'rejected') log.push({ text: `   ✗ variant ${p.step} rejected: ${p.reason}`, cls: 'warn' });
              else if (p.status === 'invalid') log.push({ text: `   ✗ variant ${p.step} invalid output`, cls: 'warn' });
              else if (p.status === 'error') log.push({ text: `   ⚠ variant ${p.step} error: ${p.message}`, cls: 'danger' });
            }
            render();
          }
        );
        log.push({ text: `\nDone. ${made.length} new variants added to your bank.`, cls: 'success' });
        refreshBank();
        updateGeneratorCounts();
      } catch (err) {
        log.push({ text: '⚠ ' + err.message, cls: 'danger' });
      } finally {
        runBtn.disabled = false;
        render();
      }
    });

    clearBtn.addEventListener('click', () => {
      if (!confirm('Clear all locally generated variants?')) return;
      Generator.clear();
      refreshBank();
      updateGeneratorCounts();
      status.innerHTML = '<span class="success">Cache cleared.</span>';
    });
  }

  function updateModelCost() {
    const m = window.LLM_MODELS && window.LLM_MODELS[LLMJudge.model];
    if (!m) return;
    // ~600 input + 100 output tokens per judgment is a rough estimate
    const perJudge = (600 / 1_000_000) * m.costIn + (100 / 1_000_000) * m.costOut;
    $('llm-model-cost').textContent = `≈ $${perJudge.toFixed(4)} per judgment · $${m.costIn}/MTok in, $${m.costOut}/MTok out.`;
  }

  function setTestResult(text, cls) {
    const el = $('llm-test-result');
    el.textContent = text;
    el.className = 'support-line' + (cls ? ' ' + cls : '');
  }

  function selectMode(mode) {
    App.mode = mode;
    document.querySelectorAll('.mode-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.mode === mode);
    });
    $('setup-two-team').classList.toggle('hidden', mode !== 'two-team');
    $('setup-solo').classList.toggle('hidden', mode !== 'solo');
    $('match-options').classList.remove('hidden');
    $('agent-toggle').classList.remove('hidden');
    $('llm-toggle').classList.remove('hidden');
    $('setup-actions').classList.remove('hidden');
    updateAgentSupport();
    updateSourceInfo();
    populateYearDropdown();
    populateSubjectDropdown();
    bindMatchOptionsListeners();
  }

  function updateSourceInfo() {
    if (!App.bank) return;
    const seedN = App.bank.concepts.filter((c) => c._source === 'seed').length;
    const corpusN = App.bank.concepts.filter((c) => c._source !== 'seed').length;
    const total = App.bank.concepts.length;
    const info = $('match-source-info');
    if (info) info.textContent = `${total} concepts total · ${seedN} seed + ${corpusN} external`;
  }

  /** Populate the Year dropdown from the corpus, with per-year counts. */
  function populateYearDropdown() {
    const sel = $('match-year');
    if (!sel || !App.bank) return;
    // Count corpus concepts per year tag
    const counts = new Map();
    for (const c of App.bank.concepts) {
      if (c._source === 'seed' || !Array.isArray(c.tags)) continue;
      for (const t of c.tags) {
        if (/^20\d{2}$/.test(t)) counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const years = [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0])); // newest first
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    sel.innerHTML = `<option value="all" selected>All years (${total} pairs)</option>` +
      years.map(([y, n]) => `<option value="${y}">${y} (${n} pair${n === 1 ? '' : 's'})</option>`).join('');
  }

  function populateSubjectDropdown() {
    const sel = $('match-subject');
    if (!sel || !App.bank) return;
    const counts = { biology: 0, physical_science: 0 };
    for (const c of App.bank.concepts) {
      if (c._source === 'seed') continue;
      const s = c.subject || inferSubject(c);
      if (s === 'biology' || s === 'physical_science') counts[s] += 1;
    }
    sel.innerHTML =
      `<option value="all" selected>All subjects (${counts.biology + counts.physical_science})</option>` +
      `<option value="biology">Biology (${counts.biology})</option>` +
      `<option value="physical_science">Physical Science (${counts.physical_science})</option>`;
  }

  /** When the user changes a match option, update the live count hint. */
  function bindMatchOptionsListeners() {
    const upd = () => updateMatchCount();
    ['match-source', 'match-topic', 'match-year', 'match-subject', 'match-length'].forEach((id) => {
      const el = $(id);
      if (el && !el.dataset.bound) {
        el.addEventListener('change', upd);
        el.dataset.bound = '1';
      }
    });
    upd();
  }

  /** Live "you'll get N rounds with these filters" indicator. */
  function updateMatchCount() {
    if (!App.bank) return;
    const opts = {
      source: ($('match-source') || {}).value || 'all',
      topic: ($('match-topic') || {}).value || 'all',
      year: ($('match-year') || {}).value || 'all',
      subject: ($('match-subject') || {}).value || 'all',
      length: parseInt(($('match-length') || {}).value, 10) || 25,
    };
    // Mirror the filter logic without shuffling/slicing
    let pool = App.bank.concepts.slice();
    if (opts.source === 'seed') pool = pool.filter((c) => c._source === 'seed');
    if (opts.source === 'corpus') pool = pool.filter((c) => c._source !== 'seed');
    if (opts.topic !== 'all') pool = pool.filter((c) => Array.isArray(c.tags) && c.tags.includes(opts.topic));
    if (opts.year !== 'all') pool = pool.filter((c) => Array.isArray(c.tags) && c.tags.includes(opts.year));
    if (opts.subject !== 'all') pool = pool.filter((c) => (c.subject || inferSubject(c)) === opts.subject);

    // Compute rotation breakdown
    const seen = getSeenMap();
    const unseenCount = pool.filter((c) => !seen.has(c.id)).length;
    const seenCount = pool.length - unseenCount;
    const willPlay = Math.min(opts.length, pool.length);
    const willPlayUnseen = Math.min(unseenCount, willPlay);
    const willPlaySeen = willPlay - willPlayUnseen;

    const info = $('match-year-info');
    if (info) {
      const breakdown = seenCount > 0
        ? `${unseenCount} unseen · ${seenCount} previously seen`
        : `${unseenCount} unseen`;
      const matchPlan = willPlaySeen > 0
        ? `${willPlayUnseen} new + ${willPlaySeen} review`
        : `${willPlayUnseen} new`;
      info.innerHTML = `Pool: <strong>${pool.length}</strong> (${breakdown}). ` +
        `This match: <strong>${matchPlan}</strong>. ` +
        `<a href="https://science.osti.gov/wdts/nsb/Regional-Competitions/Resources/MS-Sample-Questions" target="_blank" rel="noreferrer noopener">DOE source</a>`;
    }
  }

  /**
   * Tiered judge:
   *  - Tier 1: high-confidence rule-based verdict (no LLM call, free + instant).
   *  - Tier 2: rule-based was uncertain → escalate to the LLM if configured.
   *  - Tier 3: LLM unavailable / threw → fall back to whatever the rule said.
   *
   * The tier number is surfaced on the returned verdict so the UI can show
   * the user which path was taken.
   */
  async function judgeAnswer(spoken, q) {
    const ruleVerdict = Judge.judge(spoken, q);

    // Tier 1: high-confidence rule-based wins, no LLM call
    const HIGH_CONFIDENCE = 0.85;
    if (ruleVerdict.confidence >= HIGH_CONFIDENCE) {
      return {
        correct: ruleVerdict.correct,
        confidence: ruleVerdict.confidence,
        reasoning: ruleVerdict.reason,
        source: 'rule',
        tier: 1,
        needsReview: false,
      };
    }

    // Tier 2: rule-based was uncertain — escalate to LLM if available
    if (window.LLMJudge && LLMJudge.isReady()) {
      try {
        hideQuotaBanner();
        const llmResult = await LLMJudge.judge(spoken, q);
        return { ...llmResult, tier: 2 };
      } catch (err) {
        maybeShowQuotaBanner(err);
        console.warn('LLM judge threw, falling back to rule:', err);
      }
    }

    // Tier 3: rule-based as last resort
    return {
      correct: ruleVerdict.correct,
      confidence: ruleVerdict.confidence,
      reasoning: ruleVerdict.reason,
      source: 'rule',
      tier: 3,
      needsReview: false,
    };
  }

  /**
   * Fetch a brief grounded explanation from the LLM (or a static fallback).
   * Always resolves with a string (or null if neither path works).
   */
  async function generateExplanation(q, studentAnswer, wasCorrect) {
    if (window.LLMJudge && LLMJudge.isReady()) {
      try {
        hideQuotaBanner();
        const text = await LLMJudge.explain(q, studentAnswer, wasCorrect);
        if (text) return { text, source: 'llm' };
      } catch (err) {
        maybeShowQuotaBanner(err);
        console.warn('explain failed:', err);
      }
    }
    // Fallback: minimal rule-based hint when LLM isn't configured
    const ans = q.type === 'multiple_choice' ? `${q.answer} — ${q.answer_text || ''}` : q.answer;
    if (wasCorrect) {
      return { text: `Correct. The canonical answer is "${ans}".`, source: 'fallback' };
    }
    return { text: `The correct answer is "${ans}". Enable the LLM Judge for a fuller explanation.`, source: 'fallback' };
  }

  /**
   * Show an explanation in the given panel. `panelId` and `textId` identify
   * the elements in the DOM. Triggers the LLM (or fallback) and writes the
   * explanation back to history when ready.
   */
  async function fillExplanation(opts) {
    const { panelId, textId, q, studentAnswer, wasCorrect, historyEntry } = opts;
    const panel = $(panelId);
    const txt = $(textId);
    panel.classList.remove('hidden');
    panel.classList.add('loading');
    txt.classList.add('loading');
    txt.textContent = (window.LLMJudge && LLMJudge.isReady())
      ? 'Generating explanation'
      : 'Looking up answer';
    try {
      const result = await generateExplanation(q, studentAnswer, wasCorrect);
      panel.classList.remove('loading');
      txt.classList.remove('loading');
      if (!result) {
        panel.classList.add('hidden');
        return;
      }
      txt.textContent = result.text;
      if (historyEntry) historyEntry.explanation = result.text;
    } catch (err) {
      panel.classList.remove('loading');
      txt.classList.remove('loading');
      txt.textContent = 'Could not generate explanation: ' + (err.message || err);
    }
  }

  /**
   * Render a verdict block into a transcript element.
   */
  function renderVerdictBlock(verdict, heard) {
    const cls = verdict.needsReview ? 'review' : (verdict.correct ? 'correct' : 'incorrect');
    const icon = verdict.needsReview ? '⚠️' : (verdict.correct ? '✅' : '❌');
    const label = verdict.needsReview ? 'Needs review' : (verdict.correct ? 'Correct' : 'Incorrect');
    const sourceTag = verdict.source === 'llm'
      ? `🤖 ${escapeHtml(verdict.model || 'LLM')}`
      : verdict.source === 'rule_fallback'
        ? '⚙ rule (LLM unavailable)'
        : '⚙ rule-based';
    // Tier-1 wins are decided locally without an LLM call. Surface it so
    // the user can see why the LLM didn't fire (and that we saved a token).
    const tierTag = verdict.tier === 1
      ? '<span class="tier-tag">⚡ rule-only</span>'
      : '';

    let agreementLine = '';
    if (verdict.source === 'llm' && verdict.ruleVerdict) {
      if (verdict.agreement === true) {
        agreementLine = `<div class="meta">✓ <strong>Cross-check passed</strong> — LLM and rule-based agree.</div>`;
      } else if (verdict.agreement === false) {
        agreementLine = `<div class="meta">⚠ <strong>Cross-check disagreement</strong> — LLM says ${verdict.correct ? 'correct' : 'incorrect'}, rule-based says ${verdict.ruleVerdict.correct ? 'correct' : 'incorrect'}. Verify manually.</div>`;
      }
    }

    const matched = verdict.matchedPart ? `<span><strong>Matched:</strong> ${escapeHtml(verdict.matchedPart)}</span>` : '';
    const missing = verdict.missing ? `<span><strong>Missing:</strong> ${escapeHtml(verdict.missing)}</span>` : '';
    const conf = typeof verdict.confidence === 'number' ? `confidence ${verdict.confidence.toFixed(2)}` : '';
    const cost = verdict.costUsd ? `<span>cost ≈ $${verdict.costUsd.toFixed(4)}</span>` : '';
    const reviewFlag = verdict.needsReview && !verdict.fallbackReason
      ? `<div class="review-flag">⚠ Marked as needing review (low confidence or judges disagreed). Use the override buttons if the judgment is wrong.</div>`
      : '';
    const fallbackNote = verdict.fallbackReason
      ? `<div class="review-flag">⚠ LLM call failed (${escapeHtml(verdict.fallbackReason)}) — fell back to rule-based judgment. Verify manually.</div>`
      : '';

    return `
      <div class="meta"><strong>Heard:</strong> "${escapeHtml(heard || '(empty)')}"</div>
      <div class="verdict-block ${cls}">
        <div class="verdict-line">${icon} ${label} <span class="conf">${conf}</span> <span class="source-tag">${sourceTag}</span>${tierTag}</div>
        <div class="reasoning">${escapeHtml(verdict.reasoning || '')}</div>
        ${(matched || missing || cost) ? `<div class="meta">${matched}${missing}${cost}</div>` : ''}
        ${agreementLine}
        ${reviewFlag}
        ${fallbackNote}
      </div>`;
  }

  function updateAgentSupport() {
    const el = $('agent-support');
    if (!Agent.isSupported()) {
      const tts = Agent.isTtsSupported() ? '' : '(no TTS)';
      const stt = Agent.isSttSupported() ? '' : '(no Speech Recognition)';
      el.className = 'support-line warn';
      el.textContent = `⚠ Browser missing speech APIs ${tts} ${stt}. Agent will fall back to manual moderator controls.`;
    } else {
      el.className = 'support-line';
      el.textContent = '✓ Speech APIs available. Click "Allow" when the browser prompts for microphone access.';
    }
  }

  function showQuotaBanner(message) {
    const el = $('quota-banner');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function hideQuotaBanner() {
    const el = $('quota-banner');
    if (!el) return;
    el.classList.add('hidden');
    el.textContent = '';
  }

  function maybeShowQuotaBanner(err) {
    const msg = String((err && err.message) || err || '');
    if (!/\bAPI 429\b/i.test(msg)) return;
    showQuotaBanner('Free quota hit for LLM requests. Judging/explanations are using fallback behavior. Switch model or add a different provider key in setup.');
  }

  // ---------------- Match start ----------------
  function startMatch() {
    if (!App.mode) {
      alert('Pick a mode first.');
      return;
    }
    // Read match options from setup UI
    const lenSel = $('match-length');
    const srcSel = $('match-source');
    const topSel = $('match-topic');
    const yearSel = $('match-year');
    const subjectSel = $('match-subject');
    if (lenSel) App.matchOpts.length = parseInt(lenSel.value, 10) || 25;
    if (srcSel) App.matchOpts.source = srcSel.value || 'all';
    if (topSel) App.matchOpts.topic = topSel.value || 'all';
    if (yearSel) App.matchOpts.year = yearSel.value || 'all';
    if (subjectSel) App.matchOpts.subject = subjectSel.value || 'all';
    // Build a fresh randomized round list for this match
    App.rounds = buildRoundsFromBank(App.bank, App.matchOpts);
    if (!App.rounds.length) {
      alert('No questions match those filters.');
      return;
    }
    console.info(`Match: ${App.rounds.length} rounds, source=${App.matchOpts.source}, topic=${App.matchOpts.topic}`);

    showScreen(App.mode === 'two-team' ? 'game-two-team' : 'game-solo');
    App.agentDriving = App.agentEnabled && Agent.isTtsSupported();
    if (App.mode === 'two-team') {
      App.game = new TwoTeamGame();
    } else {
      App.game = new SoloGame();
    }
    App.game.start();
  }

  function showScreen(name) {
    ['setup', 'game-two-team', 'game-solo', 'results'].forEach((id) => {
      $(id).classList.toggle('active', id === name);
    });
  }

  // ============================================================
  //                   TWO-TEAM GAME CONTROLLER
  // ============================================================
  class TwoTeamGame {
    constructor() {
      this.roundIdx = 0;
      this.scores = { 1: 0, 2: 0 };
      this.teamNames = {
        1: $('team1-name').value.trim() || 'Team 1',
        2: $('team2-name').value.trim() || 'Team 2',
      };
      this.phase = 'idle';
      this.buzzedTeam = null;
      this.tossupOwner = null;
      this.teamsTriedTossup = new Set();
      this._lastWasBonus = false;
      this.timer = new Timer($('timer-fill'), $('timer-text'));
      this.transcriptEl = $('agent-transcript-tt');
      this.pttBtn = $('ptt-btn-tt');
      this.sttFailures = 0;
      this._pttListening = false;
      this.bindKeys = (e) => this.onKey(e);
    }

    start() {
      $('t1-name').textContent = this.teamNames[1];
      $('t2-name').textContent = this.teamNames[2];
      this.updateScores();
      this.matchId = window.Progress
        ? Progress.startMatch({ mode: 'two-team', teamNames: { ...this.teamNames } })
        : null;

      // Wire buttons
      $('read-btn').addEventListener('click', () => this.onReadClick());
      $('correct-btn').addEventListener('click', () => this.onCorrect());
      $('incorrect-btn').addEventListener('click', () => this.onIncorrect());
      $('reveal-btn').addEventListener('click', () => this.revealAnswer());
      $('next-btn').addEventListener('click', () => this.nextRound());
      $('end-btn').addEventListener('click', () => this.endMatch());
      this.bindPttButton();
      document.addEventListener('keydown', this.bindKeys);

      this.loadRound();
    }

    loadRound() {
      if (this.roundIdx >= App.rounds.length) return this.endMatch();
      const round = App.rounds[this.roundIdx];

      $('round-num').textContent = `Round ${this.roundIdx + 1} of ${App.rounds.length}`;
      $('category').textContent = round.category;
      this.setPhase('idle');
      this.buzzedTeam = null;
      this.tossupOwner = null;
      this.teamsTriedTossup = new Set();
      this._lastWasBonus = false;

      $('question-type').textContent = formatType('Toss-up', round.tossup);
      $('question-text').textContent = App.agentDriving
        ? 'Listen for the moderator…'
        : 'Click "Read Toss-up" when both teams are ready.';
      $('answer-reveal').classList.add('hidden');
      $('answer-reveal').innerHTML = '';
      this.transcriptEl.classList.add('hidden');
      this.transcriptEl.innerHTML = '';
      $('tt-response-display').classList.add('hidden');
      $('tt-response-display').className = 'response-display hidden';
      $('tt-response-text').textContent = '';
      $('tt-explanation-panel').classList.add('hidden');
      $('tt-explanation-text').textContent = '';
      if (this.pttBtn) this.pttBtn.classList.add('hidden');
      this.timer.reset();

      if (App.agentDriving) {
        showButtons();
        this.runAgentToss();
      } else {
        showButtons('read-btn');
        $('read-btn').textContent = 'Read Toss-up';
        this.setStatus(`Round ${this.roundIdx + 1}: Toss-up — either team may buzz.`);
      }
    }

    onReadClick() {
      const round = App.rounds[this.roundIdx];
      if (this.phase === 'idle') {
        $('question-text').textContent = round.tossup.question;
        $('question-type').textContent = formatType('Toss-up', round.tossup) + ` · ${TOSSUP_POINTS} pts`;
        this.setPhase('tossup-reading');
        showButtons();
        this.setStatus('Buzz: A (Team 1) or L (Team 2)');
        this.timer.start(TOSSUP_SECONDS, () => this.onTossupTimeout());
      } else if (this.phase === 'bonus-pending') {
        $('question-text').textContent = round.bonus.question;
        $('question-type').textContent = formatType('Bonus', round.bonus) + ` · ${BONUS_POINTS} pts`;
        $('answer-reveal').classList.add('hidden');
        this.setPhase('bonus-reading');
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
        this.setStatus(`${this.teamNames[this.tossupOwner]} — confer and answer.`);
        this.timer.start(BONUS_SECONDS, () => this.onBonusTimeout());
      }
    }

    onKey(e) {
      if (!$('game-two-team').classList.contains('active')) return;
      if (this.phase !== 'tossup-reading') return;
      const k = e.key.toLowerCase();
      if (k === 'a') this.handleBuzz(1);
      else if (k === 'l') this.handleBuzz(2);
    }

    handleBuzz(team) {
      if (this.teamsTriedTossup.has(team)) return;
      this.timer.stop();
      Agent.cancel(); // stop any TTS in progress (interrupt model is acknowledged in RULES.md as future work)
      this.buzzedTeam = team;
      this.teamsTriedTossup.add(team);
      this.setPhase('tossup-buzzed');
      this.flashTeam(team);
      if (App.agentDriving) {
        this.setStatus(`${this.teamNames[team]} buzzed. Hold to answer.`, team);
        this.showPtt(true);
      } else {
        this.setStatus(`${this.teamNames[team]} buzzed in. Did they answer correctly?`, team);
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
      }
    }

    onCorrect() {
      this.showPtt(false);
      if (this.phase === 'tossup-buzzed') {
        this.addScore(this.buzzedTeam, TOSSUP_POINTS);
        this.tossupOwner = this.buzzedTeam;
        this._recordAttempt({ team: this.buzzedTeam, kind: 'tossup', correct: true, response: $('tt-response-text').textContent.trim() });
        this.revealAnswer();
        this._explainForCurrent(true, 'tossup');
        this.setPhase('bonus-pending');
        showButtons('read-btn', 'next-btn');
        $('read-btn').textContent = 'Read Bonus';
        this.setStatus(`${this.teamNames[this.tossupOwner]} earned ${TOSSUP_POINTS} pts. Bonus is theirs.`);
        if (App.agentDriving) this.runAgentBonus();
      } else if (this.phase === 'bonus-reading') {
        this.addScore(this.tossupOwner, BONUS_POINTS);
        this._recordAttempt({ team: this.tossupOwner, kind: 'bonus', correct: true, response: $('tt-response-text').textContent.trim() });
        this.timer.stop();
        this.revealAnswer();
        this._explainForCurrent(true, 'bonus');
        this.setPhase('revealed');
        this.setStatus(`${this.teamNames[this.tossupOwner]} earned ${BONUS_POINTS} bonus pts.`, null, 'success');
        showButtons('next-btn');
        if (App.agentDriving) Agent.speak(`Correct. ${this.teamNames[this.tossupOwner]} earns ${BONUS_POINTS} bonus points.`);
      }
    }

    onIncorrect() {
      this.showPtt(false);
      if (this.phase === 'tossup-buzzed') {
        // Record the wrong-answer attempt for the team that just buzzed
        this._recordAttempt({ team: this.buzzedTeam, kind: 'tossup', correct: false, response: $('tt-response-text').textContent.trim() });
        const other = this.buzzedTeam === 1 ? 2 : 1;
        this.clearTeamFlash();
        if (this.teamsTriedTossup.has(other)) {
          this.revealAnswer();
          this._explainForCurrent(false, 'tossup');
          this.setPhase('revealed');
          this.setStatus('Both teams missed the toss-up. No bonus.', null, 'danger');
          showButtons('next-btn');
          if (App.agentDriving) Agent.speak('Both teams missed. The correct answer was: ' + plainAnswer(App.rounds[this.roundIdx].tossup));
        } else {
          this.buzzedTeam = other;
          this.setPhase('tossup-buzzed');
          this.flashTeam(other);
          this.timer.start(FREESHOT_SECONDS, () => this.onIncorrect());
          if (App.agentDriving) {
            this.setStatus(`${this.teamNames[other]} — your free shot. Hold to answer.`, other);
            this.showPtt(true);
          } else {
            this.setStatus(`${this.teamNames[other]} — 5-second free shot. Correct answer?`, other);
            showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
          }
        }
      } else if (this.phase === 'bonus-reading') {
        this._recordAttempt({ team: this.tossupOwner, kind: 'bonus', correct: false, response: $('tt-response-text').textContent.trim() });
        this.timer.stop();
        this.revealAnswer();
        this._explainForCurrent(false, 'bonus');
        this.setPhase('revealed');
        this.setStatus(`${this.teamNames[this.tossupOwner]} missed the bonus. No points.`, null, 'danger');
        showButtons('next-btn');
        if (App.agentDriving) Agent.speak('Incorrect. The correct answer was: ' + plainAnswer(App.rounds[this.roundIdx].bonus));
      }
    }

    onTossupTimeout() {
      this.showPtt(false);
      // Record a "no buzz" outcome — neither team attempted, but the round counts
      this._recordAttempt({ team: null, kind: 'tossup', correct: false, response: '(no buzz)' });
      this.revealAnswer();
      this._explainForCurrent(false, 'tossup');
      this.setPhase('revealed');
      this.setStatus('Time. No team buzzed. No bonus.', null, 'danger');
      showButtons('next-btn');
      if (App.agentDriving) Agent.speak('Time. The answer was: ' + plainAnswer(App.rounds[this.roundIdx].tossup));
    }

    onBonusTimeout() {
      this.showPtt(false);
      this._recordAttempt({ team: this.tossupOwner, kind: 'bonus', correct: false, response: '(time)' });
      this.revealAnswer();
      this._explainForCurrent(false, 'bonus');
      this.setPhase('revealed');
      this.setStatus(`Time. ${this.teamNames[this.tossupOwner]} did not answer.`, null, 'danger');
      showButtons('next-btn');
      if (App.agentDriving) Agent.speak('Time. The answer was: ' + plainAnswer(App.rounds[this.roundIdx].bonus));
    }

    _explainForCurrent(wasCorrect, kind) {
      const round = App.rounds[this.roundIdx];
      const q = (kind === 'bonus') ? round.bonus : round.tossup;
      // Pull "what they said" from the visible response panel if the agent populated it
      const heard = $('tt-response-text').textContent.trim();
      $('tt-explanation-panel').classList.add('hidden');
      fillExplanation({
        panelId: 'tt-explanation-panel',
        textId: 'tt-explanation-text',
        q,
        studentAnswer: heard,
        wasCorrect,
      });
    }

    // -------- Agent flow --------
    async runAgentToss() {
      const round = App.rounds[this.roundIdx];
      try {
        await Agent.speak(`Round ${this.roundIdx + 1}. ${round.category}. Toss-up.`);
        if (this.phase !== 'idle') return;
        $('question-text').textContent = round.tossup.question;
        $('question-type').textContent = formatType('Toss-up', round.tossup) + ` · ${TOSSUP_POINTS} pts`;
        await Agent.speakQuestion(round.tossup.question);
        if (this.phase !== 'idle') return;
        this.setPhase('tossup-reading');
        this.setStatus('Buzz: A (Team 1) or L (Team 2). 5 seconds.');
        this.timer.start(TOSSUP_SECONDS, () => this.onTossupTimeout());
      } catch (err) {
        console.warn('Agent toss-up speak failed:', err);
        // Fallback to manual
        showButtons('read-btn');
        this.setStatus('Agent error — switch to manual.');
      }
    }

    async runAgentBonus() {
      // Advance state and read bonus
      const round = App.rounds[this.roundIdx];
      try {
        await sleep(400);
        $('question-text').textContent = round.bonus.question;
        $('question-type').textContent = formatType('Bonus', round.bonus) + ` · ${BONUS_POINTS} pts`;
        $('answer-reveal').classList.add('hidden');
        await Agent.speak(`Bonus question for ${this.teamNames[this.tossupOwner]}.`);
        if (this.phase !== 'bonus-pending') return;
        await Agent.speakQuestion(round.bonus.question);
        if (this.phase !== 'bonus-pending') return;
        this.setPhase('bonus-reading');
        this.setStatus(`${this.teamNames[this.tossupOwner]} — hold to answer (20 sec).`);
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
        this.timer.start(BONUS_SECONDS, () => this.onBonusTimeout());
        this.showPtt(true);
      } catch (err) {
        console.warn('Agent bonus failed:', err);
      }
    }

    async runAgentAnswer(kind) {
      if (!Agent.isSttSupported()) {
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
        return;
      }
      this._pttListening = true;
      const ms = (kind === 'tossup' ? TOSSUP_SECONDS : BONUS_SECONDS) * 1000;
      this.transcriptEl.classList.remove('hidden');
      this.transcriptEl.innerHTML = '<span class="label">Listening</span>';
      try {
        const transcript = await Agent.listen({
          timeoutMs: ms + 2000,
          interim: (t) => { this.transcriptEl.innerHTML = `<span class="label">Listening</span><div>${escapeHtml(t)}</div>`; },
        });
        this.timer.stop();
        this.sttFailures = 0;
        this._pttListening = false;
        this.showPtt(false);
        const q = (kind === 'tossup') ? App.rounds[this.roundIdx].tossup : App.rounds[this.roundIdx].bonus;
        this.transcriptEl.innerHTML = `<span class="label">Judging…</span><div>"${escapeHtml(transcript)}"</div>`;
        const verdict = await judgeAnswer(transcript, q);
        this.transcriptEl.innerHTML = `<span class="label">Judgment</span>${renderVerdictBlock(verdict, transcript)}`;
        // Persistent response panel — what the team said
        this._showTeamResponse(transcript, verdict, this.buzzedTeam);
        if (verdict.needsReview) {
          this.setStatus('Judgment needs review — click Correct or Incorrect to confirm.', null, 'warn');
          showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
          return;
        }
        if (verdict.correct) this.onCorrect();
        else this.onIncorrect();
      } catch (err) {
        const msg = err.message || '';
        this._pttListening = false;
        this.showPtt(false);
        if (msg === 'no-speech' || msg === 'timeout' || /^STT:/.test(msg)) this.sttFailures += 1;
        const isUnavailable = /^STT: (network|not-allowed|service-not-allowed|audio-capture)/.test(msg);
        if (isUnavailable) {
          // Speech recognition unavailable — stop the timer and let the
          // moderator judge manually instead of penalizing on the clock.
          this.timer.stop();
          this.timer.reset();
          this.transcriptEl.innerHTML = `<span class="label">Voice unavailable</span><div>Speech recognition couldn't connect (<code>${escapeHtml(msg)}</code>). Clock stopped — judge the answer manually.</div>`;
        } else {
          console.warn('Agent listen error:', msg);
          this.transcriptEl.innerHTML = `<span class="label">Error</span><div>${escapeHtml(msg)} — please use the manual buttons.</div>`;
        }
        if (this.sttFailures >= 2) {
          this.transcriptEl.innerHTML += '<div>Voice had repeated errors. Use manual Correct/Incorrect controls for this round.</div>';
        }
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
      }
    }

    bindPttButton() {
      if (!this.pttBtn) return;
      const start = (e) => {
        e.preventDefault();
        if (!App.agentDriving || this._pttListening) return;
        if (this.phase !== 'tossup-buzzed' && this.phase !== 'bonus-reading') return;
        this.pttBtn.classList.add('active');
        this.runAgentAnswer(this.phase === 'bonus-reading' ? 'bonus' : 'tossup');
      };
      const stop = (e) => {
        e.preventDefault();
        this.pttBtn.classList.remove('active');
        if (this._pttListening) Agent.cancel();
      };
      this.pttBtn.addEventListener('pointerdown', start);
      this.pttBtn.addEventListener('pointerup', stop);
      this.pttBtn.addEventListener('pointerleave', stop);
      this.pttBtn.addEventListener('pointercancel', stop);
    }

    showPtt(show) {
      if (!this.pttBtn) return;
      this.pttBtn.classList.toggle('hidden', !show || !Agent.isSttSupported());
    }

    // -------- Helpers --------
    revealAnswer() {
      const round = App.rounds[this.roundIdx];
      const inBonusPath = ['bonus-reading', 'bonus-pending'].includes(this.phase) || this._lastWasBonus;
      const obj = inBonusPath ? round.bonus : round.tossup;
      const label = inBonusPath ? 'Bonus answer' : 'Toss-up answer';
      const txt = obj.type === 'multiple_choice'
        ? `${obj.answer} — ${obj.answer_text || ''}`.replace(/—\s*$/, '').trim()
        : obj.answer;
      $('answer-reveal').innerHTML = `<strong>${label}:</strong> ${escapeHtml(txt)}`;
      $('answer-reveal').classList.remove('hidden');
    }

    nextRound() {
      this.roundIdx += 1;
      if (this.roundIdx >= App.rounds.length) this.endMatch();
      else this.loadRound();
    }

    endMatch() {
      this.timer.stop();
      Agent.cancel();
      this.showPtt(false);
      document.removeEventListener('keydown', this.bindKeys);
      $('results-two-team').classList.remove('hidden');
      $('results-solo').classList.add('hidden');
      $('final-t1').querySelector('.final-name').textContent = this.teamNames[1];
      $('final-t2').querySelector('.final-name').textContent = this.teamNames[2];
      $('final-t1').querySelector('.final-score').textContent = this.scores[1];
      $('final-t2').querySelector('.final-score').textContent = this.scores[2];
      $('final-t1').classList.remove('winner-team');
      $('final-t2').classList.remove('winner-team');
      if (this.scores[1] > this.scores[2]) {
        $('winner').textContent = `🏆 ${this.teamNames[1]} wins!`;
        $('final-t1').classList.add('winner-team');
      } else if (this.scores[2] > this.scores[1]) {
        $('winner').textContent = `🏆 ${this.teamNames[2]} wins!`;
        $('final-t2').classList.add('winner-team');
      } else {
        $('winner').textContent = "It's a tie!";
      }
      if (window.Progress && this.matchId) {
        Progress.endMatch(this.matchId, {
          team_scores: { ...this.scores },
          final_score: Math.max(this.scores[1], this.scores[2]),
        });
      }
      showScreen('results');
    }

    setPhase(phase) {
      this.phase = phase;
      this._lastWasBonus = phase === 'bonus-reading' || phase === 'bonus-pending' || (phase === 'revealed' && this._lastWasBonus);
      $('phase-label').textContent = phase.startsWith('bonus') ? 'Bonus' : 'Toss-up';
      $('phase-label').classList.toggle('bonus', phase.startsWith('bonus'));
    }

    setStatus(msg, team, mod) {
      const el = $('status-line');
      el.textContent = msg;
      el.className = 'status-line';
      if (team === 1) el.classList.add('team1-buzz');
      if (team === 2) el.classList.add('team2-buzz');
      if (mod) el.classList.add(mod);
    }

    flashTeam(team) {
      this.clearTeamFlash();
      if (team === 1) document.querySelector('.team.team1').classList.add('active-buzz');
      if (team === 2) document.querySelector('.team.team2').classList.add('active-buzz');
    }

    clearTeamFlash() {
      document.querySelectorAll('.team.active-buzz').forEach(el => el.classList.remove('active-buzz'));
    }

    _showTeamResponse(text, verdict, team) {
      const el = $('tt-response-display');
      const lab = $('tt-response-label');
      const txt = $('tt-response-text');
      const cls = (verdict && verdict.needsReview) ? 'review' : (verdict && verdict.correct ? 'correct' : 'incorrect');
      el.className = `response-display ${cls}`;
      lab.textContent = team ? `${this.teamNames[team]} said` : 'Team said';
      txt.textContent = (text || '').trim();
    }

    _recordAttempt({ team, kind, correct, response, source }) {
      if (!window.Progress || !this.matchId) return;
      const round = App.rounds[this.roundIdx];
      if (!round) return;
      const q = (kind === 'bonus') ? round.bonus : round.tossup;
      Progress.recordAttempt(this.matchId, {
        round_idx: this.roundIdx,
        concept_id: round.conceptId || null,
        variant_id: q ? q.id : null,
        category: round.category,
        subcategory: round.subcategory || null,
        tags: round.tags || [],
        phase: kind,
        question_type: q ? q.type : null,
        response: response || '',
        correct: !!correct,
        needs_review: false,
        confidence: null,
        source: source || 'manual',
        team: team || null,
      });
    }

    addScore(team, pts) {
      this.scores[team] += pts;
      this.updateScores();
    }

    updateScores() {
      $('t1-score').textContent = this.scores[1];
      $('t2-score').textContent = this.scores[2];
    }
  }

  // ============================================================
  //                       SOLO GAME CONTROLLER
  // ============================================================
  class SoloGame {
    constructor() {
      this.roundIdx = 0;
      this.score = 0;
      this.correctCount = 0;
      this.incorrectCount = 0;
      this.streak = 0;
      this.tossupsAttempted = 0;
      this.tossupsCorrect = 0;
      this.bonusesAttempted = 0;
      this.bonusesCorrect = 0;
      this.playerName = $('solo-name').value.trim() || 'Player';
      this.phase = 'idle';
      this.tossupOwner = false;
      this._lastWasBonus = false;
      this.timer = new Timer($('solo-timer-fill'), $('solo-timer-text'));
      this.transcriptEl = $('agent-transcript-solo');
      this.pttBtn = $('ptt-btn-solo');
      this.sttFailures = 0;
      this._pttListening = false;
      this.bindKeys = (e) => this.onKey(e);
      // History entry per question (toss-up or bonus). Each: {round, kind, question, response, verdict, canonical}
      this.history = [];
    }

    start() {
      $('solo-player-name').textContent = this.playerName;
      this.updateStats();
      this.matchId = window.Progress
        ? Progress.startMatch({ mode: 'solo', playerName: this.playerName })
        : null;

      $('solo-read-btn').addEventListener('click', () => this.onReadClick());
      $('solo-buzz-btn').addEventListener('click', () => this.onBuzz());
      $('solo-submit-btn').addEventListener('click', () => this.onSubmitTyped());
      $('solo-answer-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.onSubmitTyped();
      });
      $('solo-reveal-btn').addEventListener('click', () => this.onGiveUp());
      $('solo-next-btn').addEventListener('click', () => this.nextRound());
      $('solo-override-correct').addEventListener('click', () => this.overrideJudgment(true));
      $('solo-override-incorrect').addEventListener('click', () => this.overrideJudgment(false));
      $('solo-end-btn').addEventListener('click', () => this.endMatch());
      this.bindPttButton();
      document.addEventListener('keydown', this.bindKeys);

      this.loadRound();
    }

    loadRound() {
      if (this.roundIdx >= App.rounds.length) return this.endMatch();
      const round = App.rounds[this.roundIdx];

      $('solo-round-num').textContent = `Round ${this.roundIdx + 1} of ${App.rounds.length}`;
      $('solo-category').textContent = round.category;
      this.setPhase('idle');
      this.tossupOwner = false;
      this._lastWasBonus = false;
      $('solo-question-type').textContent = formatType('Toss-up', round.tossup);
      $('solo-question-text').textContent = App.agentDriving
        ? 'Listen for the moderator…'
        : 'Press "Read Question" to begin.';
      $('solo-answer-reveal').classList.add('hidden');
      $('solo-answer-reveal').innerHTML = '';
      this.transcriptEl.classList.add('hidden');
      this.transcriptEl.innerHTML = '';
      $('solo-answer-wrap').classList.add('hidden');
      $('solo-answer-input').value = '';
      $('solo-response-display').classList.add('hidden');
      $('solo-response-display').className = 'response-display hidden';
      $('solo-response-text').textContent = '';
      $('solo-explanation-panel').classList.add('hidden');
      $('solo-explanation-text').textContent = '';
      if (this.pttBtn) this.pttBtn.classList.add('hidden');
      this.timer.reset();
      this.hideOverrides();

      if (App.agentDriving) {
        soloShowButtons();
        this.runAgentToss();
      } else {
        soloShowButtons('solo-read-btn');
        $('solo-read-btn').textContent = 'Read Toss-up';
        this.setStatus('Press Space when ready to answer.');
      }
    }

    onKey(e) {
      if (!$('game-solo').classList.contains('active')) return;
      if (e.key === ' ' && (this.phase === 'tossup-reading' || this.phase === 'bonus-reading')) {
        e.preventDefault();
        this.onBuzz();
      }
    }

    onReadClick() {
      const round = App.rounds[this.roundIdx];
      if (this.phase === 'idle') {
        $('solo-question-text').textContent = round.tossup.question;
        $('solo-question-type').textContent = formatType('Toss-up', round.tossup) + ` · ${TOSSUP_POINTS} pts`;
        this.setPhase('tossup-reading');
        soloShowButtons('solo-buzz-btn', 'solo-reveal-btn');
        this.setStatus('Press Space (or "I\'m Ready") when ready to answer.');
        // Solo mode does NOT enforce a 5-sec window — player drives pace
      } else if (this.phase === 'bonus-pending') {
        $('solo-question-text').textContent = round.bonus.question;
        $('solo-question-type').textContent = formatType('Bonus', round.bonus) + ` · ${BONUS_POINTS} pts`;
        $('solo-answer-reveal').classList.add('hidden');
        this.setPhase('bonus-reading');
        soloShowButtons('solo-buzz-btn', 'solo-reveal-btn');
        this.setStatus('Bonus — press Space when ready to answer.');
      }
    }

    onBuzz() {
      if (this.phase !== 'tossup-reading' && this.phase !== 'bonus-reading') return;
      // Show input field (typed or spoken). Solo mode is self-paced — generous timer.
      $('solo-answer-wrap').classList.remove('hidden');
      $('solo-answer-input').focus();
      const secs = this.phase === 'tossup-reading' ? 45 : 45;
      this.timer.start(secs, () => this.onAnswerTimeout());
      if (App.agentDriving && Agent.isSttSupported()) {
        this.setStatus('Hold to answer, or type in the box.', null);
        this.showPtt(true);
      }
    }

    async onSubmitTyped() {
      if (this.phase !== 'tossup-reading' && this.phase !== 'bonus-reading') return;
      const txt = $('solo-answer-input').value.trim();
      if (!txt) return;
      this.timer.stop();
      Agent.cancel();
      const q = this.phase === 'tossup-reading' ? App.rounds[this.roundIdx].tossup : App.rounds[this.roundIdx].bonus;
      // Show "judging" state if LLM is enabled
      if (window.LLMJudge && LLMJudge.isReady()) {
        this.transcriptEl.classList.remove('hidden');
        this.transcriptEl.innerHTML = `<span class="label">Judging…</span><div>"${escapeHtml(txt)}"</div>`;
      }
      const verdict = await judgeAnswer(txt, q);
      // Render verdict block in transcript area
      this.transcriptEl.classList.remove('hidden');
      this.transcriptEl.innerHTML = `<span class="label">Judgment</span>${renderVerdictBlock(verdict, txt)}`;
      this.processVerdict(verdict, txt);
    }

    onGiveUp() {
      if (this.phase === 'revealed') return;
      this.timer.stop();
      Agent.cancel();
      this.showPtt(false);
      this.processVerdict({ correct: false, confidence: 1, reason: 'gave up' }, '(skipped)');
    }

    onAnswerTimeout() {
      if (this.phase !== 'tossup-reading' && this.phase !== 'bonus-reading') return;
      this.showPtt(false);
      this.processVerdict({ correct: false, confidence: 1, reason: 'time' }, '(time)');
    }

    async runAgentToss() {
      const round = App.rounds[this.roundIdx];
      try {
        await Agent.speak(`Round ${this.roundIdx + 1}. ${round.category}. Toss-up.`);
        if (this.phase !== 'idle') return;
        $('solo-question-text').textContent = round.tossup.question;
        $('solo-question-type').textContent = formatType('Toss-up', round.tossup) + ` · ${TOSSUP_POINTS} pts`;
        await Agent.speakQuestion(round.tossup.question);
        if (this.phase !== 'idle') return;
        this.setPhase('tossup-reading');
        this.setStatus('Hold to answer, or type in the box.');
        $('solo-answer-wrap').classList.remove('hidden');
        $('solo-answer-input').focus();
        soloShowButtons('solo-reveal-btn');
        this.timer.start(TOSSUP_SECONDS * 3, () => this.onAnswerTimeout());
        this.showPtt(true);
      } catch (err) {
        console.warn('Solo agent toss failed:', err);
      }
    }

    async runAgentBonus() {
      const round = App.rounds[this.roundIdx];
      try {
        await sleep(400);
        $('solo-question-text').textContent = round.bonus.question;
        $('solo-question-type').textContent = formatType('Bonus', round.bonus) + ` · ${BONUS_POINTS} pts`;
        $('solo-answer-reveal').classList.add('hidden');
        await Agent.speak('Bonus.');
        if (this.phase !== 'bonus-pending') return;
        await Agent.speakQuestion(round.bonus.question);
        if (this.phase !== 'bonus-pending') return;
        this.setPhase('bonus-reading');
        this.setStatus('Hold to answer, or type in the box.');
        $('solo-answer-wrap').classList.remove('hidden');
        $('solo-answer-input').focus();
        soloShowButtons('solo-reveal-btn');
        this.timer.start(BONUS_SECONDS, () => this.onAnswerTimeout());
        this.showPtt(true);
      } catch (err) {
        console.warn('Solo agent bonus failed:', err);
      }
    }

    async runAgentListen(kind) {
      if (!Agent.isSttSupported()) return;
      this._pttListening = true;
      const ms = (kind === 'tossup' ? TOSSUP_SECONDS * 3 : BONUS_SECONDS) * 1000;
      this.transcriptEl.classList.remove('hidden');
      this.transcriptEl.innerHTML = '<span class="label">Listening</span>';
      try {
        const transcript = await Agent.listen({
          timeoutMs: ms,
          interim: (t) => { this.transcriptEl.innerHTML = `<span class="label">Listening</span><div>${escapeHtml(t)}</div>`; },
        });
        if (!transcript.trim()) return;
        this._pttListening = false;
        this.showPtt(false);
        this.sttFailures = 0;
        this.timer.stop();
        $('solo-answer-input').value = transcript;
        const q = (kind === 'tossup') ? App.rounds[this.roundIdx].tossup : App.rounds[this.roundIdx].bonus;
        this.transcriptEl.innerHTML = `<span class="label">Judging…</span><div>"${escapeHtml(transcript)}"</div>`;
        const verdict = await judgeAnswer(transcript, q);
        this.transcriptEl.innerHTML = `<span class="label">Judgment</span>${renderVerdictBlock(verdict, transcript)}`;
        this.processVerdict(verdict, transcript);
      } catch (err) {
        const msg = err.message || '';
        this._pttListening = false;
        this.showPtt(false);
        if (msg === 'no-speech' || msg === 'timeout' || /^STT:/.test(msg)) this.sttFailures += 1;
        const isUnavailable = /^STT: (network|not-allowed|service-not-allowed|audio-capture)/.test(msg);
        const isBenign = msg === 'no-speech' || msg === 'timeout' || msg === 'aborted';
        if (isUnavailable) {
          // Speech recognition is unavailable in this environment. Stop the
          // answer timer so the user can type at their own pace without being
          // auto-marked incorrect.
          this.timer.stop();
          this.timer.reset();
          this.transcriptEl.innerHTML = `<span class="label">Voice unavailable</span><div>Speech recognition couldn't connect (<code>${escapeHtml(msg)}</code>). The clock has been stopped — please type your answer below.</div>`;
          $('solo-answer-wrap').classList.remove('hidden');
          $('solo-answer-input').focus();
        } else if (!isBenign) {
          this.transcriptEl.innerHTML = `<span class="label">Error</span><div>${escapeHtml(msg)} — type your answer.</div>`;
        }
        if (this.sttFailures >= 2) {
          this.transcriptEl.innerHTML += '<div>Voice had repeated errors. Continue with typed answers for this question.</div>';
          $('solo-answer-wrap').classList.remove('hidden');
          $('solo-answer-input').focus();
        }
      }
    }

    bindPttButton() {
      if (!this.pttBtn) return;
      const start = (e) => {
        e.preventDefault();
        if (!App.agentDriving || this._pttListening || !Agent.isSttSupported()) return;
        if (this.phase !== 'tossup-reading' && this.phase !== 'bonus-reading') return;
        this.pttBtn.classList.add('active');
        this.runAgentListen(this.phase === 'bonus-reading' ? 'bonus' : 'tossup');
      };
      const stop = (e) => {
        e.preventDefault();
        this.pttBtn.classList.remove('active');
        if (this._pttListening) Agent.cancel();
      };
      this.pttBtn.addEventListener('pointerdown', start);
      this.pttBtn.addEventListener('pointerup', stop);
      this.pttBtn.addEventListener('pointerleave', stop);
      this.pttBtn.addEventListener('pointercancel', stop);
    }

    showPtt(show) {
      if (!this.pttBtn) return;
      this.pttBtn.classList.toggle('hidden', !show || !Agent.isSttSupported());
    }

    processVerdict(verdict, given) {
      this.showPtt(false);
      const wasBonus = this.phase === 'bonus-reading';
      this.timer.stop();
      // Lock out further submissions for this question
      $('solo-answer-wrap').classList.add('hidden');
      $('solo-answer-input').value = '';
      // Show what the kid said in a persistent panel
      this.showResponse(given, verdict);
      // Track in round history
      const round = App.rounds[this.roundIdx];
      const q = wasBonus ? round.bonus : round.tossup;
      const historyEntry = {
        roundNum: this.roundIdx + 1,
        kind: wasBonus ? 'bonus' : 'tossup',
        category: round.category,
        question: q.question,
        response: given,
        correct: !!verdict.correct,
        needsReview: !!verdict.needsReview,
        canonical: q.type === 'multiple_choice' ? `${q.answer} — ${q.answer_text || ''}`.replace(/—\s*$/, '').trim() : q.answer,
        reasoning: verdict.reasoning || '',
        source: verdict.source || 'rule',
        explanation: null,
      };
      this.history.push(historyEntry);
      // Persist to long-term progress
      if (window.Progress && this.matchId) {
        Progress.recordAttempt(this.matchId, {
          round_idx: this.roundIdx,
          concept_id: round.conceptId || null,
          variant_id: q.id || null,
          category: round.category,
          subcategory: round.subcategory || null,
          tags: round.tags || [],
          phase: wasBonus ? 'bonus' : 'tossup',
          question_type: q.type,
          response: given,
          correct: !!verdict.correct,
          needs_review: !!verdict.needsReview,
          confidence: typeof verdict.confidence === 'number' ? verdict.confidence : null,
          source: verdict.source || 'rule',
          team: null,
        });
      }
      this.revealAnswer();
      // Kick off the brief explanation (async — UI stays responsive)
      $('solo-explanation-panel').classList.add('hidden');
      fillExplanation({
        panelId: 'solo-explanation-panel',
        textId: 'solo-explanation-text',
        q,
        studentAnswer: given,
        wasCorrect: !!verdict.correct,
        historyEntry,
      });
      this.lastVerdict = { verdict, given, wasBonus };

      if (wasBonus) {
        this.bonusesAttempted += 1;
        if (verdict.correct) {
          this.score += BONUS_POINTS;
          this.bonusesCorrect += 1;
          this.correctCount += 1;
          this.streak += 1;
          this.setStatus(`+${BONUS_POINTS} bonus! ${this.formatVerdict(verdict, given)}`, null, 'success');
          if (App.agentDriving) Agent.speak(`Correct. Plus ten points.`);
        } else {
          this.incorrectCount += 1;
          this.streak = 0;
          this.setStatus(`Bonus missed. ${this.formatVerdict(verdict, given)}`, null, 'danger');
          if (App.agentDriving) Agent.speak(`Incorrect. The answer was: ${plainAnswer(App.rounds[this.roundIdx].bonus)}`);
        }
        this.setPhase('revealed');
        soloShowButtons('solo-next-btn');
        this.showOverrides();
      } else {
        this.tossupsAttempted += 1;
        if (verdict.correct) {
          this.score += TOSSUP_POINTS;
          this.tossupsCorrect += 1;
          this.correctCount += 1;
          this.streak += 1;
          this.tossupOwner = true;
          this.setStatus(`+${TOSSUP_POINTS}! ${this.formatVerdict(verdict, given)} — bonus next.`, null, 'success');
          if (App.agentDriving) Agent.speak(`Correct. Plus four points. Bonus question.`);
          this.setPhase('bonus-pending');
          $('solo-answer-wrap').classList.add('hidden');
          $('solo-read-btn').textContent = 'Read Bonus';
          soloShowButtons(App.agentDriving ? 'solo-next-btn' : 'solo-read-btn', 'solo-next-btn');
          this.showOverrides();
          if (App.agentDriving) this.runAgentBonus();
        } else {
          this.incorrectCount += 1;
          this.streak = 0;
          this.setStatus(`Missed. ${this.formatVerdict(verdict, given)} No bonus.`, null, 'danger');
          if (App.agentDriving) Agent.speak(`Incorrect. The answer was: ${plainAnswer(App.rounds[this.roundIdx].tossup)}`);
          this.setPhase('revealed');
          soloShowButtons('solo-next-btn');
          this.showOverrides();
        }
      }
      this.updateStats();
    }

    overrideJudgment(makeCorrect) {
      if (!this.lastVerdict) return;
      const { verdict, wasBonus } = this.lastVerdict;
      if (verdict.correct === makeCorrect) {
        this.setStatus('Override matches current judgment — no change.', null);
        return;
      }
      const pts = wasBonus ? BONUS_POINTS : TOSSUP_POINTS;
      const sign = makeCorrect ? 1 : -1;
      this.score += sign * pts;
      if (wasBonus) this.bonusesCorrect += sign;
      else this.tossupsCorrect += sign;
      this.correctCount += sign;
      this.incorrectCount -= sign;
      verdict.correct = makeCorrect;
      this.setStatus(`Manual override: now marked ${makeCorrect ? 'correct' : 'incorrect'}.`, null, makeCorrect ? 'success' : 'danger');
      this.updateStats();
    }

    showOverrides() {
      $('solo-override-correct').classList.remove('hidden');
      $('solo-override-incorrect').classList.remove('hidden');
    }
    hideOverrides() {
      $('solo-override-correct').classList.add('hidden');
      $('solo-override-incorrect').classList.add('hidden');
    }

    showResponse(given, verdict) {
      const el = $('solo-response-display');
      const txt = $('solo-response-text');
      const cls = verdict.needsReview ? 'review' : (verdict.correct ? 'correct' : 'incorrect');
      el.className = `response-display ${cls}`;
      // Clean up the "(time)" / "(skipped)" placeholders so the panel
      // shows what the kid actually said, or an explicit "no answer" hint
      let display = (given || '').trim();
      if (display === '(time)' || display === '(skipped)' || !display) display = '';
      txt.textContent = display;
    }

    formatVerdict(v, given) {
      const g = given ? `Heard: "${given}". ` : '';
      const why = v.reasoning || v.reason || '';
      return `${g}(${why})`;
    }

    revealAnswer() {
      const round = App.rounds[this.roundIdx];
      const inBonusPath = this.phase === 'bonus-reading' || this._lastWasBonus;
      const obj = inBonusPath ? round.bonus : round.tossup;
      const label = inBonusPath ? 'Bonus answer' : 'Toss-up answer';
      const txt = obj.type === 'multiple_choice'
        ? `${obj.answer} — ${obj.answer_text || ''}`.replace(/—\s*$/, '').trim()
        : obj.answer;
      $('solo-answer-reveal').innerHTML = `<strong>${label}:</strong> ${escapeHtml(txt)}`;
      $('solo-answer-reveal').classList.remove('hidden');
    }

    nextRound() {
      this.roundIdx += 1;
      if (this.roundIdx >= App.rounds.length) this.endMatch();
      else this.loadRound();
    }

    endMatch() {
      this.timer.stop();
      Agent.cancel();
      this.showPtt(false);
      document.removeEventListener('keydown', this.bindKeys);
      $('results-two-team').classList.add('hidden');
      $('results-solo').classList.remove('hidden');
      $('winner').textContent = '';
      $('solo-final-score').textContent = this.score;
      const total = this.correctCount + this.incorrectCount;
      const acc = total === 0 ? '—' : Math.round((this.correctCount / total) * 100) + '%';
      $('solo-final-accuracy').textContent = acc;
      $('solo-final-tossups').textContent = `${this.tossupsCorrect} / ${this.tossupsAttempted}`;
      $('solo-final-bonuses').textContent = `${this.bonusesCorrect} / ${this.bonusesAttempted}`;
      this.renderReview();
      if (window.Progress && this.matchId) {
        Progress.endMatch(this.matchId, {
          final_score: this.score,
          tossups: { correct: this.tossupsCorrect, attempted: this.tossupsAttempted },
          bonuses: { correct: this.bonusesCorrect, attempted: this.bonusesAttempted },
        });
      }
      showScreen('results');
    }

    renderReview() {
      const list = $('solo-review-list');
      list.innerHTML = '';
      if (!this.history.length) {
        list.innerHTML = '<p style="color:var(--muted);font-size:0.9rem;">No rounds played.</p>';
        return;
      }
      this.history.forEach((h) => {
        const row = document.createElement('div');
        row.className = `review-row ${h.correct ? 'correct' : 'incorrect'}`;
        const verdictLabel = h.correct ? '✓ Correct' : (h.needsReview ? '⚠ Needs review' : '✗ Incorrect');
        const responseShown = (h.response && h.response !== '(time)' && h.response !== '(skipped)') ? h.response : '<em>(no answer given)</em>';
        const explanation = h.explanation
          ? `<div class="review-key">Why:</div><div class="review-val">${escapeHtml(h.explanation)}</div>`
          : '';
        row.innerHTML = `
          <div class="review-head">
            <span class="review-round">Round ${h.roundNum} · ${h.kind === 'bonus' ? 'Bonus' : 'Toss-up'} · ${escapeHtml(h.category)}</span>
            <span class="review-verdict">${verdictLabel}</span>
          </div>
          <div class="review-q">${escapeHtml(h.question)}</div>
          <div class="review-block">
            <div class="review-key">You said:</div>
            <div class="review-val you">${responseShown.startsWith('<em>') ? responseShown : escapeHtml(responseShown)}</div>
            <div class="review-key">Answer:</div>
            <div class="review-val review-canonical">${escapeHtml(h.canonical)}</div>
            ${explanation}
          </div>`;
        list.appendChild(row);
      });
    }

    setPhase(phase) {
      this.phase = phase;
      this._lastWasBonus = phase === 'bonus-reading' || phase === 'bonus-pending' || (phase === 'revealed' && this._lastWasBonus);
      $('solo-phase-label').textContent = phase.startsWith('bonus') ? 'Bonus' : 'Toss-up';
      $('solo-phase-label').classList.toggle('bonus', phase.startsWith('bonus'));
    }

    setStatus(msg, _team, mod) {
      const el = $('solo-status-line');
      el.textContent = msg;
      el.className = 'status-line';
      if (mod) el.classList.add(mod);
    }

    updateStats() {
      $('solo-score').textContent = this.score;
      $('solo-correct').textContent = this.correctCount;
      $('solo-incorrect').textContent = this.incorrectCount;
      const total = this.correctCount + this.incorrectCount;
      $('solo-accuracy').textContent = total === 0 ? '—' : Math.round((this.correctCount / total) * 100) + '%';
      $('solo-streak').textContent = `streak: ${this.streak}`;
    }
  }

  // ============================================================
  //                          UTILITIES
  // ============================================================
  class Timer {
    constructor(fillEl, textEl) {
      this.fill = fillEl;
      this.text = textEl;
      this.id = null;
      this.end = 0;
      this.total = 0;
    }
    start(seconds, onExpire) {
      this.stop();
      this.total = seconds;
      this.end = Date.now() + seconds * 1000;
      this.fill.classList.remove('urgent');
      this.tick(onExpire);
      this.id = setInterval(() => this.tick(onExpire), 100);
    }
    tick(onExpire) {
      const remMs = Math.max(0, this.end - Date.now());
      const remS = remMs / 1000;
      this.fill.style.width = (remMs / (this.total * 1000)) * 100 + '%';
      this.text.textContent = remS.toFixed(1) + 's';
      if (remS <= this.total * 0.25) this.fill.classList.add('urgent');
      if (remMs <= 0) {
        this.stop();
        onExpire && onExpire();
      }
    }
    stop() {
      if (this.id) clearInterval(this.id);
      this.id = null;
    }
    reset() {
      this.stop();
      this.fill.style.width = '100%';
      this.fill.classList.remove('urgent');
      this.text.textContent = '—';
    }
  }

  function showButtons(...ids) {
    ['read-btn', 'correct-btn', 'incorrect-btn', 'reveal-btn', 'next-btn'].forEach((id) => {
      $(id).classList.add('hidden');
    });
    ids.forEach((id) => $(id) && $(id).classList.remove('hidden'));
  }

  function soloShowButtons(...ids) {
    ['solo-read-btn', 'solo-buzz-btn', 'solo-reveal-btn', 'solo-next-btn'].forEach((id) => {
      $(id).classList.add('hidden');
    });
    ids.forEach((id) => $(id) && $(id).classList.remove('hidden'));
  }

  function formatType(prefix, q) {
    return `${prefix} · ${q.type === 'multiple_choice' ? 'Multiple Choice' : 'Short Answer'}`;
  }

  function plainAnswer(q) {
    return q.type === 'multiple_choice' ? `${q.answer}, ${q.answer_text || ''}`.replace(/,\s*$/, '').trim() : q.answer;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // (sleep is defined earlier near voice controls)

  // ============================================================
  //                    AGENT STATUS OVERLAY
  // ============================================================
  function bindAgentOverlay() {
    const overlay = $('agent-overlay');
    const text = $('agent-status-text');
    const live = $('agent-transcript-live');

    Agent.onStateChange((state, detail) => {
      if (!App.agentEnabled) {
        overlay.classList.add('hidden');
        return;
      }
      overlay.classList.remove('hidden');
      overlay.dataset.state = state;
      switch (state) {
        case 'speaking':
          text.textContent = '🔊 Reading…';
          live.textContent = (detail && detail.text) ? detail.text.slice(0, 80) + (detail.text.length > 80 ? '…' : '') : '';
          break;
        case 'listening':
          text.textContent = '🎙️ Listening…';
          live.textContent = '';
          break;
        case 'error':
          text.textContent = '⚠ Agent error';
          break;
        default:
          text.textContent = 'Idle';
          live.textContent = '';
      }
    });
  }
})();
