// Helpers for tests/m2-lead.spec.js: Lead mode in the real app (?mockHands). Browser-only (uses pages).
import { expect } from "@playwright/test";
import { AUDIO_TAP_SCRIPT, captureHealth } from "./audio.js";
import { results, leftHand, rightHand, fist, pinch } from "./hands.js";
import { makeView } from "../../src/input/hand-input.js";

export const SCREENS = "test-results/screens";

/**
 * Hand scene for a viewport. Default = real use: the chord ("Left") hand on the screen LEFT (selfie view, verified
 * with a real camera), so the expression hand and the ladder are on the RIGHT edge. `swap` mirrors it (the unusual
 * case: chord hand on the screen right, e.g. crossed hands).
 */
export function scene({ width = 1280, height = 800 } = {}, { swap = false } = {}) {
  const view = makeView(640, 480, width, height);
  const L = swap ? { x: 0.72, y: 0.5 } : { x: 0.28, y: 0.5 };
  const R = swap ? { x: 0.3, y: 0.42 } : { x: 0.7, y: 0.42 };
  const at = (p) => ({ pos: p, view });
  return {
    view,
    L,
    R,
    exprSide: swap ? "left" : "right",
    chordSide: swap ? "right" : "left",
    /** Chord hand: degree 1..7 at the scene position (left height 0.5 = master 2/3 unless `volume`). */
    left: (deg = 1, o = {}) => leftHand(deg, { ...at({ x: L.x, y: o.y ?? L.y }), ...o }),
    /** Open right hand with `count` fingers at height y (display). */
    open: (count = 4, y = R.y, o = {}) => rightHand(count, { ...at({ x: o.x ?? R.x, y }), ...o }),
    /** Pre-pinch "claw" (all fingers out, thumb near the index tip): preview, never a finger count. */
    preview: (y = R.y, o = {}) => pinch({ ...at({ x: o.x ?? R.x, y }), distance: 0.55, fingers: ["index", "middle", "ring", "pinky"], ...o }),
    /** Pinch = play. */
    play: (y = R.y, o = {}) => pinch({ ...at({ x: o.x ?? R.x, y }), fingers: ["index", "middle", "ring", "pinky"], ...o }),
    fistAt: (p = R, o = {}) => fist({ ...at(p), ...o }),
  };
}

export async function setHands(page, ...hands) {
  await page.evaluate((r) => (window.__gsTest.results = r), results(...hands.filter(Boolean)));
}

/** Opens the app like the `synthPage` fixture (audio tap, start overlay dismissed, loop running). */
export async function openApp(context, { viewport } = {}) {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await page.addInitScript(AUDIO_TAP_SCRIPT);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto("/?mockHands");
  await page.locator("#startOverlay").click();
  await expect(page.locator("#startOverlay")).toBeHidden();
  await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0);
  page.__errors = errors;
  return page;
}

export const bus = (page, name) => page.evaluate((n) => window.__gsTest.bus.get(n), name);
/** The mode the right hand drives: "lead" while the Lead layer is on (bus `mode` stays the base then), else `mode`. */
export const modeId = (page) => page.evaluate(() => window.__gsTest.bus.get("layer") || window.__gsTest.bus.get("mode"));
export const dbg = (page, at) =>
  page.evaluate((at) => window.__gsTest.registry.getMode("lead")._debug(at ?? window.__gsTest.ctx.now), at);
export const ladder = (page) =>
  page.evaluate(() => window.__gsTest.registry.getMode("lead")._controller.state.ladder.notes.map((n) => n.midi));
export const yFor = (page, midi) => page.evaluate((m) => window.__gsTest.registry.getMode("lead")._yForMidi(m), midi);

/** Waits n animation frames. */
export async function frames(page, n = 3) {
  await page.evaluate((n) => new Promise((res) => {
    let i = 0;
    const step = () => (++i >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  }), n);
}

const STEP = { right: [0.014, 0], left: [-0.014, 0], up: [0, -0.022], down: [0, 0.022] };

/**
 * Fist at `from` -> menu opens -> move toward `dir` (steps of the m1-integration flow) until `expectId` is
 * selected (null = stay in the centre zone). Returns the final fist point.
 */
export async function fistSelect(page, { left, from, fistAt, dir = "left", steps = 10, expectId }) {
  await setHands(page, left, fistAt(from));
  await expect.poll(async () => (await bus(page, "menu"))?.state, { timeout: 2000 }).toBe("open");
  let p = from;
  for (let i = 1; i <= steps; i++) {
    p = { x: from.x + STEP[dir][0] * i, y: from.y + STEP[dir][1] * i };
    await setHands(page, left, fistAt(p));
    await page.waitForTimeout(35);
  }
  await expect.poll(async () => (await bus(page, "menu"))?.selectedId ?? null, { timeout: 2000 }).toBe(expectId ?? null);
  return p;
}

/** Whole gesture switch (fist, move, open hand); resolves after the countdown. `open(p)` = the opening hand. */
export async function switchMode(page, { left, from, fistAt, open, dir, expectId, onSelected }) {
  const p = await fistSelect(page, { left, from, fistAt, dir, expectId });
  if (onSelected) await onSelected(p);
  await setHands(page, left, open(p));
  await expect.poll(() => modeId(page), { timeout: 1000 }).toBe(expectId);
  await expect.poll(async () => (await bus(page, "menu")) ?? null, { timeout: 2000 }).toBe(null);
  return p;
}

/** Starts a long recording; `stop()` resolves with { samples, sampleRate, health }. */
export async function startRec(page) {
  await page.evaluate(() => {
    window.__audioCap.chunks = [];
    window.__audioCap.blocks = [];
    window.__audioCap.recording = true;
  });
  return async () => {
    const { chunks, blocks, sampleRate } = await page.evaluate(() => {
      window.__audioCap.recording = false;
      return { chunks: window.__audioCap.chunks, blocks: window.__audioCap.blocks, sampleRate: window.__audioCap.sampleRate };
    });
    return { samples: Float32Array.from(chunks.flat()), sampleRate, health: captureHealth(blocks, sampleRate) };
  };
}

/** Longest run (s) below `thresh` inside [t0, t1] s (same metric as tests/m1-integration.spec.js). */
export function longestSilence(samples, sr, t0 = 0, t1 = samples.length / sr, thresh = 0.003) {
  let best = 0, run = 0;
  for (let i = Math.max(0, Math.round(t0 * sr)); i < Math.min(samples.length, Math.round(t1 * sr)); i++) {
    if (Math.abs(samples[i]) < thresh) best = Math.max(best, ++run);
    else run = 0;
  }
  return best / sr;
}

/**
 * Max |second difference| (discontinuity metric of tests/m1-integration.spec.js). Render-quantum joins are
 * skipped: the capture tap can drop a whole quantum under load, which spikes exactly there.
 */
export function maxD2(samples) {
  let m = 0;
  for (let i = 2; i < samples.length; i++) {
    if (i % 128 < 2) continue;
    m = Math.max(m, Math.abs(samples[i] - 2 * samples[i - 1] + samples[i - 2]));
  }
  return m;
}

export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
