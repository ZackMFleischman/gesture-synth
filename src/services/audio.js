// Audio engine. One shared graph for every mode, built once, never rebuilt on a mode switch:
//
//   chord oscillators -> chord instance gain (attack/release) -> chordGain (Chords' right-height volume) ─┐
//   arp / lead / noteOn() voices ─────────────────────────────────────────────────────────────────────────┤
//                                                                                                         v
//   out (GainNode 1, the PRE-FILTER bus) -> driveIn -> waveshaper (Drive) -> driveOut -> lowpass filter
//     -> baseGain (1; eased down under the Lead layer) -> mix (GainNode 1)
//   lead voice -> layerIn -> layerFilter (Lead's own tilt filter, same curve) ---------> mix
//   mix -> dry (GainNode) ──────────────────────────────────────────┐
//   mix -> spaceSend (0..SPACE.WET) -> convolver (generated IR) ────┴-> masterGain (left height, all modes)
//     -> limiter (DynamicsCompressor) -> clipper (soft-clip waveshaper, |y| < 0.98) -> destination
//
// The Lead layer (docs/architecture.md "Lead layer"): Lead plays on top of a base mode (Chords / Arp). The base
// keeps the shared filter at its HELD value while the right hand's tilt drives the lead voice's own filter, so
// the two never fight over one filter and neither value jumps when the layer turns on or off. The lead skips Drive
// (a base value, held under the layer: the router holds the right-hand axes then) but gets Space (after `mix`).
// While the layer is on, baseGain eases the base down by BASE_UNDER_LAYER (-1.9 dB, tau 0.12 s): room for the lead,
// and the loudest base (worst chord 0.67 at the limiter input) + lead stays under the limiter threshold.
//
// Drive (right hand sideways, src/core/axes.js): y = makeup * tanh(g * x). The waveshaper curve is fixed (tanh over
// its input range, DRIVE.CURVE_K); driveIn scales the input (g / CURVE_K) and driveOut is the makeup gain that keeps
// a signal at the reference level DRIVE.REF where it was (DRIVE.COMP trims the RMS rise of the squarer wave), so
// turning Drive up adds harmonics, not level, and steady playing stays under the limiter. Before Drive is first used
// the curve is null and both gains are 1: the graph is bit-identical to the original pass-through.
// Space (left hand sideways): a reverb send after the filter (ConvolverNode, IR generated here: decaying stereo
// noise, no assets). Created on first use; at space 0 the send is 0 and the dry path is untouched (gain 1). As the
// wet level rises the dry is trimmed by up to SPACE.DUCK so the sum keeps the same headroom.
//
// Gain staging (docs/architecture.md, "Accepted amendments"): normal playing never reaches the limiter.
// Worst steady state = master 1, right volume 1, sawtooth, filter fully open (tilt +1: 5 kHz, Q 5.2), every
// key/degree/voicing incl. close voicings summing in phase: 4 oscillators at level 1 peak at 5.15 after the
// filter (square: 6.1, triangle: 4.0; measured offline over all 1344 chords). CHORD_LEVEL 0.13 puts that
// at 0.67 (-3.5 dBFS), 1.5 dB under the limiter threshold. Arp (gate 1, x2) peaks ~0.5 and Lead (lead +
// pad) ~0.36 at master 1 with their own level constants. The limiter (-2 dBFS, 20:1, 1 ms) only catches
// transients/overshoot; the soft clipper (linear to 0.9) is the last guard, so the output never exceeds ±1.
// Note: DynamicsCompressor adds a fixed makeup gain below threshold (Chrome: (1/fullRangeGain)^0.6, about
// +1.0 dB at -2 dB / knee 1 / 20:1, measured; it was +2.9 dB at the old -6 dB / knee 3). Linear, so part of the staging.
//
// SynthEngine keeps the original chord behavior (oscillators, filter curve, waveform). Additions:
//  - chordGain (chord-voice volume, setVolume) is separate from masterGain (setMasterVolume)
//  - a limiter + soft clipper on the master: the output never exceeds ±1
//  - releaseChord(fade): click-free chord fade-out (used when leaving Chords)
//  - note/on, note/off (paired by a global `id`) and note/cancel on the bus

import { bus as sharedBus } from "../core/bus.js";

