// Agentic Moderator — Web Speech API wrapper + rule-based judge
// Phase 2 will swap rule-based judging for an LLM judge (Claude API).

(() => {
  'use strict';

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;

  const VOICE_PREF_KEY = 'science-bowl-voice-prefs';

  const Agent = {
    state: 'idle',                  // idle | speaking | listening | error
    listeners: new Set(),
    voice: null,
    rate: 0.8,                       // slower default — easier for younger listeners
    pitch: 1.0,
    enabled: false,
    voiceName: null,                 // user override; null = auto-pick
    _recognition: null,
    _currentUtterance: null,
    _keepAlive: null,

    isSupported() {
      return !!synth && !!SpeechRecognition;
    },

    isTtsSupported() {
      return !!synth;
    },

    isSttSupported() {
      return !!SpeechRecognition;
    },

    enable() {
      this.enabled = true;
      this.loadPrefs();
      this._loadVoice();
    },

    disable() {
      this.enabled = false;
      this.cancel();
    },

    loadPrefs() {
      try {
        const raw = localStorage.getItem(VOICE_PREF_KEY);
        if (!raw) return;
        const p = JSON.parse(raw);
        if (typeof p.rate === 'number') this.rate = p.rate;
        if (typeof p.pitch === 'number') this.pitch = p.pitch;
        if (typeof p.voiceName === 'string') this.voiceName = p.voiceName;
      } catch (_) {}
    },

    savePrefs() {
      localStorage.setItem(VOICE_PREF_KEY, JSON.stringify({
        rate: this.rate,
        pitch: this.pitch,
        voiceName: this.voiceName,
      }));
    },

    setRate(r) { this.rate = Number(r) || 0.8; this.savePrefs(); },
    setPitch(p) { this.pitch = Number(p) || 1.0; this.savePrefs(); },

    setVoiceByName(name) {
      this.voiceName = name || null;
      this._loadVoice();
      this.savePrefs();
    },

    /** Return all available voices, with quality-ranked metadata. */
    listVoices() {
      const voices = synth ? synth.getVoices() : [];
      return voices
        .filter((v) => /^en[-_]/i.test(v.lang))
        .map((v) => ({
          name: v.name,
          lang: v.lang,
          localService: v.localService,
          isHighQuality: VOICE_QUALITY.high.test(v.name),
          isEnhanced: VOICE_QUALITY.enhanced.test(v.name),
          isFemale: VOICE_QUALITY.female.test(v.name),
          score: rankVoice(v),
        }))
        .sort((a, b) => b.score - a.score);
    },

    onStateChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },

    _setState(s, detail) {
      this.state = s;
      this.listeners.forEach((fn) => fn(s, detail));
    },

    _loadVoice() {
      const voices = synth.getVoices();
      if (!voices.length) return;

      // 1. Honor explicit user pick if it still exists
      if (this.voiceName) {
        const picked = voices.find((v) => v.name === this.voiceName);
        if (picked) { this.voice = picked; return; }
      }

      // 2. Auto-pick the highest-ranked English voice
      const ranked = voices
        .filter((v) => /^en[-_]/i.test(v.lang))
        .map((v) => ({ v, s: rankVoice(v) }))
        .sort((a, b) => b.s - a.s);
      this.voice = (ranked[0] && ranked[0].v) || voices[0] || null;
    },

    /**
     * Speak text. Resolves when done. Rejects if cancelled.
     * @param {string} text
     * @param {{rate?:number, pitch?:number, onBoundary?:Function}} opts
     */
    speak(text, opts = {}) {
      return new Promise((resolve, reject) => {
        if (!synth) return reject(new Error('SpeechSynthesis not supported'));
        if (!this.voice) this._loadVoice();

        const u = new SpeechSynthesisUtterance(text);
        u.voice = this.voice;
        u.rate = opts.rate ?? this.rate;
        u.pitch = opts.pitch ?? this.pitch;
        u.lang = (this.voice && this.voice.lang) || 'en-US';

        this._currentUtterance = u;
        this._setState('speaking', { text });

        // Single settle path so end / error / safety-timeout can't double-fire.
        let settled = false;
        let safety = null;
        const finishSpeak = (err) => {
          if (settled) return;
          settled = true;
          this._stopKeepAlive();
          if (safety) { clearTimeout(safety); safety = null; }
          if (this._currentUtterance === u) {
            this._currentUtterance = null;
            this._setState('idle');
          }
          if (err) reject(err); else resolve();
        };

        // Chrome silently stops speechSynthesis after ~15s of continuous speech
        // (and is especially flaky with network/cloud voices), which cut the
        // toss-up read off mid-sentence — typically around the longer MC stem.
        // Toggling pause()/resume() on an interval keeps the engine alive for
        // the full utterance. Cleared on settle and by cancel().
        this._stopKeepAlive();
        this._keepAlive = setInterval(() => {
          if (!synth.speaking) { this._stopKeepAlive(); return; }
          try { synth.pause(); synth.resume(); } catch (_) {}
        }, 10000);

        // Safety net: some Chrome/voice combinations never fire onend or
        // onerror, which would leave the agent stuck "speaking" forever — the
        // overlay frozen and any awaiting caller (read flow, post-answer
        // announcement) never resuming. Resolve after a generous estimate of
        // the utterance length so the game always proceeds.
        const wordCount = (text || '').trim().split(/\s+/).filter(Boolean).length;
        const maxMs = Math.min(60000, Math.max(8000, wordCount * 800));
        safety = setTimeout(() => finishSpeak(), maxMs);

        u.onend = () => finishSpeak();
        u.onerror = (e) => {
          // 'canceled' / 'interrupted' aren't true errors
          if (e.error === 'canceled' || e.error === 'interrupted') finishSpeak();
          else finishSpeak(new Error('TTS error: ' + e.error));
        };
        if (opts.onBoundary) u.onboundary = opts.onBoundary;

        synth.speak(u);
      });
    },

    /**
     * Speak a Science Bowl question with kid-friendly cadence:
     *   - Stem read first
     *   - Brief pause (~250ms)
     *   - Each multiple-choice option as its own utterance
     *   - Slightly slower for the option list so letters land cleanly
     *
     * Falls back to a single speak() call for short-answer questions.
     */
    async speakQuestion(text) {
      if (!text || this._cancelRequested) return;
      // Detect MC options as "W) ..." through "Z) ..."
      const m = text.match(/^(.*?)\s*W\)\s*(.+?)\s*X\)\s*(.+?)\s*Y\)\s*(.+?)\s*Z\)\s*(.+?)\s*\.?$/s);
      if (!m) {
        await this.speak(text);
        return;
      }
      const [, stem, w, x, y, z] = m;
      // Read the question stem (drop trailing "?" punctuation cue is fine — it's already there)
      await this.speak(stem.trim());
      if (this._cancelRequested) return;
      await sleep(220);
      if (this._cancelRequested) return;
      // Each option, slightly slower with a clear letter prefix
      const optRate = Math.max(0.55, (this.rate || 0.8) - 0.05);
      const opts = [
        ['W', w], ['X', x], ['Y', y], ['Z', z],
      ];
      for (const [letter, body] of opts) {
        if (this._cancelRequested) return;
        // "Option W. Cell, tissue, organ, or organism."
        await this.speak(`Option ${letter}. ${body.replace(/\.$/, '')}.`, { rate: optRate });
        if (this._cancelRequested) return;
        await sleep(150);
      }
    },

    /**
     * Listen for speech. Resolves with transcript or rejects on timeout/error.
     * @param {{timeoutMs?:number, interim?:Function}} opts
     */
    listen(opts = {}) {
      return new Promise((resolve, reject) => {
        if (!SpeechRecognition) return reject(new Error('SpeechRecognition not supported'));

        let finalTranscript = '';
        let lastInterim = '';
        let speechStarted = false;
        let resolved = false;
        let pendingRetry = false;
        let transientRetries = 0;
        const MAX_TRANSIENT_RETRIES = 2;
        let noSpeechTimer = null;
        let maxTimer = null;
        let rec = null;

        const clearTimers = () => {
          if (noSpeechTimer) { clearTimeout(noSpeechTimer); noSpeechTimer = null; }
          if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
        };

        const finish = (val, err) => {
          if (resolved) return;
          resolved = true;
          clearTimers();
          try { rec && rec.stop(); } catch (_) {}
          this._recognition = null;
          this._setState('idle');
          if (err) reject(err);
          else resolve(val);
        };

        // Once the speaker actually starts talking, cancel the no-speech
        // timeout so a slow or lengthy answer is never cut off mid-sentence.
        const markSpeaking = () => {
          speechStarted = true;
          if (noSpeechTimer) { clearTimeout(noSpeechTimer); noSpeechTimer = null; }
        };

        const startRecognition = () => {
          pendingRetry = false;
          rec = new SpeechRecognition();
          rec.lang = 'en-US';
          rec.interimResults = !!opts.interim;
          rec.maxAlternatives = 3;
          rec.continuous = false;
          rec.onspeechstart = markSpeaking;

          rec.onresult = (event) => {
            markSpeaking();
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const r = event.results[i];
              if (r.isFinal) {
                finalTranscript += r[0].transcript;
              } else {
                lastInterim = r[0].transcript;
                if (opts.interim) opts.interim(r[0].transcript);
              }
            }
            if (finalTranscript.trim()) finish(finalTranscript.trim());
          };

          rec.onerror = (e) => {
            // Chrome can emit a spurious 'no-speech' / 'aborted' / 'audio-capture'
            // right after TTS releases the mic — even while the player is talking.
            // If nothing was captured yet, retry a couple of times within the
            // overall window instead of giving up on the first hiccup.
            const transient = (e.error === 'no-speech' || e.error === 'aborted' || e.error === 'audio-capture');
            const nothingHeard = !speechStarted && !finalTranscript.trim() && !lastInterim.trim();
            if (transient && nothingHeard && !resolved && transientRetries < MAX_TRANSIENT_RETRIES) {
              transientRetries += 1;
              pendingRetry = true;
              try { rec.abort(); } catch (_) {}
              setTimeout(() => { if (!resolved) startRecognition(); }, 200);
              return;
            }
            if (e.error === 'no-speech') finish('', new Error('no-speech'));
            else if (e.error === 'aborted') finish('');
            else finish(null, new Error('STT: ' + e.error));
          };

          rec.onend = () => {
            // onend fires after onerror; if a retry is queued, let it run.
            if (resolved || pendingRetry) return;
            // Prefer a finalized transcript, but fall back to the last interim
            // so a captured-but-not-finalized answer isn't discarded.
            const best = finalTranscript.trim() || lastInterim.trim();
            if (best) finish(best);
            else finish('', new Error('no-speech'));
          };

          this._recognition = rec;
          this._setState('listening');
          try { rec.start(); } catch (_) { /* start() can throw if called too soon after abort; retries/timeouts cover it */ }
        };

        startRecognition();

        // No-speech timeout: only fires if the speaker never starts talking
        // across the whole window (retries included).
        if (opts.timeoutMs) {
          noSpeechTimer = setTimeout(() => {
            if (!speechStarted && !resolved) finish('', new Error('no-speech'));
          }, opts.timeoutMs);
        }
        // Absolute safety cap so recognition can't hang forever — uses whatever
        // was captured (final or last interim) rather than failing outright.
        maxTimer = setTimeout(() => {
          if (resolved) return;
          const best = finalTranscript.trim() || lastInterim.trim();
          if (best) finish(best);
          else finish('', new Error('timeout'));
        }, opts.maxMs || 30000);
      });
    },

    _stopKeepAlive() {
      if (this._keepAlive) { clearInterval(this._keepAlive); this._keepAlive = null; }
    },

    cancel() {
      this._cancelRequested = true;
      this._stopKeepAlive();
      try { synth && synth.cancel(); } catch (_) {}
      try { this._recognition && this._recognition.abort(); } catch (_) {}
      this._currentUtterance = null;
      this._recognition = null;
      this._setState('idle');
      // Give in-flight speech loops a moment to observe cancellation before
      // allowing later speech calls to proceed.
      setTimeout(() => { this._cancelRequested = false; }, 250);
    },
  };

  // Voice quality heuristics. Modern OS voices include "Premium", "Enhanced",
  // "Neural" (Microsoft Edge), and "Natural" naming markers — these are
  // markedly clearer than legacy fallback voices.
  const VOICE_QUALITY = {
    high: /\b(Premium|Enhanced|Neural|Natural|HD)\b/i,
    enhanced: /\b(Aria|Jenny|Eric|Guy|Davis|Sara|Ana|Andrew|Brian|Emma|Michelle|Roger|Steffan|Tony)\b/i, // Microsoft Neural names
    appleNatural: /\b(Ava|Allison|Samantha|Karen|Daniel|Tom|Susan|Kate|Tessa)\s*\(?\s*(Premium|Enhanced)?/i,
    google: /\bGoogle (US|UK|English|en)/i,
    female: /\b(Samantha|Karen|Allison|Susan|Kate|Tessa|Aria|Jenny|Sara|Ana|Emma|Michelle|Ava|Joanna|Salli|Kendra|Kimberly|Ivy|Joanna|Nicole|Russian Female)\b/i,
  };

  function rankVoice(v) {
    let s = 0;
    if (VOICE_QUALITY.high.test(v.name)) s += 50;     // explicit "Premium"/"Enhanced"/"Neural"
    if (VOICE_QUALITY.enhanced.test(v.name)) s += 30; // known Microsoft Neural names
    if (VOICE_QUALITY.appleNatural.test(v.name)) s += 25;
    if (VOICE_QUALITY.google.test(v.name)) s += 20;
    if (VOICE_QUALITY.female.test(v.name)) s += 8;    // tiny preference for clearer-perceived female voices
    if (v.lang === 'en-US') s += 10;
    if (v.lang.startsWith('en')) s += 5;
    if (!v.localService) s += 3;                       // network/cloud voices are usually higher quality
    return s;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Voices may load asynchronously
  if (synth) {
    synth.onvoiceschanged = () => Agent._loadVoice();
  }

  // ============================================================
  //                     RULE-BASED ANSWER JUDGE
  // ============================================================
  // Domain-aware rule judge for Campbell Bio Ch 1-2 (and basics beyond).
  // Pipeline (short-answer):
  //   1. Normalize: lowercase, strip filler words, collapse plurals.
  //   2. Expand abbreviations (DNA → deoxyribonucleic acid).
  //   3. Expand number words (8 ↔ eight).
  //   4. Build the candidate answer set: canonical + accept-alternates +
  //      thesaurus synonyms (bidirectional walk).
  //   5. Try, in order: exact match, substring, stem match, Levenshtein,
  //      token overlap. First strong hit wins.
  //
  // The thesaurus targets concepts in Campbell Bio Ch 1-2 plus common NSB-MS
  // bio/chem terms. Each entry maps a canonical answer (lowercase, normalized)
  // to a list of acceptable phrasings the student might give.

  // ---------------- Domain thesaurus ----------------
  const SYNONYMS = {
    // -------- Biology themes / hierarchy --------
    'emergent properties': ['emergent property', 'emergence', 'emergent characteristics'],
    'biodiversity': ['diversity of life', 'species diversity', 'biological diversity'],
    'homeostasis': ['internal regulation', 'stable internal environment', 'physiological regulation', 'homeostatic regulation'],
    'population': ['populations'],
    'ecosystem': ['ecological system', 'ecosystems'],
    'community': ['biological community', 'communities'],
    'organism': ['organisms', 'individual organism'],
    'gene expression': ['protein synthesis from dna', 'expression of genes'],

    // -------- Domains / classification --------
    'bacteria': ['domain bacteria', 'kingdom bacteria', 'eubacteria'],
    'archaea': ['domain archaea', 'archaebacteria'],
    'eukarya': ['domain eukarya', 'eukaryotes', 'eukaryota'],
    'eukaryote': ['eukaryotic organism', 'eukaryotes'],
    'prokaryote': ['prokaryotic organism', 'prokaryotes'],

    // -------- Evolution --------
    'natural selection': ['darwinian selection', 'selection by nature', 'darwinian natural selection'],
    'homologous structures': ['homologies', 'homology', 'homologous features', 'homologous parts'],
    'analogous structures': ['analogies', 'analogous features', 'convergent structures'],
    'adaptation': ['adaptive trait', 'adaptive feature', 'adaptations'],
    'charles darwin': ['darwin'],
    'alfred russel wallace': ['wallace', 'alfred wallace', 'a r wallace'],
    'galapagos islands': ['galapagos', 'the galapagos'],
    'hms beagle': ['the beagle', 'beagle'],
    'evolution': ['biological evolution', 'darwinian evolution', 'evolutionary change'],

    // -------- Scientific inquiry --------
    'hypothesis': ['scientific hypothesis', 'testable hypothesis', 'testable explanation', 'hypotheses'],
    'control group': ['control', 'controls', 'experimental control'],
    'inductive': ['induction', 'inductive reasoning'],
    'deductive': ['deduction', 'deductive reasoning'],
    'discovery science': ['descriptive science', 'observational science', 'observational study'],
    'theory': ['scientific theory'],

    // -------- Chemistry: atoms --------
    'neutron': ['neutrons', 'neutral particle'],
    'proton': ['protons', 'positive particle', 'positively charged particle'],
    'electron': ['electrons', 'negatively charged particle'],
    'isotope': ['isotopes'],
    'valence electrons': ['valence', 'valence electron', 'outer electrons', 'outermost electrons', 'outer shell electrons'],
    'noble gases': ['inert gases', 'noble gas', 'group 18 elements', 'group viii elements'],
    'inert': ['unreactive', 'stable', 'chemically inert', 'nonreactive'],
    'atomic number': ['number of protons'],
    'mass number': ['nucleon number', 'atomic mass number'],

    // -------- Chemistry: bonding --------
    'covalent bond': ['covalent', 'shared electron bond', 'electron sharing bond'],
    'polar covalent bond': ['polar covalent', 'polar bond'],
    'nonpolar covalent bond': ['nonpolar covalent', 'nonpolar bond'],
    'ionic bond': ['ionic', 'ionic bonding'],
    'hydrogen bond': ['hydrogen bonding', 'h bond', 'h-bond'],
    'van der waals interactions': ['van der waals forces', 'london dispersion forces', 'dispersion forces', 'van der waals'],
    'electronegativity': ['electronegative pull', 'electron attraction'],
    'molecular shape': ['molecular geometry', 'conformation', 'three dimensional shape', '3d shape'],
    'oxygen': ['o2'], // for "oxygen" answers; the reverse (O2 → oxygen) handled by abbreviations

    // -------- Chemistry: reactions --------
    'reactants': ['reactant', 'starting materials', 'starting substances'],
    'products': ['product'],
    'chemical equilibrium': ['equilibrium', 'reaction equilibrium'],
    'cellular respiration': ['cell respiration', 'aerobic respiration'],

    // -------- General bio terms --------
    'cell': ['cells'],
    'cells': ['cell'],
    'tissue': ['tissues'],
    'organ': ['organs'],
    'molecule': ['molecules'],
    'organelle': ['organelles'],
    'atom': ['atoms'],
  };

  // Common abbreviations expand to full names (and vice versa)
  const ABBREVIATIONS = {
    'dna': 'deoxyribonucleic acid',
    'rna': 'ribonucleic acid',
    'mrna': 'messenger ribonucleic acid',
    'trna': 'transfer ribonucleic acid',
    'rrna': 'ribosomal ribonucleic acid',
    'atp': 'adenosine triphosphate',
    'adp': 'adenosine diphosphate',
    'amp': 'adenosine monophosphate',
    'co2': 'carbon dioxide',
    'h2o': 'water',
    'o2': 'oxygen',
    'n2': 'nitrogen',
    'h': 'hydrogen',
    'c': 'carbon',
    'n': 'nitrogen',
    'o': 'oxygen',
  };

  // Number words ↔ digits, mostly to handle small integer answers
  const NUMBER_WORDS = {
    'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
    'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
    'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
    'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
    'eighteen': '18', 'nineteen': '19', 'twenty': '20',
  };
  const DIGITS_TO_WORDS = Object.fromEntries(
    Object.entries(NUMBER_WORDS).map(([w, d]) => [d, w])
  );

  // Build the bidirectional synonym lookup once at module load
  const SYNONYM_LOOKUP = (() => {
    const map = new Map();
    const addEdge = (a, b) => {
      const na = norm(a), nb = norm(b);
      if (!na || !nb) return;
      if (!map.has(na)) map.set(na, new Set());
      map.get(na).add(nb);
    };
    for (const [canonical, alts] of Object.entries(SYNONYMS)) {
      addEdge(canonical, canonical);
      for (const alt of alts) {
        addEdge(canonical, alt);
        addEdge(alt, canonical);
        // also link alts to each other
        for (const other of alts) if (other !== alt) addEdge(alt, other);
      }
    }
    return map;
  })();

  const Judge = {
    /**
     * @param {string} spoken
     * @param {{type:string, answer:string, answer_text?:string}} q
     * @returns {{correct:boolean, confidence:number, reason:string}}
     */
    judge(spoken, q) {
      const sp = norm(spoken);
      if (!sp) return { correct: false, confidence: 0, reason: 'empty' };
      return q.type === 'multiple_choice'
        ? this._judgeMultipleChoice(sp, q)
        : this._judgeShortAnswer(sp, q);
    },

    _judgeMultipleChoice(sp, q) {
      const expectedLetter = q.answer.toLowerCase();
      const tokens = sp.split(/\s+/).filter(Boolean);

      // 1. Unambiguous single-letter token (W/X/Y/Z). Highest-confidence signal.
      const explicit = tokens.find((t) => /^[wxyz]$/.test(t));
      if (explicit) {
        if (explicit === expectedLetter) return { correct: true, confidence: 0.95, reason: 'letter match' };
        return { correct: false, confidence: 0.9, reason: `heard letter ${explicit.toUpperCase()}, expected ${q.answer}` };
      }

      // 2. Verbal answer matching the correct option text. Tried BEFORE phonetic
      //    homophones so a real answer containing a word like "why" isn't
      //    mis-read as the letter Y.
      if (q.answer_text) {
        const verbal = this._judgeShortAnswer(sp, { ...q, type: 'short_answer', answer: q.answer_text });
        if (verbal.correct) return { ...verbal, reason: `verbal: ${verbal.reason}` };
      }

      // 3. Phonetic homophone ("why"=Y, "ex"=X, "zee"=Z, …) — only when the
      //    student essentially just said the letter (a short utterance), so
      //    "why is it the third one" doesn't collide with the letter Y.
      if (tokens.length <= 2) {
        const phon = tokens.find((t) => /^(double[uw]|doubleyou|ex|why|zee|zed)$/.test(t));
        if (phon) {
          const heard = phoneticToLetter(phon);
          if (heard === expectedLetter) return { correct: true, confidence: 0.9, reason: 'letter match (phonetic)' };
          return { correct: false, confidence: 0.85, reason: `heard letter ${heard.toUpperCase()}, expected ${q.answer}` };
        }
      }
      return { correct: false, confidence: 0.5, reason: 'no match' };
    },

    _judgeShortAnswer(sp, q) {
      // Multi-part canonical answers ("Bacteria, Archaea, and Eukarya") require
      // EVERY part — a single matching part earns no credit. This mirrors the
      // LLM judge's rule 5 (no partial credit on multi-part answers).
      const parts = requiredParts(q.answer);
      if (parts.length) {
        const allPresent = parts.every((p) => sp === p || containsWord(sp, p));
        return allPresent
          ? { correct: true, confidence: 0.95, reason: 'all required parts present', match: q.answer }
          : { correct: false, confidence: 0.6, reason: 'multi-part answer is missing one or more required parts', match: null };
      }

      // Negation guard: if the student negates and the canonical does not, no
      // fuzzy/substring match should count as correct ("not oxygen" ≠ "oxygen").
      const NEGATION = /\b(not|no|never|none|nor)\b/;
      const studentNegates = NEGATION.test(sp);
      const canonicalNegates = NEGATION.test(norm(q.answer));

      // Build a rich set of acceptable answer forms
      const baseCandidates = expandAcceptables(q.answer);
      const candidates = new Set();
      for (const c of baseCandidates) {
        const n = norm(c);
        if (!n) continue;
        candidates.add(n);
        // Synonym expansion
        const syns = SYNONYM_LOOKUP.get(n) || new Set();
        syns.forEach((s) => candidates.add(s));
        // Two-hop walk: synonyms of synonyms (covers "homology" → "homologous structures" → "homologies")
        for (const s of syns) {
          const more = SYNONYM_LOOKUP.get(s) || new Set();
          more.forEach((m) => candidates.add(m));
        }
        // Abbreviation expansions
        if (ABBREVIATIONS[n]) candidates.add(ABBREVIATIONS[n]);
        // Reverse abbreviation lookup
        for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
          if (full === n) candidates.add(abbr);
        }
        // Number-word equivalence on the canonical
        candidates.add(wordsToDigits(n));
        candidates.add(digitsToWords(n));
      }
      // Same expansion on the student answer
      const studentForms = new Set([
        sp,
        wordsToDigits(sp),
        digitsToWords(sp),
        normalizeAbbrev(sp),
      ]);

      // Try each (student-form, candidate) pair; return on first strong hit.
      let best = { correct: false, confidence: 0, reason: 'no match', match: null };
      for (const studentForm of studentForms) {
        if (!studentForm) continue;
        for (const exp of candidates) {
          if (!exp) continue;
          // 1. Exact
          if (studentForm === exp) {
            return { correct: true, confidence: 1.0, reason: studentForm === sp ? 'exact' : 'exact (after normalization)', match: exp };
          }
          // 2. Substring (whole-word, either direction). Word-boundary aligned
          //    and length-guarded so a short candidate like "c" (carbon) can't
          //    match inside an unrelated word ("calcium"). Confidence stays
          //    below the Tier-1 cutoff (0.85) so borderline phrasings escalate
          //    to the LLM judge instead of being trusted outright.
          if (containsWord(studentForm, exp) || containsWord(exp, studentForm)) {
            if (best.confidence < 0.82) best = { correct: true, confidence: 0.82, reason: 'substring', match: exp };
            continue;
          }
          // 3. Stem-level equality (e.g., "homologous" stem == "homology" stem)
          if (stemEqual(studentForm, exp)) {
            if (best.confidence < 0.88) best = { correct: true, confidence: 0.88, reason: 'stem match', match: exp };
            continue;
          }
          // 4. Levenshtein similarity
          const score = similarity(studentForm, exp);
          if (score >= 0.78 && score > best.confidence) {
            best = { correct: true, confidence: score, reason: `fuzzy (${score.toFixed(2)})`, match: exp };
          } else if (score > best.confidence) {
            best = { correct: false, confidence: score, reason: `fuzzy below threshold (${score.toFixed(2)})`, match: exp };
          }
          // 5. Token overlap (for multi-word canonical answers)
          const overlap = tokenOverlap(studentForm, exp);
          if (overlap >= 0.7 && overlap > best.confidence) {
            best = { correct: true, confidence: overlap, reason: `token overlap (${overlap.toFixed(2)})`, match: exp };
          } else if (overlap > best.confidence && overlap >= 0.5) {
            best = { correct: false, confidence: overlap, reason: `partial token overlap (${overlap.toFixed(2)})`, match: exp };
          }
        }
      }
      if (best.correct && studentNegates && !canonicalNegates) {
        return { correct: false, confidence: 0.55, reason: 'student answer negates the canonical', match: best.match };
      }
      return best;
    },
  };

  // ---------- helpers ----------
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      // Remove parenthesized hints "(accept: ...)" etc. — handled separately
      .replace(/[^a-z0-9\s]/g, ' ')
      // Strip filler / common interjections that don't add meaning
      .replace(/\b(a|an|the|of|is|are|um|uh|er|my|answer|i|think|guess|maybe|like|you know|its|it s)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Convert spelled-out small numbers to digits ("eight" → "8"). */
  function wordsToDigits(s) {
    return s.replace(
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g,
      (m) => NUMBER_WORDS[m]
    );
  }

  /** Convert small digits to words ("8" → "eight"). */
  function digitsToWords(s) {
    return s.replace(/\b(\d{1,2})\b/g, (m) => DIGITS_TO_WORDS[m] || m);
  }

  /** Expand abbreviations: "dna" → "deoxyribonucleic acid". Doesn't collapse the reverse. */
  function normalizeAbbrev(s) {
    return s.replace(/\b([a-z0-9]+)\b/g, (tok) => ABBREVIATIONS[tok] || tok);
  }

  function phoneticToLetter(token) {
    const map = {
      'w': 'w', 'doubleu': 'w', 'doublew': 'w', 'doubleyou': 'w',
      'x': 'x', 'ex': 'x',
      'y': 'y', 'why': 'y',
      'z': 'z', 'zee': 'z', 'zed': 'z',
    };
    return map[token.replace(/\s/g, '')] || token[0];
  }

  function expandAcceptables(answer) {
    const list = [answer];
    const m = answer.match(/accept[:\s]+([^)]+?)(?:\)|$)/i);
    if (m) {
      const alts = m[1].split(/[,;]| or /).map((s) => s.trim()).filter(Boolean);
      list.push(...alts);
    }
    list.push(answer.replace(/\s*\(accept[^)]*\)\s*/i, '').trim());
    list.push(answer.replace(/\s*\(do not accept[^)]*\)\s*/i, '').trim());
    return [...new Set(list.filter(Boolean))];
  }

  /**
   * Lightweight stemmer for short bio/chem terms.
   * Strips common English suffixes; designed for length, not perfection.
   * Examples:
   *   "homologous" → "homolog"
   *   "homology"   → "homolog"
   *   "homologies" → "homolog"
   *   "selection"  → "select"
   */
  function stem(word) {
    if (word.length < 4) return word;
    return word
      .replace(/ies$/, 'y')
      .replace(/(?:ous|ity|tion|sion|ment|ness|ic|ical|ally|ly)$/, '')
      .replace(/(?:ing|ed|s|y|e)$/, '')
      .toLowerCase();
  }

  /** Compare phrase A and B as bags of stemmed tokens. True when ≥80% overlap. */
  function stemEqual(a, b) {
    const sa = a.split(/\s+/).filter(Boolean).map(stem);
    const sb = b.split(/\s+/).filter(Boolean).map(stem);
    if (!sa.length || !sb.length) return false;
    const setA = new Set(sa);
    const inter = sb.filter((t) => setA.has(t)).length;
    const cov = inter / Math.max(sa.length, sb.length);
    return cov >= 0.8;
  }

  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    const dist = levenshtein(a, b);
    return 1 - dist / Math.max(a.length, b.length);
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const v0 = new Array(n + 1);
    const v1 = new Array(n + 1);
    for (let i = 0; i <= n; i++) v0[i] = i;
    for (let i = 0; i < m; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < n; j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (let j = 0; j <= n; j++) v0[j] = v1[j];
    }
    return v1[n];
  }

  function tokenOverlap(a, b) {
    const ta = new Set(a.split(/\s+/).filter(Boolean));
    const tb = b.split(/\s+/).filter(Boolean);
    if (!tb.length) return 0;
    const hits = tb.filter((t) => ta.has(t)).length;
    return hits / tb.length;
  }

  /** True if `needle` (≥3 chars) appears as a whole word inside `hay`. */
  function containsWord(hay, needle) {
    if (!needle || needle.length < 3) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + escaped + '\\b').test(hay);
  }

  /**
   * Split a conjunctive multi-part canonical answer ("A, B, and C") into its
   * required, normalized components. Returns [] for single-part answers and for
   * disjunctions ("A or B"), where either alternative suffices and normal
   * matching should run instead.
   */
  function requiredParts(answer) {
    const cleaned = String(answer || '')
      .replace(/\((?:accept|do not accept)[^)]*\)/ig, '')
      .replace(/\baccept[:\s][^).]*/ig, '');
    if (/\bor\b/i.test(cleaned)) return [];
    const parts = cleaned.split(/,|\band\b/i).map((s) => norm(s)).filter(Boolean);
    return parts.length > 1 ? parts : [];
  }

  window.Agent = Agent;
  window.Judge = Judge;
})();
