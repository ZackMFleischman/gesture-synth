// Stand-in for the app ctx (docs/architecture.md "ctx") so the Arp mode can be developed in isolation.
// Audio chain mirrors main.js SynthEngine: out (waveshaper, pass-through) -> lowpass filter -> master gain
// -> destination. Every voice (Chords pad, Arp, Lead) connects to `out`, so they all share the filter
// and master volume and a mode switch never rebuilds the chain.

import { createClock } from "../src/services/clock.js";

// ---- minimal bus (the real one lives in src/core/bus.js) ----
export function createBusStub() {
  const decl = new Map();
  const values = new Map();
  const subs = new Set();
  return {
    declare(name, { type, owner } = {}) {
      decl.set(name, { name, type, owner });
    },
    set(name, v) {
      if (!subs.size) {
        values.set(name, v);
        return;
      }
      const val = typeof v === "function" ? v() : v;
      values.set(name, val);
      for (const s of subs) s.onSet?.(name, val);
    },
    emit(name, data, playTime) {
      if (!subs.size) return;
      for (const s of subs) s.onEvent?.(name, data, playTime);
    },
    get(name) {
      const v = values.get(name);
      return typeof v === "function" ? v() : v;
    },
    subscribe(consumer) {
      subs.add(consumer);
      return () => subs.delete(consumer);
    },
    manifest() {
      return [...decl.values()];
    },
  };
}

// ---- harmony stub: same music theory as main.js (getDegreeFreq / getChordName) ----
const KEYS = [
  // name, MIDI of the tonic as main.js plays it (Gb, G, Ab drop an octave to stay in range)
  ["A", 57], ["Bb", 58], ["B", 59], ["C", 60], ["Db", 61], ["D", 62], ["Eb", 63], ["E", 64],
  ["F", 65], ["Gb", 54], ["G", 55], ["Ab", 56],
];
export const KEY_NAMES = KEYS.map(([n]) => n);
const DEGREE_SEMITONES = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: -1 };
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
const MAJOR_SCALE = {
  A: ["A", "B", "C#", "D", "E", "F#", "G#"], Bb: ["Bb", "C", "D", "Eb", "F", "G", "A"],
  B: ["B", "C#", "D#", "E", "F#", "G#", "A#"], C: ["C", "D", "E", "F", "G", "A", "B"],
  Db: ["Db", "Eb", "F", "Gb", "Ab", "Bb", "C"], D: ["D", "E", "F#", "G", "A", "B", "C#"],
  Eb: ["Eb", "F", "G", "Ab", "Bb", "C", "D"], E: ["E", "F#", "G#", "A", "B", "C#", "D#"],
  F: ["F", "G", "A", "Bb", "C", "D", "E"], Gb: ["Gb", "Ab", "Bb", "Cb", "Db", "Eb", "F"],
  G: ["G", "A", "B", "C", "D", "E", "F#"], Ab: ["Ab", "Bb", "C", "Db", "Eb", "F", "G"],
};

export function createHarmonyStub() {
  let key = "A";
  let degree = 1;
  let isMajor = true;
  let resting = false;
  let chord = null;
  const h = {
    voicing: 1,
    get chord() {
      return chord;
    },
    get key() {
      return key;
    },
    /** Picks the chord (left hand). `rest: true` = left fist (no chord). */
    pick({ key: k = key, degree: d = degree, isMajor: m = isMajor, rest = false } = {}) {
      key = k;
      degree = d;
      isMajor = m;
      resting = rest;
      if (resting) {
        chord = null;
        return chord;
      }
      const tonic = KEYS.find(([n]) => n === key)[1];
      const rootMidi = tonic + DEGREE_SEMITONES[degree];
      const name = MAJOR_SCALE[key][degree - 1] + (isMajor ? "" : "m");
      chord = { roman: ROMAN[degree - 1], degree, isMajor, name, rootMidi, tones: [] };
      return chord;
    },
  };
  h.pick();
  return h;
}

/** Same tilt -> cutoff/Q curve as main.js SynthEngine.updateFilterSweep. */
export function filterForTilt(tilt) {
  const t = Math.max(-1, Math.min(1, Number(tilt) || 0));
  if (t < 0) return { freq: 1200 - -t * 950, q: 0.7 + -t * 1.5 };
  return { freq: 1200 + t * 3800, q: 0.7 + t * 4.5 };
}

export function createLabCtx({ bpm = 120, rate = 1 / 8, masterVolume = 0.8 } = {}) {
  const ac = new AudioContext({ latencyHint: "interactive" });
  const out = ac.createWaveShaper(); // pass-through (curve null), as in SynthEngine
  out.oversample = "4x";
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1200;
  filter.Q.value = 0.7;
  const master = ac.createGain();
  master.gain.value = masterVolume;
  out.connect(filter);
  filter.connect(master);
  master.connect(ac.destination);

  const bus = createBusStub();
  const clock = createClock(ac, { bpm, rate, bus });
  const harmony = createHarmonyStub();
  let waveform = "triangle";

  const audio = {
    ac,
    master,
    out,
    filter,
    get waveform() {
      return waveform;
    },
    setWaveform(type) {
      waveform = type;
    },
    setFilter(tilt) {
      const { freq, q } = filterForTilt(tilt);
      const now = ac.currentTime;
      filter.frequency.setTargetAtTime(freq, now, 0.04);
      filter.Q.setTargetAtTime(q, now, 0.04);
      bus.set("filter", (tilt + 1) / 2);
    },
    setMasterVolume(v) {
      master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), ac.currentTime, 0.03);
      ctx.masterVolume = v;
    },
    playChord() {}, // Chords pad: not part of this lab
    noteOn() {}, // generic voice API: not needed by Arp (it owns its voice)
  };

  const ctx = {
    audio,
    clock,
    harmony,
    bus,
    param(name, { type = "continuous", value, min, max } = {}) {
      bus.declare(name, { type });
      let v = value;
      bus.set(name, v);
      return {
        min,
        max,
        get value() {
          return v;
        },
        set value(nv) {
          v = nv;
          bus.set(name, nv);
        },
      };
    },
    toCanvas: ({ x, y }) => ({ x, y }),
    now: () => performance.now(),
    masterVolume,
  };
  return ctx;
}
