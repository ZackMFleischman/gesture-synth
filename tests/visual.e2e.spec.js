// Visual baselines for STABLE surfaces of the real app (layer: e2e). Pixel comparison with toHaveScreenshot;
// baselines live in tests/__screenshots__/visual.e2e.spec.js/ (one per platform).
//   Update after an intended UI change:  PW_PORT=52xx npm run test:visual -- --update-snapshots
//   then Read the new PNGs and commit them with the change that caused them.
// Only surfaces that are not in flux get a baseline. Lead chrome landed with M2; Arp / radial-menu chrome
// follows (docs/testing.md "Visual baselines").
import { test, expect } from "./fixtures.js";
import { leftHand, rightHand, pinch } from "./helpers/hands.js";
import { makeView } from "../src/input/hand-input.js";

const STYLE = "tests/helpers/visual.css"; // hides the animated canvas during the screenshot

async function playing(page, setHands) {
  await setHands(leftHand(4), rightHand(3, { volume: 0.75, tilt: 0.5 }));
  await expect(page.locator("#chordDisplay")).toHaveText("D(IV)");
  await expect(page.locator("#qualityDisplay")).toHaveText("Major 7th");
  await expect(page.locator(".vol-bar.lit")).toHaveCount(6);
  await expect(page.locator("#distortionDisplay")).toHaveText("Filter: +50%");
}

test("start overlay", async ({ page }) => {
  await page.goto("/?mockHands");
  await expect(page.locator("#startOverlay")).toBeVisible();
  await expect(page).toHaveScreenshot("start-overlay.png", { stylePath: STYLE });
});

test("Chords mode chrome while playing", async ({ synthPage: page, setHands }) => {
  await playing(page, setHands);
  await expect(page).toHaveScreenshot("chords-playing.png", { stylePath: STYLE });
});

test("help modal", async ({ synthPage: page, setHands }) => {
  await playing(page, setHands);
  await page.locator("#helpButton").click();
  await expect(page.locator("#helpModal")).toBeVisible();
  await expect(page).toHaveScreenshot("help-modal.png", { stylePath: STYLE });
});

test("gesture guide (key of A)", async ({ synthPage: page, setHands }) => {
  await playing(page, setHands);
  await page.locator("#guideToggle").click();
  await expect(page.locator("#gestureGuide")).toBeVisible();
  await expect(page).toHaveScreenshot("gesture-guide.png", { stylePath: STYLE });
});

test("Lead mode chrome (mode + note-set badges, pad chord, no meter)", async ({ synthPage: page, setHands }) => {
  // Same scene as the Lead e2e tests: chord hand on the screen right, pre-pinch claw on the left.
  const view = makeView(640, 480, 1280, 800);
  const hands = () => setHands(
    leftHand(4, { pos: { x: 0.72, y: 0.5 }, view }),
    pinch({ pos: { x: 0.3, y: 0.42 }, view, distance: 0.55, fingers: ["index", "middle", "ring", "pinky"] })
  );
  await hands();
  await page.locator("#controlsToggle").click();
  await page.locator('#controlsPanel [data-control="mode"] button[data-value="lead"]').click();
  await page.locator("#controlsToggle").click();
  await page.mouse.move(640, 400);
  await hands();
  await expect(page.locator("#chordDisplay")).toHaveText("D(IV)");
  await expect(page.locator("#qualityDisplay")).toHaveText("Major");
  await expect(page.locator("#noteSetBadge i.on")).toHaveCount(1);
  await expect(page.locator("#volumeMeter")).toBeHidden();
  // First-use labels (3 s at the hand) are gone before the baseline is taken.
  await expect.poll(() => page.evaluate(() => window.__gsTest.ui.firstUse), { timeout: 6000 }).toBe(false);
  await expect(page).toHaveScreenshot("lead-playing.png", { stylePath: STYLE });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("Chords mode chrome while playing (mobile)", async ({ synthPage: page, setHands }) => {
    await playing(page, setHands);
    await expect(page).toHaveScreenshot("chords-playing-mobile.png", { stylePath: STYLE });
  });
});