const CHORD_VOICE = "chords";
/** Level of each chord oscillator (4 summed). Worst case stays under the limiter threshold (see header). */
export const CHORD_LEVEL = 0.13;
/** Fade-in of a chord that starts from silence (no previous chord sounding). */
const CHORD_ATTACK = 0.03;
/** Soft clipper: linear below KNEE, saturates towards CEIL. Inputs beyond ±1 map to the curve ends. */
const CLIP_KNEE = 0.9;
const CLIP_CEIL = 0.09; // headroom above the knee (curve end ≈ 0.972)
/** Base level while the Lead layer plays on top (setLayerMix): -1.9 dB. Measured worst steady Chords + Lead (sawtooth,
 *  right 1, voicing 3, both filters open, master 1): -1.74 dBFS at the limiter input without it (over the -2 dB
 *  threshold), see tests/gain-staging.e2e.spec.js. */
export const BASE_UNDER_LAYER = 0.8;
const LAYER_MIX_TAU = 0.12;
/** Master limiter: a safety net for transients only (steady playing stays below the threshold). */
export const LIMITER = Object.freeze({ threshold: -2, knee: 1, ratio: 20, attack: 0.001, release: 0.1 });
/**
 * Drive (0..1 -> saturation). G_MIN..G_MAX = tanh pre-gain (curve ~linear at G_MIN); REF = level (peak, at the
 * waveshaper input) kept constant by the makeup gain: a loud chord at full right volume peaks ~0.3-0.5 there;
 * COMP = makeup trim at full drive (a saturated wave is squarer: more RMS for the same peak).
 */
export const DRIVE = Object.freeze({ G_MIN: 0.05, G_MAX: 9, REF: 0.3, COMP: 0.62, CURVE_K: 4, TAU: 0.03 });
/** Space (0..1 -> reverb). WET = send level at 1; DUCK = dry trim at 1; IR length (s) and decay (s to -60 dB). */
export const SPACE = Object.freeze({ WET: 0.8, DUCK: 0.22, IR_S: 2.8, RT60: 2.4, PREDELAY_S: 0.012, TAU: 0.05 });

/** Drive stage gains for an amount 0..1: { pre, post } (pre = driveIn, post = driveOut). Pure. */
export function driveGains(amount) {
  const d = Math.max(0, Math.min(1, amount));
  const g = DRIVE.G_MIN + (DRIVE.G_MAX - DRIVE.G_MIN) * d * d; // squared: fine control at the low end
  const comp = 1 - (1 - DRIVE.COMP) * d;
  return { pre: g / DRIVE.CURVE_K, post: (comp * DRIVE.REF) / Math.tanh(g * DRIVE.REF), g };
}

function tanhCurve(n = 8193) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(DRIVE.CURVE_K * ((i / (n - 1)) * 2 - 1));
  return c;
}

/** Reverb impulse response: stereo noise with an exponential decay (RT60), short predelay, soft onset. */
function makeImpulse(ac) {
  const sr = ac.sampleRate;
  const len = Math.round(SPACE.IR_S * sr);
  const buf = ac.createBuffer(2, len, sr);
  const pre = Math.round(SPACE.PREDELAY_S * sr);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1; // deterministic
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const onset = Math.min(1, t / 0.008);
      d[i] = rnd() * onset * Math.pow(10, (-3 * t) / SPACE.RT60);
    }
  }
  return buf;
}

let noteIdCounter = 0;
/** Globally unique note id (pairs note/on with note/off or note/cancel across all voices). */
export const nextNoteId = () => ++noteIdCounter;

const freqToMidi = (f) => Math.round(69 + 12 * Math.log2(f / 440));

function softClipCurve(n = 4097) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= CLIP_KNEE ? a : CLIP_KNEE + CLIP_CEIL * Math.tanh((a - CLIP_KNEE) / CLIP_CEIL);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

export class SynthEngine {
  constructor({ bus = sharedBus, waveform = "triangle", onFirstSound = null } = {}) {
    this.ctx = null;
    this.filter = null;
    this.layerIn = null; // Lead layer bus (see header)
    this.layerFilter = null;
    this.baseGain = null; // base modes' level (eased down under the Lead layer)
    this.mix = null;
    this.waveShaper = null;
    this.chordGain = null;
    this.masterGain = null;
    this.limiter = null;
    this.clipper = null;
    this.oscillators = [];
    this.oscIds = [];
    this.chordInstance = null; // GainNode the current chord's oscillators feed
    this.currentKey = null;
    this.waveform = waveform;
    this.onFirstSound = onFirstSound;
    this.hasPlayedFirstSound = false;
    this.masterVolume = 0;
    this.drive = 0;
    this.space = 0;
    this.spaceSend = null; // reverb send (created on first use)
    this.bus = bus;
    bus.declare("note/on", { type: "event", owner: "audio" });
    bus.declare("note/off", { type: "event", owner: "audio" });
    bus.declare("note/cancel", { type: "event", owner: "audio" });
  }

