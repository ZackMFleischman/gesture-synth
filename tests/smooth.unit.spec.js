// Display smoothing (src/ui/smooth.js, One-Euro): still-hand jitter goes down, a fast step is followed quickly, gaps
// restart without a slide-in, vectors share one cutoff. Display only — the sound/control paths never read it.
import { test, expect } from "@playwright/test";
import { createOneEuro, createSmoothers, SMOOTH } from "../src/ui/smooth.js";

// Deterministic jitter (LCG), +-0.004 display units ~ landmark noise of a still hand at 30 fps.
function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
const std = (a) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
};
const FRAME = 1000 / 30;

test("still hand: jitter at least 3x lower than the raw input", () => {
  const f = createOneEuro();
  const rnd = lcg(7);
  const raw = [];
  const out = [];
  for (let i = 0; i < 300; i++) {
    const v = 0.5 + rnd() * 0.004;
    raw.push(v);
    out.push(f.filter(v, i * FRAME));
  }
  expect(std(out.slice(30)) * 3).toBeLessThan(std(raw.slice(30)));
});

test("fast step: reaches 90 % within ~120 ms; a still output never overshoots", () => {
  const f = createOneEuro();
  for (let i = 0; i < 30; i++) f.filter(0.2, i * FRAME);
  const t0 = 30 * FRAME;
  let reached = null;
  let max = 0;
  for (let i = 0; i < 30; i++) {
    const v = f.filter(0.6, t0 + i * FRAME);
    max = Math.max(max, v);
    if (reached === null && v >= 0.2 + 0.9 * 0.4) reached = i * FRAME;
  }
  expect(reached).not.toBeNull();
  expect(reached).toBeLessThanOrEqual(134); // spec ~120 ms (4 frames at 30 fps); measured: 90 % at 33 ms
  expect(max).toBeLessThanOrEqual(0.6);
});

test("gap > GAP_MS or null: restarts at the new value (no slide-in); same timestamp = same answer", () => {
  const f = createOneEuro();
  f.filter(0.1, 0);
  f.filter(0.1, FRAME);
  expect(f.filter(0.9, FRAME + SMOOTH.GAP_MS + 1)).toBe(0.9);
  const a = f.filter(0.5, FRAME + SMOOTH.GAP_MS + 40);
  expect(f.filter(0.7, FRAME + SMOOTH.GAP_MS + 40)).toBe(a);
  expect(f.filter(null, 1000)).toBe(null);
  expect(f.filter(0.3, 1010)).toBe(0.3);
});

test("vectors: one shared cutoff (a diagonal move keeps its direction); other keys pass through", () => {
  const f = createOneEuro();
  f.filter({ x: 0, y: 0, id: "a" }, 0);
  const p = f.filter({ x: 0.1, y: 0.1, id: "b" }, FRAME);
  expect(p.id).toBe("b");
  expect(p.x).toBeCloseTo(p.y, 12);
  expect(p.x).toBeGreaterThan(0);
  expect(p.x).toBeLessThan(0.1);
});

test("smoother bank: one filter per key with its preset; reset(key) restarts that key only", () => {
  const sm = createSmoothers();
  sm.get("a", 0, 0);
  sm.get("b", 0, 0, "filter");
  const a1 = sm.get("a", 1, FRAME);
  const b1 = sm.get("b", 1, FRAME, "filter");
  expect(a1).toBeGreaterThan(0);
  expect(a1).toBeLessThan(1);
  expect(b1).toBeLessThan(a1); // the filter preset has a lower beta (heavier smoothing at the same speed)
  sm.reset("a");
  expect(sm.get("a", 0.5, 2 * FRAME)).toBe(0.5);
  expect(sm.get("b", 1, 2 * FRAME, "filter")).not.toBe(1);
  expect(sm.has("a") && sm.has("b") && !sm.has("c")).toBe(true);
});
