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
// Until the worklet has loaded (onReady, a few ms after the AudioContext starts) a decaying sawtooth stands in.
import { stepParam, wrapSource, biquad, series, perContext } from "../shared.js";

export const ELECTRIC = Object.freeze({
  T60: { chords: 3.5, arp: 2.1, lead: 8 }, // ring time per voice (s); the Lead's mono string sustains longest
  DAMP_T60: 0.06, // palm mute at release()
  AMP: 0.5, // pluck strength
  PRE: 2.2, // gain into the clipper (its curve spans 4x its input range): heavy overdrive
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

export default {
  id: "electric",
  label: "Electric",
  icon: "M13 3L6 13h5l-1 8 7-10h-5l1-8",
  level: 0.3,
  traits: { strumMs: 9, releaseTailS: 0.5, sustains: false, legato: "hammer-on", hammerOn: 0.3 },

  onReady(ac) {
    if (!ac.audioWorklet) return false;
    return ac.audioWorklet.addModule(new URL("./ks-worklet.js", import.meta.url)).then(() => {
      loaded.set(ac, true);
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
      biquad(ac, "peaking", 2400, 1.4, 5), // cabinet resonance
      biquad(ac, "lowpass", 4800, 0.8), // speaker roll-off
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
    let hz = freq;

    if (loaded.get(ac)) {
      const node = new AudioWorkletNode(ac, "ks-string", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { freq, t60, amp, tone: 0.55, bright: 0.35, pickPos: 0.14, start: mono ? null : t0, persistent: mono },
      });
      node.connect(pre);
      const post = (m) => node.port.postMessage(m);
      const src = wrapSource("electric", out, freq, {
        stop(t) { post({ type: "end", time: t }); },
        release(t) { post({ type: "damp", time: t, t60: ELECTRIC.DAMP_T60 }); },
        setFreq(f, t, ramp = 0.003) {
          hz = f;
          src.frequency.value = f;
          post({ type: "freq", time: t, freq: f, ramp: Math.max(0.0005, ramp) });
        },
        excite(t, a = 1) {
          post({ type: "t60", time: t, t60 }); // undo a palm mute
          post({ type: "pluck", time: t, amp: amp * a, freq: hz });
        },
      });
      node.port.onmessage = (e) => {
        if (e.data && e.data.type === "ended") {
          try { node.disconnect(); } catch {}
          src._fireEnded();
        }
      };
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