  ensureContext() {
    if (this.ctx) return;
    const ac = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());

    this.inBus = ac.createGain(); // `out`: every voice connects here
    this.driveIn = ac.createGain();
    this.driveOut = ac.createGain();
    this.waveShaper = ac.createWaveShaper();
    this.waveShaper.curve = null; // pass-through until Drive is first used
    this.waveShaper.oversample = "4x"; // Reduces aliasing harshness
    this.dry = ac.createGain();

    this.filter = ac.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 0.7;

    // Lead layer: its own tilt filter into `mix` (after the shared filter and Drive, before Space).
    this.layerIn = ac.createGain();
    this.layerFilter = ac.createBiquadFilter();
    this.layerFilter.type = "lowpass";
    this.layerFilter.frequency.value = 1200;
    this.layerFilter.Q.value = 0.7;

    this.chordGain = ac.createGain();
    this.chordGain.gain.value = 0;

    this.baseGain = ac.createGain();
    this.baseGain.gain.value = 1;
    this.mix = ac.createGain(); // base + Lead layer, before dry / Space

    this.masterGain = ac.createGain();
    this.masterGain.gain.value = this.masterVolume;

    // Limiter: fast attack, high ratio, threshold just below full scale. Steady playing stays under it.
    this.limiter = ac.createDynamicsCompressor();
    for (const k of ["threshold", "knee", "ratio", "attack", "release"]) this.limiter[k].value = LIMITER[k];

    // Safety net for the limiter's attack/lookahead overshoot: a soft clip that cannot exceed ±0.98.
    this.clipper = ac.createWaveShaper();
    this.clipper.curve = softClipCurve();
    this.clipper.oversample = "2x";

