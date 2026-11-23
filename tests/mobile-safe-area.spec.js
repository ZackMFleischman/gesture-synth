// Unit (Node): edge tracks move in by the safe-area inset on their side (docs/mobile-ui.md §6).
import { test, expect } from "@playwright/test";
import { trackX } from "../src/ui/edge-tracks.js";
import { edgeTrackX } from "../src/ui/theme.js";

test("trackX: no inset = theme edgeTrackX; insets move each track inward", () => {
  const G = { W: 844, H: 390 };
  expect(trackX("left", G)).toBe(edgeTrackX("left", 844));
  expect(trackX("right", G)).toBe(edgeTrackX("right", 844));
  const S = { ...G, safe: { left: 47, right: 0, top: 0, bottom: 21 } };
  expect(trackX("left", S)).toBe(edgeTrackX("left", 844) + 47);
  expect(trackX("right", S)).toBe(edgeTrackX("right", 844));
  expect(trackX("right", { ...G, safe: { left: 0, right: 47 } })).toBe(edgeTrackX("right", 844) - 47);
});
