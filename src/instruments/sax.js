// Sax: a sawtooth "reed" + breath noise through a reed-like formant bank (band-passes at 500 / 1350 / 2600 Hz and a
// low body, then a gentle air low-pass), delayed vibrato (starts 0.25 s into a note, 5.2 Hz, up to ±14 cents).
// Legato-friendly: a Lead note step only moves the pitch; a new attack (excite) = a breath puff and the vibrato
// starts over. The formants are fixed in frequency, so they live in the shared (linear) post chain.
import { stepParam, wrapSource, fadeOut, fadeIn, biquad, noiseBuffer } from "./shared.js";

const breathHz = (f) => Math.min(4000, Math.max(900, f * 3));

export default {
  id: "sax",
  label: "Sax",
  icon: "M9 3v11a4 4 0 0 0 8 0v-2M9 6.5h3M9 10h3",
  level: 1.9,
  traits: { releaseTailS: 0.03, sustains: true, legato: "retrigger" },
  createChain(ac) {
    const input = ac.createGain();
    const sum = ac.createGain();
    for (const [f, q, g] of [[500, 4, 1], [1350, 5, 0.55], [2600, 6, 0.3]]) {
      const gg = ac.createGain();
      gg.gain.value = g;
      input.connect(biquad(ac, "bandpass", f, q)).connect(gg).connect(sum);
    }
    const bg = ac.createGain();
    bg.gain.value = 0.35;
    input.connect(biquad(ac, "lowpass", 900, 0.6)).connect(bg).connect(sum); // the bore's low body
    const air = biquad(ac, "lowpass", 4500, 0.5);
    sum.connect(air);
    return { input, output: air };
  },
  createSource(ac, freq, t0) {
    const out = ac.createGain();
    const osc = ac.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    const vib = ac.createOscillator();
    vib.frequency.value = 5.2;
    const vibDepth = ac.createGain();
    vibDepth.gain.value = 0;
    vib.connect(vibDepth).connect(osc.detune);
    const body = ac.createGain();
    body.gain.value = 0.85;
    osc.connect(body).connect(out);
    const noise = ac.createBufferSource();
    noise.buffer = noiseBuffer(ac);
    noise.loop = true;
    const bp = biquad(ac, "bandpass", breathHz(freq), 0.9);
    const breath = ac.createGain();
    breath.gain.value = 0.05;
    noise.connect(bp).connect(breath).connect(out);
    const swell = (t) => {
      stepParam(vibDepth.gain, 0, t, 0);
      vibDepth.gain.setValueAtTime(0, t + 0.25);
      vibDepth.gain.linearRampToValueAtTime(14, t + 0.65);
      stepParam(breath.gain, 0.12, t, 0);
      breath.gain.setTargetAtTime(0.05, t + 0.02, 0.06);
    };
    osc.start(t0);
    vib.start(t0);
    noise.start(t0, Math.random() * 1.5);
    swell(t0);
    const src = wrapSource("sax", out, freq, {
      stop(t) { try { osc.stop(t); vib.stop(t); noise.stop(t); } catch {} },
      release(t) { fadeOut(out.gain, t, 0.012); },
      setFreq(f, t, ramp = 0) {
        stepParam(osc.frequency, f, t, ramp);
        bp.frequency.setTargetAtTime(breathHz(f), t, 0.02);
        src.frequency.value = f;
      },
      excite(t) {
        fadeIn(out.gain, t);
        swell(t);
      },
    });
    osc.onended = () => src._fireEnded();
    return src;
  },
};
