// Audio engine: oscillators -> waveshaper -> lowpass filter -> master volume.
// SynthEngine is moved unchanged from the old main.js; additions:
//  - `waveform` replaces the old global `currentWaveform`
//  - `onFirstSound` callback replaces the direct analytics call
//  - publishes note/on + note/off (per voice) on the signal bus
//  - noteOn() one-shot voices for sequenced modes (arp/lead)

import { bus as sharedBus } from "../core/bus.js";

const CHORD_VOICE = "chords";

export class SynthEngine {
  constructor({ bus = sharedBus, waveform = "triangle", onFirstSound = null } = {}) {
    this.ctx = null;
    this.filter = null;
    this.waveShaper = null;
    this.masterGain = null;
    this.oscillators = [];
    this.currentKey = null;
    this.waveform = waveform;
    this.onFirstSound = onFirstSound;
    this.hasPlayedFirstSound = false;
    this.bus = bus;
    bus.declare("note/on", { type: "event", owner: "audio" });
    bus.declare("note/off", { type: "event", owner: "audio" });
  }

  ensureContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.waveShaper = this.ctx.createWaveShaper();
    this.waveShaper.curve = null;
    this.waveShaper.oversample = "4x"; // Reduces aliasing harshness

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 0.7;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0;

    // Signal chain: oscillators -> waveshaper -> filter -> masterGain -> output
    this.waveShaper.connect(this.filter);
    this.filter.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
  }

  updateVolume(volume01) {
    if (!this.ctx) return;
    // Smooth gain transitions to prevent audio clicking
    this.masterGain.gain.setTargetAtTime(volume01, this.ctx.currentTime, 0.03);
  }
  setVolume(volume01) {
    if (!this.ctx) return;
    const clamped = Math.max(0, Math.min(1, volume01));
    this.masterGain.gain.linearRampToValueAtTime(clamped, this.ctx.currentTime + 0.05);
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

    this._emitOff(this.oscillators);
    this.oscillators.forEach((osc) => { try { osc.stop(); } catch {} });
    this.oscillators = freqs.map((freq) => {
      const osc = this.ctx.createOscillator();
      osc.type = this.waveform;
      osc.frequency.value = freq;
      osc.connect(this.waveShaper); // was: this.filter
      osc.start();
      return osc;
    });
    this.currentKey = key;
    this._emitOn(freqs);
  }

  stop() {
    this.setVolume(0);
    this._emitOff(this.oscillators);
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
   * One-shot note for sequenced modes: osc -> envelope -> pre-master bus (`out`).
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
    if (this.bus.wants("note/on")) this.bus.emit("note/on", { freq, voice }, t0);
    if (this.bus.wants("note/off")) this.bus.emit("note/off", { freq, voice }, t1);
    return osc;
  }

  _emitOn(freqs) {
    if (!this.bus.wants("note/on")) return;
    const t = this.ctx.currentTime;
    for (const freq of freqs) this.bus.emit("note/on", { freq, voice: CHORD_VOICE }, t);
  }

  _emitOff(oscillators) {
    if (!oscillators.length || !this.bus.wants("note/off")) return;
    const t = this.ctx.currentTime;
    for (const osc of oscillators) this.bus.emit("note/off", { freq: osc.frequency.value, voice: CHORD_VOICE }, t);
  }
}

/** The ctx.audio facade handed to modes (contract: docs/architecture.md "ctx"). */
export function createAudioFacade(synth) {
  return {
    get ac() { return synth.ctx; },
    get master() { return synth.masterGain; },
    get out() { return synth.waveShaper; },
    playChord: (freqs) => synth.playNotes(freqs),
    noteOn: (freq, when, dur, opts) => synth.noteOn(freq, when, dur, opts),
    setFilter: (tilt) => synth.updateFilterSweep(tilt),
    setWaveform: (type) => {
      synth.waveform = type;
      synth.currentKey = null; // forces sound refresh
    },
    /** Chord-voice level (the existing right-hand volume). */
    setVolume: (v) => synth.setVolume(v),
    synth,
  };
}
