// Lead mode sound: a monophonic lead voice (discrete note steps, retrigger, click-free envelope) and the left-hand chord as
// a soft pad. Both feed ctx.audio.out (the pre-master bus: waveshaper -> shared tilt filter -> master volume),
// so the shared filter and master volume apply. It never touches the master gain (the router owns it).
// Note events carry {freq, midi, voice, id}; `id` comes from `nextId` (ctx.audio.nextNoteId: app-wide unique),
// and every note/on pairs with exactly one note/off of the same id.
//
// Levels leave headroom for the resonant filter: lead peak 0.2, pad <= ~0.16 total.
//
// Release (pinch opens): a smooth fade over leadConfig.releaseMs (releaseCurve: cubic, slope 0 at the end = exact,
// click-free silence; -60 dB at 90% of the time). releaseTime() is the one place that picks the length, so an
// instrument trait (e.g. traits.releaseTailS) can override it later. A new pinch during the fade retriggers via
// cancelAndHold + the RETRIGGER_DIP_S dip (no click, no stuck note).

import { leadConfig } from "./lead-config.js";

// ---- Tunables ----
export const LEAD_PEAK = 0.2;
export const LEAD_SUSTAIN = 0.16;
export const ATTACK_S = 0.01; // linear attack
export const DECAY_TAU = 0.08; // peak -> sustain
export const RELEASE_TAU = 0.03; // (legacy; the release now uses releaseCurve over leadConfig.releaseMs)
export const RELEASE_POINTS = 64;

/**
 * Release envelope: `points` gain values from `level` to exactly 0, shape (1 - x)^3 (gentle start like an
 * exponential with tau = T/3, slope 0 at the end so the tail never clicks; -60 dB at x = 0.9).
 */
export function releaseCurve(level, points = RELEASE_POINTS) {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1);
    c[i] = level * (1 - x) * (1 - x) * (1 - x);
  }
  return c;
}

/** Release length in seconds (live: leadConfig.releaseMs; clamped 10 ms .. 1.5 s, the graph outlives it on stop). */
export function releaseTime() {
  const ms = Number(leadConfig.releaseMs);
  return Math.max(0.01, Math.min(1.5, Number.isFinite(ms) ? ms / 1000 : 0.25));
}
export const RETRIGGER_DIP_S = 0.008; // a new pinch on a sounding voice dips to 0 first (audible onset, no click)
// Moving to another note while pinched steps the pitch (lead decision after the real-camera session: the 70 ms
// portamento sounded like a slide guitar). The step is a 3 ms exponential ramp, not a jump to the new value
// at an arbitrary sample: the oscillator keeps its phase either way, the ramp only rounds the slope kink.
// Measured: no click under the lab's click metric (max jump / steady max < 1.6), no intermediate pitch in an
// 85 ms FFT window (tests/lead.spec.js "audio quality").
export const PITCH_STEP_S = 0.003;
export const LEAD_TONE_HZ = 3200; // fixed lowpass that takes the edge off bright waveforms

export const PAD_LEVEL = 0.03; // per pad note (4 notes, 2 oscillators each)
export const PAD_ATTACK_TAU = 0.12;
export const PAD_RELEASE_TAU = 0.25;
export const PAD_TONE_HZ = 900;

/** Cancel future automation but keep the param where it is right now. */
function hold(param, t) {
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(t);
  } else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}

const freqToMidi = (f) => Math.round(69 + 12 * Math.log2(f / 440));
let localId = 0;

/**
 * @param {object} audio ctx.audio facade ({ ac, out, synth?, nextNoteId? })
 * @param {{ bus?: object, voice?: string, padVoice?: string, nextId?: () => number }} [opts]
 */
