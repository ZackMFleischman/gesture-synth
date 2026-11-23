// Lead mode: pure musical logic + the right-hand state machine (no DOM, no audio).
//   - note sets built from the key + the current chord
//   - a 2-octave range mapped over the ladder, snapping with hysteresis at note edges
//   - octave state with limits, octave arrows (pinch must START on the arrow, held 0.3 s)
//   - note-set toggle that needs the finger count stable for 0.3 s (never during/around a pinch)
//
// Coordinates: the controller works in ladder units `u`: 0 = bottom note line, 1 = top note line.
// Values beyond [0, 1] are the arrow zones. lead.js converts screen y <-> u.

import { MAJOR_SCALE } from "../services/harmony.js";

// ---- Tunables ----

/** Finger count must be stable this long to change the note set. */
export const SET_HOLD_MS = 300;
/** Pinch held on an octave arrow this long changes the octave. */
export const ARROW_HOLD_MS = 300;
/** Range over the ladder (2 octaves, both ends included). */
export const RANGE_SEMITONES = 24;
/** Octave positions (4 marks). low note = tonic pitch class + 12 * (octave + OCTAVE_BASE). */
export const OCTAVE_MIN = 0;
export const OCTAVE_MAX = 3;
export const OCTAVE_DEFAULT = 2; // key A -> A4..A6, key C -> C4..C6
const OCTAVE_BASE = 3;
/** Hysteresis: to leave a note the hand must pass the midpoint to the neighbour by this fraction of the gap. */
export const SNAP_HYSTERESIS = 0.3;
/** Arrow zone (ladder units beyond the end lines): enter past ENTER, leave inside EXIT. */
export const ARROW_ENTER = 0.045;
export const ARROW_EXIT = 0.025;
/** Hand may vanish this long (MediaPipe dropouts) before a playing note stops. */
export const LOST_GRACE_MS = 150;
/** A finger count only counts when the thumb is clearly away from the index tip (not a pinch on its way). */
export const COUNT_MIN_PINCH_DISTANCE = 0.7;

export const NOTE_SETS = Object.freeze([
  null,
  { id: 1, name: "Chord notes" },
  { id: 2, name: "Five notes" },
  { id: 3, name: "Full scale" },
  { id: 4, name: "All notes" },
]);

// ---- Pitch helpers ----

export const KEY_PC = Object.freeze({ C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 });
const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb"]);
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
// Same convention as harmony.DEGREE_SEMITONES (degree 7 sits a semitone under the tonic).
const DEGREE_SEMI = [0, 0, 2, 4, 5, 7, 9, -1];

export const mod12 = (n) => ((n % 12) + 12) % 12;
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

export function tonicPc(keyName) {
  return KEY_PC[keyName] ?? 9;
}

/** Note name with octave, spelled for the key ("C#5" in A, "Bb4" in F). */
export function noteName(midi, keyName = "A") {
  const pc = mod12(midi);
  let octave = Math.floor(midi / 12) - 1;
  const scale = MAJOR_SCALE[keyName];
  if (scale) {
    for (const n of scale) {
      const npc = mod12(LETTER_PC[n[0]] + (n.includes("#") ? 1 : 0) - (n.includes("b") ? 1 : 0));
      if (npc === pc) {
        if (n === "Cb") octave += 1; // Cb5 is the B just below C5
        return n + octave;
      }
    }
  }
  return (FLAT_KEYS.has(keyName) ? FLAT_NAMES : SHARP_NAMES)[pc] + octave;
}

/**
 * Chord pitch classes {root, third, fifth} for a harmony chord ({degree, isMajor}); null chord = the tonic triad.
 */
export function chordPcs(chord, keyName) {
  const t = tonicPc(keyName);
  const degree = chord ? chord.degree : 1;
  const isMajor = chord ? chord.isMajor : true;
  const root = mod12(t + DEGREE_SEMI[degree]);
  return { root, third: mod12(root + (isMajor ? 4 : 3)), fifth: mod12(root + 7), degree, isMajor };
}

/**
 * Pitch classes of a note set (sorted ascending, as offsets mod 12).
 *  1 = chord notes (triad), 2 = five-note scale (the chord root's major/minor pentatonic: always contains the
 *  triad, never a semitone clash), 3 = full scale (the key's major scale with the chord's own tones swapped in
 *  for their diatonic counterparts, e.g. the minor third of a tilted-minor I), 4 = all 12.
 */
