// Visual baselines for STABLE surfaces of the real app (layer: e2e). Pixel comparison with toHaveScreenshot;
// baselines live in tests/__screenshots__/visual.e2e.spec.js/ (one per platform).
//   Update after an intended UI change:  PW_PORT=52xx npm run test:visual -- --update-snapshots
//   then Read the new PNGs and commit them with the change that caused them.
// Only surfaces that are not in flux get a baseline. Arp / Lead / radial-menu chrome is added after M1/M2
// integration (docs/testing.md "Visual baselines").
import { test, expect } from "./fixtures.js";
import { leftHand, rightHand } from "./helpers/hands.js";

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

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("Chords mode chrome while playing (mobile)", async ({ synthPage: page, setHands }) => {
    await playing(page, setHands);
    await expect(page).toHaveScreenshot("chords-playing-mobile.png", { stylePath: STYLE });
  });
});
