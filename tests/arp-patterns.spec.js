// Pure Node unit tests (no browser): arp note logic and the clock's step/beat arithmetic.
import { test, expect } from "@playwright/test";
import {
  arpNotes, patternIndex, arpNoteAt, voicingSemitones, gateToDuration, midiName, midiToHz, PATTERNS,
} from "../src/modes/arp-patterns.js";
import { createClock } from "../src/services/clock.js";

const names = (ms) => ms.map(midiName);

test.describe("arp-patterns", () => {
  test("voicings match Chords mode (main.js getSolidNotes)", () => {
    expect(voicingSemitones(true, 1)).toEqual([0, 7, 12, 16]);
    expect(voicingSemitones(true, 2)).toEqual([4, 7, 12, 16]);
    expect(voicingSemitones(true, 3)).toEqual([0, 4, 7, 11]);
    expect(voicingSemitones(true, 4)).toEqual([0, 4, 7, 10]);
    expect(voicingSemitones(false, 1)).toEqual([0, 7, 12, 15]);
    expect(voicingSemitones(false, 2)).toEqual([3, 7, 12, 15]);
    expect(voicingSemitones(false, 3)).toEqual([0, 3, 7, 10]);
    expect(voicingSemitones(false, 4)).toEqual([0, 3, 6, 9]);
    expect(voicingSemitones(true, 0)).toEqual([0, 7, 12, 16]); // out of range clamps
    expect(voicingSemitones(true, 9)).toEqual([0, 4, 7, 10]);
  });

  test("notes for a chord, 1-3 octaves, ascending without duplicates", () => {
    expect(names(arpNotes(57, true, 1, 1))).toEqual(["A3", "E4", "A4", "C#5"]);
    expect(names(arpNotes(57, true, 1, 2))).toEqual(["A3", "E4", "A4", "C#5", "E5", "A5", "C#6"]);
    expect(names(arpNotes(57, true, 3, 3))).toEqual([
      "A3", "C#4", "E4", "G#4", "A4", "C#5", "E5", "G#5", "A5", "C#6", "E6", "G#6",
    ]);
    expect(names(arpNotes(59, false, 4, 1))).toEqual(["B3", "D4", "F4", "G#4"]); // Bdim7
    expect(arpNotes(57, true, 1, 0)).toHaveLength(4); // clamps to 1 octave
    expect(arpNotes(57, true, 1, 7)).toEqual(arpNotes(57, true, 1, 3));
    expect(midiToHz(57)).toBeCloseTo(220, 6);
  });

  test("up / down / up-down sequences", () => {
    const seq = (p, len, n = 12) => Array.from({ length: n }, (_, i) => patternIndex(p, i, len));
    expect(seq("up", 4)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    expect(seq("down", 4)).toEqual([3, 2, 1, 0, 3, 2, 1, 0, 3, 2, 1, 0]);
    expect(seq("updown", 4)).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1]);
    expect(seq("updown", 2, 6)).toEqual([0, 1, 0, 1, 0, 1]);
    for (const p of PATTERNS) expect(seq(p, 1, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  test("random: deterministic, every note once per pass, never the same note twice in a row", () => {
    for (const len of [3, 4, 7, 12]) {
      const seq = Array.from({ length: len * 50 }, (_, i) => patternIndex("random", i, len));
      expect(seq).toEqual(Array.from({ length: len * 50 }, (_, i) => patternIndex("random", i, len)));
      for (let c = 0; c < 50; c++) expect([...seq.slice(c * len, c * len + len)].sort((a, b) => a - b)).toEqual([...Array(len).keys()]);
      for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
      // Not just "up" in disguise.
      expect(seq.slice(0, len * 4)).not.toEqual(Array.from({ length: len * 4 }, (_, i) => i % len));
    }
  });

  test("a chord change continues the pattern position instead of restarting", () => {
    const s = { isMajor: true, voicing: 1, octaves: 1, pattern: "up" };
    const played = [];
    for (let pos = 0; pos < 8; pos++) {
      const rootMidi = pos < 6 ? 57 : 62; // A -> D after 6 steps
      played.push(midiName(arpNoteAt({ ...s, rootMidi }, pos)));
    }
    expect(played).toEqual(["A3", "E4", "A4", "C#5", "A3", "E4", "D5", "F#5"]);
    expect(arpNoteAt({ ...s, rootMidi: null }, 3)).toBeNull(); // no chord = rest
  });

  test("gate maps low = short, high = longer than a step (overlap)", () => {
    expect(gateToDuration(0, 0.25)).toBeCloseTo(0.025, 9);
    expect(gateToDuration(0, 0.1)).toBe(0.02); // floor
    expect(gateToDuration(0.5, 0.25)).toBeCloseTo(0.2625, 9);
    expect(gateToDuration(1, 0.25)).toBeCloseTo(0.5, 9);
    expect(gateToDuration(5, 0.25)).toBeCloseTo(0.5, 9);
  });
});

// ---- clock with a fake AudioContext: time only moves when the test says so ----
function fakeClock(opts) {
  const ac = { currentTime: 0 };
  const clock = createClock(ac, { startDelay: 0.05, ...opts });
  const steps = [];
  clock.onStep((i, time, info) => steps.push({ i, time, beat: info.beat, beats: info.stepBeats }));
  const advance = (to, dt = 0.025) => {
    while (ac.currentTime < to - 1e-12) {
      ac.currentTime = Math.min(to, ac.currentTime + dt);
      clock.tick();
    }
  };
  return { ac, clock, steps, advance };
}

test.describe("clock (fake time)", () => {
  test("steps are scheduled ahead on an exact grid; beatAt / nextBeatTime agree", () => {
    const { clock, steps, advance, ac } = fakeClock({ bpm: 120, rate: 1 / 8 });
    clock.start();
    advance(10);
    expect(steps[0]).toMatchObject({ i: 0, time: 0.05, beat: 0 });
    for (let k = 0; k < steps.length; k++) {
      expect(steps[k].i).toBe(k);
      expect(steps[k].time).toBeCloseTo(0.05 + k * 0.25, 12);
      expect(steps[k].time).toBeLessThanOrEqual(10 + clock.lookahead + 1e-9);
    }
    expect(steps.at(-1).time).toBeGreaterThan(10); // scheduled ahead of "now"
    expect(clock.beatAt(0.05 + 3.25 * 0.5)).toBeCloseTo(3.25, 9);
    ac.currentTime = 9.3;
    expect(clock.nextBeatTime()).toBeCloseTo(9.55, 9);
    clock.stop();
  });

  test("2-minute run: no drift, no missing/duplicate step", () => {
    const { clock, steps, advance } = fakeClock({ bpm: 133, rate: 1 / 16 });
    clock.start();
    advance(120, 0.031);
    const dur = (0.25 * 60) / 133;
    for (let k = 0; k < steps.length; k++) {
      expect(steps[k].i).toBe(k);
      expect(Math.abs(steps[k].time - (0.05 + k * dur))).toBeLessThan(1e-9);
    }
    expect(steps.length).toBe(Math.floor((120 + clock.lookahead - 0.05) / dur) + 1);
  });

  test("tempo change: no step lost or doubled, new tempo from the next unscheduled step", () => {
    const { clock, steps, advance } = fakeClock({ bpm: 120, rate: 1 / 8 });
    clock.start();
    advance(1.01);
    clock.bpm = 90;
    advance(4);
    for (let k = 1; k < steps.length; k++) {
      expect(steps[k].i).toBe(steps[k - 1].i + 1);
      expect(steps[k].beat).toBe(steps[k - 1].beat + 0.5);
      const d = steps[k].time - steps[k - 1].time;
      expect(Math.min(Math.abs(d - 0.25), Math.abs(d - 1 / 3))).toBeLessThan(1e-9);
    }
    expect(steps.filter((s) => s.time > 1.2).every((s, k, a) => k === 0 || Math.abs(s.time - a[k - 1].time - 1 / 3) < 1e-9)).toBe(true);
  });

  test("double time and rate changes start on the next whole beat", () => {
    const { clock, steps, advance } = fakeClock({ bpm: 120, rate: 1 / 8 });
    const changes = [];
    clock.onStepChange((i, time, info) => changes.push({ i, time, beats: info.stepBeats }));
    clock.start();
    advance(1.2); // beat ~2.3
    clock.doubleTime = true;
    expect(clock.doubleTime).toBe(true);
    advance(3);
    const firstFast = steps.find((s) => s.beats === 0.25);
    expect(firstFast.beat).toBe(3); // the next whole beat after the request (beat 2.3)
    expect(steps.filter((s) => s.beat < 3).every((s) => s.beats === 0.5)).toBe(true);

    // Request 20 ms before a beat whose step is already scheduled: that beat step is re-timed.
    advance(clock.timeAtBeat(8) - 0.02);
    clock.doubleTime = false;
    expect(changes.at(-1)).toMatchObject({ beats: 0.5 });
    expect(changes.at(-1).time).toBeCloseTo(clock.timeAtBeat(8), 9);
    advance(6);
    for (let k = 1; k < steps.length; k++) expect(steps[k].beat).toBe(steps[k - 1].beat + (steps[k - 1].beat >= 3 && steps[k - 1].beat < 8 ? 0.25 : 0.5));

    // Rate 1/4 requested off-beat waits for the beat.
    clock.rate = 1 / 4;
    advance(9);
    const firstQuarter = steps.find((s, k) => k > 0 && s.beat - steps[k - 1].beat === 1);
    expect(Number.isInteger(steps[steps.indexOf(firstQuarter) - 1].beat)).toBe(true);
    clock.stop();
  });

  test("stop / restart begins again at step 0; listeners unsubscribe", () => {
    const { clock, steps, advance } = fakeClock();
    let stopped = 0;
    clock.onStop(() => stopped++);
    const extra = [];
    const off = clock.onStep((i) => extra.push(i));
    clock.start();
    advance(1);
    clock.stop();
    expect(stopped).toBe(1);
    off();
    const n = steps.length;
    clock.start();
    advance(2);
    clock.stop();
    expect(steps[n].i).toBe(0);
    expect(extra.length).toBe(n);
    expect(clock.bpm).toBe(120);
    clock.bpm = 1000;
    expect(clock.bpm).toBe(240);
    clock.rate = 1 / 3; // ignored
    expect(clock.rate).toBe(1 / 8);
  });
});
