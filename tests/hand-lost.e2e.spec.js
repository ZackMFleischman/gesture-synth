// "Hand lost" ring + plate (real app): shown when a hand drops out, then fade away (real-camera
// feedback: a ring locked on screen isn't useful). Timings: MOTION.lostHold + lostFade in theme.js.
import { test, expect } from "./fixtures.js";
import { leftHand, rightHand } from "./helpers/hands.js";
import { MOTION } from "../src/ui/theme.js";
import { lostAlpha } from "../src/ui/edge-tracks.js";

const lostRegions = (page) =>
  page.evaluate(() => window.__gsTest.ui.regions.filter((r) => /-ghost$|-lost-label$/.test(r.name)).map((r) => r.name));

test("lostAlpha: full, then fades to zero", () => {
  expect(lostAlpha(0)).toBe(1);
  expect(lostAlpha(MOTION.lostHold)).toBe(1);
  expect(lostAlpha(MOTION.lostHold + MOTION.lostFade / 2)).toBeCloseTo(0.5, 5);
  expect(lostAlpha(MOTION.lostHold + MOTION.lostFade)).toBe(0);
  expect(lostAlpha(60_000)).toBe(0);
});

test("hand-lost ring shows, then disappears after ~2 s", async ({ synthPage: page, setHands }) => {
  await setHands(leftHand(1), rightHand(1));
  await page.waitForTimeout(400);
  await setHands(leftHand(1)); // right hand drops out
  await expect.poll(() => lostRegions(page), { timeout: 1500 }).toContain("right-track-ghost");
  await page.waitForTimeout(MOTION.lostHold + MOTION.lostFade + 500);
  expect(await lostRegions(page)).toEqual([]);
});
