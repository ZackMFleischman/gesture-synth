// Gesture reliability (M0 0.3): synthetic but adversarial sequences through createHandInput.
// Noise is seeded Gaussian jitter on every landmark (x, y), in normalized image units unless noted
// (0.004 ~ 2.5 px on a 640 px camera; MediaPipe on a still hand is typically ~1 px).
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import {
  buildHandFrame, createHandInput, PINCH_START, PINCH_END, getThresholds, setThresholds, DEFAULT_THRESHOLDS,
} from "../src/input/hand-input.js";
import { createBus } from "../src/core/bus.js";
import { test as appTest, SCREENS_DIR } from "./fixtures.js";
import { hand, fist, pinch, leftHand, rightHand, results } from "./helpers/hands.js";
import { SAMPLE_RECORDING, replayUrl, replayThrough, loadRecordingFile } from "./helpers/replay.js";

// ---------------------------------------------------------------- noise + pose tools

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  return () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}
const clone = (h) => ({ handedness: h.handedness, landmarks: h.landmarks.map((p) => ({ ...p })) });

function jitter(h, sigma, g) {
  const c = clone(h);
  for (const p of c.landmarks) { p.x += g() * sigma; p.y += g() * sigma; }
  return c;
}
/** Linear blend of two poses' landmarks (0 = a, 1 = b). */
function lerpPose(a, b, k) {
  return {
    handedness: a.handedness,
    landmarks: a.landmarks.map((p, i) => ({
      x: p.x + (b.landmarks[i].x - p.x) * k,
      y: p.y + (b.landmarks[i].y - p.y) * k,
      z: 0,
    })),
  };
}
/** Rotate the whole hand in the image plane about the wrist (degrees, square identity view). */
function rotate(h, deg) {
  const c = clone(h);
  const w = c.landmarks[0];
  const [s, co] = [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];
  const [wx, wy] = [w.x, w.y];
  for (const p of c.landmarks) {
    const dx = p.x - wx, dy = p.y - wy;
    p.x = wx + dx * co - dy * s;
    p.y = wy + dx * s + dy * co;
  }
  return c;
}

const DT = 33; // ~30 fps

/**
 * One pinch trial from `pose` (a right-hand shape): hold, 200 ms approach, hold pinch,
 * 200 ms release, hold. Returns per-frame { phase, frame }.
 */
function pinchTrial(pose, { seed, sigma = 0.004, scale = 1, deg = 0, tilt = 0 }) {
  const g = gaussian(mulberry32(seed));
  const r = mulberry32(seed ^ 0x9e3779b9);
  const pinchPose = pinch({ distance: 0.06 + r() * 0.12, volume: 0.8, scale, tilt });
  const phases = [["hold", 600, () => pose], ["approach", 200, (k) => lerpPose(pose, pinchPose, k)],
    ["pinched", 500, () => pinchPose], ["release", 200, (k) => lerpPose(pinchPose, pose, k)], ["after", 500, () => pose]];
  const input = createHandInput({ bus: createBus() });
  const out = [];
  let t = 1000 + Math.floor(r() * 1000);
  for (const [phase, ms, at] of phases) {
    for (let e = 0; e < ms; e += DT, t += DT) {
      let h = jitter(at(e / ms), sigma, g);
      if (deg) h = rotate(h, deg);
      out.push({ phase, t, frame: input.process(results(h), t).right });
    }
  }
  return out;
}

/** Checks one trial; returns null if correct, else a short reason. */
function judgeTrial(trial, { voicing } = {}) {
  const edges = [];
  for (let i = 1; i < trial.length; i++) {
    if (trial[i].frame.pinch !== trial[i - 1].frame.pinch) edges.push({ i, on: trial[i].frame.pinch });
  }
  if (trial[0].frame.pinch) return "pinched at start";
  if (edges.length !== 2) return `${edges.length} pinch edges`;
  const [on, off] = edges;
  if (!on.on || off.on) return "edge order";
  if (!["approach", "pinched"].includes(trial[on.i].phase)) return `started in ${trial[on.i].phase}`;
  if (!["release", "after"].includes(trial[off.i].phase)) return `ended in ${trial[off.i].phase}`;
  if (trial.some((s) => s.phase === "pinched" && !s.frame.pinch)) return "dropped during hold";
  if (trial.some((s) => s.frame.pinch && s.frame.fist)) return "pinch and fist together";
  if (voicing !== undefined && trial[on.i].frame.voicingBeforePinch !== voicing) {
    return `restored voicing ${trial[on.i].frame.voicingBeforePinch}, want ${voicing}`;
  }
  return null;
}

