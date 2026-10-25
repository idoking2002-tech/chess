// Piece voices. Each one is synthesized with Web Audio (formant voice + noise),
// unless a real clip exists at /sounds/<name>.mp3 - then that file is played instead.
window.SFX = (() => {
  const KEYS = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
  const TYPE_TO_KEY = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  // F1, F2, F3 (Hz) per vowel.
  const VOWELS = {
    a: [800, 1150, 2900], o: [450, 800, 2830], u: [325, 700, 2530], e: [480, 1720, 2520],
    i: [300, 2300, 3000], uh: [520, 1190, 2390], ae: [660, 1700, 2400],
  };
  const BW = [90, 110, 170];
  const FGAIN = [1, 0.55, 0.28];

  const settings = load();
  const custom = {};
  let ctx = null, master = null, noiseBuf = null;

  function load() {
    const d = { enabled: true, volume: 0.8, speech: true };
    try { return Object.assign(d, JSON.parse(localStorage.getItem('chess.sound') || '{}')); } catch { return d; }
  }
  function save() {
    try { localStorage.setItem('chess.sound', JSON.stringify(settings)); } catch {}
  }

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 6;
      master = ctx.createGain();
      master.gain.value = settings.volume;
      master.connect(comp).connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function ramp(param, pts, t) {
    param.setValueAtTime(pts[0][1], t + pts[0][0]);
    for (let i = 1; i < pts.length; i++) param.linearRampToValueAtTime(pts[i][1], t + pts[i][0]);
  }

  function driveCurve(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  function noiseSource(t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
    return s;
  }

  // A voiced syllable: sawtooth "glottis" (+ breath noise) through three formant filters.
  function voice(o) {
    const t = ctx.currentTime + 0.02 + (o.at || 0);
    const dur = o.dur;
    const shift = o.formantShift || 1;
    const src = ctx.createGain();

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    ramp(osc.frequency, o.pitch, t);
    const og = ctx.createGain();
    og.gain.value = o.voiced ?? 1;
    osc.connect(og).connect(src);
    osc.start(t);
    osc.stop(t + dur + 0.05);

    if (o.vib) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = o.vib.rate;
      lg.gain.value = o.vib.depth;
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    if (o.breath) {
      const ng = ctx.createGain();
      ng.gain.value = o.breath;
      noiseSource(t, dur).connect(ng).connect(src);
    }

    const env = ctx.createGain();
    ramp(env.gain, o.env || [[0, 0], [0.02, 1], [Math.max(0.03, dur - 0.06), 1], [dur, 0]], t);

    const vowels = o.vowels || [[0, o.vowel || 'a']];
    for (let k = 0; k < 3; k++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = (VOWELS[vowels[0][1]][k] * shift) / BW[k];
      ramp(bp.frequency, vowels.map(([dt, v]) => [dt, VOWELS[v][k] * shift]), t);
      const g = ctx.createGain();
      g.gain.value = FGAIN[k] * 4;
      src.connect(bp).connect(g).connect(env);
    }

    let out = env;
    if (o.drive) {
      const ws = ctx.createWaveShaper();
      ws.curve = driveCurve(o.drive);
      env.connect(ws);
      out = ws;
    }
    const vol = ctx.createGain();
    vol.gain.value = o.gain ?? 1;
    out.connect(vol).connect(master);
  }

  // A filtered noise burst (breaths, "h", "f", thuds).
  function noise(o) {
    const t = ctx.currentTime + 0.02 + (o.at || 0);
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.value = o.freq || 1000;
    f.Q.value = o.q || 1;
    const env = ctx.createGain();
    ramp(env.gain, o.env || [[0, 0], [0.01, o.gain ?? 0.5], [o.dur, 0]], t);
    noiseSource(t, o.dur).connect(f).connect(env).connect(master);
  }

  function tone(o) {
    const t = ctx.currentTime + 0.02 + (o.at || 0);
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    ramp(osc.frequency, o.pitch, t);
    const env = ctx.createGain();
    ramp(env.gain, [[0, 0], [0.005, o.gain ?? 0.4], [o.dur, 0]], t);
    osc.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  let englishVoice = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices();
    englishVoice = vs.find((v) => /^en[-_](US|GB)/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
  }
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
  }

  const SYNTH = {
    // Roblox-style "oof": short, falling, rounded vowel, ends in an "f".
    pawn() {
      voice({ dur: 0.26, pitch: [[0, 240], [0.05, 255], [0.26, 140]], vowels: [[0, 'o'], [0.12, 'u']],
        env: [[0, 0], [0.012, 1], [0.17, 0.8], [0.25, 0]], formantShift: 1.05 });
      noise({ at: 0.19, dur: 0.1, type: 'highpass', freq: 2600, gain: 0.22 });
    },
    // Deep "he-he-he-heh... haaa" laugh.
    king() {
      [0, 0.15, 0.3, 0.45].forEach((at, i) => {
        noise({ at, dur: 0.05, freq: 1400, q: 0.8, gain: 0.35 });
        voice({ at: at + 0.025, dur: 0.11, pitch: [[0, 150 - i * 7], [0.11, 118 - i * 7]], vowel: 'e',
          breath: 0.15, formantShift: 0.88, gain: 0.95 });
      });
      noise({ at: 0.64, dur: 0.06, freq: 1300, q: 0.8, gain: 0.4 });
      voice({ at: 0.67, dur: 0.5, pitch: [[0, 140], [0.5, 92]], vowels: [[0, 'a'], [0.5, 'uh']],
        breath: 0.2, vib: { rate: 9, depth: 9 }, formantShift: 0.88,
        env: [[0, 0], [0.03, 1], [0.3, 0.8], [0.5, 0]] });
    },
    // "HOG RIDAAAA!" - shouted syllables.
    knight() {
      noise({ dur: 0.05, freq: 1500, q: 0.8, gain: 0.4 });
      voice({ at: 0.03, dur: 0.2, pitch: [[0, 185], [0.2, 205]], vowels: [[0, 'o'], [0.2, 'uh']], drive: 2.5 });
      voice({ at: 0.27, dur: 0.13, pitch: [[0, 225], [0.13, 250]], vowels: [[0, 'uh'], [0.13, 'i']], drive: 2.5 });
      voice({ at: 0.42, dur: 0.85, pitch: [[0, 255], [0.15, 305], [0.85, 235]], vowels: [[0, 'e'], [0.1, 'a']],
        vib: { rate: 6, depth: 14 }, breath: 0.2, drive: 3.5, env: [[0, 0], [0.03, 1], [0.6, 0.9], [0.85, 0]] });
    },
    // Blood-curdling scream.
    rook() {
      voice({ dur: 1.0, pitch: [[0, 480], [0.12, 880], [0.7, 820], [1.0, 600]], vowels: [[0, 'ae'], [0.15, 'a']],
        vib: { rate: 7, depth: 35 }, breath: 0.35, drive: 4, formantShift: 1.25, gain: 0.75,
        env: [[0, 0], [0.05, 1], [0.8, 0.9], [1.0, 0]] });
    },
    // Out-of-breath panting: hah-heh-hah-heh.
    bishop() {
      for (let i = 0; i < 4; i++) {
        const at = i * 0.24, out = i % 2 === 0;
        voice({ at, dur: 0.17, pitch: [[0, 190], [0.17, 165]], vowel: out ? 'a' : 'ae', voiced: 0.12, breath: 1.4,
          gain: 0.9, env: [[0, 0], [0.03, 1], [0.08, 0.7], [0.17, 0]] });
        noise({ at, dur: 0.16, freq: out ? 1100 : 1700, q: 1.2, gain: 0.3 });
      }
    },
    // Long, dramatic "uuuhhhhnn" groan.
    queen() {
      voice({ dur: 1.1, pitch: [[0, 230], [0.2, 255], [0.6, 210], [1.1, 170]],
        vowels: [[0, 'o'], [0.5, 'uh'], [1.1, 'u']], vib: { rate: 5, depth: 6 }, breath: 0.3, formantShift: 1.1,
        env: [[0, 0], [0.12, 1], [0.85, 0.8], [1.1, 0]] });
    },
  };

  function speak(text, pitch, rate) {
    if (!englishVoice) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = englishVoice;
    u.lang = englishVoice.lang;
    u.pitch = pitch;
    u.rate = rate;
    u.volume = settings.volume;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    return true;
  }

  // Use real clips dropped into /public/sounds when available.
  fetch('sounds-manifest')
    .then((r) => r.json())
    .then((files) => {
      for (const f of files) {
        const key = f.replace(/\.\w+$/, '').toLowerCase();
        if (KEYS.includes(key)) custom[key] = new Audio(`sounds/${encodeURIComponent(f)}`);
      }
    })
    .catch(() => {});

  function playKey(key) {
    if (custom[key]) {
      const a = custom[key].cloneNode();
      a.volume = settings.volume;
      a.play().catch(() => {});
      return;
    }
    if (key === 'knight' && settings.speech && speak('Hog riderrrr!', 0.7, 1.15)) return;
    if (!ac()) return;
    SYNTH[key]();
  }

  return {
    keys: KEYS,
    settings,
    unlock() { if (settings.enabled) ac(); },
    play(type, force) {
      if (!settings.enabled && !force) return;
      const key = TYPE_TO_KEY[type] || type;
      if (KEYS.includes(key)) playKey(key);
    },
    capture() {
      if (!settings.enabled || !ac()) return;
      noise({ dur: 0.1, type: 'lowpass', freq: 500, gain: 0.7 });
      tone({ dur: 0.12, pitch: [[0, 140], [0.12, 60]], gain: 0.5 });
    },
    notify() {
      if (!settings.enabled || !ac()) return;
      tone({ dur: 0.15, pitch: [[0, 660]], gain: 0.25, type: 'triangle' });
      tone({ at: 0.15, dur: 0.25, pitch: [[0, 990]], gain: 0.25, type: 'triangle' });
    },
    set(k, v) {
      settings[k] = v;
      if (k === 'volume' && master) master.gain.value = v;
      if (k === 'enabled' && !v && 'speechSynthesis' in window) speechSynthesis.cancel();
      save();
    },
  };
})();
