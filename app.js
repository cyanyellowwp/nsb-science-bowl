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
    reviewGate: true,        // moderator reviews/rewords a spoken answer before it's judged/scored
    matchOpts: {           // chosen on setup; consumed by buildRoundsFromBank
      source: 'all',       // 'seed' | 'corpus' | 'all'
      length: 25,
      topic: 'all',        // 'all' | 'biology' | 'physics_chemistry' | 'math' | 'earth_space'
      year: 'all',         // 'all' | '2015' .. '2022'
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
          nsbCategory: c.nsbCategory || inferNsbCategory(c),
          _source: src.id || 'corpus',
        });
      }
    }
    // Merge any LLM-generated variants the user has accumulated locally
    if (window.Generator) {
      for (const c of Generator.getCachedConcepts()) {
        concepts.push({
          ...c,
          nsbCategory: c.nsbCategory || inferNsbCategory(c),
          _source: 'generated',
        });
      }
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
    const hay = `${concept.subject || ''} ${concept.category || ''} ${concept.subcategory || ''} ${(concept.tags || []).join(' ')}`.toLowerCase();
    if (hay.includes('physics') || hay.includes('chemistry') || hay.includes('physical_science') || hay.includes('physical science')) {
      return 'physical_science';
    }
    if (hay.includes('math')) return 'math';
    if (hay.includes('earth') || hay.includes('space')) return 'earth_space';
    return 'biology';
  }

  function inferNsbCategory(concept) {
    const hay = `${concept.subject || ''} ${concept.category || ''} ${concept.subcategory || ''} ${(concept.tags || []).join(' ')}`.toLowerCase();
    if (hay.includes('biology') || hay.includes('life science')) return 'biology';
    if (hay.includes('physics') || hay.includes('chemistry') || hay.includes('physical_science') || hay.includes('physical science')) return 'physics_chemistry';
    if (hay.includes('math')) return 'math';
    if (hay.includes('earth') || hay.includes('space')) return 'earth_space';
    return 'biology';
  }

  function matchesNsbCategory(concept, value) {
    if (!value || value === 'all') return true;
    return (concept.nsbCategory || inferNsbCategory(concept)) === value;
  }

  /**
   * Filter a concept pool by the selected source key.
   *   'all'    → everything
   *   'seed'   → hand-curated seed only
   *   'corpus' → everything except seed (legacy meaning)
   *   <id>     → only concepts from that content source (e.g. 'grade5')
   */
  function filterBySource(pool, source) {
    if (source === 'seed') return pool.filter((c) => c._source === 'seed');
    if (source === 'corpus') return pool.filter((c) => c._source !== 'seed');
    if (source && source !== 'all') return pool.filter((c) => c._source === source);
    return pool;
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

    let pool = filterBySource(bank.concepts.slice(), source);

    if (topic !== 'all') {
      pool = pool.filter((c) => matchesNsbCategory(c, topic));
    }

    // Year filter — applies only to corpus concepts (which have a `source.year` and a year tag)
    if (year !== 'all') {
      pool = pool.filter((c) => Array.isArray(c.tags) && c.tags.includes(year));
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

    // Moderator review gate — defaults on (checkbox is `checked` in markup).
    const reviewCheck = $('agent-review-gate');
    if (reviewCheck) {
      App.reviewGate = reviewCheck.checked;
      reviewCheck.addEventListener('change', () => { App.reviewGate = reviewCheck.checked; });
    }

    bindVoiceControls();
    bindLlmConfig();

    $('start-btn').addEventListener('click', startMatch);
    const weakBtn = $('solo-weak-btn');
    if (weakBtn) weakBtn.addEventListener('click', startWeakTopicsMatch);
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

  /**
   * Microphone diagnostic. Separates the two things that can break voice input:
   *   (a) mic hardware / browser permission  → tested with getUserMedia + a live
   *       level meter so you can SEE the mic respond to your voice, and
   *   (b) speech recognition (Chrome → Google) → tested with Agent.listen().
   * Reports the exact failure so it's actionable.
   */
  async function testMicrophone(out) {
    const set = (msg, cls) => { out.textContent = msg; out.className = 'support-line' + (cls ? ' ' + cls : ''); };

    if (!Agent.isSttSupported()) {
      set('❌ This browser can\'t do speech recognition. Use Chrome or Edge on a computer (Safari/Firefox won\'t work for spoken answers).', 'error');
      return;
    }
    const localOk = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!window.isSecureContext && !localOk) {
      set(`⚠️ The mic needs a secure page (https:// or localhost). This page is "${location.protocol}//${location.hostname}", so the browser will block it. Open the app via http://localhost:3000/ or deploy over https.`, 'warn');
      return;
    }

    // (a) Request the mic and show a 3-second level meter.
    set('🎤 Requesting microphone… allow access if the browser asks.');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') set('❌ Microphone permission is blocked. Click the 🔒 (or camera/mic) icon in the address bar, allow the microphone for this site, then retry.', 'error');
      else if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') set('❌ No microphone was found. Connect a mic (or check your computer\'s sound input settings) and retry.', 'error');
      else set('❌ Could not open the microphone: ' + ((e && e.message) || n || 'unknown error'), 'error');
      return;
    }

    let peak = 0;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ac = new Ctx();
      const node = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      node.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const t0 = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let max = 0;
          for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i] - 128));
          peak = Math.max(peak, max);
          const level = Math.max(0, Math.min(20, Math.round((max / 60) * 20)));
          out.className = 'support-line';
          out.textContent = '🎤 Say something! Level: [' + '█'.repeat(level) + '░'.repeat(20 - level) + ']';
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve();
        };
        tick();
      });
      try { ac.close(); } catch (_) {}
    } catch (_) { /* AudioContext unavailable — skip the meter */ }
    stream.getTracks().forEach((t) => t.stop());

    if (peak < 4) {
      set('⚠️ The mic opened but I barely heard any sound. Make sure the right microphone is selected and not muted, then retry (or speak louder/closer).', 'warn');
      return;
    }

    // (b) Now test the speech recognizer itself.
    set('✅ Mic is picking up sound. 🗣️ Now say a word or two for the recognizer…');
    try {
      const heard = await Agent.listen({ timeoutMs: 6000, maxMs: 9000, interim: (t) => set('🗣️ Hearing: "' + t + '"…') });
      if (heard && heard.trim()) set('✅ All set! Mic works and I heard: "' + heard.trim() + '"', 'success');
      else set('⚠️ Your mic works (sound detected), but the recognizer didn\'t catch words. Speak clearly and retry.', 'warn');
    } catch (e) {
      const msg = (e && e.message) || '';
      if (/not-allowed|service-not-allowed/.test(msg)) set('❌ Speech recognition was blocked. Allow the microphone for this site and retry.', 'error');
      else if (/no-speech/.test(msg)) set('⚠️ Your mic works (sound detected), but no speech was recognized. Speak a bit louder/closer and retry.', 'warn');
      else if (/network/.test(msg)) set('❌ Speech recognition needs the internet (Chrome sends audio to Google to transcribe). Check your connection and retry.', 'error');
      else set('⚠️ Mic works, but recognition errored: ' + msg + '. You can still type answers.', 'warn');
    }
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

    const testMic = $('agent-test-mic-btn');
    const micResult = $('agent-mic-result');
    if (testMic && micResult) testMic.addEventListener('click', () => testMicrophone(micResult));

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

  /** When the user changes a match option, update the live count hint. */
  function bindMatchOptionsListeners() {
    const upd = () => updateMatchCount();
    ['match-source', 'match-topic', 'match-year', 'match-length'].forEach((id) => {
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
      length: parseInt(($('match-length') || {}).value, 10) || 25,
    };
    // Mirror the filter logic without shuffling/slicing
    let pool = filterBySource(App.bank.concepts.slice(), opts.source);
    if (opts.topic !== 'all') pool = pool.filter((c) => matchesNsbCategory(c, opts.topic));
    if (opts.year !== 'all') pool = pool.filter((c) => Array.isArray(c.tags) && c.tags.includes(opts.year));

    // Compute rotation breakdown
    const seen = getSeenMap();
    const unseenCount = pool.filter((c) => !seen.has(c.id)).length;
    const seenCount = pool.length - unseenCount;
    const willPlay = Math.min(opts.length, pool.length);
    const willPlayUnseen = Math.min(unseenCount, willPlay);
    const willPlaySeen = willPlay - willPlayUnseen;

    const info = $('match-year-info');
    if (info) {
      const categoryLabel = opts.topic === 'all'
        ? 'all categories'
        : opts.topic === 'biology'
          ? 'biology'
          : opts.topic === 'physics_chemistry'
            ? 'physics/chemistry'
            : opts.topic === 'math'
              ? 'math'
              : 'earth and space science';
    const breakdown = seenCount > 0
        ? `${unseenCount} unseen · ${seenCount} previously seen`
        : `${unseenCount} unseen`;
      const matchPlan = willPlaySeen > 0
        ? `${willPlayUnseen} new + ${willPlaySeen} review`
        : `${willPlayUnseen} new`;
      info.innerHTML = `Pool: <strong>${pool.length}</strong> in <strong>${categoryLabel}</strong> (${breakdown}). ` +
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

    // Tier 2: rule-based was uncertain — escalate to LLM if available and under budget
    if (window.LLMJudge && LLMJudge.enabled && LLMJudge.overBudget && LLMJudge.overBudget()) {
      showQuotaBanner(LLMJudge.budgetNotice());
    } else if (window.LLMJudge && LLMJudge.isReady()) {
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
    if ((err && err.code === 'BUDGET_EXCEEDED') || /spend cap/i.test(msg)) {
      showQuotaBanner(msg);
      return;
    }
    if (!/\bAPI 429\b/i.test(msg)) return;
    showQuotaBanner('Free quota hit for LLM requests. Judging/explanations are using fallback behavior. Switch model or add a different provider key in setup.');
  }

  const BuzzerAudio = {
    ctx: null,

    ensureContext() {
      if (typeof window === 'undefined') return null;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    },

    play(team) {
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      const isTeam1 = team === 1;
      osc.type = isTeam1 ? 'square' : 'triangle';
      osc.frequency.setValueAtTime(isTeam1 ? 880 : 587.33, now);
      osc.frequency.exponentialRampToValueAtTime(isTeam1 ? 659.25 : 440, now + 0.11);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(isTeam1 ? 1800 : 1400, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    },
  };

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
    if (lenSel) App.matchOpts.length = parseInt(lenSel.value, 10) || 25;
    if (srcSel) App.matchOpts.source = srcSel.value || 'all';
    if (topSel) App.matchOpts.topic = topSel.value || 'all';
    if (yearSel) App.matchOpts.year = yearSel.value || 'all';
    const deferEl = $('solo-defer-review');
    App.matchOpts.deferReview = !!(deferEl && deferEl.checked);
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

  /**
   * Build a focused round list from the kid's weak concepts. For each concept
   * it prefers a freshly-generated variant (tagged with the original concept id)
   * and falls back to the original question, but always tracks the round under
   * the ORIGINAL concept id so the dashboard mastery for that topic updates.
   */
  function buildWeakTopicsRounds(weakIds, length) {
    const rounds = [];
    for (const cid of weakIds.slice(0, length)) {
      const orig = App.bank.concepts.find((c) => c.id === cid);
      const gens = App.bank.concepts.filter((c) => c._source === 'generated' && Array.isArray(c.tags) && c.tags.includes(cid));
      const pick = gens.length ? gens[gens.length - 1] : orig;
      if (!pick) continue;
      const tu = pickRandom(pick.tossup_variants);
      const bonusPool = (pick.bonus_variants && pick.bonus_variants.length) ? pick.bonus_variants : ((orig && orig.bonus_variants) || []);
      const bo = pickRandom(bonusPool);
      if (!tu || !bo) continue;
      rounds.push({
        id: rounds.length + 1,
        conceptId: cid,
        category: (orig || pick).category,
        subcategory: (orig || pick).subcategory || null,
        tags: (orig || pick).tags || [],
        source: 'weak-review',
        tossup: tu,
        bonus: bo,
      });
    }
    return shuffle(rounds);
  }

  /**
   * "Practice my weak topics": pull the all-time weak concepts from history
   * (most-missed first), regenerate fresh variants for them when the LLM is
   * available (falling back to existing questions), then start a focused solo
   * match scored against the same concepts so progress is comparable over time.
   */
  async function startWeakTopicsMatch() {
    const out = $('solo-weak-status');
    const set = (m, cls) => { if (out) { out.textContent = m; out.className = 'support-line' + (cls ? ' ' + cls : ''); } };
    if (!App.bank) { set('Question bank still loading — try again in a moment.', 'warn'); return; }

    const stats = window.Progress ? Progress.conceptsWithBank(App.bank.concepts) : [];
    let weak = stats
      .filter((c) => c.mastery === 'struggling' || c.mastery === 'needs_work')
      .sort((a, b) => (a.accuracy - b.accuracy) || (b.attempts - a.attempts));
    if (!weak.length) {
      set('No weak topics yet — finish a practice test first, then this will drill the ones you missed.', 'warn');
      return;
    }
    const length = parseInt(($('match-length') || {}).value, 10) || 10;
    weak = weak.slice(0, length);
    const weakIds = weak.map((w) => w.concept_id);

    // Fresh variants, falling back to the existing questions.
    if (window.LLMJudge && LLMJudge.isReady() && window.Generator) {
      set(`🔄 Writing fresh re-phrasings for ${weakIds.length} weak topic(s)… (uses the LLM, within the daily cap)`);
      try {
        await Generator.generateForWeakConcepts(
          { maxConcepts: weakIds.length, perConcept: 1 },
          (p) => { if (p.phase === 'concept') set(`🔄 Fresh variant ${p.conceptIndex} of ${p.conceptTotal}…`); }
        );
        refreshBank();
      } catch (e) {
        set(`Couldn't generate fresh variants (${e.message || e}) — using your existing questions for these topics.`, 'warn');
      }
    } else {
      set('Tip: enable the LLM Judge for fresh re-phrasings. Using existing questions for now.', 'warn');
    }

    App.rounds = buildWeakTopicsRounds(weakIds, length);
    if (!App.rounds.length) { set('Could not build a quiz from your weak topics.', 'error'); return; }

    App.mode = 'solo';
    App.matchOpts.deferReview = !!($('solo-defer-review') && $('solo-defer-review').checked);
    App.agentDriving = App.agentEnabled && Agent.isTtsSupported();
    showScreen('game-solo');
    App.game = new SoloGame();
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
      this.currentTossupWasInterrupt = false;
      this.pendingRereadTeam = null;
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
      $('judge-btn').addEventListener('click', () => this.onJudgeReviewed());
      // Keep the recorded/explained response in sync with moderator edits.
      $('tt-answer-input').addEventListener('input', () => {
        $('tt-response-text').textContent = $('tt-answer-input').value;
      });
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
      this.currentTossupWasInterrupt = false;
      this.pendingRereadTeam = null;
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
      $('tt-answer-review').classList.add('hidden');
      $('tt-answer-input').value = '';
      $('tt-explanation-panel').classList.add('hidden');
      $('tt-explanation-text').textContent = '';
      if (this.pttBtn) this.pttBtn.classList.add('hidden');
      this.timer.reset();
      this.clearDecisionBanner();
      this.updateHostDisplay();

      if (App.agentDriving) {
        showButtons();
        this.runAgentToss();
      } else {
        showButtons('read-btn');
        $('read-btn').textContent = 'Begin Toss-up Reading (R)';
        this.setStatus(`Round ${this.roundIdx + 1}: read the toss-up aloud. Interrupts can buzz before the question is fully read.`);
      }
    }

    onReadClick() {
      const round = App.rounds[this.roundIdx];
      if (this.phase === 'idle') {
        $('question-text').textContent = round.tossup.question;
        $('question-type').textContent = formatType('Toss-up', round.tossup) + ` · ${TOSSUP_POINTS} pts`;
        this.setPhase('tossup-reading-early');
        showButtons('read-btn');
        $('read-btn').textContent = 'Question Fully Read (R)';
        this.setStatus('Read the toss-up aloud. A/L = interrupt buzz before the question is fully read.');
      } else if (this.phase === 'tossup-reading-early') {
        this.setPhase('tossup-reading');
        showButtons('reveal-btn');
        // Start the NSB buzz window. A buzz (handleBuzz) stops this timer; if it
        // expires with no buzz, onTossupTimeout reveals the answer and advances.
        this.timer.start(TOSSUP_SECONDS, () => this.onTossupTimeout());
        this.setStatus('Question fully read. Wait for the buzz app, then press A (Team 1) or L (Team 2).');
      } else if (this.phase === 'tossup-reread-pending') {
        this.startInterruptReread(false);
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
      const tag = (e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '');
      if (['input', 'textarea', 'select'].includes(tag)) return;
      const k = e.key.toLowerCase();
      if (['tossup-reading-early', 'tossup-reading'].includes(this.phase)) {
        if (k === 'a') { e.preventDefault(); this.handleBuzz(1); return; }
        if (k === 'l') { e.preventDefault(); this.handleBuzz(2); return; }
      }
      if (k === 'r') { e.preventDefault(); clickVisibleButton('read-btn'); return; }
      if (k === 'g') { e.preventDefault(); clickVisibleButton('judge-btn'); return; }
      if (k === 'c') { e.preventDefault(); clickVisibleButton('correct-btn'); return; }
      if (k === 'x') { e.preventDefault(); clickVisibleButton('incorrect-btn'); return; }
      if (k === 'v') { e.preventDefault(); clickVisibleButton('reveal-btn'); return; }
      if (k === 'n') { e.preventDefault(); clickVisibleButton('next-btn'); }
    }

    handleBuzz(team) {
      if (this.teamsTriedTossup.has(team)) return;
      const wasInterrupt = this.phase === 'tossup-reading-early';
      this.timer.stop();
      Agent.cancel();
      BuzzerAudio.play(team);
      this.buzzedTeam = team;
      this.teamsTriedTossup.add(team);
      this.currentTossupWasInterrupt = wasInterrupt;
      this.setPhase('tossup-buzzed');
      this.flashTeam(team);
      if (App.agentDriving) {
        this.setStatus(`${this.teamNames[team]} ${wasInterrupt ? 'interrupted' : 'buzzed'}. Listening for their answer now…`, team);
        this.promptAgentAnswer('tossup', { autoStart: true });
      } else {
        this.setStatus(`${this.teamNames[team]} ${wasInterrupt ? 'interrupted before the question was fully read' : 'buzzed in after the full read'}. Did they answer correctly?`, team);
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
      }
    }

    onCorrect() {
      this.showPtt(false);
      this.clearDecisionBanner();
      $('tt-answer-review').classList.add('hidden');
      if (this.phase === 'tossup-buzzed' || this.phase === 'tossup-reread-answering') {
        this.addScore(this.buzzedTeam, TOSSUP_POINTS);
        this.tossupOwner = this.buzzedTeam;
        this._recordAttempt({ team: this.buzzedTeam, kind: 'tossup', correct: true, response: $('tt-response-text').textContent.trim() });
        this.revealAnswer();
        this._explainForCurrent(true, 'tossup');
        this.currentTossupWasInterrupt = false;
        this.pendingRereadTeam = null;
        this.setPhase('bonus-pending');
        showButtons('read-btn', 'next-btn');
        $('read-btn').textContent = 'Read Bonus (R)';
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
      this.clearDecisionBanner();
      $('tt-answer-review').classList.add('hidden');
      if (this.phase === 'tossup-buzzed') {
        this._recordAttempt({ team: this.buzzedTeam, kind: 'tossup', correct: false, response: $('tt-response-text').textContent.trim() });
        const other = this.buzzedTeam === 1 ? 2 : 1;
        this.clearTeamFlash();
        if (this.currentTossupWasInterrupt) {
          // Interrupt + wrong answer: the opponent gets the toss-up re-read in
          // full and answers it. Points are awarded ONLY if they answer the
          // re-read correctly (handled in onCorrect) — there is no automatic
          // interrupt award. (Previously added +4 here AND +4 on a correct
          // re-read, double-counting to +8.)
          this.pendingRereadTeam = other;
          this.buzzedTeam = other;
          this.currentTossupWasInterrupt = false;
          this.setPhase('tossup-reread-pending');
          showButtons('read-btn', 'reveal-btn');
          $('read-btn').textContent = `Re-read for ${this.teamNames[other]} (R)`;
          this.setStatus(`${this.teamNames[other]} gets the toss-up. Re-read it in full; they answer for ${TOSSUP_POINTS} points.`, other, 'warn');
          if (App.agentDriving) this.startInterruptReread(true);
        } else if (this.teamsTriedTossup.has(other)) {
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
          this.timer.reset();
          if (App.agentDriving) {
            this.setStatus(`${this.teamNames[other]} — your free shot. Listening for their answer now…`, other);
            this.promptAgentAnswer('tossup', { autoStart: true });
          } else {
            this.setStatus(`${this.teamNames[other]} gets the free shot. Judge their answer when they respond.`, other);
            showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
          }
        }
      } else if (this.phase === 'tossup-reread-answering') {
        this._recordAttempt({ team: this.buzzedTeam, kind: 'tossup', correct: false, response: $('tt-response-text').textContent.trim() });
        this.revealAnswer();
        this._explainForCurrent(false, 'tossup');
        this.pendingRereadTeam = null;
        this.setPhase('revealed');
        this.setStatus(`${this.teamNames[this.buzzedTeam]} missed the re-read toss-up. No bonus.`, null, 'danger');
        showButtons('next-btn');
        if (App.agentDriving) Agent.speak('Incorrect. The correct answer was: ' + plainAnswer(App.rounds[this.roundIdx].tossup));
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
        this.setPhase('tossup-reading-early');
        this.setStatus('Buzz anytime during the read for an interrupt. After the full read, wait for the buzz app and press A or L.');
        await Agent.speakQuestion(round.tossup.question);
        if (this.phase !== 'tossup-reading-early') return;
        this.setPhase('tossup-reading');
        showButtons('reveal-btn');
        // Start the NSB buzz window. A buzz (handleBuzz) stops this timer; if it
        // expires with no buzz, onTossupTimeout reveals the answer and advances.
        this.timer.start(TOSSUP_SECONDS, () => this.onTossupTimeout());
        this.setStatus('Question fully read. Wait for the buzz app, then press A (Team 1) or L (Team 2).');
      } catch (err) {
        console.warn('Agent toss-up speak failed:', err);
        // Fallback to manual
        showButtons('read-btn');
        this.setStatus('Agent error — switch to manual.');
      }
    }

    async startInterruptReread(autoSpeak) {
      const round = App.rounds[this.roundIdx];
      const team = this.pendingRereadTeam || this.buzzedTeam;
      if (!team) return;
      this.timer.stop();
      $('question-text').textContent = round.tossup.question;
      $('question-type').textContent = formatType('Toss-up', round.tossup) + ` · ${TOSSUP_POINTS} pts`;
      $('answer-reveal').classList.add('hidden');
      if (!autoSpeak) {
        this.setPhase('tossup-reread-answering');
        this.flashTeam(team);
        this.setStatus(`${this.teamNames[team]} — answer after the full re-read.`, team, 'warn');
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
        return;
      }
      try {
        await Agent.speak(`Re-reading the toss-up for ${this.teamNames[team]}. They answer for ${TOSSUP_POINTS} points.`);
        if (this.phase !== 'tossup-reread-pending') return;
        await Agent.speakQuestion(round.tossup.question);
        if (this.phase !== 'tossup-reread-pending') return;
        this.setPhase('tossup-reread-answering');
        this.flashTeam(team);
        this.setStatus(`${this.teamNames[team]} — listening for their answer now…`, team, 'warn');
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
        this.promptAgentAnswer('tossup', { autoStart: true });
      } catch (err) {
        console.warn('Agent re-read failed:', err);
        this.setPhase('tossup-reread-answering');
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
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
        this.setStatus(`${this.teamNames[this.tossupOwner]} — listening for the bonus answer now…`);
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
        this.timer.start(BONUS_SECONDS, () => this.onBonusTimeout());
        this.promptAgentAnswer('bonus', { autoStart: true });
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
      // No-speech window = time for the player to BEGIN speaking after buzzing.
      // maxMs = absolute cap. The no-speech timer is cleared once they start
      // talking, so a slow or lengthy spoken answer is never cut off mid-word.
      const startWindowMs = (kind === 'tossup' ? 9000 : 12000);
      const maxMs = (kind === 'tossup' ? 20000 : BONUS_SECONDS * 1000);
      this.transcriptEl.classList.remove('hidden');
      this.transcriptEl.innerHTML = '<span class="label">Listening</span>';
      try {
        const transcript = await Agent.listen({
          timeoutMs: startWindowMs,
          maxMs,
          interim: (t) => { this.transcriptEl.innerHTML = `<span class="label">Listening</span><div>${escapeHtml(t)}</div>`; },
        });
        this.timer.stop();
        this.sttFailures = 0;
        this._pttListening = false;
        this.showPtt(false);
        // Moderator review gate: pause so the moderator can reword/fix the heard
        // answer and decide — nothing is judged or scored until they approve.
        if (App.reviewGate) {
          this.enterReview(transcript, kind);
          return;
        }
        const q = (kind === 'tossup') ? App.rounds[this.roundIdx].tossup : App.rounds[this.roundIdx].bonus;
        this.transcriptEl.innerHTML = `<span class="label">Judging…</span><div>"${escapeHtml(transcript)}"</div>`;
        const verdict = await judgeAnswer(transcript, q);
        this.transcriptEl.innerHTML = `<span class="label">Judgment</span>${renderVerdictBlock(verdict, transcript)}`;
        // Persistent response panel — what the team said
        this._showTeamResponse(transcript, verdict, this.buzzedTeam);
        if (verdict.needsReview) {
          this.setDecisionBanner('LLM uncertain — human decide now. Use Mark Correct or Mark Incorrect.', 'warn');
          this.setStatus('Judgment needs review — click Correct or Incorrect to confirm.', null, 'warn');
          showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
          $('two-team-controls').classList.add('review-required');
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
          this.setDecisionBanner('Voice unavailable — moderator judge manually using Correct / Incorrect.', 'danger');
          this.transcriptEl.innerHTML = `<span class="label">Voice unavailable</span><div>Speech recognition couldn't connect (<code>${escapeHtml(msg)}</code>). Clock stopped — judge the answer manually.</div>`;
        } else {
          console.warn('Agent listen error:', msg);
          this.transcriptEl.innerHTML = `<span class="label">Error</span><div>${escapeHtml(msg)} — please use the manual buttons.</div>`;
        }
        if (this.sttFailures >= 2) {
          this.transcriptEl.innerHTML += '<div>Voice had repeated errors. Use manual Correct/Incorrect controls for this round.</div>';
        }
        // Even when voice fails, let the moderator type what they heard and
        // judge it — the review gate doubles as the manual-entry path.
        if (App.reviewGate) {
          this.enterReview('', kind, msg);
          return;
        }
        showButtons('correct-btn', 'incorrect-btn', 'reveal-btn');
      }
    }

    /**
     * Moderator review gate. Shows the heard answer in an editable field and
     * pauses — nothing is judged or scored until the moderator presses Judge
     * (which runs the judge as an assist) or marks Correct/Incorrect directly.
     */
    enterReview(text, kind, note) {
      this._reviewKind = kind;
      this.timer.stop();
      this.showPtt(false);
      this.clearDecisionBanner();
      $('two-team-controls').classList.remove('review-required');
      const input = $('tt-answer-input');
      input.value = text || '';
      $('tt-answer-review').classList.remove('hidden');
      $('tt-response-display').classList.add('hidden');
      // Keep the recorded/explained response in sync from the start.
      $('tt-response-text').textContent = text || '';
      this.transcriptEl.classList.add('hidden');
      this.transcriptEl.innerHTML = '';
      this.setStatus(
        note
          ? `Voice didn't capture (${note}). Type what the team said, then press Judge (G) — or mark it directly.`
          : 'Review or reword the answer, then press Judge (G) — or mark it directly. Nothing is scored until you decide.',
        this.buzzedTeam, 'warn');
      showButtons('judge-btn', 'correct-btn', 'incorrect-btn', 'reveal-btn');
      try { input.focus(); input.select(); } catch (_) {}
    }

    /** Judge the (possibly reworded) answer as guidance — moderator still finalizes. */
    async onJudgeReviewed() {
      const input = $('tt-answer-input');
      const text = (input.value || '').trim();
      $('tt-response-text').textContent = text;
      const round = App.rounds[this.roundIdx];
      const q = (this._reviewKind === 'bonus') ? round.bonus : round.tossup;
      this.transcriptEl.classList.remove('hidden');
      this.transcriptEl.innerHTML = '<span class="label">Judging…</span>';
      const verdict = await judgeAnswer(text, q);
      this.transcriptEl.innerHTML = `<span class="label">Suggested judgment</span>${renderVerdictBlock(verdict, text)}`;
      const conf = Math.round((verdict.confidence || 0) * 100);
      this.setStatus(`Suggested: ${verdict.correct ? 'CORRECT' : 'INCORRECT'} (${conf}% confidence). Confirm with Mark Correct or Mark Incorrect.`, this.buzzedTeam, verdict.correct ? 'success' : 'warn');
      showButtons('judge-btn', 'correct-btn', 'incorrect-btn', 'reveal-btn');
    }

    promptAgentAnswer(kind, options = {}) {
      const { autoStart = false } = options;
      this.showPtt(true);
      if (!autoStart || !App.agentDriving || this._pttListening || !Agent.isSttSupported()) return;
      this.pttBtn && this.pttBtn.classList.add('active');
      setTimeout(() => {
        const phaseMatches = (kind === 'bonus')
          ? this.phase === 'bonus-reading'
          : ['tossup-buzzed', 'tossup-reread-answering'].includes(this.phase);
        if (!phaseMatches || this._pttListening) return;
        this.runAgentAnswer(kind);
      }, 250);
    }

    bindPttButton() {
      if (!this.pttBtn) return;
      const start = (e) => {
        e.preventDefault();
        if (!App.agentDriving || this._pttListening) return;
        if (!['tossup-buzzed', 'tossup-reread-answering', 'bonus-reading'].includes(this.phase)) return;
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
      this.pttBtn.classList.remove('active');
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
      const showBonus = phase.startsWith('bonus') || (phase === 'revealed' && this._lastWasBonus);
      $('phase-label').textContent = showBonus ? 'Bonus' : 'Toss-up';
      $('phase-label').classList.toggle('bonus', showBonus);
      this.updateHostDisplay();
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
      this.updateHostDisplay();
    }

    clearTeamFlash() {
      document.querySelectorAll('.team.active-buzz').forEach(el => el.classList.remove('active-buzz'));
      this.updateHostDisplay();
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


    setDecisionBanner(message, tone) {
      const el = $('decision-banner');
      const controls = $('two-team-controls');
      if (!el || !controls) return;
      if (!message) {
        el.className = 'decision-banner hidden';
        el.textContent = '';
        controls.classList.remove('review-required');
        return;
      }
      el.textContent = message;
      el.className = `decision-banner ${tone || 'warn'}`;
      controls.classList.add('review-required');
    }

    clearDecisionBanner() {
      this.setDecisionBanner('');
    }

    updateHostDisplay() {
      const stateEl = $('round-state');
      const turnEl = $('turn-indicator');
      const interruptEl = $('interrupt-banner');
      const roundInfo = document.querySelector('.round-info');
      const questionCard = $('question-card');
      if (!stateEl || !turnEl) return;
      let stateText = 'Moderator ready';
      let turnText = 'Waiting to begin the toss-up';
      let tone = '';
      let interruptMessage = '';
      if (this.phase === 'tossup-reading-early') {
        stateText = 'Reading in progress';
        turnText = 'Either team may interrupt with A/L';
      } else if (this.phase === 'tossup-reading') {
        stateText = 'Waiting for buzz';
        turnText = 'Use A or L when the buzz app shows who buzzed';
      } else if (this.phase === 'tossup-buzzed') {
        stateText = this.currentTossupWasInterrupt ? 'Interrupt attempt' : 'Toss-up answer';
        turnText = this.buzzedTeam ? `${this.teamNames[this.buzzedTeam]} is answering now` : 'Waiting for an answer';
        tone = this.buzzedTeam || '';
      } else if (this.phase === 'tossup-reread-pending') {
        stateText = 'Interrupt penalty';
        turnText = this.pendingRereadTeam ? `${this.teamNames[this.pendingRereadTeam]} gets +4 and a full re-read` : 'Prepare to re-read the toss-up';
        tone = 'warn';
        interruptMessage = this.pendingRereadTeam
          ? `⚠ INTERRUPT PENALTY — RE-READ THE FULL TOSS-UP FOR ${this.teamNames[this.pendingRereadTeam].toUpperCase()}`
          : '⚠ INTERRUPT PENALTY — RE-READ THE FULL TOSS-UP';
      } else if (this.phase === 'tossup-reread-answering') {
        stateText = 'Re-read answer';
        turnText = this.buzzedTeam ? `${this.teamNames[this.buzzedTeam]} answers after the re-read` : 'Answer after the re-read';
        tone = this.buzzedTeam || 'warn';
        interruptMessage = this.buzzedTeam
          ? `⚠ RE-READ COMPLETE — ${this.teamNames[this.buzzedTeam].toUpperCase()} ANSWERS NOW`
          : '⚠ RE-READ COMPLETE — ANSWER NOW';
      } else if (this.phase === 'bonus-pending') {
        stateText = 'Bonus ready';
        turnText = this.tossupOwner ? `${this.teamNames[this.tossupOwner]} earned the bonus` : 'Bonus ready';
        tone = this.tossupOwner || '';
      } else if (this.phase === 'bonus-reading') {
        stateText = 'Bonus live';
        turnText = this.tossupOwner ? `${this.teamNames[this.tossupOwner]} is conferring / answering` : 'Bonus answering';
        tone = this.tossupOwner || 'warn';
      } else if (this.phase === 'revealed') {
        stateText = 'Answer revealed';
        turnText = 'Review result and move to the next round';
      }
      stateEl.textContent = stateText;
      turnEl.textContent = turnText;
      turnEl.className = 'turn-indicator';
      if (tone === 1 || tone === '1') turnEl.classList.add('team1');
      else if (tone === 2 || tone === '2') turnEl.classList.add('team2');
      else if (tone === 'warn') turnEl.classList.add('warn');

      if (interruptEl) {
        if (interruptMessage) {
          interruptEl.textContent = interruptMessage;
          interruptEl.classList.remove('hidden');
        } else {
          interruptEl.textContent = '';
          interruptEl.classList.add('hidden');
        }
      }
      if (roundInfo) roundInfo.classList.toggle('interrupt-mode', !!interruptMessage);
      if (questionCard) questionCard.classList.toggle('interrupt-mode', !!interruptMessage);
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
      this.updateHostDisplay();
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
      // Guided-review mode: hide answers/score/correctness during the test and
      // present every toss-up AND bonus, then reveal everything in the end review.
      this.deferReview = !!(App.matchOpts && App.matchOpts.deferReview);
      this._answeredCount = 0;
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

      if (this.deferReview) {
        // In guided-review mode the answer is never shown mid-test, so "reveal"
        // wording would be misleading — this button just skips with no answer.
        $('solo-reveal-btn').textContent = 'Skip — no answer';
      }

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
      const ssReset = $('solo-answer-select');
      if (ssReset) { ssReset.classList.add('hidden'); ssReset.innerHTML = ''; }
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
      // Show the answer area. Multiple-choice questions get a friendly dropdown
      // of the W/X/Y/Z options; everything else gets the free-text box.
      $('solo-answer-wrap').classList.remove('hidden');
      const q = this.phase === 'tossup-reading' ? App.rounds[this.roundIdx].tossup : App.rounds[this.roundIdx].bonus;
      const sel = $('solo-answer-select');
      const inp = $('solo-answer-input');
      const choices = q && q.type === 'multiple_choice' ? parseChoices(q.question) : null;
      if (sel && choices) {
        sel.innerHTML = '<option value="" selected disabled>Choose your answer…</option>' +
          choices.map((c) => `<option value="${c.letter}">${c.letter}) ${escapeHtml(c.text)}</option>`).join('');
        sel.classList.remove('hidden');
        inp.classList.add('hidden');
        sel.focus();
      } else {
        if (sel) sel.classList.add('hidden');
        inp.classList.remove('hidden');
        inp.focus();
      }
      // Now that the answer area is open, hide "I'm Ready" (keep "I don't know").
      soloShowButtons('solo-reveal-btn');
      const secs = this.phase === 'tossup-reading' ? 45 : 45;
      this.timer.start(secs, () => this.onAnswerTimeout());
      if (App.agentDriving && Agent.isSttSupported()) {
        this.setStatus(choices ? 'Pick your answer, or hold the mic to say it.' : 'Hold to answer, or type in the box.', null);
        this.showPtt(true);
      }
    }

    async onSubmitTyped() {
      if (this.phase !== 'tossup-reading' && this.phase !== 'bonus-reading') return;
      const sel = $('solo-answer-select');
      const usingSelect = sel && !sel.classList.contains('hidden');
      const txt = (usingSelect ? (sel.value || '') : $('solo-answer-input').value).trim();
      if (!txt) return;
      this.timer.stop();
      Agent.cancel();
      const q = this.phase === 'tossup-reading' ? App.rounds[this.roundIdx].tossup : App.rounds[this.roundIdx].bonus;
      // Show "judging" state if LLM is enabled (skipped in guided-review mode)
      if (!this.deferReview && window.LLMJudge && LLMJudge.isReady()) {
        this.transcriptEl.classList.remove('hidden');
        this.transcriptEl.innerHTML = `<span class="label">Judging…</span><div>"${escapeHtml(txt)}"</div>`;
      }
      const verdict = await judgeAnswer(txt, q);
      if (!this.deferReview) {
        // Render verdict block (withheld in guided-review mode until the end)
        this.transcriptEl.classList.remove('hidden');
        this.transcriptEl.innerHTML = `<span class="label">Judgment</span>${renderVerdictBlock(verdict, txt)}`;
      }
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
      this.lastVerdict = { verdict, given, wasBonus };

      // ---- Accounting (always — feeds the end-of-test review and results) ----
      if (wasBonus) {
        this.bonusesAttempted += 1;
        if (verdict.correct) { this.score += BONUS_POINTS; this.bonusesCorrect += 1; this.correctCount += 1; this.streak += 1; }
        else { this.incorrectCount += 1; this.streak = 0; }
      } else {
        this.tossupsAttempted += 1;
        if (verdict.correct) { this.score += TOSSUP_POINTS; this.tossupsCorrect += 1; this.correctCount += 1; this.streak += 1; this.tossupOwner = true; }
        else { this.incorrectCount += 1; this.streak = 0; }
      }

      // ---- Guided-review mode: reveal nothing until the end ----
      if (this.deferReview) {
        this._answeredCount += 1;
        const totalQ = App.rounds.length * 2;
        this.showResponseNeutral(given);
        this.hideOverrides();
        this.transcriptEl.classList.add('hidden');
        $('solo-answer-reveal').classList.add('hidden');
        $('solo-explanation-panel').classList.add('hidden');
        const cheers = ['Nice — locked in! 🎯', 'Got it! On to the next →', 'Great focus! Keep going 💪', 'Answer saved! Next →', 'Awesome — keep it up ⭐'];
        const cheer = cheers[this._answeredCount % cheers.length];
        const progress = `Question ${this._answeredCount} of ${totalQ}`;
        const last = (this.roundIdx + 1 >= App.rounds.length);
        if (!wasBonus) {
          // Always present the bonus too — every question gets answered.
          this.setPhase('bonus-pending');
          $('solo-read-btn').textContent = 'Next question →';
          soloShowButtons('solo-read-btn');
          this.setStatus(`${cheer}  ·  ${progress}`, null);
        } else {
          this.setPhase('revealed');
          $('solo-next-btn').textContent = last ? 'Finish & review together →' : 'Next question →';
          soloShowButtons('solo-next-btn');
          this.setStatus(last ? `All done! 🎉 Now review every question together.  ·  ${progress}` : `${cheer}  ·  ${progress}`, null);
        }
        this.updateStats();
        return;
      }

      // ---- Normal mode: immediate feedback ----
      this.showResponse(given, verdict);
      this.revealAnswer();
      $('solo-explanation-panel').classList.add('hidden');
      fillExplanation({
        panelId: 'solo-explanation-panel',
        textId: 'solo-explanation-text',
        q,
        studentAnswer: given,
        wasCorrect: !!verdict.correct,
        historyEntry,
      });

      if (wasBonus) {
        if (verdict.correct) {
          this.setStatus(`+${BONUS_POINTS} bonus! ${this.formatVerdict(verdict, given)}`, null, 'success');
          if (App.agentDriving) Agent.speak(`Correct. Plus ten points.`);
        } else {
          this.setStatus(`Bonus missed. ${this.formatVerdict(verdict, given)}`, null, 'danger');
          if (App.agentDriving) Agent.speak(`Incorrect. The answer was: ${plainAnswer(App.rounds[this.roundIdx].bonus)}`);
        }
        this.setPhase('revealed');
        soloShowButtons('solo-next-btn');
        this.showOverrides();
      } else {
        if (verdict.correct) {
          this.setStatus(`+${TOSSUP_POINTS}! ${this.formatVerdict(verdict, given)} — bonus next.`, null, 'success');
          if (App.agentDriving) Agent.speak(`Correct. Plus four points. Bonus question.`);
          this.setPhase('bonus-pending');
          $('solo-read-btn').textContent = 'Read Bonus';
          soloShowButtons(App.agentDriving ? 'solo-next-btn' : 'solo-read-btn', 'solo-next-btn');
          this.showOverrides();
          if (App.agentDriving) this.runAgentBonus();
        } else {
          this.setStatus(`Missed. ${this.formatVerdict(verdict, given)} No bonus.`, null, 'danger');
          if (App.agentDriving) Agent.speak(`Incorrect. The answer was: ${plainAnswer(App.rounds[this.roundIdx].tossup)}`);
          this.setPhase('revealed');
          soloShowButtons('solo-next-btn');
          this.showOverrides();
        }
      }
      this.updateStats();
    }

    showResponseNeutral(given) {
      // Confirm what the kid typed without revealing whether it's right.
      const el = $('solo-response-display');
      const txt = $('solo-response-text');
      el.className = 'response-display';
      let display = (given || '').trim();
      if (display === '(time)' || display === '(skipped)' || !display) display = '(no answer)';
      txt.textContent = display;
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
      const showBonus = phase.startsWith('bonus') || (phase === 'revealed' && this._lastWasBonus);
      $('solo-phase-label').textContent = showBonus ? 'Bonus' : 'Toss-up';
      $('solo-phase-label').classList.toggle('bonus', showBonus);
    }

    setStatus(msg, _team, mod) {
      const el = $('solo-status-line');
      el.textContent = msg;
      el.className = 'status-line';
      if (mod) el.classList.add(mod);
    }

    updateStats() {
      if (this.deferReview) {
        // Guided-review mode: keep score/correctness hidden during the test.
        $('solo-score').textContent = '🔒';
        $('solo-correct').textContent = '–';
        $('solo-incorrect').textContent = '–';
        $('solo-accuracy').textContent = '🔒';
        $('solo-streak').textContent = 'shown at the end';
        return;
      }
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
    ['read-btn', 'judge-btn', 'correct-btn', 'incorrect-btn', 'reveal-btn', 'next-btn'].forEach((id) => {
      $(id).classList.add('hidden');
    });
    ids.forEach((id) => $(id) && $(id).classList.remove('hidden'));
  }

  function clickVisibleButton(id) {
    const el = $(id);
    if (!el || el.classList.contains('hidden') || el.disabled) return false;
    el.click();
    return true;
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

  /**
   * Parse the W/X/Y/Z options out of a multiple-choice question stem.
   * Returns [{letter, text}, …] in W-X-Y-Z order, or null if it can't find them.
   */
  function parseChoices(question) {
    if (!question) return null;
    const re = /\b([WXYZ])\)\s*(.+?)(?=\s+[WXYZ]\)|\s*$)/gs;
    const found = {};
    let m;
    while ((m = re.exec(question)) !== null) {
      found[m[1]] = m[2].replace(/[.\s]+$/, '').trim();
    }
    const out = ['W', 'X', 'Y', 'Z'].filter((l) => found[l]).map((l) => ({ letter: l, text: found[l] }));
    return out.length >= 2 ? out : null;
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