const TRIALS = 20;

// ---------------------------------------------------------------- pinch from every finger count

test.describe("pinch starts and ends 20/20 from every right-hand finger count", () => {
  for (const q of [0, 1, 2, 3, 4]) {
    for (const thumb of [false, true]) {
      test(`voicing ${q}, thumb ${thumb ? "out" : "in"}`, () => {
        const fails = [];
        for (let k = 0; k < TRIALS; k++) {
          const trial = pinchTrial(rightHand(q, { thumb }), { seed: 1000 * q + (thumb ? 500 : 0) + k });
          const why = judgeTrial(trial, { voicing: q });
          if (why) fails.push(`#${k}: ${why}`);
        }
        expect(fails, `${TRIALS - fails.length}/${TRIALS} correct`).toEqual([]);
      });
    }
  }

  test("near / far camera (scale 0.5-2, jitter in hand sizes)", () => {
    const fails = [];
    for (const scale of [0.5, 0.75, 1.5, 2]) {
      for (let k = 0; k < TRIALS; k++) {
        const q = k % 5;
        // jitter 0.03 hand sizes (= 0.0045 at scale 1): pixel noise grows relative to a far hand
        const trial = pinchTrial(rightHand(q, { scale, thumb: k % 2 === 1 }), { seed: 7000 + k, scale, sigma: 0.0045 * scale });
        const why = judgeTrial(trial, { voicing: q });
        if (why) fails.push(`scale ${scale} #${k}: ${why}`);
      }
    }
    expect(fails).toEqual([]);
  });

  test("rotated (±25°) and tilted (±1) hands", () => {
    const fails = [];
    for (const deg of [-25, -12, 12, 25]) {
      for (const tilt of [-1, 0, 1]) {
        for (let k = 0; k < 5; k++) {
          const q = (k % 4) + 1;
          const trial = pinchTrial(rightHand(q, { tilt }), { seed: 9000 + k + deg * 10 + tilt * 3, deg, tilt });
          const why = judgeTrial(trial, { voicing: q });
          if (why) fails.push(`deg ${deg} tilt ${tilt} #${k}: ${why}`);
        }
      }
    }
    expect(fails).toEqual([]);
  });
});

// ---------------------------------------------------------------- fist is never a pinch

