// Electric: overdriven electric lead guitar.
//   String: Karplus-Strong (./ks-worklet.js, AudioWorklet "ks-string"): a noise burst with a pick-position comb into
//     a tuned feedback delay (fractional, linear interpolation, gliding length = click-free pitch steps) with a
//     two-point low-pass in the loop. A DelayNode loop can't do this: its minimum delay in a cycle is one render
//     quantum (128 samples, so nothing above ~375 Hz).
//   Amp, PER STRING: pre-gain -> asymmetric tube-style soft clipper (WaveShaper, 4x oversampled; the asymmetry adds
//     even harmonics). Clipping each string on its own ("hexaphonic" distortion) keeps full chord voicings clear (no
//     intermodulation mud between strings), so Chords keeps its voicings rather than dropping to power chords.
//     The clipper's compression is what sustains a held Lead note (the string keeps hitting the curve as it decays).
//   Post chain (linear, shared by a voice's strings): tone stack (bass shelf, mid peak 800 Hz, treble shelf) and a
//     cabinet (high-pass 80 Hz, resonance 2.4 kHz, low-pass 4.8 kHz + 5.2 kHz).
//   Level: compensated (`level`) so steady play is as loud as the other instruments and stays under the limiter;
//     the global Drive (right hand sideways) adds its own level-compensated saturation on top.
// Strings come from a per-AudioContext POOL of idle worklet nodes (created in onReady, grown on demand): a new
// AudioWorkletNode gets its processor asynchronously (0-10 ms live, much longer in an OfflineAudioContext), which
// would delay a strum. A string is busy from its note until shortly after stop(); then it is silent and reusable.
// Until the worklet has loaded (onReady, a few ms after the AudioContext starts) a decaying sawtooth stands in.
import { stepParam, wrapSource, biquad, series, perContext } from "../shared.js";

export const ELECTRIC = Object.freeze({
  T60: { chords: 3.5, arp: 2.1, lead: 8 }, // ring time per voice (s); the Lead's mono string sustains longest
  DAMP_T60: 0.06, // palm mute at release()
  AMP: 0.5, // pluck strength
  PRE: 30, // gain into the clipper (a decaying string stays in heavy overdrive for ~1 s: sustain)
});

/** Asymmetric tube-style soft clip: tanh for positive inputs, a later, softer knee for negative ones. Pure. */
export function tubeCurve(n = 4097, drive = 4) {
  const c = new Float32Array(n);
  const a = 0.62;
  for (let i = 0; i < n; i++) {
    const u = drive * ((i / (n - 1)) * 2 - 1);
    const y = u >= 0 ? Math.tanh(u) : Math.tanh(a * u) / a;
    c[i] = y * a; // normalized: the negative side saturates at -1
  }
  return c;
}

const loaded = new WeakMap(); // ac -> true once the worklet module is in
const pools = new WeakMap(); // ac -> [{ node, plucks, busyUntil, to }]
const POOL_START = 12;

/** String settings (also used by tests for a clean reference string). seed: deterministic pick noise per string. */
export const STRING_OPTIONS = Object.freeze({ tone: 0.55, bright: 0.35, pickPos: 0.14, persistent: true });

function newString(ac, index) {
  const node = new AudioWorkletNode(ac, "ks-string", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { ...STRING_OPTIONS, seed: 1000 + index },
  });
  return { node, plucks: 0, busyUntil: 0, to: null };
}

/** A silent string from the pool (marked busy until released), connected to `dest`. */
function takeString(ac, dest) {
  let pool = pools.get(ac);
  if (!pool) pools.set(ac, (pool = []));
  const now = ac.currentTime;
  let s = pool.find((p) => p.busyUntil <= now);
  if (!s) pool.push((s = newString(ac, pool.length)));
  s.busyUntil = Infinity;
  if (s.to) { try { s.node.disconnect(); } catch {} }
  s.node.connect(dest);
  s.to = dest;
  for (const n of ["freq", "t60", "pluckAmp"]) s.node.parameters.get(n).cancelScheduledValues(now);
  return s;
}

