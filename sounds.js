// Game sounds. Voices are synthesized with Web Audio (glottal source + 5 formants,
// pitch jitter, roughness, breath and a little room reverb); spoken lines use the
// browser's text-to-speech with a synthesized fallback. A real clip dropped into
// sounds/<name>.mp3 always wins over the synthesized version.
window.SFX = (() => {
  const KEYS = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn', 'check', 'mate'];
  const TYPE_TO_KEY = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  // Formant frequencies F1..F5 (Hz, adult male) and bandwidths.
  const VOWELS = {
    a: [730, 1090, 2440, 3400, 4500], e: [530, 1840, 2480, 3400, 4500], i: [270, 2290, 3010, 3500, 4500],
    o: [570, 840, 2410, 3400, 4500], u: [300, 870, 2240, 3400, 4500], uh: [640, 1190, 2390, 3400, 4500],
    ae: [660, 1720, 2410, 3400, 4500], r: [490, 1350, 1690, 3300, 4500], l: [360, 1000, 2500, 3400, 4500],
  };
  const BW = [80, 90, 120, 150, 200];
  const FGAIN = [1, 0.6, 0.35, 0.2, 0.12];

  const settings = load();
  const custom = {};
  let ctx = null, master = null, voiceBus = null, noiseBuf = null, glottal = null;
  let songBus = null, songAudio = null, ttsWarm = false;

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
      comp.threshold.value = -14;
      comp.ratio.value = 5;
      master = ctx.createGain();
      master.gain.value = settings.volume;
      master.connect(comp).connect(ctx.destination);

      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

      // Glottal pulse spectrum: harmonics falling ~ -7 dB/octave.
      const n = 80, real = new Float32Array(n), imag = new Float32Array(n);
      for (let k = 1; k < n; k++) imag[k] = 1 / Math.pow(k, 1.15);
      glottal = ctx.createPeriodicWave(real, imag);

      // Voices go through a small room so they don't sound "in a box".
      voiceBus = ctx.createGain();
      const rev = ctx.createConvolver();
      const len = Math.floor(ctx.sampleRate * 1.4);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const ch = ir.getChannelData(c);
        for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.5);
      }
      rev.buffer = ir;
      const wet = ctx.createGain();
      wet.gain.value = 0.16;
      voiceBus.connect(master);
      voiceBus.connect(rev).connect(wet).connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  const T = (at) => ctx.currentTime + 0.03 + (at || 0);

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
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.1);
    return s;
  }
  function slowNoise(t, dur, freq, amount) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = freq;
    lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.value = amount;
    noiseSource(t, dur).connect(lp).connect(g);
    return g;
  }

  // One voiced (or whispered) syllable.
  //   pitch: [[t, Hz]...]  vowels: [[t, 'a']...]  env: [[t, gain]...]
  //   jitter: random pitch wobble, rough: harsh amplitude flutter, breath: aspiration,
  //   voiced: 0 = whisper, vib: {rate, depth (cents)}, drive: distortion, formantShift: >1 = smaller head
  function voice(o) {
    const t = T(o.at), dur = o.dur, shift = o.formantShift || 1;
    const src = ctx.createGain();

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(glottal);
    ramp(osc.frequency, o.pitch, t);
    slowNoise(t, dur, 14, 1400 * (o.jitter ?? 0.5)).connect(osc.detune);
    if (o.vib) {
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = o.vib.rate;
      lg.gain.value = o.vib.depth;
      lfo.connect(lg).connect(osc.detune);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    const og = ctx.createGain();
    og.gain.value = o.voiced ?? 1;
    if (o.rough) slowNoise(t, dur, 70, 9 * o.rough).connect(og.gain);
    osc.connect(og).connect(src);
    osc.start(t);
    osc.stop(t + dur + 0.05);

    if (o.breath) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 400;
      const ng = ctx.createGain();
      ng.gain.value = o.breath * 0.6;
      noiseSource(t, dur).connect(hp).connect(ng).connect(src);
    }

    const env = ctx.createGain();
    ramp(env.gain, o.env || [[0, 0], [0.02, 1], [Math.max(0.03, dur - 0.06), 1], [dur, 0]], t);

    const vowels = o.vowels || [[0, o.vowel || 'a']];
    for (let k = 0; k < 5; k++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = (VOWELS[vowels[0][1]][k] * shift) / BW[k];
      ramp(bp.frequency, vowels.map(([dt, v]) => [dt, VOWELS[v][k] * shift]), t);
      const g = ctx.createGain();
      g.gain.value = FGAIN[k] * 5;
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
    out.connect(vol).connect(o.dest || voiceBus);
  }

  // Filtered noise: breaths, "h", "sh", "f", "t", thuds.
  function noise(o) {
    const t = o.abs ?? T(o.at);
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.value = o.freq || 1000;
    f.Q.value = o.q || 1;
    const env = ctx.createGain();
    ramp(env.gain, o.env || [[0, 0], [0.005, o.gain ?? 0.5], [o.dur, 0]], t);
    noiseSource(t, o.dur).connect(f).connect(env).connect(o.dest || voiceBus);
  }

  function tone(o) {
    const t = o.abs ?? T(o.at);
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    if (o.exp) {
      osc.frequency.setValueAtTime(o.pitch[0][1], t);
      osc.frequency.exponentialRampToValueAtTime(o.pitch[1][1], t + o.pitch[1][0]);
    } else ramp(osc.frequency, o.pitch, t);
    if (o.detune) osc.detune.value = o.detune;
    const env = ctx.createGain();
    ramp(env.gain, o.env || [[0, 0], [0.005, o.gain ?? 0.4], [o.dur, 0]], t);
    let node = osc.connect(env);
    if (o.filter) node = node.connect(o.filter);
    node.connect(o.dest || master);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  // An aspirated "h" into a vowel.
  const h = (at, vowel, f, gain = 0.8, dur = 0.06) =>
    voice({ at, dur, pitch: [[0, f]], vowel, voiced: 0, breath: 1.6, gain,
      env: [[0, 0], [0.012, 1], [dur, 0.2]] });

  // ---------- synthesized sounds ----------
  const SYNTH = {
    // Roblox "oof": short, rounded, falling, ends in a soft "f".
    pawn() {
      voice({ dur: 0.3, pitch: [[0, 205], [0.04, 232], [0.3, 148]], vowels: [[0, 'o'], [0.1, 'u']],
        breath: 0.1, jitter: 0.5, env: [[0, 0], [0.012, 1], [0.17, 0.85], [0.28, 0]] });
      noise({ at: 0.21, dur: 0.13, freq: 4200, q: 0.7, gain: 0.16 });
    },

    // Big belly laugh: "huh-huh-huh-ha-ha... haaaa".
    king() {
      const syl = [[0, 0.12, 150], [0.19, 0.12, 146], [0.37, 0.12, 140], [0.54, 0.13, 132], [0.72, 0.14, 124]];
      syl.forEach(([at, d, f], i) => {
        h(at, i < 3 ? 'uh' : 'a', f);
        voice({ at: at + 0.045, dur: d, pitch: [[0, f * 1.06], [d, f * 0.82]], vowel: i < 3 ? 'uh' : 'a',
          breath: 0.3, jitter: 0.9, rough: 0.35, formantShift: 0.9,
          env: [[0, 0], [0.02, 1], [d * 0.6, 0.8], [d, 0]] });
      });
      h(0.93, 'a', 120, 0.9, 0.08);
      voice({ at: 0.99, dur: 0.6, pitch: [[0, 128], [0.6, 88]], vowels: [[0, 'a'], [0.6, 'uh']],
        breath: 0.35, jitter: 1, rough: 0.5, vib: { rate: 7, depth: 45 }, formantShift: 0.9,
        env: [[0, 0], [0.03, 1], [0.35, 0.75], [0.6, 0]] });
    },

    // "HOG RIDAAAA!" (fallback when text-to-speech is unavailable).
    knight() {
      const yell = { breath: 0.25, jitter: 0.7, rough: 0.25, drive: 1.8 };
      h(0, 'o', 185, 0.9);
      voice({ ...yell, at: 0.05, dur: 0.2, pitch: [[0, 180], [0.2, 198]], vowel: 'o' });
      noise({ at: 0.25, dur: 0.03, type: 'lowpass', freq: 700, gain: 0.35 }); // g
      voice({ ...yell, at: 0.29, dur: 0.09, pitch: [[0, 205], [0.09, 228]], vowels: [[0, 'r'], [0.09, 'a']] });
      voice({ ...yell, at: 0.38, dur: 0.14, pitch: [[0, 232], [0.14, 250]], vowels: [[0, 'a'], [0.14, 'i']] });
      noise({ at: 0.53, dur: 0.02, type: 'highpass', freq: 2500, gain: 0.25 }); // d
      voice({ ...yell, at: 0.55, dur: 1.0, pitch: [[0, 250], [0.2, 305], [0.75, 290], [1.0, 230]],
        vowels: [[0, 'uh'], [0.12, 'a']], vib: { rate: 6, depth: 55 }, rough: 0.45, drive: 2.6,
        env: [[0, 0], [0.03, 1], [0.75, 0.9], [1.0, 0]] });
    },

    // Rough, chaotic scream with a sub-harmonic growl underneath.
    rook() {
      const pitch = [[0, 520], [0.1, 950], [0.5, 1030], [1.0, 900], [1.3, 640]];
      const env = [[0, 0], [0.06, 1], [1.0, 0.9], [1.3, 0]];
      voice({ dur: 1.3, pitch, vowels: [[0, 'ae'], [0.2, 'a']], vib: { rate: 6.5, depth: 70 }, jitter: 2,
        rough: 1, breath: 0.45, drive: 3, formantShift: 1.2, gain: 0.7, env });
      voice({ dur: 1.3, pitch: pitch.map(([t, f]) => [t, f / 2]), vowel: 'a', jitter: 2.5, rough: 1,
        drive: 2, formantShift: 1.2, gain: 0.25, env });
    },

    // Out-of-breath panting: whispered "hah-heh" in and out.
    bishop() {
      for (let i = 0; i < 6; i++) {
        const at = i * 0.21, out = i % 2 === 0, d = out ? 0.16 : 0.12;
        voice({ at, dur: d, pitch: [[0, 210], [d, 180]], vowel: out ? 'a' : 'ae', voiced: 0.05, breath: 1.7,
          gain: out ? 1 : 0.65, env: [[0, 0], [0.025, 1], [0.07, 0.6], [d, 0]] });
      }
    },

    // Creaky start into a long "uuuhhhhnn" groan.
    queen() {
      voice({ dur: 0.28, pitch: [[0, 68], [0.28, 95]], vowel: 'o', jitter: 3, rough: 1, breath: 0.2,
        formantShift: 1.12, gain: 0.55 });
      voice({ at: 0.2, dur: 1.25, pitch: [[0, 185], [0.25, 240], [0.7, 215], [1.25, 155]],
        vowels: [[0, 'o'], [0.45, 'uh'], [0.95, 'u']], vib: { rate: 5, depth: 28 }, jitter: 1, rough: 0.3,
        breath: 0.4, formantShift: 1.12, env: [[0, 0], [0.15, 1], [0.95, 0.8], [1.25, 0]] });
    },

    // "HOLY SHIT!" (fallback when text-to-speech is unavailable).
    check() {
      const v = { breath: 0.25, jitter: 0.7, rough: 0.2 };
      h(0, 'o', 210, 0.9);
      voice({ ...v, at: 0.05, dur: 0.17, pitch: [[0, 205], [0.17, 230]], vowels: [[0, 'o'], [0.17, 'o']] });
      voice({ ...v, at: 0.22, dur: 0.07, pitch: [[0, 225], [0.07, 240]], vowels: [[0, 'l'], [0.07, 'i']] });
      voice({ ...v, at: 0.29, dur: 0.12, pitch: [[0, 240], [0.12, 215]], vowel: 'i' });
      noise({ at: 0.45, dur: 0.17, type: 'highpass', freq: 2600, q: 0.7, gain: 0.45 }); // sh
      voice({ ...v, at: 0.6, dur: 0.22, pitch: [[0, 290], [0.22, 245]], vowel: 'i', drive: 1.5 });
      noise({ at: 0.84, dur: 0.03, type: 'highpass', freq: 3500, gain: 0.4 }); // t
    },

    mate() { song(); },
  };

  // ---------- checkmate song: airhorns, riser, then a wobbly drop ----------
  function song() {
    stopSong();
    songBus = ctx.createGain();
    songBus.gain.value = 0.8;
    songBus.connect(master);
    const bus = songBus, b = 60 / 150, t0 = ctx.currentTime + 0.05;
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

    const airhorn = (t, d) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.6;
      const ws = ctx.createWaveShaper();
      ws.curve = driveCurve(3);
      const g = ctx.createGain();
      g.gain.value = 0.35;
      bp.connect(ws).connect(g).connect(bus);
      for (const [m, det] of [[70, -9], [70, 8], [58, 0], [77, 4]]) {
        tone({ abs: t, dur: d, type: 'sawtooth', pitch: [[0, hz(m)], [d * 0.7, hz(m)], [d, hz(m) * 0.94]],
          detune: det, env: [[0, 0], [0.01, 0.5], [d - 0.04, 0.45], [d, 0]], dest: bp });
      }
    };
    const kick = (t) => tone({ abs: t, dur: 0.3, exp: true, pitch: [[0, 170], [0.14, 42]], gain: 1, dest: bus,
      env: [[0, 0], [0.003, 1], [0.3, 0]] });
    const snare = (t) => {
      noise({ abs: t, dur: 0.18, type: 'highpass', freq: 1400, gain: 0.55, dest: bus });
      tone({ abs: t, dur: 0.09, type: 'triangle', pitch: [[0, 220], [0.09, 160]], gain: 0.35, dest: bus });
    };
    const hat = (t, g) => noise({ abs: t, dur: 0.04, type: 'highpass', freq: 8000, gain: g, dest: bus });
    const crash = (t) => noise({ abs: t, dur: 1.6, type: 'highpass', freq: 4500, dest: bus,
      env: [[0, 0], [0.005, 0.5], [1.6, 0]] });

    // Intro: BWAAA BWA BWAAAAA + riser.
    airhorn(t0, 0.22);
    airhorn(t0 + 0.28, 0.12);
    airhorn(t0 + 0.45, 0.55);
    noise({ abs: t0 + 0.3, dur: 0.8, type: 'bandpass', freq: 3000, q: 2, dest: bus,
      env: [[0, 0], [0.75, 0.4], [0.8, 0]] });

    const s = t0 + 1.1, bars = 8, steps = bars * 16, sx = b / 4;
    const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G

    // Wobble bass: two detuned saws through a resonant low-pass swept at 8th-note rate.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 9; lp.frequency.value = 600;
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 2 / b;
    lg.gain.value = 520;
    lfo.connect(lg).connect(lp.frequency);
    lfo.start(s);
    lfo.stop(s + steps * sx);
    const bg = ctx.createGain();
    bg.gain.value = 0.55;
    lp.connect(bg).connect(bus);

    for (let bar = 0; bar < bars; bar++) {
      const ch = chords[bar % 4], bt = s + bar * 16 * sx;
      for (const det of [-12, 12]) {
        tone({ abs: bt, dur: 16 * sx, type: 'sawtooth', pitch: [[0, hz(ch[0] - 24)]], detune: det, dest: lp,
          env: [[0, 0], [0.01, 0.5], [16 * sx - 0.03, 0.5], [16 * sx, 0]] });
      }
      // Chiptune lead arpeggio; jumps an octave for the second half.
      const up = bar >= 4 ? 24 : 12, pat = [0, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 3, 2, 1, 2, 3];
      pat.forEach((p, k) => {
        const m = (p === 3 ? ch[0] + 12 : ch[p]) + up;
        tone({ abs: bt + k * sx, dur: sx * 0.9, type: 'square', pitch: [[0, hz(m)]], dest: bus,
          env: [[0, 0], [0.004, 0.09], [sx * 0.8, 0.05], [sx * 0.9, 0]] });
      });
    }
    for (let i = 0; i < steps; i++) {
      const t = s + i * sx;
      if (i % 4 === 0) kick(t);
      if (i % 8 === 4) snare(t);
      if (i >= steps - 8 && i % 2 === 0) snare(t); // fill
      hat(t, i % 2 ? 0.12 : 0.22);
    }
    crash(s);
    crash(s + 4 * 16 * sx);
    const end = s + steps * sx;
    airhorn(end, 0.22);
    airhorn(end + 0.28, 0.6);
    crash(end);
  }

  function stopSong() {
    if (songBus) {
      const g = songBus;
      g.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
      setTimeout(() => g.disconnect(), 600);
      songBus = null;
    }
    if (songAudio) { songAudio.pause(); songAudio = null; }
  }

  // ---------- text-to-speech with fallback ----------
  let englishVoice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    englishVoice = vs.find((v) => /^en[-_]US/i.test(v.lang) && /male|david|guy|daniel|alex/i.test(v.name))
      || vs.find((v) => /^en[-_](US|GB)/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
  }
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
  }

  // Speak a line; if speech doesn't actually start quickly (blocked, no voices,
  // mobile restrictions), play the synthesized version instead.
  function speak(text, pitch, rate, fallback) {
    if (!settings.speech || !('speechSynthesis' in window)) return fallback();
    const u = new SpeechSynthesisUtterance(text);
    if (englishVoice) u.voice = englishVoice;
    u.lang = englishVoice ? englishVoice.lang : 'en-US';
    u.pitch = pitch;
    u.rate = rate;
    u.volume = Math.min(1, settings.volume * 1.2);
    let done = false;
    const giveUp = () => { if (!done) { done = true; speechSynthesis.cancel(); fallback(); } };
    u.onstart = () => { done = true; };
    u.onerror = giveUp;
    speechSynthesis.cancel();
    // Chrome drops a speak() issued in the same tick as cancel().
    setTimeout(() => speechSynthesis.speak(u), 30);
    setTimeout(giveUp, 700);
  }

  // ---------- custom clips ----------
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
      if (key === 'mate') { stopSong(); songAudio = a; }
      return;
    }
    if (!ac()) return;
    if (key === 'knight') return speak('Hog riderrrrr!', 0.75, 1.1, SYNTH.knight);
    if (key === 'check') return speak('Holy shit!', 1.05, 1.05, SYNTH.check);
    SYNTH[key]();
  }

  return {
    keys: KEYS,
    settings,
    unlock() {
      if (!settings.enabled) return;
      ac();
      // Mobile browsers only allow speech that was first started from a tap.
      if (!ttsWarm && 'speechSynthesis' in window) {
        ttsWarm = true;
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    },
    play(type, force) {
      if (!settings.enabled && !force) return;
      const key = TYPE_TO_KEY[type] || type;
      if (KEYS.includes(key)) playKey(key);
    },
    stopSong() { if (ctx || songAudio) stopSong(); },
    capture() {
      if (!settings.enabled || !ac()) return;
      noise({ dur: 0.1, type: 'lowpass', freq: 500, gain: 0.7, dest: master });
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
      if (k === 'enabled' && !v) {
        if ('speechSynthesis' in window) speechSynthesis.cancel();
        if (ctx || songAudio) stopSong();
      }
      save();
    },
  };
})();
