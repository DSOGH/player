// Demo music generator (runs inside the service worker). Produces small WAV loops
// with real tempo, intros, fade-outs and silences so transitions/BPM can be tried without a NAS.
(function () {
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function synth(p) {
    const sr = 22050;
    const dur = p.dur || 60;
    const n = Math.floor(dur * sr);
    const L = new Float32Array(n);
    const R = rng(p.seed || 7);
    const beat = 60 / p.bpm;
    const start = p.lead || 0;
    const end = dur - (p.tail || 0);
    const style = p.style || 'house';
    const root = p.root || 45;
    const prog = style === 'chill' ? [0, 5, 8, 3] : [0, 8, 3, 10];
    const add = (i, v) => { if (i >= 0 && i < n) L[i] += v; };

    // drums
    let k = 0;
    for (let tb = start; tb < end - 0.05; tb += beat, k++) {
      const i0 = Math.floor(tb * sr);
      const playKick = style === 'chill' ? k % 2 === 0 : style === 'dnb' ? (k % 4 === 0 || k % 8 === 5) : true;
      if (playKick && tb > start + (p.drumsIn || 0)) {
        let ph = 0;
        for (let j = 0; j < 0.32 * sr; j++) {
          const t = j / sr;
          ph += (2 * Math.PI * (48 + 95 * Math.exp(-t * 28))) / sr;
          add(i0 + j, 0.95 * Math.sin(ph) * Math.exp(-t * 9));
        }
      }
      if (tb > start + (p.drumsIn || 0)) {
        const hi = Math.floor((tb + beat / 2) * sr);
        let prev = 0;
        for (let j = 0; j < 0.05 * sr; j++) {
          const w = R() * 2 - 1;
          add(hi + j, (w - prev) * 0.16 * Math.exp((-j / sr) * 70));
          prev = w;
        }
        if ((style === 'rock' || style === 'dnb' || style === 'house') && k % 2 === 1) {
          for (let j = 0; j < 0.2 * sr; j++) {
            const t = j / sr;
            add(i0 + j, ((R() * 2 - 1) * 0.3 + Math.sin(2 * Math.PI * 190 * t) * 0.2) * Math.exp(-t * 16));
          }
        }
      }
    }
    // bass + pad + lead
    const bar = beat * 4;
    let bassPh = 0, padPh = [0, 0, 0], leadPh = 0;
    const penta = [0, 3, 5, 7, 10, 12, 15];
    let leadNote = 0, leadStart = 0;
    for (let i = Math.floor(start * sr); i < Math.floor(end * sr); i++) {
      const t = i / sr - start;
      const b = Math.floor(t / bar);
      const chord = root + prog[b % 4];
      // bass on eighths
      const e = (t % (beat / 2)) / (beat / 2);
      const bf = mtof(chord - 12 + (Math.floor(t / (beat / 2)) % 4 === 3 ? 7 : 0));
      bassPh += (2 * Math.PI * bf) / sr;
      const bassEnv = Math.exp(-e * 3.2);
      let bass = Math.sin(bassPh) + 0.4 * Math.sin(2 * bassPh) + 0.18 * Math.sin(3 * bassPh);
      bass *= 0.22 * bassEnv * (t > (p.bassIn || 0) ? 1 : 0);
      // pad
      const notes = [chord + 12, chord + 15, chord + 19];
      let pad = 0;
      for (let q = 0; q < 3; q++) {
        padPh[q] += (2 * Math.PI * mtof(notes[q])) / sr;
        pad += Math.sin(padPh[q]) + 0.3 * Math.sin(2 * padPh[q] + 0.5);
      }
      const padSwell = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / bar - Math.PI / 2);
      pad *= (style === 'chill' ? 0.07 : 0.045) * (0.6 + 0.4 * padSwell);
      // lead
      if (t - leadStart >= beat / (style === 'dnb' ? 2 : 1)) {
        leadStart = t;
        leadNote = R() < 0.25 ? -1 : chord + 24 + penta[Math.floor(R() * penta.length)];
      }
      let lead = 0;
      if (leadNote > 0 && p.melody && t > (p.melodyIn ?? 8)) {
        leadPh += (2 * Math.PI * mtof(leadNote)) / sr;
        const le = Math.exp(-(t - leadStart) * 5);
        lead = (Math.sin(leadPh) + 0.2 * Math.sin(3 * leadPh)) * 0.09 * le;
      }
      L[i] += bass + pad + lead;
    }
    // envelopes
    const fi = p.fadeIn || 0, fo = p.fadeOut || 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let g = 1;
      if (t < start || t > end) g = 0;
      else {
        if (fi && t < start + fi) g *= (t - start) / fi;
        if (fo && t > end - fo) g *= Math.max(0, (end - t) / fo);
      }
      L[i] = Math.tanh(L[i] * 1.1) * g * 0.85;
    }
    // WAV encode (16-bit mono)
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    return buf;
  }
  self.demoSynth = synth;
})();
