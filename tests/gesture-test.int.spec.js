// labs/gesture-test.html (browser): live HandFrame values, threshold sliders, Record -> replayable JSON,
// ?replay on the test page. The classifier itself is unit-tested in hand-input / gesture-reliability.unit.
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { fist, pinch, leftHand, rightHand, results } from "./helpers/hands.js";
import { SAMPLE_RECORDING, replayUrl, replayThrough } from "./helpers/replay.js";

test("?replay drives the gesture test page", async ({ page }) => {
  await page.goto(replayUrl(SAMPLE_RECORDING, "/labs/gesture-test.html", { loop: true }));
  await expect(page.locator("#source")).toContainText("replay");
  await expect(page.locator('[data-testid="Right-pinch-state"]')).toHaveText("PINCH", { timeout: 6000 });
});

test("Record button saves a replayable recording", async ({ page }) => {
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

// ---------------------------------------------------------------- the test page itself

test("gesture test page shows live values (mockHands) — screenshot", async ({ page }) => {
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