    this.chordGain.connect(this.inBus);
    this.inBus.connect(this.driveIn);
    this.driveIn.connect(this.waveShaper);
    this.waveShaper.connect(this.driveOut);
    this.driveOut.connect(this.filter);
    this.filter.connect(this.baseGain);
    this.baseGain.connect(this.mix);
    this.layerIn.connect(this.layerFilter);
    this.layerFilter.connect(this.mix);
    this.mix.connect(this.dry);
    this.dry.connect(this.masterGain);
    if (this.drive > 0) this.setDrive(this.drive, true);
    if (this.space > 0) this.setSpace(this.space, true);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.clipper);
    this.clipper.connect(ac.destination);
  }

  /** Chord-voice level (Chords' right-hand height). Unchanged semantics from the original setVolume. */
  setVolume(volume01) {
    if (!this.ctx) return;
    const clamped = Math.max(0, Math.min(1, volume01));
    this.chordGain.gain.linearRampToValueAtTime(clamped, this.ctx.currentTime + 0.05);
  }
  updateVolume(volume01) {
    this.setVolume(volume01);
  }

  /** Lead layer on/off: eases the base (everything through the shared filter) to BASE_UNDER_LAYER / back to 1. */
  setLayerMix(on) {
    if (!this.ctx) return;
    this.baseGain.gain.setTargetAtTime(on ? BASE_UNDER_LAYER : 1, this.ctx.currentTime, LAYER_MIX_TAU);
  }

  /** Master volume (left-hand height, every mode). The router already smooths it; this only de-zippers. */
  setMasterVolume(volume01) {
    const v = Math.max(0, Math.min(1, volume01));
    this.masterVolume = v;
    if (!this.ctx) return;
    this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Drive 0..1 (saturation, level-compensated). See the header and DRIVE. */
  setDrive(amount, force = false) {
    const d = Math.max(0, Math.min(1, Number(amount) || 0));
    if (d === this.drive && !force) return;
    this.drive = d;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const { pre, post } = driveGains(d);
    if (!this.waveShaper.curve) {
      if (d === 0) return; // never used: stay bit-identical pass-through
      // First use: the fixed tanh curve, gains jump to the (near-linear) start values, then glide.
      this.waveShaper.curve = tanhCurve();
      const g0 = driveGains(0);
      this.driveIn.gain.setValueAtTime(g0.pre, t);
      this.driveOut.gain.setValueAtTime(g0.post, t);
    }
    this.driveIn.gain.setTargetAtTime(pre, t, DRIVE.TAU);
    this.driveOut.gain.setTargetAtTime(post, t, DRIVE.TAU);
  }

  /** Space 0..1 (reverb send after the filter). See the header and SPACE. */
  setSpace(amount, force = false) {
    const v = Math.max(0, Math.min(1, Number(amount) || 0));
    if (v === this.space && !force) return;
    this.space = v;
    if (!this.ctx) return;
    const ac = this.ctx;
    if (!this.spaceSend) {
      if (v === 0) return; // never used: no convolver running
      this.spaceSend = ac.createGain();
      this.spaceSend.gain.value = 0;
      this.convolver = ac.createConvolver();
      this.convolver.buffer = makeImpulse(ac); // normalize (default) = equal-power IR
      this.mix.connect(this.spaceSend); // base + Lead layer
      this.spaceSend.connect(this.convolver);
      this.convolver.connect(this.masterGain);
    }
    const t = ac.currentTime;
    this.spaceSend.gain.setTargetAtTime(v * SPACE.WET, t, SPACE.TAU);
    this.dry.gain.setTargetAtTime(1 - SPACE.DUCK * v, t, SPACE.TAU);
  }

  updateFilterSweep(tiltFactor, filter = this.filter) {
    if (!filter || !this.ctx) return;

    // Base parameters for a balanced centered (0%) hand
    let targetFrequency = 1200;
    let targetQ = 0.7;

    if (tiltFactor < 0) {
      // ---- INWARD TILT (Acoustic Warmth) ----
      const intensity = Math.abs(tiltFactor);
      targetFrequency = 1200 - (intensity * 950);
      targetQ = 0.7 + (intensity * 1.5); // Add a subtle woody, hollow resonance
    }
    else if (tiltFactor > 0) {
      // ---- OUTWARD TILT (EDM Filter Sweep) ----
      targetFrequency = 1200 + (tiltFactor * 3800);
      targetQ = 0.7 + (tiltFactor * 4.5); // Spikes resonance for synthetic "squelch"
    }

    // Smooth out audio node updates frame-by-frame to eliminate audio clicking
    const now = this.ctx.currentTime;
    filter.frequency.setTargetAtTime(targetFrequency, now, 0.04);
    filter.Q.setTargetAtTime(targetQ, now, 0.04);
  }

  playNotes(freqs) {
    if (!this.ctx || freqs.length === 0) return;

    if (!this.hasPlayedFirstSound) {
      this.hasPlayedFirstSound = true;
      if (this.onFirstSound) this.onFirstSound();
    }

    const key = freqs.map((f) => f.toFixed(1)).join(",");
    if (key === this.currentKey) return;

    const ac = this.ctx;
    if (!this.chordInstance) {
      // Starting from silence (first chord, or after releaseChord): short fade-in, no click.
      const g = ac.createGain();
      g.gain.setValueAtTime(0, ac.currentTime);
      g.gain.linearRampToValueAtTime(CHORD_LEVEL, ac.currentTime + CHORD_ATTACK);
      g.connect(this.chordGain);
      this.chordInstance = g;
    }

    // Chord change: swap the oscillators (original behavior).
    this._emitOff();
    this.oscillators.forEach((osc) => { try { osc.stop(); } catch {} });
    this.oscillators = freqs.map((freq) => {
      const osc = ac.createOscillator();
      osc.type = this.waveform;
      osc.frequency.value = freq;
      osc.connect(this.chordInstance);
      osc.start();
      return osc;
    });
    this.currentKey = key;
    this._emitOn(freqs);
  }

  /**
   * Fades the sounding chord out over `fade` s (click-free) and forgets it, so the next
   * playNotes() starts a fresh chord with a fade-in. chordGain is left untouched.
   */
  releaseChord(fade = 0.4) {
    if (!this.ctx || !this.chordInstance) return;
    const ac = this.ctx;
    const t = ac.currentTime;
    const g = this.chordInstance.gain;
    // Not cancelAndHoldAtTime: after a finished linear ramp Chrome holds a wrong (about half) value,
    // which is an audible step. The attack ramp is long over, so g.value is the real level.
    // Equal-power (cosine) fade: keeps the level up while the next mode's voices come in.
    const v = g.value;
    const curve = new Float32Array(64);
    for (let i = 0; i < curve.length; i++) curve[i] = v * Math.cos((Math.PI / 2) * (i / (curve.length - 1)));
    g.cancelScheduledValues(0);
    g.setValueCurveAtTime(curve, t, fade);
    const node = this.chordInstance;
    const oscs = this.oscillators;
    this._emitOff();
    for (const osc of oscs) { try { osc.stop(t + fade + 0.02); } catch {} }
    if (oscs[0]) oscs[0].onended = () => { try { node.disconnect(); } catch {} };
    this.chordInstance = null;
    this.oscillators = [];
    this.currentKey = null;
  }

  stop() {
    this.setVolume(0);
    this._emitOff();
    this.oscillators.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch {}
    });
    this.oscillators = [];
    this.currentKey = null;
  }

  /**
   * One-shot note for sequenced modes: osc -> envelope -> pre-filter bus (`out`).
   * Emits note/on at `when` and note/off at `when + dur` (AudioContext time).
   */
  noteOn(freq, when, dur, { voice = "default", gain = 0.25, type } = {}) {
    if (!this.ctx) return null;
    const ac = this.ctx;
    const t0 = Math.max(when ?? ac.currentTime, ac.currentTime);
    const t1 = t0 + Math.max(0.01, dur);
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = type || this.waveform;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(gain, t0 + 0.005);
    env.gain.setTargetAtTime(0, t1, 0.02);
    osc.connect(env);
    env.connect(this.inBus);
    osc.start(t0);
    osc.stop(t1 + 0.2);
    osc.onended = () => { try { env.disconnect(); } catch {} };
    const id = nextNoteId();
    const midi = freqToMidi(freq);
    if (this.bus.wants("note/on")) this.bus.emit("note/on", { freq, midi, voice, id }, t0);
    if (this.bus.wants("note/off")) this.bus.emit("note/off", { freq, midi, voice, id }, t1);
    return osc;
  }

  _emitOn(freqs) {
    this.oscIds = freqs.map(() => nextNoteId());
    if (!this.bus.wants("note/on")) return;
    const t = this.ctx.currentTime;
    freqs.forEach((freq, i) =>
      this.bus.emit("note/on", { freq, midi: freqToMidi(freq), voice: CHORD_VOICE, id: this.oscIds[i] }, t)
    );
  }

  _emitOff() {
    const oscs = this.oscillators;
    const ids = this.oscIds;
    this.oscIds = [];
    if (!oscs.length || !this.bus.wants("note/off")) return;
    const t = this.ctx.currentTime;
    oscs.forEach((osc, i) => {
      const freq = osc.frequency.value;
      this.bus.emit("note/off", { freq, midi: freqToMidi(freq), voice: CHORD_VOICE, id: ids[i] }, t);
    });
  }
}

