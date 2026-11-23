import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { leftHand, rightHand, heightForMaster } from "./helpers/hands.js";

test("start overlay gates the app and dismisses on click", async ({ page }) => {
  await page.goto("/?mockHands");
  await expect(page.locator("#startOverlay")).toBeVisible();
  await expect(page.locator("#overlay")).toHaveClass(/dimmed/);
  await page.screenshot({ path: `${SCREENS_DIR}/01-start-overlay.png` });

  await page.locator("#startOverlay").click();
  await expect(page.locator("#startOverlay")).toBeHidden();
  await expect(page.locator("#overlay")).not.toHaveClass(/dimmed/);
  expect(await page.evaluate(() => window.__gsTest.synth.ctx?.state)).toBe("running");
});

test("help modal opens, closes via ✕ and via backdrop", async ({ synthPage: page }) => {
  const modal = page.locator("#helpModal");
  await expect(modal).toBeHidden();

  await page.locator("#helpButton").click();
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Left Hand");
  await page.screenshot({ path: `${SCREENS_DIR}/02-help-modal.png` });

  await page.locator("#closeHelp").click();
  await expect(modal).toBeHidden();

  await page.locator("#helpButton").click();
  await page.mouse.click(5, 5); // backdrop
  await expect(modal).toBeHidden();
});

test("gesture guide toggles and follows the selected key", async ({ synthPage: page }) => {
  const guide = page.locator("#gestureGuide");
  const toggle = page.locator("#guideToggle");
  await expect(guide).toBeHidden();

  await toggle.click();
  await expect(guide).toBeVisible();
  await expect(toggle).toHaveText("Close Guide");
  await expect(guide.locator(".gesture-guide-note")).toHaveText(["A", "B", "C#", "D", "E", "F#", "G#"]);

  await page.locator("#keySelect").selectOption({ label: "D#/Eb" });
  await expect(guide.locator(".gesture-guide-note")).toHaveText(["Eb", "F", "G", "Ab", "Bb", "C", "D"]);
  await page.screenshot({ path: `${SCREENS_DIR}/03-guide-eb.png` });

  await toggle.click();
  await expect(guide).toBeHidden();
  await expect(toggle).toHaveText("Open Guide");
});

test("playing state renders chord, quality, meter and energy wave", async ({ synthPage: page, setHands }) => {
  // 6 of 8 bars: the meter shows the volume = the left height (master 0.75) in Chords.
  await setHands(leftHand(4, { volume: heightForMaster(0.75) }), rightHand(3, { volume: 0.75, tilt: 0.5 }));
  await expect(page.locator("#chordDisplay")).toHaveText("D(IV)");
  await expect(page.locator("#qualityDisplay")).toHaveText("Major 7th");
  await expect(page.locator(".vol-bar.lit")).toHaveCount(6);
  await expect(page.locator("#distortionDisplay")).toHaveText("Filter: +50%");
  await page.screenshot({ path: `${SCREENS_DIR}/04-playing-desktop.png` });
});

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("controls stay on-screen and don't overlap", async ({ synthPage: page, setHands }) => {
    await setHands(leftHand(6, { minor: true }), rightHand(1, { volume: 0.5 }));
    await expect(page.locator("#chordDisplay")).toHaveText("F#m(vi)");
    // Phones: the mobile system (docs/mobile-ui.md) holds the top-left controls in its collapsed bar.
    await page.locator("#gsPill").click();
    await page.locator("#guideToggle").click();

    const all = ["keySelect", "toneSelect", "guideToggle", "gestureGuide", "volumeMeter",
      "distortionDisplay", "chordDisplay", "qualityDisplay", "helpButton"];
    const ids = [];
    for (const id of all) {
      if (await page.locator(`#${id}`).isVisible()) ids.push(id);
      else expect(await page.locator(`#gsBar #${id}, #${id}`).first().evaluate((e) => !!e.closest("#gsBar") || e.id === "volumeMeter" || e.id === "distortionDisplay"),
        `#${id} hidden but not in the mobile bar (the filter readout is hidden on purpose: the arc at the hand shows it)`).toBe(true);
    }
    ids.push("gsBar");
    const boxes = {};
    for (const id of ids) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box, `#${id} rendered`).not.toBeNull();
      expect(box.x, `#${id} left edge`).toBeGreaterThanOrEqual(0);
      expect(box.y, `#${id} top edge`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `#${id} right edge`).toBeLessThanOrEqual(390);
      expect(box.y + box.height, `#${id} bottom edge`).toBeLessThanOrEqual(844);
      boxes[id] = box;
    }
    const overlaps = (a, b) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(overlaps(boxes[ids[i]], boxes[ids[j]]), `#${ids[i]} overlaps #${ids[j]}`).toBe(false);
      }
    }
    await page.screenshot({ path: `${SCREENS_DIR}/05-playing-mobile.png` });
  });
});
