// Milestone 1.6 pure logic (Node, no browser): the pinch -> tempo mapping (whole BPM steps, no jump at
// the start, hysteresis, clamping) and the shared `pinch` bus event from hand input.
// The app journey is tests/m1-pinch.spec.js.
import { test, expect } from "@playwright/test";
import { leftHand, rightHand, pinch, results } from "./helpers/hands.js";
import { pinchTempo, PINCH_TEMPO, VOICING_HOLD, voicingHoldMs, isPinchApproach } from "../src/modes/arp.js";
import { MIN_BPM, MAX_BPM } from "../src/services/clock.js";
import { createHandInput } from "../src/input/hand-input.js";
import { createBus } from "../src/core/bus.js";
import { matchToScheduleAnyOffset } from "./helpers/schedule-match.js";

test.describe("pinch tempo mapping (pure)", () => {
  test("no movement = exactly the start tempo; tracking jitter never changes it", () => {
    expect(pinchTempo(110, 0)).toBe(110);
    let b = 110;
    // ±0.05 hand sizes of jitter = ±0.65 BPM raw: below the half step + hysteresis.
    for (const d of [0.02, -0.03, 0.05, -0.05, 0.01, 0.04, -0.02]) {
      b = pinchTempo(110, d, b);
      expect(b).toBe(110);
    }
  });

  test("whole BPM steps, 1 BPM per 1/BPM_PER_HAND hand sizes; ±20 BPM = ~±1.5 hand sizes", () => {
    for (const k of [1, 6, 13, 20, -1, -9, -20]) expect(pinchTempo(110, k / PINCH_TEMPO.BPM_PER_HAND)).toBe(110 + k);
    expect(20 / PINCH_TEMPO.BPM_PER_HAND).toBeGreaterThan(1.2);
    expect(20 / PINCH_TEMPO.BPM_PER_HAND).toBeLessThan(1.8);
    // A slow sweep up then back down visits every integer once each way (no skipped or repeated values).
    let b = 110;
    const seen = [b];
    for (let i = 1; i <= 400; i++) {
      b = pinchTempo(110, (i / 400) * (10 / PINCH_TEMPO.BPM_PER_HAND), b);
      if (b !== seen.at(-1)) seen.push(b);
    }
    for (let i = 400; i >= 0; i--) {
      b = pinchTempo(110, (i / 400) * (10 / PINCH_TEMPO.BPM_PER_HAND), b);
      if (b !== seen.at(-1)) seen.push(b);
    }
    expect(seen).toEqual([110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 119, 118, 117, 116, 115, 114, 113, 112, 111, 110]);
  });

  test("hysteresis: hovering on a half-step boundary does not flicker", () => {
    let b = 110;
    const half = 0.5 / PINCH_TEMPO.BPM_PER_HAND;
    const vals = new Set();
    for (let i = 0; i < 50; i++) {
      b = pinchTempo(110, half + (i % 2 ? 0.01 : -0.01), b);
      vals.add(b);
    }
    expect([...vals]).toEqual([110]);
  });

  test("clamped to the clock's range", () => {
    expect(pinchTempo(235, 2)).toBe(MAX_BPM);
    expect(pinchTempo(45, -3)).toBe(MIN_BPM);
  });

  test("hand input emits `pinch` 1 at the start and 0 at the release / when the pinching hand is lost", () => {
    const b = createBus();
    const events = [];
    b.subscribe({ onEvent: (n, d) => events.push([n, d]) }, "pinch");
    const hi = createHandInput({ bus: b });
    let t = 0;
    const feed = (...hands) => hi.process(results(...hands), (t += 33));
    feed(leftHand(1), rightHand(2));
    feed(leftHand(1), pinch());
    feed(leftHand(1), pinch());
    expect(events).toEqual([["pinch", 1]]);
    feed(leftHand(1), rightHand(2));
    expect(events).toEqual([["pinch", 1], ["pinch", 0]]);
    feed(leftHand(1), pinch());
    feed(leftHand(1)); // right hand lost mid-pinch
    expect(events).toEqual([["pinch", 1], ["pinch", 0], ["pinch", 1], ["pinch", 0]]);
    // A left-hand (chord hand) pinch is not the mode hand's pinch.
    feed(pinch({ handedness: "Left" }), rightHand(1));
    expect(events.length).toBe(4);
  });
});

test("helper: matchToScheduleAnyOffset finds the capture offset across a tempo change even when it exceeds half a step", () => {
  // 110 BPM eighths, then 126 BPM eighths; the capture sees everything 0.18 s later than recStart says.
  const d110 = 30 / 110;
  const d126 = 30 / 126;
  const sched = [];
  let t = 1;
  for (let i = 0; i < 6; i++, t += d110) sched.push(t);
  for (let i = 0; i < 6; i++, t += d126) sched.push(t);
  const recStart = 0.9;
  const onsets = sched.slice(1, 11).map((s) => s - recStart + 0.18);
  const m = matchToScheduleAnyOffset(onsets, sched, recStart);
  expect(m.offset).toBeCloseTo(0.18, 9);
  expect(Math.max(...m.errors.map(Math.abs))).toBeLessThan(1e-9);
  expect(m.pairs.map((p) => p.sched)).toEqual(sched.slice(1, 11));
  // A note heard one old-tempo interval late (a real timing error) is not explained away.
  const late = onsets.slice();
  late[6] += d110 - d126;
  expect(Math.max(...matchToScheduleAnyOffset(late, sched, recStart).errors.map(Math.abs))).toBeGreaterThan(0.01);
});

test("voicing hold: 100 ms for a normal count change, 300 ms for a pinch forming", async () => {
  const { buildHandFrame } = await import("../src/input/hand-input.js");
  const frame = (h) => buildHandFrame(h.landmarks, h.handedness, {});
  expect(VOICING_HOLD.MS).toBe(100);
  // Deliberate 3 (index, middle, ring) and a 3 with the index curled but the thumb away: normal hold.
  expect(voicingHoldMs(frame(rightHand(3)))).toBe(100);
  expect(voicingHoldMs(frame(pinch({ distance: 1.2 })))).toBe(100);
  // Thumb closing on the curled index (not a pinch yet): the pinch lookback.
  const approach = frame(pinch({ distance: 0.5 }));
  expect(approach.pinch).toBe(false);
  expect(approach.voicingCount).toBe(3);
  expect(isPinchApproach(approach)).toBe(true);
  expect(voicingHoldMs(approach)).toBe(300);
});
