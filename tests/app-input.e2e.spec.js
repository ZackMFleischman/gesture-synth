// The real app's input path (index.html + main.js): display geometry and ?replay of recorded hands.
// Pure classification lives in hand-input.unit.spec.js / gesture-reliability.unit.spec.js.
import { test, expect } from "./fixtures.js";
import { fist, DESKTOP_VIEW } from "./helpers/hands.js";
import { SAMPLE_RECORDING, replayUrl } from "./helpers/replay.js";

test("app view + ctx.toCanvas match drawFrame's mirrored cover crop", async ({ synthPage: page, setHands }) => {
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

test("?replay drives the app: chord appears", async ({ page }) => {
  await page.goto(replayUrl(SAMPLE_RECORDING));
  await page.locator("#startOverlay").click();
  await expect(page.locator("#chordDisplay")).toHaveText("A(I)");
  await expect(page.locator("#qualityDisplay")).toHaveText("Major 1st Inv");
  await expect.poll(() => page.evaluate(() => window.__gsTest.bus.get("right/pinch")), { timeout: 5000 }).toBe(true);
  // after the recording ends the hands are gone
  await expect(page.locator("#chordDisplay")).toHaveText("--", { timeout: 8000 });
});
