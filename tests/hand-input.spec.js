// Pure-logic tests for src/input/hand-input.js (run in Node, no browser).
import { test, expect } from "@playwright/test";
import {
  buildHandFrame,
  createHandInput,
  makeView,
  toDisplay,
  PINCH_START,
  PINCH_END,
} from "../src/input/hand-input.js";
import { createBus } from "../src/core/bus.js";
import { test as appTest } from "./fixtures.js";
import { hand, fist, pinch, leftHand, rightHand, results, DESKTOP_VIEW } from "./helpers/hands.js";

const frameOf = (h, opts) => buildHandFrame(h.landmarks, h.handedness, opts);

test.describe("HandFrame basics", () => {
  test("has every contract field", () => {
    const f = frameOf(rightHand(2), { t: 123 });
    for (const k of ["handedness", "landmarks", "fingers", "fingerCount", "voicingCount", "fist", "pinch",
      "pinchDistance", "height", "tilt", "pos", "handSize", "t"]) {
      expect(f, k).toHaveProperty(k);
    }
    expect(f.t).toBe(123);
    expect(f.handedness).toBe("Right");
    expect(Object.keys(f.fingers).sort()).toEqual(["index", "middle", "pinky", "ring", "thumb"]);
  });

  test("finger counts: fingerCount includes thumb, voicingCount does not", () => {
    const f = frameOf(leftHand(5));
    expect(f.fingerCount).toBe(5);
    expect(f.voicingCount).toBe(4);
    const r = frameOf(rightHand(3, { thumb: true }));
    expect(r.fingerCount).toBe(4);
    expect(r.voicingCount).toBe(3);
    expect(r.fingers.thumb).toBe(true);
  });

  test("height and tilt keep the existing semantics", () => {
    expect(frameOf(rightHand(1, { volume: 0.25 })).height).toBeCloseTo(0.25, 5);
    expect(frameOf(rightHand(1, { volume: 1 })).height).toBeCloseTo(1, 5);
    expect(frameOf(rightHand(1, { tilt: 0.5 })).tilt).toBeCloseTo(0.5, 5);
    expect(frameOf(leftHand(1, { tilt: -0.6 })).tilt).toBeCloseTo(-0.6, 5);
  });
});

test.describe("fist", () => {
  test("closed hand is a fist with the thumb in or out", () => {
    expect(frameOf(fist({ thumb: false })).fist).toBe(true);
    expect(frameOf(fist({ thumb: true })).fist).toBe(true);
    expect(frameOf(fist({ handedness: "Left", thumb: true })).fist).toBe(true);
    // the plain "closed" hand used by older tests also counts
    expect(frameOf(rightHand(0)).fist).toBe(true);
    expect(frameOf(rightHand(0, { thumb: true })).fist).toBe(true);
  });

  test("any extended finger (index..pinky) is not a fist", () => {
    for (const q of [1, 2, 3, 4]) expect(frameOf(rightHand(q)).fist, `quality ${q}`).toBe(false);
    expect(frameOf(hand({ handedness: "Right", fingers: ["pinky"] })).fist).toBe(false);
  });

  test("fist holds at any hand size and in the real desktop view", () => {
    for (const scale of [0.5, 1, 1.6]) {
      expect(frameOf(fist({ scale })).fist, `scale ${scale}`).toBe(true);
      expect(frameOf(fist({ scale }), { view: DESKTOP_VIEW }).fist, `desktop scale ${scale}`).toBe(true);
    }
  });

  test("a fist is never a pinch", () => {
    for (const thumb of [false, true]) {
      const f = frameOf(fist({ thumb }));
      expect(f.pinch).toBe(false);
      expect(frameOf(fist({ thumb }), { wasPinching: true }).pinch).toBe(false);
    }
  });
});

test.describe("pinch", () => {
  test("pinchDistance is thumb-index distance in hand sizes", () => {
    expect(frameOf(pinch({ distance: 0.1 })).pinchDistance).toBeCloseTo(0.1, 5);
    expect(frameOf(pinch({ distance: 0.6 })).pinchDistance).toBeCloseTo(0.6, 5);
    // independent of hand size
    expect(frameOf(pinch({ distance: 0.2, scale: 0.5 })).pinchDistance).toBeCloseTo(0.2, 5);
  });

  test("hysteresis: starts below PINCH_START, ends only above PINCH_END", () => {
    const between = (PINCH_START + PINCH_END) / 2;
    expect(frameOf(pinch({ distance: PINCH_START - 0.02 })).pinch).toBe(true);
    expect(frameOf(pinch({ distance: between })).pinch).toBe(false); // not yet pinching
    expect(frameOf(pinch({ distance: between }), { wasPinching: true }).pinch).toBe(true); // stays on
    expect(frameOf(pinch({ distance: PINCH_END + 0.02 }), { wasPinching: true }).pinch).toBe(false);
  });

  test("hysteresis is tracked per hand across frames by createHandInput", () => {
    const input = createHandInput({ bus: createBus() });
    const between = (PINCH_START + PINCH_END) / 2;
    const seq = [0.8, between, 0.1, between, between, PINCH_END + 0.05, between];
    const want = [false, false, true, true, true, false, false];
    seq.forEach((d, i) => {
      const { right } = input.process(results(leftHand(1), pinch({ distance: d })), i);
      expect(right.pinch, `step ${i} d=${d}`).toBe(want[i]);
    });
    // losing the hand resets the state
    input.process(results(pinch({ distance: 0.1 })), 10);
    input.process(results(), 11);
    expect(input.process(results(pinch({ distance: between })), 12).right.pinch).toBe(false);
  });

  test("requires the middle finger extended", () => {
    expect(frameOf(pinch({ fingers: ["ring", "pinky"] })).pinch).toBe(false);
    expect(frameOf(pinch({ fingers: ["middle"] })).pinch).toBe(true);
    // pinch from each finger count that includes the middle finger
    for (const q of [2, 3, 4]) expect(frameOf(rightHand(q, { pinch: 0.1 })).pinch, `quality ${q}`).toBe(true);
  });

  test("open hand is not a pinch", () => {
    for (const q of [0, 1, 2, 3, 4]) expect(frameOf(rightHand(q)).pinch, `quality ${q}`).toBe(false);
  });
});

