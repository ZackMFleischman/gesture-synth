// Audio engine. One shared graph for every mode, built once, never rebuilt on a mode switch:
//
//   chord oscillators -> chord instance gain (attack/release) -> chordGain (Chords' right-height volume) ─┐
//   arp / lead / noteOn() voices ─────────────────────────────────────────────────────────────────────────┤
//                                                                                                         v
//   out (waveshaper, pass-through; the PRE-FILTER bus) -> lowpass filter -> masterGain (left height, all modes)
//     -> limiter (DynamicsCompressor) -> clipper (soft-clip waveshaper, |y| < 0.95) -> destination
//
// SynthEngine keeps the original chord behavior (oscillators, filter curve, waveform). Additions:
//  - chordGain (chord-voice volume, setVolume) is separate from masterGain (setMasterVolume)
//  - a limiter + soft clipper on the master: the output never exceeds ±1
//  - releaseChord(fade): click-free chord fade-out (used when leaving Chords)
//  - note/on, note/off (paired by a global `id`) and note/cancel on the bus

import { bus as sharedBus } from "../core/bus.js";

const CHORD_VOICE = "chords";
/** Level of each chord oscillator (4 summed). Leaves headroom for the limiter; see tests/audio.spec.js. */
export const CHORD_LEVEL = 0.42;
/** Fade-in of a chord that starts from silence (no previous chord sounding). */
const CHORD_ATTACK = 0.03;
/** Soft clipper: linear below KNEE, saturates towards CEIL. Inputs beyond ±1 map to the curve ends. */
const CLIP_KNEE = 0.8;
const CLIP_CEIL = 0.18; // headroom above the knee (curve end ≈ 0.944)

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
    this.bus = bus;
    bus.declare("note/on", { type: "event", owner: "audio" });
    bus.declare("note/off", { type: "event", owner: "audio" });
    bus.declare("note/cancel", { type: "event", owner: "audio" });
  }

  ensureContext() {
    if (this.ctx) return;
    const ac = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());

    this.waveShaper = ac.createWaveShaper();
    this.waveShaper.curve = null;
    this.waveShaper.oversample = "4x"; // Reduces aliasing harshness

    this.filter = ac.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 0.7;

    this.chordGain = ac.createGain();
    this.chordGain.gain.value = 0;

    this.masterGain = ac.createGain();
    this.masterGain.gain.value = this.masterVolume;

    // Gentle limiter: fast attack, high ratio, threshold a few dB below full scale.
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;

    // Safety net for the limiter's attack/lookahead overshoot: a soft clip that cannot exceed ±0.95.
    this.clipper = ac.createWaveShaper();
    this.clipper.curve = softClipCurve();
    this.clipper.oversample = "2x";

    this.chordGain.connect(this.waveShaper);
    this.waveShaper.connect(this.filter);
    this.filter.connect(this.masterGain);
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

  /** Master volume (left-hand height, every mode). The router already smooths it; this only de-zippers. */
  setMasterVolume(volume01) {
    const v = Math.max(0, Math.min(1, volume01));
    this.masterVolume = v;
    if (!this.ctx) return;
    this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  updateFilterSweep(tiltFactor) {
    if (!this.filter || !this.ctx) return;

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
    this.filter.frequency.setTargetAtTime(targetFrequency, now, 0.04);
    this.filter.Q.setTargetAtTime(targetQ, now, 0.04);
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
    env.connect(this.waveShaper);
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
    /** PRE-FILTER input bus: every voice connects here (-> filter -> master -> limiter). */
    get out() { return synth.waveShaper; },
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
    setWaveform: (type) => {
      synth.waveform = type;
      synth.currentKey = null; // forces sound refresh
    },
    /** Chord-voice level (Chords' right-hand volume). */
    setVolume: (v) => synth.setVolume(v),
    /** Master volume (left-hand height; the router calls this). */
    setMasterVolume: (v) => synth.setMasterVolume(v),
    synth,
  };
}