export default {
  id: "electric",
  label: "Electric",
  icon: "M13 3L6 13h5l-1 8 7-10h-5l1-8",
  level: 0.76,
  traits: { strumMs: 9, releaseTailS: 0.5, sustains: false, legato: "hammer-on", hammerOn: 0.3 },

  onReady(ac) {
    if (!ac.audioWorklet) return false;
    return ac.audioWorklet.addModule(new URL("./ks-worklet.js", import.meta.url)).then(() => {
      loaded.set(ac, true);
      if (!pools.has(ac)) pools.set(ac, Array.from({ length: POOL_START }, (_, i) => newString(ac, i)));
      return true;
    });
  },
  /** true once the Karplus-Strong worklet is loaded in `ac` (tests). */
  isReady: (ac) => !!loaded.get(ac),

  createChain: (ac) =>
    series([
      biquad(ac, "highpass", 80, 0.7), // cabinet: no flub (also removes the clipper's DC)
      biquad(ac, "lowshelf", 160, 0.7, 2), // tone stack: bass
      biquad(ac, "peaking", 800, 0.9, 3), // mid
      biquad(ac, "highshelf", 3200, 0.7, -4), // treble
      biquad(ac, "peaking", 2400, 0.9, 3), // cabinet resonance (broad: a narrow one rings = peaks)
      biquad(ac, "lowpass", 4800, 0.6), // speaker roll-off
      biquad(ac, "lowpass", 5200, 0.6),
    ]),

  createSource(ac, freq, t0, opts = {}) {
    const out = ac.createGain();
    const pre = ac.createGain();
    pre.gain.value = ELECTRIC.PRE / 4;
    const shaper = ac.createWaveShaper();
    shaper.curve = perContext(ac, "tube-curve", () => tubeCurve());
    shaper.oversample = "4x";
    pre.connect(shaper).connect(out);
    const t60 = ELECTRIC.T60[opts.voice] ?? ELECTRIC.T60.chords;
    const amp = opts.amp ?? ELECTRIC.AMP;
    const mono = !!opts.mono;

    if (loaded.get(ac)) {
      const str = takeString(ac, pre);
      const node = str.node;
      const P = (n) => node.parameters.get(n);
      const tA = Math.max(ac.currentTime, Math.min(t0, ac.currentTime));
      P("freq").setValueAtTime(freq, tA);
      P("t60").setValueAtTime(t60, tA);
      const pluck = (t, a) => {
        P("pluckAmp").setValueAtTime(amp * a, t);
        P("pluck").setValueAtTime(++str.plucks, t); // every change of `pluck` = one pluck (sample-accurate)
      };
      if (!mono) pluck(t0, 1);
      let stopped = false;
      const src = wrapSource("electric", out, freq, {
        stop(t) {
          if (stopped) return;
          stopped = true;
          const ts = Math.max(t, ac.currentTime);
          P("t60").setValueAtTime(0.005, ts); // silent within a few ms: back to the pool
          str.busyUntil = ts + 0.06;
          setTimeout(() => src._fireEnded(), Math.max(0, (str.busyUntil - ac.currentTime) * 1000) + 20);
        },
        release(t) { P("t60").setValueAtTime(ELECTRIC.DAMP_T60, t); }, // palm mute
        setFreq(f, t, ramp = 0.003) {
          src.frequency.value = f;
          stepParam(P("freq"), f, t, ramp);
        },
        excite(t, a = 1) {
          P("t60").setValueAtTime(t60, t); // undo a palm mute
          pluck(t, a);
        },
      });
      src.node = node;
      return src;
    }

    // Fallback while the worklet loads: a sawtooth with a pluck-like decay into the same clipper.
    const osc = ac.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    const env = ac.createGain();
    env.gain.value = 0;
    const pluck = (t, a = 1) => {
      stepParam(env.gain, 0, t, 0);
      env.gain.linearRampToValueAtTime(amp * a, t + 0.003);
      env.gain.setTargetAtTime(amp * a * 0.3, t + 0.003, t60 / 6.9);
    };
    osc.connect(env).connect(pre);
    osc.start(t0);
    if (!mono) pluck(t0);
    const src = wrapSource("electric", out, freq, {
      stop(t) { try { osc.stop(t); } catch {} },
      release(t) { stepParam(env.gain, env.gain.value, t, 0); env.gain.setTargetAtTime(0, t, ELECTRIC.DAMP_T60 / 6.9); },
      setFreq(f, t, ramp = 0.003) { stepParam(osc.frequency, f, t, ramp); src.frequency.value = f; },
      excite(t, a = 1) { pluck(t, a); },
    });
    osc.onended = () => src._fireEnded();
    src.fallback = true;
    return src;
  },
};