test.describe("a fist is never a pinch", () => {
  test("thumb in / out / borderline / on the index tip, jitter, scale, rotation: 0 pinch frames", () => {
    let frames = 0;
    const bad = [];
    for (const thumbMode of ["in", "out", "borderline", "onIndex"]) {
      for (const scale of [0.5, 1, 2]) {
        for (const deg of [-20, 0, 20]) {
          const g = gaussian(mulberry32(frames + 1));
          const input = createHandInput({ bus: createBus() });
          for (let i = 0; i < 60; i++) {
            const h = fist({ thumb: thumbMode === "out", scale });
            if (thumbMode === "borderline") h.landmarks[4].x = h.landmarks[3].x;
            if (thumbMode === "onIndex") h.landmarks[4] = { ...h.landmarks[8] }; // pinchDistance ~0
            let j = jitter(h, 0.005 * scale, g);
            if (deg) j = rotate(j, deg);
            const f = input.process(results(j), i * DT).right;
            frames++;
            if (f.pinch) bad.push(`pinch: ${thumbMode} s${scale} ${deg}° #${i}`);
            if (!f.fist) bad.push(`not fist: ${thumbMode} s${scale} ${deg}° #${i}`);
          }
        }
      }
    }
    expect(frames).toBe(4 * 3 * 3 * 60);
    expect(bad).toEqual([]);
  });

  test("fist state does not depend on the thumb (thumb flapping in a fist)", () => {
    const input = createHandInput({ bus: createBus() });
    for (let i = 0; i < 40; i++) {
      const f = input.process(results(fist({ thumb: i % 2 === 0 })), i * DT).right;
      expect(f.fist).toBe(true);
      expect(f.pinch).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- hysteresis / flicker

test.describe("no flicker in the threshold band", () => {
  const countEdges = (arr) => arr.reduce((n, v, i) => n + (i && v !== arr[i - 1] ? 1 : 0), 0);

  // σ = 0.002 per coordinate -> pinchDistance noise σ ≈ 0.02 hand sizes; the band is 0.15 wide.
  const hover = (center, { seed, startPinched = false, drift = 0 }) => {
    const g = gaussian(mulberry32(seed));
    const input = createHandInput({ bus: createBus() });
    if (startPinched) input.process(results(pinch({ distance: 0.05 })), -DT);
    const states = [];
    for (let i = 0; i < 300; i++) { // 10 s
      const d = center + drift * Math.sin(i / 7);
      states.push(input.process(results(jitter(pinch({ distance: d }), 0.002, g)), i * DT).right.pinch);
    }
    return states;
  };

  test("open hand hovering in the middle of the band never pinches", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const s = hover((PINCH_START + PINCH_END) / 2, { seed, drift: 0.01 });
      expect(countEdges(s), `seed ${seed}`).toBe(0);
      expect(s[0]).toBe(false);
    }
  });

  test("hovering right at PINCH_START: starts once, never flickers back", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const s = [false, ...hover(PINCH_START, { seed })]; // was open before
      expect(countEdges(s), `seed ${seed}`).toBe(1);
      expect(s.at(-1)).toBe(true);
    }
  });

  test("pinched hand hovering right at PINCH_END: ends once, never flickers back", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const s = [true, ...hover(PINCH_END, { seed, startPinched: true })]; // was pinched before
      expect(countEdges(s), `seed ${seed}`).toBe(1);
    }
  });

  test("slow close-open sweep through the band: exactly one start and one end", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const g = gaussian(mulberry32(seed));
      const input = createHandInput({ bus: createBus() });
      const states = [];
      for (let i = 0; i <= 200; i++) {
        const d = 0.1 + 0.7 * Math.abs(1 - i / 100); // 0.8 -> 0.1 -> 0.8 over ~6.6 s
        states.push(input.process(results(jitter(pinch({ distance: d }), 0.004, g)), i * DT).right.pinch);
      }
      expect(countEdges(states), `seed ${seed}`).toBe(2);
    }
  });

  test("thumb hysteresis: borderline thumb in a fist barely flickers (plain compare flickers a lot)", () => {
    for (const [sigma, maxPerSec] of [[0.003, 0], [0.004, 1]]) {
      const g = gaussian(mulberry32(7));
      const input = createHandInput({ bus: createBus() });
      const hyst = [], plain = [];
      for (let i = 0; i < 300; i++) { // 10 s
        const h = fist();
        h.landmarks[4].x = h.landmarks[3].x;
        const j = jitter(h, sigma, g);
        hyst.push(input.process(results(j), i * DT).right.fingers.thumb);
        plain.push(buildHandFrame(j.landmarks, "Right").fingers.thumb);
      }
      expect(countEdges(plain), `plain σ=${sigma}`).toBeGreaterThan(100);
      expect(countEdges(hyst) / 10, `hysteresis σ=${sigma} flips/s`).toBeLessThanOrEqual(maxPerSec);
    }
  });

  test("thumb still switches cleanly when really moved", () => {
    const input = createHandInput({ bus: createBus() });
    const seq = [false, false, true, true, false, true];
    seq.forEach((thumb, i) => {
      expect(input.process(results(rightHand(2, { thumb })), i * DT).right.fingers.thumb, `step ${i}`).toBe(thumb);
    });
  });
});

// ---------------------------------------------------------------- voicing restore

