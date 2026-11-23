// Unit (Node): pure mobile layout math (src/ui/mobile/layout-metrics.js) + the safe-area edge-track x
// (src/ui/edge-tracks.js trackX). docs/mobile-ui.md.
import { test, expect } from "@playwright/test";
import {
  unionArea, coverage, overlapArea, zoneCoverage, handZones, offscreen, summarize, budgetFor, BUDGET, MOBILE_SIZES,
} from "../src/ui/mobile/layout-metrics.js";
import { trackX } from "../src/ui/edge-tracks.js";
import { edgeTrackX, clearArea } from "../src/ui/theme.js";

const R = (x, y, w, h) => ({ x, y, w, h });

test("unionArea counts overlaps once and clips to the viewport", () => {
  expect(unionArea([], 100, 100)).toBe(0);
  expect(unionArea([R(0, 0, 10, 10)], 100, 100)).toBe(100);
  expect(unionArea([R(0, 0, 10, 10), R(5, 5, 10, 10)], 100, 100)).toBe(175);
  expect(unionArea([R(0, 0, 10, 10), R(0, 0, 10, 10)], 100, 100)).toBe(100); // duplicates
  expect(unionArea([R(-5, -5, 10, 10)], 100, 100)).toBe(25); // clipped
  expect(unionArea([R(0, 0, 10, 10), R(2, 2, 3, 3)], 100, 100)).toBe(100); // contained
  expect(coverage([R(0, 0, 50, 100)], 100, 100)).toBe(0.5);
});

test("overlapArea / zoneCoverage / offscreen", () => {
  expect(overlapArea(R(0, 0, 10, 10), R(5, 5, 10, 10))).toBe(25);
  expect(overlapArea(R(0, 0, 10, 10), R(10, 0, 10, 10))).toBe(0); // touching edges don't overlap
  expect(zoneCoverage([R(0, 0, 10, 10), R(5, 0, 10, 10)], R(0, 0, 20, 10))).toBe(0.75);
  expect(offscreen(R(-3, 2, 10, 10), 100, 10)).toEqual({ left: 3, top: 0, right: 0, bottom: 2 });
});

test("handZones: chord hand left of center, expression hand right, both on screen", () => {
  for (const { width: W, height: H } of Object.values(MOBILE_SIZES)) {
    const z = handZones(W, H);
    expect(z.chord.x + z.chord.w / 2).toBeLessThan(W / 2);
    expect(z.expr.x + z.expr.w / 2).toBeGreaterThan(W / 2);
    for (const r of [z.chord, z.expr]) expect(Object.values(offscreen(r, W, H)).every((v) => v === 0)).toBe(true);
  }
});

test("summarize reports clear-area intruders and off-screen items", () => {
  const W = 390;
  const H = 844;
  const c = clearArea(W, H);
  const s = summarize(
    [
      { name: "a", rect: R(20, 10, 100, 34) },
      { name: "b", rect: R(c.x + 10, c.y + 10, 20, 20) },
      { name: "c", rect: R(380, 10, 30, 30), dom: false },
    ],
    W,
    H,
  );
  expect(s.inClear).toEqual(["b"]);
  expect(s.offscreen).toEqual(["c"]);
  expect(s.domCoverage).toBeLessThan(s.coverage);
});

test("budgets: phones under 360 px get the small row", () => {
  expect(budgetFor(390)).toBe(BUDGET);
  expect(budgetFor(320).playing).toBe(BUDGET.small.playing);
  expect(budgetFor(320).touch).toBe(44);
});

test("trackX: no inset = theme edgeTrackX; insets move each track inward", () => {
  const G = { W: 844, H: 390 };
  expect(trackX("left", G)).toBe(edgeTrackX("left", 844));
  expect(trackX("right", G)).toBe(edgeTrackX("right", 844));
  expect(trackX("left", { ...G, safe: { left: 47, right: 0 } })).toBe(edgeTrackX("left", 844) + 47);
  expect(trackX("right", { ...G, safe: { left: 47, right: 0 } })).toBe(edgeTrackX("right", 844));
  expect(trackX("right", { ...G, safe: { left: 0, right: 47 } })).toBe(edgeTrackX("right", 844) - 47);
});