export function setPcs(setId, keyName, chord) {
  const c = chordPcs(chord, keyName);
  let pcs;
  switch (setId) {
    case 1:
      pcs = [c.root, c.third, c.fifth];
      break;
    case 2:
      pcs = (c.isMajor ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10]).map((s) => mod12(c.root + s));
      break;
    case 3: {
      const t = tonicPc(keyName);
      const scale = MAJOR_STEPS.map((s) => mod12(t + s));
      // Diatonic counterparts of root/third/fifth are scale steps degree-1, +2, +4.
      const base = (c.degree - 1) % 7;
      scale[base] = c.root;
      scale[(base + 2) % 7] = c.third;
      scale[(base + 4) % 7] = c.fifth;
      pcs = scale;
      break;
    }
    default:
      pcs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  }
  return [...new Set(pcs)].sort((a, b) => a - b);
}

/** Lowest MIDI note of the range for this key + octave index. */
export function rangeLow(keyName, octave) {
  return tonicPc(keyName) + 12 * (octave + OCTAVE_BASE);
}

/**
 * The ladder: every note of the set inside [low, low + 24], ascending.
 * @returns {{low:number, high:number, notes:{midi:number, pc:number, isChord:boolean, u:number, name:string}[]}}
 */
export function buildLadder({ keyName = "A", chord = null, setId = 1, octave = OCTAVE_DEFAULT } = {}) {
  const low = rangeLow(keyName, octave);
  const high = low + RANGE_SEMITONES;
  const pcs = new Set(setPcs(setId, keyName, chord));
  const c = chordPcs(chord, keyName);
  const chordSet = new Set([c.root, c.third, c.fifth]);
  const notes = [];
  for (let m = low; m <= high; m++) {
    const pc = mod12(m);
    if (!pcs.has(pc)) continue;
    notes.push({ midi: m, pc, isChord: chordSet.has(pc), u: (m - low) / RANGE_SEMITONES, name: noteName(m, keyName) });
  }
  return { low, high, notes };
}

/**
 * Snaps a continuous pitch (semitones, MIDI scale) to a ladder index with hysteresis.
 * @param {number} p continuous pitch
 * @param {{midi:number}[]} notes ascending
 * @param {number|null} prev index currently shown (null = no history)
 */
export function snapIndex(p, notes, prev = null, hyst = SNAP_HYSTERESIS) {
  const n = notes.length;
  if (!n) return null;
  // Nearest note (notes are few: linear scan is fine and allocation-free).
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(p - notes[i].midi);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (prev == null || prev < 0 || prev >= n || prev === best) return best;
  const dPrev = Math.abs(p - notes[prev].midi);
  const dir = best > prev ? 1 : -1;
  const gap = Math.abs(notes[prev + dir].midi - notes[prev].midi);
  // dPrev - bestD = 2 * (distance past the midpoint) for adjacent notes.
  return dPrev - bestD > 2 * hyst * gap ? best : prev;
}

// ---- The right-hand controller (state machine) ----

/**
 * createLeadController() -> { setContext, step, state, setNoteSet, setOctave, stepOctave }
 *
 * step(input, now) with input = {
 *   present: boolean,       // a right hand (or a screen pointer) is there
 *   u: number,              // raw ladder coordinate (0 bottom line .. 1 top line; beyond = arrow zones)
 *   pinch: boolean,         // play gesture (pinch, mouse button, key)
 *   count: 1..4 | null,     // a VALID finger count this frame (see validCount), else null
 *   noteIdx?: number|null,  // force the cursor to this ladder index (keyboard); skips height + arrows
 * }
 * Returns the events of this step (reused array): {type:"noteOn"|"glide"|"noteOff", midi, from?} |
 * {type:"noteset", value} | {type:"octave", value, dir}.
 */
