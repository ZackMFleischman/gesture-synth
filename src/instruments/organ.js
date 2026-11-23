// Organ: additive "drawbar" organ. One PeriodicWave oscillator at f/2 carries the partials of the 16', 8', 4',
// 2 2/3' and 2' drawbars (harmonics 1, 2, 4, 6, 8 of f/2; registration ~ 5 8 6 5 4), so the pitch is exact and one
// oscillator does the whole tone. A short high-passed noise burst = key click at every attack; slow scanner-style
// vibrato (6.4 Hz, ±5 cents). Sustains at full level while the key is down; the key release is an 8 ms fade.
import { stepParam, wrapSource, fadeOut, fadeIn, biquad, series, perContext } from "./shared.js";

const DRAWBARS = { 1: 0.32, 2: 1, 4: 0.55, 6: 0.42, 8: 0.32 };

function organWave(ac) {
  return perContext(ac, "organ-wave", () => {
    const real = new Float32Array(9);
    const imag = new Float32Array(9);
    for (const [h, a] of Object.entries(DRAWBARS)) imag[h] = a;
    return ac.createPeriodicWave(real, imag);
  });
}

function clickBuffer(ac) {
  return perContext(ac, "organ-click", () => {
    const n = Math.round(ac.sampleRate * 0.008);
    const b = ac.createBuffer(1, n, ac.sampleRate);
    const d = b.getChannelData(0);
    let s = 13579;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d[i] = (s / 2147483648 - 1) * Math.min(1, i / 12) * Math.exp(-i / (ac.sampleRate * 0.0018));
    }
    return b;
  });
}

export default {
  id: "organ",
  label: "Organ",
  icon: "M5 20V10M9.5 20V6M14 20V4M18.5 20V8M3 20h18",
  level: 0.98,
  traits: { releaseTailS: 0.03, sustains: true, legato: "retrigger" },
  createChain: (ac) => series([biquad(ac, "lowpass", 7000, 0.5)]),
  createSource(ac, freq, t0) {
    const out = ac.createGain();
    const osc = ac.createOscillator();
    osc.setPeriodicWave(organWave(ac));
    osc.frequency.value = freq / 2;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 6.4;
    const depth = ac.createGain();
    depth.gain.value = 5; // cents
    lfo.connect(depth).connect(osc.detune);
    osc.connect(out);
    const clickHp = biquad(ac, "highpass", 1800);
    const clickGain = ac.createGain();
    clickGain.gain.value = 0.18;
    clickHp.connect(clickGain).connect(out);
    const click = (t, amt = 1) => {
      const b = ac.createBufferSource();
      b.buffer = clickBuffer(ac);
      const g = ac.createGain();
      g.gain.value = amt;
      b.connect(g).connect(clickHp);
      b.start(Math.max(t, ac.currentTime));
      b.onended = () => { try { g.disconnect(); } catch {} };
    };
    osc.start(t0);
    lfo.start(t0);
    click(t0);
    const src = wrapSource("organ", out, freq, {
      stop(t) { try { osc.stop(t); lfo.stop(t); } catch {} },
      release(t) { fadeOut(out.gain, t, 0.008); },
      setFreq(f, t, ramp = 0) {
        stepParam(osc.frequency, f / 2, t, ramp);
        src.frequency.value = f;
      },
      excite(t, amt = 1) {
        fadeIn(out.gain, t);
        click(t, amt);
      },
    });
    osc.onended = () => src._fireEnded();
    return src;
  },
};