test.describe("pinch start restores the voicing from ~0.3 s before", () => {
  test("finger count drops during the approach; voicingBeforePinch is the earlier count", () => {
    for (const q of [1, 2, 3, 4]) {
      const input = createHandInput({ bus: createBus() });
      let t = 0;
      const step = (h) => input.process(results(h), (t += DT)).right;
      for (let i = 0; i < 20; i++) step(rightHand(q)); // hold voicing q
      for (let i = 0; i < 4; i++) step(rightHand(Math.max(q - 1, 0))); // index starts to curl (~130 ms)
      const f = step(pinch({ distance: 0.1 }));
      expect(f.pinch).toBe(true);
      expect(f.voicingCount).toBe(3); // the "OK" shape reads 3 fingers...
      expect(f.voicingBeforePinch, `from voicing ${q}`).toBe(q); // ...but the restore is q
      // latched for the whole pinch
      for (let i = 0; i < 10; i++) expect(step(pinch({ distance: 0.2 })).voicingBeforePinch).toBe(q);
      // null when released
      expect(step(rightHand(q)).voicingBeforePinch).toBeNull();
    }
  });

  test("quick re-pinch still restores the pre-pinch voicing", () => {
    const input = createHandInput({ bus: createBus() });
    let t = 0;
    const step = (h) => input.process(results(h), (t += DT)).right;
    for (let i = 0; i < 20; i++) step(rightHand(4));
    for (let i = 0; i < 10; i++) step(pinch({ distance: 0.1 }));
    for (let i = 0; i < 3; i++) step(pinch({ distance: 0.7 })); // released ~100 ms
    const f = step(pinch({ distance: 0.1 }));
    expect(f.pinch).toBe(true);
    expect(f.voicingBeforePinch).toBe(4);
  });

  test("lookback uses timestamps, not frame counts (15 fps vs 60 fps)", () => {
    for (const dt of [1000 / 15, 1000 / 60]) {
      const input = createHandInput({ bus: createBus() });
      let t = 0;
      const step = (h) => input.process(results(h), (t += dt)).right;
      for (let ms = 0; ms < 800; ms += dt) step(rightHand(2));
      for (let ms = 0; ms < 200; ms += dt) step(rightHand(1)); // last 200 ms before the pinch
      expect(step(pinch({ distance: 0.1 })).voicingBeforePinch, `dt ${dt}`).toBe(2);
    }
  });

  test("single frame (no history): voicingBeforePinch falls back to voicingCount", () => {
    const f = buildHandFrame(pinch().landmarks, "Right");
    expect(f.voicingBeforePinch).toBe(f.voicingCount);
    expect(buildHandFrame(rightHand(2).landmarks, "Right").voicingBeforePinch).toBeNull();
  });
});

// ---------------------------------------------------------------- runtime thresholds

test.describe.serial("runtime thresholds", () => {
  test.afterEach(() => setThresholds(DEFAULT_THRESHOLDS));

  test("setThresholds live-edits the classifier; defaults unchanged", () => {
    expect(DEFAULT_THRESHOLDS).toMatchObject({ PINCH_START: 0.3, PINCH_END: 0.45, FIST_TIP_RATIO: 1.5 });
    const h = pinch({ distance: 0.4 });
    expect(buildHandFrame(h.landmarks, "Right").pinch).toBe(false);
    setThresholds({ PINCH_START: 0.5, PINCH_END: 0.6 });
    expect(getThresholds().PINCH_START).toBe(0.5);
    expect(buildHandFrame(h.landmarks, "Right").pinch).toBe(true);
    setThresholds({ PINCH_END: 0.1 }); // end is clamped to >= start
    expect(getThresholds().PINCH_END).toBe(0.5);
    setThresholds({ FIST_TIP_RATIO: 0.5 });
    expect(buildHandFrame(fist().landmarks, "Right").fist).toBe(false);
  });
});

// ---------------------------------------------------------------- record / replay

