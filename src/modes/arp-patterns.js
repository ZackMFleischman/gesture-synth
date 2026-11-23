// Pure arp music logic: which notes a chord gives, and which of them each step plays.
// No DOM / Web Audio here, so it runs in Node tests.

import { voicingSemitones } from "../services/harmony.js";

export const PATTERNS = ["up", "down", "updown", "random"];
export const PATTERN_LABELS = { up: "Up", down: "Down", updown: "Up-down", random: "Random" };

// The voicing table lives in the harmony service (shared with Chords).
export { voicingSemitones };

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

/**
 * MIDI notes the arp cycles through, ascending, without duplicates.
 * @param {number} rootMidi chord root (e.g. 57 = A3)
 * @param {boolean} isMajor
 * @param {number} voicing 1..4
 * @param {number} octaves 1..3 — the voicing repeated an octave up per extra octave
 */
export function arpNotes(rootMidi, isMajor, voicing, octaves = 1) {
  const base = voicingSemitones(isMajor, voicing).map((s) => rootMidi + s);
  const n = Math.max(1, Math.min(3, Math.round(octaves) || 1));
  const set = new Set();
  for (let o = 0; o < n; o++) for (const m of base) set.add(m + 12 * o);
  return [...set].sort((a, b) => a - b);
}

// Deterministic per-step hash so "random" is reproducible (and testable) for a given step.
function hash(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

function shuffled(len, seed) {
  const a = Array.from({ length: len }, (_, i) => i);
  for (let i = len - 1; i > 0; i--) {
    const j = hash(seed * 31 + i) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Index into a note list of length `len` for pattern position `pos` (0, 1, 2, ...).
 * The position keeps counting across chord changes, so a new chord continues the pattern
 * instead of restarting it.
 */
export function patternIndex(pattern, pos, len) {
  if (len <= 1) return 0;
  const p = Math.max(0, pos | 0);
  switch (pattern) {
    case "down":
      return len - 1 - (p % len);
    case "updown": {
      const period = 2 * len - 2;
      const i = p % period;
      return i < len ? i : period - i;
    }
    case "random": {
      // Each pass plays every note once in a shuffled order (seeded by the pass number); the first
      // note of a pass is never the last note of the previous pass, so no note repeats back to back.
      if (len === 2) return p % 2;
      const cycle = Math.floor(p / len);
      const perm = shuffled(len, cycle);
      if (cycle > 0 && perm[0] === shuffled(len, cycle - 1)[len - 1]) [perm[0], perm[1]] = [perm[1], perm[0]];
      return perm[p % len];
    }
    case "up":
    default:
      return p % len;
  }
}

/** The MIDI note for pattern position `pos`, or null if there is no chord (rest). */
export function arpNoteAt({ rootMidi, isMajor, voicing, octaves, pattern }, pos) {
  if (rootMidi == null) return null;
  const notes = arpNotes(rootMidi, isMajor, voicing, octaves);
  return notes[patternIndex(pattern, pos, notes.length)];
}

/** Note length in seconds for a gate 0..1 and step length: low = short pluck, high = overlapping. */
export function gateToDuration(gate, stepDur) {
  const g = Math.max(0, Math.min(1, Number(gate) || 0));
  return Math.max(0.02, stepDur * (0.1 + 1.9 * g));
}