export function createLeadController({ setId = 1, octave = OCTAVE_DEFAULT } = {}) {
  const s = {
    keyName: "A",
    chord: null,
    setId,
    octave,
    ladder: buildLadder({ setId, octave }),
    ladderVersion: 0,
    changeKind: "context", // what caused the last ladder rebuild: context (key/chord) | set | octave

    present: false,
    lostSince: null,
    u: 0.5,
    preview: null, // ladder index under the hand
    hover: null, // "up" | "down" | null: cursor on an arrow
    pinchMode: "none", // none | note | arrow | dead
    playIdx: null, // ladder index sounding (pinchMode === "note")
    playMidi: null,
    arrowDir: null,
    arrowSince: 0,
    arrowProgress: 0,

    setCandidate: null,
    setSince: 0,
    setHoldTarget: null, // count being held (differs from setId)
    setHoldProgress: 0,
    setChangedAt: -Infinity,
    octaveChangedAt: -Infinity,
    octaveDir: 0,
    contextChangedAt: -Infinity,
  };
  const events = [];
  let ctxKey = "";

  function rebuild(kind) {
    s.changeKind = kind;
    const keepPreview = s.preview != null ? s.ladder.notes[s.preview]?.midi : null;
    const keepPlay = s.playMidi;
    s.ladder = buildLadder({ keyName: s.keyName, chord: s.chord, setId: s.setId, octave: s.octave });
    s.ladderVersion++;
    const find = (m) => {
      if (m == null) return null;
      const i = s.ladder.notes.findIndex((n) => n.midi === m);
      return i >= 0 ? i : null;
    };
    s.preview = find(keepPreview);
    if (s.pinchMode === "note") s.playIdx = find(keepPlay);
  }

  /** Key + chord (harmony.chord). Cheap when unchanged. */
  function setContext(keyName, chord, now) {
    const k = `${keyName}|${chord ? chord.degree + (chord.isMajor ? "M" : "m") : "-"}`;
    if (k === ctxKey) return false;
    ctxKey = k;
    s.keyName = keyName;
    s.chord = chord ? { degree: chord.degree, isMajor: chord.isMajor } : null;
    s.contextChangedAt = now;
    rebuild("context");
    return true;
  }

  function setNoteSet(id, now = 0) {
    id = Math.max(1, Math.min(4, Math.round(id)));
    if (id === s.setId) return false;
    s.setId = id;
    s.setChangedAt = now;
    s.setHoldTarget = null;
    s.setHoldProgress = 0;
    rebuild("set");
    return true;
  }

  function setOctave(o, now = 0) {
    o = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, Math.round(o)));
    if (o === s.octave) return false;
    s.octaveDir = Math.sign(o - s.octave);
    s.octave = o;
    s.octaveChangedAt = now;
    rebuild("octave");
    return true;
  }

  const atLimit = (dir) => (dir > 0 ? s.octave >= OCTAVE_MAX : s.octave <= OCTAVE_MIN);
  const pitchAt = (u) => s.ladder.low + RANGE_SEMITONES * Math.max(0, Math.min(1, u));

  function step(input, now) {
    events.length = 0;
    const notes = s.ladder.notes;

    // ---- Hand lost ----
    if (!input || !input.present) {
      if (s.present) s.lostSince = now;
      s.present = false;
      s.setCandidate = null;
      s.setHoldTarget = null;
      s.setHoldProgress = 0;
      s.hover = null;
      if (s.pinchMode !== "none" && now - (s.lostSince ?? now) >= LOST_GRACE_MS) endPinch();
      return events;
    }
    s.present = true;
    s.lostSince = null;
    s.u = input.u;

    // ---- Cursor: forced index (keyboard) or height with hysteresis; arrow zones ----
    const forced = input.noteIdx != null && input.noteIdx >= 0 && input.noteIdx < notes.length;
    if (forced) {
      s.hover = null;
    } else if (s.pinchMode !== "note") {
      // Arrow zones only matter when not playing (sliding into them while playing changes nothing).
      if (s.hover === "up") { if (input.u < 1 + ARROW_EXIT) s.hover = null; }
      else if (s.hover === "down") { if (input.u > -ARROW_EXIT) s.hover = null; }
      if (!s.hover) {
        if (input.u > 1 + ARROW_ENTER) s.hover = "up";
        else if (input.u < -ARROW_ENTER) s.hover = "down";
      }
    } else {
      s.hover = null;
    }
    if (forced) s.preview = input.noteIdx;
    else if (!s.hover) s.preview = snapIndex(pitchAt(input.u), notes, s.preview);

    // ---- Pinch transitions ----
    if (input.pinch && s.pinchMode === "none") {
      if (s.hover) {
        if (atLimit(s.hover === "up" ? 1 : -1)) s.pinchMode = "dead";
        else {
          s.pinchMode = "arrow";
          s.arrowDir = s.hover === "up" ? 1 : -1;
          s.arrowSince = now;
          s.arrowProgress = 0;
        }
      } else if (s.preview != null) {
        s.pinchMode = "note";
        s.playIdx = s.preview;
        s.playMidi = notes[s.preview].midi;
        events.push({ type: "noteOn", midi: s.playMidi });
      } else {
        s.pinchMode = "dead";
      }
    } else if (!input.pinch && s.pinchMode !== "none") {
      endPinch();
    } else if (s.pinchMode === "note") {
      // Playing: the cursor stays on the ladder (clamped), the pitch glides to the snapped note.
      if (s.preview != null && s.preview !== s.playIdx) {
        const from = s.playMidi;
        s.playIdx = s.preview;
        s.playMidi = notes[s.preview].midi;
        if (s.playMidi !== from) events.push({ type: "glide", midi: s.playMidi, from });
      } else if (s.playIdx == null && s.preview != null) {
        // The ladder changed under a held note (chord/set change) and the note left it: follow the cursor.
        const from = s.playMidi;
        s.playIdx = s.preview;
        s.playMidi = notes[s.preview].midi;
        if (s.playMidi !== from) events.push({ type: "glide", midi: s.playMidi, from });
      }
    } else if (s.pinchMode === "arrow") {
      const zone = s.arrowDir > 0 ? "up" : "down";
      if (s.hover !== zone) {
        s.pinchMode = "dead"; // left the arrow: cancel, nothing plays until a new pinch
        s.arrowProgress = 0;
      } else {
        s.arrowProgress = Math.min(1, (now - s.arrowSince) / ARROW_HOLD_MS);
        if (s.arrowProgress >= 1) {
          setOctave(s.octave + s.arrowDir, now);
          events.push({ type: "octave", value: s.octave, dir: s.arrowDir });
          s.pinchMode = "dead"; // one step per pinch
        }
      }
    }

    // ---- Note-set toggle: valid count, stable SET_HOLD_MS, never while pinching ----
    const count = s.pinchMode === "none" && !input.pinch ? input.count : null;
    if (count == null) {
      s.setCandidate = null;
    } else if (count !== s.setCandidate) {
      s.setCandidate = count;
      s.setSince = now;
    }
    if (s.setCandidate != null && s.setCandidate !== s.setId) {
      s.setHoldTarget = s.setCandidate;
      s.setHoldProgress = Math.min(1, (now - s.setSince) / SET_HOLD_MS);
      if (now - s.setSince >= SET_HOLD_MS) {
        setNoteSet(s.setCandidate, now);
        events.push({ type: "noteset", value: s.setId });
      }
    } else {
      s.setHoldTarget = null;
      s.setHoldProgress = 0;
    }
    return events;
  }

  function endPinch() {
    if (s.pinchMode === "note" && s.playMidi != null) events.push({ type: "noteOff", midi: s.playMidi });
    s.pinchMode = "none";
    s.playIdx = null;
    s.playMidi = null;
    s.arrowDir = null;
    s.arrowProgress = 0;
  }

  return {
    state: s,
    setContext,
    step,
    setNoteSet,
    setOctave,
    stepOctave: (dir, now) => setOctave(s.octave + dir, now),
    atLimit,
    /** Stops a sounding note (mode exit). Returns the events. */
    release() {
      events.length = 0;
      endPinch();
      return events;
    },
  };
}

/**
 * The finger count a HandFrame shows for the note-set toggle, or null if it is not a deliberate count:
 * not pinching, index finger extended (all counting shapes 1-4 start with the index; the post-pinch "OK" shape
 * has it curled), and the thumb clearly away from the index tip (not a pinch on its way).
 */
export function validCount(hand) {
  if (!hand || hand.pinch) return null;
  if (!hand.fingers.index) return null;
  if (!(hand.pinchDistance >= COUNT_MIN_PINCH_DISTANCE)) return null;
  const c = hand.voicingCount;
  return c >= 1 && c <= 4 ? c : null;
}