test.describe("record / replay", () => {
  test("sample recording replays through createHandInput (Node)", () => {
    const frames = replayThrough(loadRecordingFile(SAMPLE_RECORDING));
    const pinched = frames.filter((f) => f.right && f.right.pinch);
    expect(frames.length).toBeGreaterThan(70);
    expect(pinched.length).toBeGreaterThan(15);
    expect(pinched.every((f) => f.right.voicingBeforePinch === 2)).toBe(true);
    expect(frames.every((f) => f.left && f.left.fingerCount === 1)).toBe(true);
  });

  appTest("?replay drives the app: chord appears", async ({ page }) => {
    await page.goto(replayUrl(SAMPLE_RECORDING));
    await page.locator("#startOverlay").click();
    await expect(page.locator("#chordDisplay")).toHaveText("A(I)");
    await expect(page.locator("#qualityDisplay")).toHaveText("Major 1st Inv");
    await expect.poll(() => page.evaluate(() => window.__gsTest.bus.get("right/pinch")), { timeout: 5000 }).toBe(true);
    // after the recording ends the hands are gone
    await expect(page.locator("#chordDisplay")).toHaveText("--", { timeout: 8000 });
  });

  appTest("?replay drives the gesture test page", async ({ page }) => {
    await page.goto(replayUrl(SAMPLE_RECORDING, "/labs/gesture-test.html", { loop: true }));
    await expect(page.locator("#source")).toContainText("replay");
    await expect(page.locator('[data-testid="Right-pinch-state"]')).toHaveText("PINCH", { timeout: 6000 });
  });

  appTest("Record button saves a replayable recording", async ({ page }) => {
    await page.goto("/labs/gesture-test.html?mockHands");
    await page.evaluate((r) => (window.__gsTest.results = r), results(leftHand(3), rightHand(2)));
    await page.locator("#recSecs").fill("1");
    const download = page.waitForEvent("download");
    await page.locator("#recBtn").click();
    const file = await (await download).path();
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(rec.format).toBe("gesture-synth-recording");
    expect(rec.frames.length).toBeGreaterThan(10);
    const frames = replayThrough(rec);
    expect(frames.at(-1).left.fingerCount).toBe(3);
    expect(frames.at(-1).right.voicingCount).toBe(2);
  });
});

// ---------------------------------------------------------------- the test page itself

appTest("gesture test page shows live values (mockHands) — screenshot", async ({ page }) => {
  await page.goto("/labs/gesture-test.html?mockHands");
  await expect(page.locator("#source")).toContainText("mockHands");
  const set = (...hands) => page.evaluate((r) => (window.__gsTest.results = r), results(...hands));

  // a voicing first, then a pinch (so "restore" and "Last event" have something to show)
  await set(leftHand(5, { tilt: 0.4 }), rightHand(4, { volume: 0.7, tilt: -0.3 }));
  await expect(page.locator("#hand-Right .dot.on")).toHaveCount(4);
  await expect(page.locator("#hand-Left .dot.on")).toHaveCount(5);
  await page.waitForTimeout(400);
  await set(leftHand(5, { tilt: 0.4 }), pinch({ distance: 0.18, volume: 0.7, tilt: -0.3 }));
  await expect(page.locator('[data-testid="Right-pinch-state"]')).toHaveText("PINCH");
  await expect(page.locator("#hand-Right")).toContainText("voi 4"); // restored voicing
  await expect(page.locator("#hand-Right")).toContainText("Last event: pinch start");

  // sliders live-edit hand-input thresholds; copy readout follows
  await page.locator("#thr-PINCH_START").fill("0.12");
  await expect(page.locator("#copyOut")).toHaveValue(/PINCH_START = 0\.12/);
  expect(await page.evaluate(() => window.__gsTest.getThresholds().PINCH_START)).toBe(0.12);
  await page.locator("#thr-PINCH_START").fill("0.3");

  await page.waitForTimeout(300);
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  await page.screenshot({ path: `${SCREENS_DIR}/gesture-test.png` });

  // fist: never a pinch, shown as FIST
  await set(leftHand(1), fist({ thumb: true }));
  await expect(page.locator("#hand-Right")).toContainText("FIST");
  await expect(page.locator('[data-testid="Right-pinch-state"]')).not.toHaveText("PINCH");
});
