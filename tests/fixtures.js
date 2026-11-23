import { test as base, expect } from "@playwright/test";
import { AUDIO_TAP_SCRIPT } from "./helpers/audio.js";
import { results } from "./helpers/hands.js";

export const SCREENS_DIR = "test-results/screens";

/**
 * `synthPage`: the app loaded with ?mockHands (MediaPipe bypassed), audio tap installed, and the start overlay already dismissed.
 * `setHands(...hands)` feeds synthetic landmarks into the next frames.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(AUDIO_TAP_SCRIPT);
    const errors = [];
    page.on("pageerror", (err) => errors.push(err));
    await use(page);
    expect(errors, "uncaught page errors").toEqual([]);
  },

  synthPage: async ({ page }, use) => {
    await page.goto("/?mockHands");
    await page.locator("#startOverlay").click();
    await expect(page.locator("#startOverlay")).toBeHidden();
    // Wait until the main loop is running (fake camera is up).
    await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0);
    await use(page);
  },

  setHands: async ({ page }, use) => {
    await use(async (...hands) => {
      const r = results(...hands);
      await page.evaluate((r) => (window.__gsTest.results = r), r);
    });
  },
});

export { expect };
