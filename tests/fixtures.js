import { test as base, expect } from "@playwright/test";
import { AUDIO_TAP_SCRIPT } from "./helpers/audio.js";
import { results, setPlacementView, viewFor } from "./helpers/hands.js";

export const SCREENS_DIR = "test-results/screens";

/**
 * `synthPage`: the app loaded with ?mockHands (MediaPipe bypassed), audio tap installed, and the start overlay already dismissed.
 * `setHands(...hands)` feeds synthetic landmarks into the next frames.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    // Hand builders place `volume` (= HandFrame.height over the reach zone) in this page's view.
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    setPlacementView(viewFor(vp.width, vp.height));
    await page.addInitScript(AUDIO_TAP_SCRIPT);
    // The mobile UI shows its tray open once on a first visit (docs/mobile-ui.md M1); tests start as a returning
    // player. tests/mobile-ui.spec.js clears this to test the first visit.
    await page.addInitScript(() => {
      try { localStorage.setItem("gs.mobile.seen", "1"); } catch { /* storage blocked in this test */ }
    });
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
