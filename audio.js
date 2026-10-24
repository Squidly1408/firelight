/* Firelight audio: everything is synthesised from noise with the Web Audio API (no files). */
'use strict';
window.FireAudio = (() => {
  let ctx = null, master = null, white = null, brown = null;
  let roarGain, roarFilter, hissGain, sizzleGain, sizzleFilter;
  let on = false, suspendTimer = 0;

  function makeBuffers() {
    const sr = ctx.sampleRate, len = Math.floor(sr * 2.5);
    white = ctx.createBuffer(1, len, sr);
    brown = ctx.createBuffer(1, len, sr);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const r = Math.random() * 2 - 1;
      w[i] = r;
      last = (last + 0.02 * r) / 1.02;
      b[i] = last * 3.5;
    }
    // crossfade the loop seam of the brown buffer
    const fade = Math.floor(sr * 0.05);
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      b[len - fade + i] = b[len - fade + i] * (1 - k) + b[i] * k;
    }
  }

  function loop(buf, offset) {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.start(0, offset || 0);
    return s;
  }

  function init() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { return false; }
    makeBuffers();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4;
    comp.connect(ctx.destination);
    master = ctx.createGain(); master.gain.value = 0; master.connect(comp);

    // low roar of the flames
    roarFilter = ctx.createBiquadFilter(); roarFilter.type = 'lowpass'; roarFilter.frequency.value = 380; roarFilter.Q.value = 0.4;
    roarGain = ctx.createGain(); roarGain.gain.value = 0;
    loop(brown).connect(roarFilter); roarFilter.connect(roarGain); roarGain.connect(master);

    // water hose hiss
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 4200; pk.gain.value = 5;
    hissGain = ctx.createGain(); hissGain.gain.value = 0;
    loop(white, 0.3).connect(hp); hp.connect(pk); pk.connect(hissGain); hissGain.connect(master);

    // steam sizzle
    sizzleFilter = ctx.createBiquadFilter(); sizzleFilter.type = 'bandpass'; sizzleFilter.frequency.value = 6500; sizzleFilter.Q.value = 0.9;
    sizzleGain = ctx.createGain(); sizzleGain.gain.value = 0;
    loop(white, 1.1).connect(sizzleFilter); sizzleFilter.connect(sizzleGain); sizzleGain.connect(master);
    return true;
  }

  function burst(t, dur, gain, type, freq, q, pan) {
    const src = ctx.createBufferSource(); src.buffer = white;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0));
      g.connect(p); p.connect(master);
    } else g.connect(master);
    src.start(t, Math.random() * 2, dur + 0.05);
  }

  const ready = () => ctx && on && ctx.state === 'running';

  return {
    get enabled() { return on; },
    setEnabled(v) {
      if (v && !init()) return false;
      on = !!v;
      if (!ctx) return on;
      clearTimeout(suspendTimer);
      if (on) {
        ctx.resume();
        master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.3);
      } else {
        master.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
        suspendTimer = setTimeout(() => { if (!on) ctx.suspend(); }, 700);
      }
      return on;
    },
    // called from a user gesture so mobile browsers allow playback
    unlock() { if (ctx && on && ctx.state !== 'running') ctx.resume(); },
    // continuous layers: fire 0..1, spray 0..1, steam 0..1
    update(fire, spray, steam, flicker) {
      if (!ready()) return;
      const t = ctx.currentTime;
      roarGain.gain.setTargetAtTime(fire * (0.35 + 0.25 * flicker), t, 0.08);
      roarFilter.frequency.setTargetAtTime(260 + 320 * fire + 200 * flicker, t, 0.1);
      hissGain.gain.setTargetAtTime(spray * 0.16, t, 0.06);
      sizzleGain.gain.setTargetAtTime(Math.min(1, steam) * (0.22 + 0.12 * Math.random()), t, 0.03);
      sizzleFilter.frequency.setTargetAtTime(5000 + 3000 * Math.random(), t, 0.05);
    },
    crackle(strength, pan) {
      if (!ready()) return;
      const t = ctx.currentTime + Math.random() * 0.01;
      burst(t, 0.004 + Math.random() * 0.025, strength * (0.25 + Math.random() * 0.5), 'bandpass',
        900 + Math.random() * 4500, 0.7 + Math.random() * 3, pan);
    },
    pop(strength, pan) {
      if (!ready()) return;
      const t0 = ctx.currentTime;
      burst(t0, 0.06, strength * 0.9, 'bandpass', 500 + Math.random() * 700, 1.2, pan);
      const n = 2 + (Math.random() * 5 | 0);
      for (let i = 0; i < n; i++) {
        burst(t0 + 0.01 + Math.random() * 0.12, 0.004 + Math.random() * 0.015, strength * (0.3 + Math.random() * 0.4),
          'bandpass', 1500 + Math.random() * 5000, 1 + Math.random() * 3, pan + (Math.random() - 0.5) * 0.2);
      }
    },
    thud(strength, pan) {
      if (!ready()) return;
      const t = ctx.currentTime;
      burst(t, 0.22, strength * 1.2, 'lowpass', 180, 0.8, pan);
      burst(t, 0.05, strength * 0.4, 'bandpass', 900, 1, pan);
    },
    strike(pan) {
      if (!ready()) return;
      const t = ctx.currentTime;
      burst(t, 0.09, 0.35, 'bandpass', 3800, 1.5, pan);
      burst(t + 0.03, 0.02, 0.25, 'highpass', 6000, 0.7, pan);
    }
  };
})();