/** The ctx.audio facade handed to modes (contract: docs/architecture.md "ctx" + accepted amendments). */
export function createAudioFacade(synth) {
  return {
    get ac() { return synth.ctx; },
    /** Master volume GainNode (left height). */
    get master() { return synth.masterGain; },
    /** PRE-FILTER input bus: every voice connects here (-> drive -> filter -> master -> limiter). */
    get out() { return synth.inBus; },
    /** Lead layer input: -> its own tilt filter (setLayerFilter) -> mix (dry + Space) -> master. Lead's voice connects here. */
    get layerOut() { return synth.layerIn; },
    /** Chords' chord-voice GainNode (right-height volume in Chords). */
    get chordGain() { return synth.chordGain; },
    get waveform() { return synth.waveform; },
    get masterVolume() { return synth.masterVolume; },
    playChord: (freqs) => synth.playNotes(freqs),
    releaseChord: (fade) => synth.releaseChord(fade),
    noteOn: (freq, when, dur, opts) => synth.noteOn(freq, when, dur, opts),
    nextNoteId,
    /** Filter from right tilt (-1..1); also publishes `filter` so readouts follow in every mode. */
    setFilter: (tilt) => {
      synth.updateFilterSweep(tilt);
      synth.bus.set("filter", tilt);
    },
    /** Lead layer's own filter from the right tilt (same curve as setFilter). Publishes nothing. */
    setLayerFilter: (tilt) => synth.updateFilterSweep(tilt, synth.layerFilter),
    /** Lead layer on/off (router): the base eases down a little to make room for the lead. */
    setLayerMix: (on) => synth.setLayerMix(on),
    setWaveform: (type) => {
      synth.waveform = type;
      synth.currentKey = null; // forces sound refresh
    },
    /** Drive 0..1 (src/core/axes.js: right hand sideways). */
    setDrive: (v) => synth.setDrive(v),
    /** Space 0..1 (reverb send; src/core/axes.js: left hand sideways). */
    setSpace: (v) => synth.setSpace(v),
    get drive() { return synth.drive; },
    get space() { return synth.space; },
    /** Chord-voice level (Chords' right-hand volume). */
    setVolume: (v) => synth.setVolume(v),
    /** Master volume (left-hand height; the router calls this). */
    setMasterVolume: (v) => synth.setMasterVolume(v),
    synth,
  };
}
