// Pure logic of Lead mode (src/modes/lead-notes.js): note sets, ladder, snapping, octave/set state machine.
// Node only (no browser). Lab/browser tests: lead.spec.js.
import { test as base, expect } from "@playwright/test";
import {
  setPcs,
  buildLadder,
  snapIndex,
  noteName,
  createLeadController,
  validCount,
  rangeLow,
  mod12,
  SET_HOLD_MS,
  ARROW_HOLD_MS,
  OCTAVE_MIN,
  OCTAVE_MAX,
  OCTAVE_DEFAULT,
  LOST_GRACE_MS,
  SET_SHAPES,
} from "../src/modes/lead-notes.js";
import { buildHandFrame } from "../src/input/hand-input.js";
import { hand } from "./helpers/hands.js";
import { confirmPhase, CONFIRM } from "../src/ui/theme.js";
import { KEYS, triad, rng } from "./helpers/theory.js";

base.describe("lead-notes (unit)", () => {
  base("note sets: chord, five-note, full scale, all 12 (key A)", () => {
    const I = { degree: 1, isMajor: true };
    expect(setPcs(1, "A", I)).toEqual([1, 4, 9]); // A C# E
    expect(setPcs(2, "A", I)).toEqual([1, 4, 6, 9, 11]); // A B C# E F#
    expect(setPcs(3, "A", I)).toEqual([1, 2, 4, 6, 8, 9, 11]); // A major
    expect(setPcs(4, "A", I)).toHaveLength(12);
    const ii = { degree: 2, isMajor: false }; // Bm
    expect(setPcs(2, "A", ii)).toEqual([2, 4, 6, 9, 11]); // B minor pentatonic: B D E F# A
    // tilted-minor I: C replaces C# in the full scale
    expect(setPcs(3, "A", { degree: 1, isMajor: false })).toEqual([0, 2, 4, 6, 8, 9, 11]);
    // no chord = tonic triad
    expect(setPcs(1, "A", null)).toEqual([1, 4, 9]);
  });

  base("every set contains the chord; five-note set never clashes a semitone with a chord tone", () => {
    for (const key of KEYS) {
      for (let degree = 1; degree <= 7; degree++) {
        for (const isMajor of [true, false]) {
          const chord = { degree, isMajor };
          const tri = triad(key, degree, isMajor);
          expect(setPcs(1, key, chord)).toEqual(tri);
          for (const set of [2, 3, 4]) {
            const pcs = setPcs(set, key, chord);
            for (const t of tri) expect(pcs, `${key} ${degree}${isMajor ? "M" : "m"} set ${set}`).toContain(t);
          }
          expect(setPcs(2, key, chord)).toHaveLength(5);
          expect(setPcs(3, key, chord)).toHaveLength(7);
          for (const p of setPcs(2, key, chord)) {
            if (tri.includes(p)) continue;
            for (const t of tri) expect(Math.min(mod12(p - t), mod12(t - p))).toBeGreaterThan(1);
          }
        }
      }
    }
  });

  base("ladder: 2 octaves, ascending, chord notes marked, positions 0..1", () => {
    const lad = buildLadder({ keyName: "C", chord: { degree: 5, isMajor: true }, setId: 3, octave: 2 });
    expect(lad.low).toBe(60);
    expect(lad.high).toBe(84);
    expect(lad.notes[0].midi).toBe(60);
    expect(lad.notes.at(-1).midi).toBe(84);
    expect(lad.notes).toHaveLength(15);
    for (let i = 1; i < lad.notes.length; i++) expect(lad.notes[i].midi).toBeGreaterThan(lad.notes[i - 1].midi);
    const chordNames = lad.notes.filter((n) => n.isChord).map((n) => n.name);
    expect(chordNames).toEqual(["D4", "G4", "B4", "D5", "G5", "B5"]); // G major chord
    expect(lad.notes[0].u).toBe(0);
    expect(lad.notes.at(-1).u).toBe(1);
    // octave limits shift the range by 12
    expect(rangeLow("A", OCTAVE_MIN)).toBe(45);
    expect(rangeLow("A", OCTAVE_MAX)).toBe(81);
    expect(rangeLow("A", OCTAVE_DEFAULT)).toBe(69);
  });

  base("note names are spelled for the key", () => {
    expect(noteName(73, "A")).toBe("C#5");
    expect(noteName(70, "F")).toBe("Bb4");
    expect(noteName(71, "Gb")).toBe("Cb5");
    expect(noteName(60, "C")).toBe("C4");
    expect(noteName(61, "C")).toBe("C#4");
    expect(noteName(61, "Eb")).toBe("Db4");
  });

  base("snapping: hysteresis at a note edge (no flicker), clean change past it", () => {
    const notes = [{ midi: 60 }, { midi: 62 }, { midi: 64 }];
    // At the exact midpoint 61 +/- 0.5 semitone jitter: stays on whatever it was.
    let idx = snapIndex(60.2, notes, null);
    expect(idx).toBe(0);
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      idx = snapIndex(61 + (r() - 0.5) * 1.0, notes, idx);
      expect(idx).toBe(0);
    }
    expect(snapIndex(61.7, notes, 0)).toBe(1); // 0.7 past the midpoint (> 0.3 * 2)
    expect(snapIndex(60.5, notes, 1)).toBe(1); // only 0.5 past the midpoint: holds
    expect(snapIndex(60.3, notes, 1)).toBe(0);
    expect(snapIndex(63.9, notes, 0)).toBe(2); // jumps are fine
  });

  base("controller: the note that plays is the previewed note", () => {
    const c = createLeadController({ setId: 3 });
    c.setContext("D", { degree: 4, isMajor: true }, 0);
    const r = rng(3);
    let t = 0;
    for (let i = 0; i < 300; i++) {
      const u = r();
      c.step({ present: true, u, pinch: false, count: null }, (t += 16));
      const previewed = c.state.ladder.notes[c.state.preview].midi;
      const evs = c.step({ present: true, u, pinch: true, count: null }, (t += 16));
      expect(evs).toEqual([{ type: "noteOn", midi: previewed }]);
      const off = c.step({ present: true, u, pinch: false, count: null }, (t += 16));
      expect(off).toEqual([{ type: "noteOff", midi: previewed }]);
    }
  });

  base("controller: moving while pinched steps note by note (discrete, no glide); a new pinch retriggers", () => {
    const c = createLeadController({ setId: 4 });
    c.setContext("C", null, 0);
    const notes = c.state.ladder.notes;
    const uOf = (m) => notes.find((n) => n.midi === m).u;
    c.step({ present: true, u: uOf(64), pinch: true, count: null }, 0);
    const evs = c.step({ present: true, u: uOf(66), pinch: true, count: null }, 16);
    expect(evs).toEqual([{ type: "step", midi: 66, from: 64 }]);
    expect(c.step({ present: true, u: uOf(66), pinch: false, count: null }, 32)).toEqual([{ type: "noteOff", midi: 66 }]);
    expect(c.step({ present: true, u: uOf(66), pinch: true, count: null }, 48)).toEqual([{ type: "noteOn", midi: 66 }]);
  });

  base("2.4 note set: counts that change < 0.3 s before a pinch never change the set; a held count does", () => {
    const c = createLeadController({ setId: 1 });
    c.setContext("A", null, 0);
    let t = 0;
    const step = (count, pinch = false) => c.step({ present: true, u: 0.5, pinch, count }, (t += 16));
    // fingers moving 4 -> 3 -> 2 over 280 ms, then a pinch
    for (const count of [4, 3, 2]) for (let i = 0; i < 6; i++) step(count);
    for (let i = 0; i < 40; i++) step(null, true); // pinching 640 ms (pinch shape reads as "3")
    expect(c.state.setId).toBe(1);
    // after release, the post-pinch shape (index curled -> null) for a long time: still nothing
    for (let i = 0; i < 40; i++) step(null);
    expect(c.state.setId).toBe(1);
    // count 2 held 0.29 s, then a pinch: nothing
    const t0 = t;
    while (t - t0 < SET_HOLD_MS - 20) step(2);
    expect(c.state.setHoldTarget).toBe(2);
    step(null, true);
    expect(c.state.setId).toBe(1);
    expect(c.state.setHoldTarget).toBe(null);
    step(null, false);
    // count 3 held >= 0.3 s: changes
    let evs = [];
    const t1 = t;
    while (t - t1 < SET_HOLD_MS + 20) evs = evs.concat(step(3).slice());
    expect(c.state.setId).toBe(3);
    expect(evs).toContainEqual({ type: "noteset", value: 3 });
  });

  base("validCount: only deliberate counting shapes", () => {
    const f = (fingers, extra = {}) => ({
      pinch: false, pinchDistance: 1.2, fingers: { thumb: false, index: false, middle: false, ring: false, pinky: false, ...fingers },
      voicingCount: Object.values(fingers).filter(Boolean).length, ...extra,
    });
    expect(validCount(f({ index: true }))).toBe(1);
    expect(validCount(f({ index: true, middle: true }))).toBe(2);
    expect(validCount(f({ index: true, middle: true, ring: true }))).toBe(3);
    expect(validCount(f({ index: true, pinky: true }))).toBe(4); // rock sign
    expect(validCount(f({ index: true, pinky: true, thumb: true }))).toBe(4); // thumb either way
    expect(validCount(f({ index: true, middle: true, thumb: true }))).toBe(2);
    // An open hand (4 fingers, thumb either way) and 5 fingers are never a set (camera feedback: releasing a
    // pinch opens the whole hand).
    expect(validCount(f({ index: true, middle: true, ring: true, pinky: true }))).toBe(null);
    expect(validCount(f({ index: true, middle: true, ring: true, pinky: true, thumb: true }))).toBe(null);
    // Other shapes that are not one of the four
    expect(validCount(f({ index: true, ring: true }))).toBe(null);
    expect(validCount(f({ index: true, middle: true, pinky: true }))).toBe(null);
    expect(validCount(f({ middle: true, ring: true, pinky: true }))).toBe(null); // post-pinch "OK" shape
    expect(validCount(f({ index: true, middle: true, ring: true, pinky: true }, { pinchDistance: 0.5 }))).toBe(null); // about to pinch
    expect(validCount(f({ index: true }, { pinch: true }))).toBe(null);
    expect(validCount(null)).toBe(null);
  });

  base("validCount on real HandFrames (hand-input + the mock hand builder): 1/2/3 fingers, rock = sets 1-4; open hand never", () => {
    const frame = (fingers, thumb = false) => buildHandFrame(hand({ handedness: "Right", fingers, thumb }).landmarks, "Right");
    expect(validCount(frame(["index"]))).toBe(1);
    expect(validCount(frame(["index", "middle"]))).toBe(2);
    expect(validCount(frame(["index", "middle", "ring"]))).toBe(3);
    expect(validCount(frame(["index", "pinky"]))).toBe(4);
    expect(validCount(frame(["index", "pinky"], true))).toBe(4);
    expect(validCount(frame(["index", "middle", "ring", "pinky"]))).toBe(null);
    expect(validCount(frame(["index", "middle", "ring", "pinky"], true))).toBe(null);
    expect(SET_SHAPES.slice(1).map((s) => s.emoji)).toEqual(["1️⃣", "2️⃣", "3️⃣", "🤘"]);
  });

  base("2.4 note set: releasing a pinch into an open hand held 1 s never changes the set; rock held 0.3 s selects 4", () => {
    const c = createLeadController({ setId: 2 });
    c.setContext("A", null, 0);
    let t = 0;
    const open = buildHandFrame(hand({ handedness: "Right", fingers: ["index", "middle", "ring", "pinky"] }).landmarks, "Right");
    const openThumb = buildHandFrame(hand({ handedness: "Right", fingers: ["index", "middle", "ring", "pinky"], thumb: true }).landmarks, "Right");
    const rock = buildHandFrame(hand({ handedness: "Right", fingers: ["index", "pinky"] }).landmarks, "Right");
    const step = (f, pinch = false) => c.step({ present: true, u: 0.5, pinch, count: pinch ? null : validCount(f) }, (t += 16));
    for (let i = 0; i < 20; i++) step(null, true); // playing
    for (let i = 0; i < 70; i++) step(i % 2 ? open : openThumb); // released into an open hand, ~1.1 s
    expect(c.state.setId).toBe(2);
    expect(c.state.setHoldTarget).toBe(null);
    const t0 = t;
    while (t - t0 < SET_HOLD_MS - 30) step(rock);
    expect(c.state.setId).toBe(2); // not yet
    expect(c.state.setHoldTarget).toBe(4);
    while (t - t0 < SET_HOLD_MS + 20) step(rock);
    expect(c.state.setId).toBe(4);
  });

  base("2.5 octave: sliding into the arrow zone during a pinch never changes the octave", () => {
    const c = createLeadController({ setId: 2 });
    c.setContext("A", null, 0);
    let t = 0;
    const top = c.state.ladder.notes.at(-1).midi;
    c.step({ present: true, u: 0.97, pinch: true, count: null }, (t += 16));
    expect(c.state.playMidi).toBe(top);
    for (let u = 0.97; u < 1.4; u += 0.01) c.step({ present: true, u, pinch: true, count: null }, (t += 16));
    for (let i = 0; i < 60; i++) c.step({ present: true, u: 1.4, pinch: true, count: null }, (t += 16)); // ~1 s on the arrow
    expect(c.state.octave).toBe(OCTAVE_DEFAULT);
    expect(c.state.playMidi).toBe(top); // cursor stopped at the last note
    expect(c.state.hover).toBe(null);
  });

  base("2.5 octave: a pinch started on an arrow and held 0.3 s steps once; limits respected", () => {
    const c = createLeadController({ setId: 2 });
    c.setContext("A", null, 0);
    let t = 0;
    const at = (u, pinch) => c.step({ present: true, u, pinch, count: null }, (t += 16));
    at(1.3, false);
    expect(c.state.hover).toBe("up");
    const t0 = t;
    while (t - t0 < ARROW_HOLD_MS - 30) at(1.3, true);
    expect(c.state.octave).toBe(OCTAVE_DEFAULT);
    expect(c.state.arrowProgress).toBeGreaterThan(0.8);
    for (let i = 0; i < 60; i++) at(1.3, true); // keep holding: still one step
    expect(c.state.octave).toBe(OCTAVE_DEFAULT + 1);
    at(1.3, false);
    for (let i = 0; i < 25; i++) at(1.3, true); // next pinch: up to the max
    expect(c.state.octave).toBe(OCTAVE_MAX);
    at(1.3, false);
    for (let i = 0; i < 40; i++) at(1.3, true); // at the limit: nothing
    expect(c.state.octave).toBe(OCTAVE_MAX);
    expect(c.state.pinchMode).toBe("dead");
    at(1.3, false);
    // leaving the arrow during the hold cancels
    at(-0.3, false);
    expect(c.state.hover).toBe("down");
    for (let i = 0; i < 10; i++) at(-0.3, true);
    at(0.5, true);
    for (let i = 0; i < 30; i++) at(0.5, true);
    expect(c.state.octave).toBe(OCTAVE_MAX);
    at(0.5, false);
    // down to the min
    for (let k = 0; k < 5; k++) {
      at(-0.3, false);
      for (let i = 0; i < 25; i++) at(-0.3, true);
      at(-0.3, false);
    }
    expect(c.state.octave).toBe(OCTAVE_MIN);
  });

  base("hand lost: a playing note survives short dropouts, stops after the grace time", () => {
    const c = createLeadController();
    c.setContext("A", null, 0);
    c.step({ present: true, u: 0.5, pinch: true, count: null }, 0);
    expect(c.step(null, 50)).toEqual([]);
    expect(c.step({ present: true, u: 0.5, pinch: true, count: null }, 80)).toEqual([]);
    expect(c.step(null, 100)).toEqual([]);
    const evs = c.step(null, 100 + LOST_GRACE_MS);
    expect(evs[0].type).toBe("noteOff");
  });
  base("setting confirm timing (theme CONFIRM): pop at the confirm, fully visible ~1 s, gone after the fade", () => {
    const at0 = confirmPhase(0);
    expect(at0.visible).toBe(true);
    expect(at0.scale).toBeCloseTo(CONFIRM.popScale, 5);
    expect(at0.flash).toBe(1);
    expect(confirmPhase(CONFIRM.popMs).scale).toBe(1);
    expect(confirmPhase(CONFIRM.popMs).flash).toBe(0);
    for (const ms of [0, 200, 500, 900, CONFIRM.holdMs]) expect(confirmPhase(ms).alpha, `alpha at ${ms} ms`).toBe(1);
    expect(confirmPhase(CONFIRM.holdMs + CONFIRM.fadeMs / 2).alpha).toBeGreaterThan(0);
    expect(confirmPhase(CONFIRM.holdMs + CONFIRM.fadeMs / 2).alpha).toBeLessThan(1);
    expect(confirmPhase(CONFIRM.holdMs + CONFIRM.fadeMs).visible).toBe(false);
    expect(confirmPhase(-Infinity).visible).toBe(false);
    expect(confirmPhase(Infinity).visible).toBe(false);
    expect(CONFIRM.holdMs + CONFIRM.fadeMs).toBeLessThanOrEqual(1500);
  });
});
