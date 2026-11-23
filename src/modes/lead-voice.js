// Lead mode sound: a monophonic lead voice (discrete note steps, retrigger, click-free envelope) and the left-hand chord as
// a soft pad. Both feed ctx.audio.out (the pre-master bus: waveshaper -> shared tilt filter -> master volume),
// so the shared filter and master volume apply. It never touches the master gain (the router owns it).
// Note events carry {freq, midi, voice, id}; `id` comes from `nextId` (ctx.audio.nextNoteId: app-wide unique),
// and every note/on pairs with exactly one note/off of the same id.
//
// Levels leave headroom for the resonant filter: lead peak 0.2, pad <= ~0.16 total.
//
// Instruments (plugins, src/instruments): the lead plays the LEAD instrument (ctx.audio.instrument("lead"); it follows
// the base until one is picked in the Sound menu). Chain: source (mono: one long-lived source) -> tone low-pass
// (traits.leadToneHz) -> envelope -> the instrument's POST (this voice's rack) -> layerOut. Only the plugin interface
// and traits are used: a pinch = source.excite() (a new attack: a re-pluck that adds to a ringing string, a key click,
// a breath puff); a note step = setFreq() (+ excite(t, traits.hammerOn) when traits.legato is "hammer-on"); the
// release = source.release(). An instrument change while a note sounds crossfades (SWAP_S) to a new source at the
// same pitch: no gap, no click.

import { createSource, createRack, instrumentFromTone, defaultInstrumentId, traitsOf } from "../instruments/index.js";

// ---- Tunables ----
export const LEAD_PEAK = 0.2;
export const LEAD_SUSTAIN = 0.16;
export const ATTACK_S = 0.01; // linear attack
export const DECAY_TAU = 0.08; // peak -> sustain
export const RELEASE_TAU = 0.03; // ~150 ms to silence
export const RETRIGGER_DIP_S = 0.008; // a new pinch on a sounding voice dips to 0 first (audible onset, no click)
// Moving to another note while pinched steps the pitch (lead decision after the real-camera session: the 70 ms
// portamento sounded like a slide guitar). The step is a 3 ms exponential ramp, not a jump to the new value
// at an arbitrary sample: the oscillator keeps its phase either way, the ramp only rounds the slope kink.
// Measured: no click under the lab's click metric (max jump / steady max < 1.6), no intermediate pitch in an
// 85 ms FFT window (tests/lead.spec.js "audio quality").
export const PITCH_STEP_S = 0.003;
export const LEAD_TONE_HZ = 3200; // fixed lowpass that takes the edge off bright waveforms
export const SWAP_S = 0.025; // instrument change while sounding: crossfade

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

  /** The lead's instrument id (Sound menu); labs without instruments: from the tone select value. */
  function instrument() {
    if (typeof audio.instrument === "function") return audio.instrument("lead");
    return instrumentFromTone((audio.synth && audio.synth.waveform) || audio.waveform) || defaultInstrumentId();
  }

  /** source -> tone -> env -> rack[inst]. */
  function buildChain(ac, rack, inst, freq) {
    const src = createSource(ac, inst, freq, ac.currentTime, { voice: "lead", mono: true });
    const tone = ac.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = traitsOf(inst).leadToneHz ?? LEAD_TONE_HZ;
    tone.Q.value = 0.5;
    const env = ac.createGain();
    env.gain.value = 0;
    src.connect(tone);
    tone.connect(env);
    env.connect(rack.input(inst));
    return { inst, src, osc: src, tone, env };
  }

  function ensure() {
    const ac = audio.ac;
    const out = audio.out;
    if (!ac || !out) return null;
    if (nodes && nodes.ac === ac) return nodes;
    // Lead layer: the lead goes through its own tilt filter (ctx.audio.layerOut -> layerFilter -> master), so the
    // base mode underneath keeps the shared filter at its held value. The pad stays on the shared bus.
    const rack = createRack(ac, audio.layerOut || out);
    const ch = buildChain(ac, rack, instrument(), 440);

    const padTone = ac.createBiquadFilter();
    padTone.type = "lowpass";
    padTone.frequency.value = PAD_TONE_HZ;
    padTone.Q.value = 0.4;
    padTone.connect(out);

    nodes = { ac, rack, ...ch, padTone, unsub: null };
    if (typeof audio.onInstrument === "function") {
      nodes.unsub = audio.onInstrument((target, id) => {
        if (target === "lead") swapInstrument(id);
      });
    }
    return nodes;
  }

  /** Instrument change: a new chain at the same pitch; a sounding note crossfades over SWAP_S. */
  function swapInstrument(id) {
    const n = nodes;
    if (!n || !id || id === n.inst) return;
    const ac = n.ac;
    const t = ac.currentTime;
    const old = { src: n.src, env: n.env, tone: n.tone };
    const freq = soundingFreq ?? n.src.frequency.value ?? 440;
    const ch = buildChain(ac, n.rack, id, freq);
    Object.assign(n, ch);
    const lvl = old.env.gain.value;
    hold(old.env.gain, t);
    old.env.gain.linearRampToValueAtTime(0, t + SWAP_S);
    try { old.src.stop(t + SWAP_S + 0.05); } catch {}
    old.src.onended = () => { try { old.env.disconnect(); } catch {} };
    if (soundingFreq != null && lvl > 0.002) {
      const g = n.env.gain;
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(Math.max(lvl, LEAD_SUSTAIN * 0.9), t + SWAP_S);
      g.setTargetAtTime(LEAD_SUSTAIN, t + SWAP_S, DECAY_TAU);
      ch.src.excite(t, 1);
    }
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
    const inst = instrument();
    if (inst !== n.inst) {
      swapInstrument(inst); // silent swap (not sounding) or a crossfade
      return noteOn(freq, extra);
    }
    n.src.setFreq(freq, ts, 0);
    n.src.excite(ts, 1);
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
    n.src.setFreq(freq, t, PITCH_STEP_S);
    const tr = traitsOf(n.inst);
    if (tr.legato === "hammer-on") n.src.excite(t, tr.hammerOn);
    emit("note/off", soundingFreq, t, soundingId);
    soundingFreq = freq;
    soundingId = newId();
    emit("note/on", freq, t, soundingId, { legato: true, ...extra });
  }

  function noteOff() {
    const n = nodes;
    if (!n || soundingFreq == null) return;
    const t = n.ac.currentTime;
    hold(n.env.gain, t);
    n.env.gain.setTargetAtTime(0, t, RELEASE_TAU);
    n.src.release(t); // the instrument's own note end (palm mute, key-up fade; no-op for oscillators)
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
    n.unsub?.();
    const t = n.ac.currentTime;
    // Keep the graph until the pad has rung out (disconnecting padTone earlier would cut it: a click).
    n.src.stop(t + PAD_RELEASE_TAU * 8);
    n.src.onended = () => {
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