export function createLeadVoice(audio, { bus = null, voice = "lead", padVoice = "pad", nextId = audio.nextNoteId } = {}) {
  const newId = typeof nextId === "function" ? nextId : () => `lead-${++localId}`;
  let nodes = null; // built lazily once the AudioContext exists
  let soundingFreq = null; // freq of the current lead note (null = released)
  let soundingId = null; // note id of the current lead note
  let pad = []; // [{ freq, gain, oscs, id }]
  let padKey = "";

  function waveform() {
    return (audio.synth && audio.synth.waveform) || "triangle";
  }

  function ensure() {
    const ac = audio.ac;
    const out = audio.out;
    if (!ac || !out) return null;
    if (nodes && nodes.ac === ac) return nodes;
    const osc = ac.createOscillator();
    osc.type = waveform();
    osc.frequency.value = 440;
    const tone = ac.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = LEAD_TONE_HZ;
    tone.Q.value = 0.5;
    const env = ac.createGain();
    env.gain.value = 0;
    osc.connect(tone);
    tone.connect(env);
    // Lead layer: the lead goes through its own tilt filter (ctx.audio.layerOut -> layerFilter -> master), so the
    // base mode underneath keeps the shared filter at its held value. The pad stays on the shared bus.
    env.connect(audio.layerOut || out);
    osc.start();

    const padTone = ac.createBiquadFilter();
    padTone.type = "lowpass";
    padTone.frequency.value = PAD_TONE_HZ;
    padTone.Q.value = 0.4;
    padTone.connect(out);

    nodes = { ac, osc, tone, env, padTone };
    return nodes;
  }

  function emit(name, freq, t, id, extra) {
    if (bus && bus.wants(name)) bus.emit(name, { freq, midi: freqToMidi(freq), voice, id, ...extra }, t);
  }

  // ---- Lead ----

  /** Starts (or retriggers) the lead note. */
  function noteOn(freq, extra) {
    const n = ensure();
    if (!n) return;
    const t = n.ac.currentTime;
    const g = n.env.gain;
    hold(g, t);
    let ts = t;
    if (g.value > 0.002) {
      // Still sounding (releasing or a fast re-pinch): dip to silence first so the new note has an onset.
      g.linearRampToValueAtTime(0, t + RETRIGGER_DIP_S);
      ts = t + RETRIGGER_DIP_S;
    }
    const wf = waveform();
    if (n.osc.type !== wf) n.osc.type = wf;
    hold(n.osc.frequency, t);
    n.osc.frequency.setValueAtTime(freq, ts);
    g.linearRampToValueAtTime(LEAD_PEAK, ts + ATTACK_S);
    g.setTargetAtTime(LEAD_SUSTAIN, ts + ATTACK_S, DECAY_TAU);
    if (soundingFreq != null) emit("note/off", soundingFreq, t, soundingId);
    soundingFreq = freq;
    soundingId = newId();
    emit("note/on", freq, ts, soundingId, extra);
  }

  /** Moves the sounding note to `freq` at once (legato: no new attack, the envelope keeps going). */
  function stepTo(freq, extra) {
    const n = ensure();
    if (!n || soundingFreq == null) return;
    const t = n.ac.currentTime;
    hold(n.osc.frequency, t);
    n.osc.frequency.exponentialRampToValueAtTime(freq, t + PITCH_STEP_S);
    emit("note/off", soundingFreq, t, soundingId);
    soundingFreq = freq;
    soundingId = newId();
    emit("note/on", freq, t, soundingId, { legato: true, ...extra });
  }

  function noteOff() {
    const n = nodes;
    if (!n || soundingFreq == null) return;
    const t = n.ac.currentTime;
    const g = n.env.gain;
    hold(g, t);
    const level = g.value;
    try {
      if (level > 1e-4) g.setValueCurveAtTime(releaseCurve(level), t, releaseTime());
      else g.setValueAtTime(0, t);
    } catch {
      g.setTargetAtTime(0, t, releaseTime() / 6.9); // overlapping automation (should not happen): exp. to -60 dB
    }
    emit("note/off", soundingFreq, t, soundingId);
    soundingFreq = null;
    soundingId = null;
  }

  // ---- Pad ----

  function releasePadVoice(v, t) {
    hold(v.gain.gain, t);
    v.gain.gain.setTargetAtTime(0, t, PAD_RELEASE_TAU);
    for (const o of v.oscs) o.stop(t + PAD_RELEASE_TAU * 8);
    v.oscs[0].onended = () => {
      try { v.gain.disconnect(); } catch {}
    };
    emit("note/off", v.freq, t, v.id, { voice: padVoice });
  }

  /** Holds `freqs` as the pad chord (crossfades from the previous one). null/[] = pad off. */
  function setPad(freqs) {
    const key = freqs && freqs.length ? freqs.map((f) => f.toFixed(2)).join(",") : "";
    if (key === padKey) return;
    const n = ensure();
    if (!n) return;
    padKey = key;
    const t = n.ac.currentTime;
    for (const v of pad) releasePadVoice(v, t);
    pad = [];
    if (!key) return;
    for (const freq of freqs) {
      const gain = n.ac.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(PAD_LEVEL, t, PAD_ATTACK_TAU);
      const a = n.ac.createOscillator();
      a.type = "triangle";
      a.frequency.value = freq;
      const b = n.ac.createOscillator();
      b.type = "sine";
      b.frequency.value = freq;
      b.detune.value = 6;
      const bGain = n.ac.createGain();
      bGain.gain.value = 0.6;
      a.connect(gain);
      b.connect(bGain);
      bGain.connect(gain);
      gain.connect(n.padTone);
      a.start(t);
      b.start(t);
      const id = newId();
      pad.push({ freq, gain, oscs: [a, b], id });
      emit("note/on", freq, t, id, { voice: padVoice });
    }
  }

  /** Releases everything and frees the nodes shortly after (mode exit). */
  function stop() {
    noteOff();
    setPad(null);
    const n = nodes;
    if (!n) return;
    nodes = null;
    const t = n.ac.currentTime;
    // Keep the graph until the pad has rung out (disconnecting padTone earlier would cut it: a click).
    n.osc.stop(t + PAD_RELEASE_TAU * 8);
    n.osc.onended = () => {
      try { n.env.disconnect(); n.padTone.disconnect(); } catch {}
    };
  }

  return {
    noteOn,
    stepTo,
    noteOff,
    setPad,
    stop,
    get sounding() { return soundingFreq; },
    get padFreqs() { return pad.map((v) => v.freq); },
    /** Live nodes (tests / debugging). */
    get nodes() { return nodes; },
  };
}