test.describe("pos and handSize", () => {
  test("pos is mirrored into display space", () => {
    const r = frameOf(rightHand(1)); // right hand sits at image x ~0.7
    expect(r.pos.x).toBeLessThan(0.5);
    const l = frameOf(leftHand(1)); // left hand at image x ~0.3
    expect(l.pos.x).toBeGreaterThan(0.5);
    expect(toDisplay({ x: 0.2, y: 0.3 })).toEqual({ x: 0.8, y: 0.3 });
  });

  test("pos option of the helper lands where asked (identity and desktop views)", () => {
    const f = frameOf(fist({ pos: { x: 0.25, y: 0.6 } }));
    expect(f.pos.x).toBeCloseTo(0.25, 6);
    expect(f.pos.y).toBeCloseTo(0.6, 6);
    const d = frameOf(fist({ pos: { x: 0.7, y: 0.4 }, view: DESKTOP_VIEW }), { view: DESKTOP_VIEW });
    expect(d.pos.x).toBeCloseTo(0.7, 6);
    expect(d.pos.y).toBeCloseTo(0.4, 6);
  });

  test("pos accounts for the cover crop like drawFrame", () => {
    // 640x480 video on a 1280x800 canvas: full width shown, 40px cropped top and bottom.
    const v = makeView(640, 480, 1280, 800);
    expect(toDisplay({ x: 0, y: 40 / 480 }, v)).toEqual({ x: 1, y: 0 });
    expect(toDisplay({ x: 1, y: 440 / 480 }, v)).toEqual({ x: 0, y: 1 });
    // portrait phone: height fits, sides cropped
    const p = makeView(640, 480, 390, 844);
    const sWidth = 480 * (390 / 844);
    const sx = (640 - sWidth) / 2;
    expect(toDisplay({ x: sx / 640, y: 0 }, p).x).toBeCloseTo(1, 9);
    expect(toDisplay({ x: (sx + sWidth) / 640, y: 1 }, p).x).toBeCloseTo(0, 9);
  });

  test("handSize scales with the hand and ignores position", () => {
    const base = frameOf(rightHand(1)).handSize;
    expect(base).toBeGreaterThan(0.1);
    expect(frameOf(rightHand(1, { scale: 2 })).handSize).toBeCloseTo(base * 2, 6);
    expect(frameOf(rightHand(1, { scale: 0.5 })).handSize).toBeCloseTo(base * 0.5, 6);
    expect(frameOf(rightHand(1, { pos: { x: 0.2, y: 0.2 } })).handSize).toBeCloseTo(base, 6);
  });
});

test("createHandInput publishes hand values on the bus", () => {
  const bus = createBus();
  const seen = {};
  bus.subscribe({ onSet: (n, v) => (seen[n] = v) }, ["left/*", "right/*"]);
  const input = createHandInput({ bus });
  input.process(results(leftHand(1), rightHand(1, { volume: 0.25, tilt: 0.5 })), 0);
  expect(seen["right/height"]).toBeCloseTo(0.25, 5);
  expect(seen["right/tilt"]).toBeCloseTo(0.5, 5);
  expect(seen["left/pos"].x).toBeGreaterThan(0.5);
  expect(seen["right/fist"]).toBe(false);
  input.process(results(leftHand(1)), 1);
  expect(seen["right/height"]).toBeNull();
});

appTest("app view + ctx.toCanvas match drawFrame's mirrored cover crop", async ({ synthPage: page, setHands }) => {
  await setHands(fist({ pos: { x: 0.25, y: 0.6 }, view: DESKTOP_VIEW }));
  await expect.poll(() => page.evaluate(() => window.__gsTest.bus.get("right/fist"))).toBe(true);
  const r = await page.evaluate(() => {
    const { handInput, ctx, results } = window.__gsTest;
    const v = handInput.view;
    // where drawFrame draws the wrist dot (mirrored context => screen x = W - canvasX)
    const c = document.getElementById("overlay");
    const p = results.landmarks[0][0];
    const canvasX = ((p.x * v.srcW - v.sx) / v.sWidth) * c.width;
    const canvasY = ((p.y * v.srcH - v.sy) / v.sHeight) * c.height;
    const { right } = handInput.process(results, 0);
    const wrist = { x: 1 - (p.x * v.srcW - v.sx) / v.sWidth, y: (p.y * v.srcH - v.sy) / v.sHeight };
    return { view: [v.srcW, v.srcH, v.dstW, v.dstH], dot: { x: c.width - canvasX, y: canvasY },
      mapped: ctx.toCanvas(wrist), pos: right.pos, palm: ctx.toCanvas(right.pos) };
  });
  expect(r.view).toEqual([640, 480, 1280, 800]); // = DESKTOP_VIEW
  expect(r.mapped.x).toBeCloseTo(r.dot.x, 6);
  expect(r.mapped.y).toBeCloseTo(r.dot.y, 6);
  expect(r.pos.x).toBeCloseTo(0.25, 6);
  expect(r.pos.y).toBeCloseTo(0.6, 6);
  expect(r.palm.x).toBeCloseTo(320, 3);
  expect(r.palm.y).toBeCloseTo(480, 3);
});
