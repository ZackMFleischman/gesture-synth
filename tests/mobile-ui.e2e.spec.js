// Mobile UI (docs/mobile-ui.md), e2e layer: the app's own mobile system (main.js) with the real handlers and
// the modes UI: before/after audit of the app, budgets, tray / sheets / guide strip / minimal HUD (remembered),
// first visit, blocked storage, phone first-use labels, desktop inert, real-app screens + a real-time video.
// Screens: test-results/screens/mobile-app-<state>-<size>.png, mobile-after-app-*; video: test-results/videos/.
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { leftHand, rightHand } from "./helpers/hands.js";
import { EXISTING, device, audit } from "./helpers/mobile-ui.js";
import { MOBILE_SIZES, budgetFor, overlapArea } from "../src/ui/mobile/layout-metrics.js";
import { clearArea } from "../src/ui/theme.js";

// =====================================================================================================
test.describe("audit (before): app without the mobile system", () => {
  for (const [size, vp] of Object.entries(MOBILE_SIZES)) {
    test.describe(size, () => {
      test.use(device(vp));

      test(`today's app ${size}`, async ({ synthPage: page, setHands }) => {
        // "Before" = the app without the mobile system (main.js mounts it; destroy() restores every node).
        await page.evaluate(() => window.__gsTest.mobile.destroy());
        await setHands(leftHand(6, { minor: true }), rightHand(3, { volume: 0.6, tilt: 0.3 }));
        await expect(page.locator("#chordDisplay")).toHaveText("F#m(vi)");
        await page.screenshot({ path: `${SCREENS_DIR}/mobile-before-app-playing-${size}.png` });
        await audit(page, "before-app-playing", size);
        await page.locator("#guideToggle").click();
        await page.screenshot({ path: `${SCREENS_DIR}/mobile-before-app-guide-${size}.png` });
        await audit(page, "before-app-guide", size);
      });

    });
  }
});

// =====================================================================================================
// The mobile system in the REAL app (main.js mounts it; real handlers from controls.js + the modes UI).
// `mountInApp` uses the app's own instance; with `fresh` it remounts one with the given options.
async function mountInApp(page, opts = null) {
  await page.evaluate(async (opts) => {
    if (opts) {
      window.__gsTest.mobile.destroy();
      const m = await import("/src/ui/mobile/mobile-ui.js");
      window.__gsTest.mobile = m.mountMobileUI({ bus: window.__gsTest.bus, ...opts });
    }
    window.__mobile = window.__gsTest.mobile;
  }, opts);
}

test.describe("real app + mobile system", () => {
  for (const [size, vp] of Object.entries(MOBILE_SIZES)) {
    test.describe(size, () => {
      test.use(device(vp));

      test(`playing collapsed ${size}: budget, clear area, real handlers`, async ({ synthPage: page, setHands }) => {
        await mountInApp(page);
        await setHands(leftHand(6, { minor: true }), rightHand(3, { volume: 0.6, tilt: 0.3 }));
        await expect(page.locator("#chordDisplay")).toHaveText("F#m(vi)");
        await page.evaluate(() => window.__mobile.setPlaying(true));
        await page.screenshot({ path: `${SCREENS_DIR}/mobile-after-app-playing-${size}.png` });
        const { s, items } = await audit(page, "after-app-playing", size);
        expect(s.domCoverage).toBeLessThanOrEqual(budgetFor(vp.width).playingDom);
        const clear = clearArea(vp.width, vp.height);
        for (const n of items) expect(overlapArea(n.rect, clear), `${n.name} in the clear area`).toBe(0);

        // Real guide toggle through the bar; the strip follows the key select.
        await page.locator("#gsPill").click();
        await page.locator("#keySelect").selectOption({ label: "D#/Eb" });
        await expect(page.locator("#gsPill")).toContainText("Eb");
        await page.locator("#guideToggle").click();
        await expect(page.locator("#gestureGuide .gesture-guide-note")).toHaveText(["Eb", "F", "G", "Ab", "Bb", "C", "D"]);
        await expect(page.locator("#gsBar")).not.toHaveClass(/open/);
        await page.screenshot({ path: `${SCREENS_DIR}/mobile-after-app-guide-${size}.png` });
        await audit(page, "after-app-guide", size);
        await page.locator("#gsGuideClose").click();
        await expect(page.locator("#gestureGuide")).toBeHidden();
        await expect(page.locator("#guideToggle")).toHaveText("Open Guide");

        // Real help.
        await page.locator("#gsPill").click();
        await page.locator("#helpButton").click();
        await expect(page.locator("#helpModal")).toBeVisible();
        await page.screenshot({ path: `${SCREENS_DIR}/mobile-after-app-help-${size}.png` });
        await page.locator("#closeHelp").click();
        await expect(page.locator("#helpModal")).toBeHidden();
      });
    });
  }

  test.describe("390x844 storage", () => {
    test.use(device(MOBILE_SIZES["390x844"]));

    test("minimal HUD is remembered across reloads", async ({ synthPage: page }) => {
      await mountInApp(page);
      await expect(page.locator("#volumeMeter")).toBeAttached();
      await expect(page.locator("#distortionDisplay")).toBeHidden(); // one filter visual: the arc at the hand
      await page.locator("#gsPill").click();
      await page.locator("#gsHudToggle").click();
      await expect(page.locator("body")).toHaveClass(/gs-hud-min/);
      await expect(page.locator("#volumeMeter")).toBeHidden();
      await expect(page.locator("#distortionDisplay")).toBeHidden();
      await page.screenshot({ path: `${SCREENS_DIR}/mobile-after-app-minimal-390x844.png` });
      await page.reload();
      await page.locator("#startOverlay").click();
      await mountInApp(page);
      await expect(page.locator("body")).toHaveClass(/gs-hud-min/);
      await expect(page.locator("#gsHudToggle")).toHaveAttribute("aria-pressed", "true");
    });

    test("first visit shows the tray open once; it folds away when hands play", async ({ synthPage: page, setHands }) => {
      await page.evaluate(() => localStorage.removeItem("gs.mobile.seen"));
      await mountInApp(page, {});
      await expect(page.locator("#gsBar")).toHaveClass(/open/);
      await page.screenshot({ path: `${SCREENS_DIR}/mobile-after-app-intro-390x844.png` });
      await setHands(leftHand(1), rightHand(1)); // the bus hand positions drive "playing" (no setPlaying call)
      await expect(page.locator("body")).toHaveClass(/gs-playing/);
      await expect(page.locator("#gsBar")).not.toHaveClass(/open/, { timeout: 4000 });
      await mountInApp(page, {});
      await expect(page.locator("#gsBar")).not.toHaveClass(/open/);
    });

    test("blocked storage: no errors, toggle still works", async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
      });
      await page.goto("/?mockHands");
      await page.locator("#startOverlay").click();
      // App instance, intro on: storage throws, so the tray opens (every load) and nothing breaks.
      await expect(page.locator("#gsBar")).toHaveClass(/open/);
      await page.locator("#gsHudToggle").click();
      await expect(page.locator("body")).toHaveClass(/gs-hud-min/);
    });
  });
});

// =====================================================================================================
test.describe("desktop unaffected", () => {
  const boxes = (page) =>
    page.evaluate((ids) => {
      const out = {};
      for (const id of ids) {
        const e = document.getElementById(id);
        const r = e.getBoundingClientRect();
        out[id] = [r.x, r.y, r.width, r.height, e.parentElement.id, getComputedStyle(e).display];
      }
      return out;
    }, [...EXISTING, "helpModal"]);

  test("1280x800: the mobile system is inert; mobile -> desktop resize restores every node", async ({ synthPage: page }) => {
    await page.locator("#guideToggle").click();
    const before = await boxes(page);
    expect(await page.evaluate(() => document.body.classList.contains("gs-mobile"))).toBe(false);
    await page.evaluate(() => window.__gsTest.mobile.destroy()); // app without it = identical boxes
    expect(await boxes(page)).toEqual(before);
    await mountInApp(page, { intro: false });
    expect(await boxes(page)).toEqual(before);
    await expect(page.locator("#gsBar")).toBeHidden();
    await page.screenshot({ path: `${SCREENS_DIR}/mobile-desktop-1280x800.png` });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("body")).toHaveClass(/gs-mobile/);
    await expect(page.locator("#keySelect")).toBeHidden(); // collapsed into the bar
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator("body")).not.toHaveClass(/gs-mobile/);
    expect(await boxes(page)).toEqual(before);
  });
});

// =====================================================================================================
// Phase B: the app's own mobile system with the modes UI (Arp), real-app screens + a real-time video.
const APP_SIZES = { "390x844": MOBILE_SIZES["390x844"], "844x390": MOBILE_SIZES["844x390"] };
const appShot = (page, state, size) => page.screenshot({ path: `${SCREENS_DIR}/mobile-app-${state}-${size}.png` });

async function appArp(page, setHands) {
  await page.evaluate(() => window.__gsTest.router.setMode("arp"));
  await expect(page.locator("body")).toHaveAttribute("data-mode", "arp");
  await setHands(leftHand(4), rightHand(3, { volume: 0.6, tilt: 0.3 }));
  await expect(page.locator("body")).toHaveClass(/gs-playing/); // bus hand positions -> playing
}

for (const [size, vp] of Object.entries(APP_SIZES)) {
  test.describe(`real app Arp ${size}`, () => {
    test.use(device(vp));

    test("states: playing-collapsed, tray-open, controls-sheet, guide-strip, minimal-hud", async ({ synthPage: page, setHands }) => {
      await appArp(page, setHands);
      await expect(page.locator("#gsPill")).toContainText("Arp");
      // The 8-bar meter is hidden in the modes UI (body.gs-modes; collapsed or not); L5: the pill replaces the
      // mode badge on phones.
      await expect(page.locator("#volumeMeter")).toBeHidden();
      await expect(page.locator("#modeBadge")).toBeHidden();
      await page.waitForTimeout(3300); // first-use labels gone
      await appShot(page, "playing-collapsed", size);
      const { s } = await audit(page, "app-arp-playing", size);
      expect(s.domCoverage).toBeLessThanOrEqual(budgetFor(vp.width).playingDom);
      expect(s.inClear).toEqual([]);

      await page.locator("#gsPill").click();
      await expect(page.locator("#gsBar")).toHaveClass(/open/);
      await expect(page.locator("#volumeMeter")).toBeHidden(); // also with the tray open
      await appShot(page, "tray-open", size);

      await page.locator("#controlsToggle").click();
      await expect(page.locator("#gsControlsSheet")).toBeVisible();
      await expect(page.locator("#gsControlsSheet #controlsPanel")).toBeVisible();
      await appShot(page, "controls-sheet", size);
      await page.locator("#gsControlsSheet .gs-close").click();
      await expect(page.locator("#gsControlsSheet")).toBeHidden();

      await page.locator("#gsPill").click();
      await page.locator("#guideToggle").click();
      await expect(page.locator("#gestureGuide")).toBeVisible();
      await appShot(page, "guide-strip", size);
      await page.locator("#gsGuideClose").click();

      await page.locator("#gsPill").click();
      await page.locator("#gsHudToggle").click();
      await page.locator("#gsPill").click(); // fold the tray
      await expect(page.locator("#transport")).toBeHidden();
      await appShot(page, "minimal-hud", size);
      const m = await audit(page, "app-arp-minimal", size);
      expect(m.s.domCoverage).toBeLessThanOrEqual(budgetFor(vp.width).minimalDom);
    });

    test("phone first-use labels: only Gate and Filter", async ({ synthPage: page, setHands }) => {
      await appArp(page, setHands);
      await expect.poll(() => page.evaluate(() => window.__gsTest.ui.firstUse)).toBe(true);
      const names = await page.evaluate(() => window.__gsTest.ui.regions.filter((r) => r.kind === "transient").map((r) => r.name));
      expect(names.sort()).toEqual(["first-use-arc", "first-use-track"]);
    });
  });
}

test.describe("real app video 390x844", () => {
  test.use(device(MOBILE_SIZES["390x844"]));

  test("tray -> auto-collapse -> controls sheet -> close (real time)", async ({ synthPage: page, setHands, browser }) => {
    test.setTimeout(60_000);
    const { createScreencast } = await import("./helpers/screencast.js");
    const rec = createScreencast();
    await appArp(page, setHands);
    await rec.track(page, "phone");
    await page.waitForTimeout(800);
    await page.locator("#gsPill").click();
    await expect(page.locator("#gsBar")).toHaveClass(/open/);
    const t0 = Date.now();
    await expect(page.locator("#gsBar")).not.toHaveClass(/open/, { timeout: 5000 }); // hands playing -> folds
    expect(Date.now() - t0).toBeGreaterThan(1500);
    await page.waitForTimeout(600);
    await page.locator("#gsPill").click();
    await page.waitForTimeout(500);
    await page.locator("#controlsToggle").click();
    await expect(page.locator("#gsControlsSheet")).toBeVisible();
    await page.waitForTimeout(1200);
    await page.locator("#gsControlsSheet .gs-close").click();
    await expect(page.locator("#gsControlsSheet")).toBeHidden();
    await page.waitForTimeout(800);
    await rec.untrack(page);
    const out = await rec.save(browser, "test-results/videos/mobile-tray-controls-390x844.webm", { layout: ["phone"], cellW: 390, cellH: 844 });
    expect(out.file).toBeTruthy();
  });
});

