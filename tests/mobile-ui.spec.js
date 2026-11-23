// Mobile UI pass (docs/mobile-ui.md).
//  - audit (before): today's app + the planned modes chrome (labs/ui-lab.html) at every phone size
//  - lab (after):    labs/mobile-lab.html states at every phone size: coverage budget, clear area, on-screen,
//                    every control within 2 taps, sheets closable, 44 px targets, auto-collapse
//  - app:            the mobile system injected into the real app (/?mockHands): works with the real handlers,
//                    minimal HUD is remembered, desktop layout is unaffected
// Numbers: test-results/mobile-audit/*.json. Screens: test-results/screens/mobile-<state>-<size>.png
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { leftHand, rightHand } from "./helpers/hands.js";
import { collectUI, writeAudit, EXISTING } from "./helpers/mobile-ui.js";
import { MOBILE_SIZES, BUDGET, budgetFor, summarize, coverage, offscreen, overlapArea } from "../src/ui/mobile/layout-metrics.js";
import { clearArea } from "../src/ui/theme.js";

const PHONES = Object.fromEntries(Object.entries(MOBILE_SIZES).filter(([k]) => k !== "768x1024"));
const device = (vp) => ({ viewport: vp, hasTouch: true, isMobile: true });

/** Persistent chrome for the coverage budget: edge tracks count by their drawn body (6 px + halo), the Lead
 *  ladder is the instrument surface (reported separately, see docs/mobile-ui.md §6). */
function chrome(items) {
  return items
    .filter((i) => i.name !== "canvas:lead-ladder")
    .map((i) =>
      /track$/.test(i.name) ? { ...i, rect: { ...i.rect, x: i.rect.x + i.rect.w / 2 - 5, w: 10 } } : i,
    );
}

async function audit(page, label, size, { budget = false } = {}) {
  const ui = await collectUI(page);
  const items = budget ? chrome(ui.items) : ui.items;
  const s = summarize(items, ui.W, ui.H);
  s.withPanels = coverage([...items, ...ui.panels].map((i) => i.rect), ui.W, ui.H);
  s.items = items.map((i) => ({ name: i.name, rect: Object.fromEntries(Object.entries(i.rect).map(([k, v]) => [k, Math.round(v)])) }));
  s.panels = ui.panels.map((i) => i.name);
  writeAudit(`${label}-${size}`, { label, size, ...s });
  return { ui, s, items };
}

const labUrl = (m, extra = "") => `/labs/mobile-lab.html?m=${m}&clean${extra}`;
async function openLab(page, m, extra) {
  await page.goto(labUrl(m, extra));
  await page.waitForFunction(() => window.__mobileLab?.ready);
}

/** Center of a visible element, asserting it is on screen and not covered (a tap there reaches it). */
async function tapTarget(page, sel) {
  const loc = page.locator(sel);
  await expect(loc, `${sel} visible`).toBeVisible();
  const hit = await loc.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, r: { x: r.x, y: r.y, w: r.width, h: r.height }, ok: !!top && (top === e || e.contains(top)) };
  });
  expect(hit.ok, `${sel} is not covered at its center`).toBe(true);
  expect(Object.values(offscreen(hit.r, page.viewportSize().width, page.viewportSize().height)).every((v) => v < 0.5), `${sel} on screen`).toBe(true);
  return hit;
}

// =====================================================================================================
test.describe("audit (before)", () => {
  for (const [size, vp] of Object.entries(MOBILE_SIZES)) {
    test.describe(size, () => {
      test.use(device(vp));

      test(`today's app ${size}`, async ({ synthPage: page, setHands }) => {
        await setHands(leftHand(6, { minor: true }), rightHand(3, { volume: 0.6, tilt: 0.3 }));
        await expect(page.locator("#chordDisplay")).toHaveText("F#m(vi)");
        await page.screenshot({ path: `${SCREENS_DIR}/mobile-before-app-playing-${size}.png` });
        await audit(page, "before-app-playing", size);
        await page.locator("#guideToggle").click();
        await page.screenshot({ path: `${SCREENS_DIR}/mobile-before-app-guide-${size}.png` });
        await audit(page, "before-app-guide", size);
      });

      for (const state of ["chords-play", "arp-play", "lead-preview", "guide-open", "controls-panel-open"]) {
        test(`planned chrome ${state} ${size}`, async ({ page }) => {
          await page.goto(`/labs/ui-lab.html?state=${state}&clean`);
          await page.waitForFunction(() => window.__uiLab?.ready);
          await page.screenshot({ path: `${SCREENS_DIR}/mobile-before-lab-${state}-${size}.png` });
          await audit(page, `before-lab-${state}`, size, { budget: true });
        });
      }
    });
  }
});

// =====================================================================================================
const PLAYING = ["playing-collapsed", "mode-chords", "mode-arp", "mode-lead", "menu", "minimal-hud"];
const ALL = [...PLAYING, "expanded", "controls-sheet", "guide-sheet", "help"];

test.describe("mobile lab (after)", () => {
  for (const [size, vp] of Object.entries(MOBILE_SIZES)) {
    test.describe(size, () => {
      test.use(device(vp));

      for (const state of ALL) {
        test(`${state}: on screen${PLAYING.includes(state) ? ", budget, clear area" : ""}`, async ({ page }) => {
          await openLab(page, state);
          expect(await page.evaluate(() => document.body.classList.contains("gs-mobile")), "mobile system active").toBe(true);
          await page.screenshot({ path: `${SCREENS_DIR}/mobile-${state}-${size}.png` });
          const { ui, s, items } = await audit(page, `after-${state}`, size, { budget: true });
          for (const n of [...ui.items, ...ui.panels]) {
            const off = offscreen(n.rect, vp.width, vp.height);
            expect(Object.values(off).every((v) => v < 0.5), `${n.name} off screen ${JSON.stringify(off)}`).toBe(true);
          }
          if (!PLAYING.includes(state)) return;
          const B = budgetFor(vp.width);
          expect(s.coverage, `UI coverage while playing (${(s.coverage * 100).toFixed(1)}%)`).toBeLessThanOrEqual(B.playing);
          const domBudget = state === "minimal-hud" ? B.minimalDom : B.playingDom;
          expect(s.domCoverage, `DOM chrome coverage (${(s.domCoverage * 100).toFixed(1)}%)`).toBeLessThanOrEqual(domBudget);
          const clear = clearArea(vp.width, vp.height);
          for (const n of items) expect(overlapArea(n.rect, clear), `${n.name} intrudes on the clear area`).toBe(0);
        });
      }
    });
  }
});

// =====================================================================================================
// Interaction checks at every phone size + landscape.
const CONTROLS = [
  // [selector inside the expanded bar, what tapping it must do]
  ["#keySelect", "focus"],
  ["#toneSelect", "focus"],
  ["#controlsToggle", "controls"],
  ["#guideToggle", "guide"],
  ["#helpButton", "help"],
  ["#gsHudToggle", "hud"],
];

for (const [size, vp] of Object.entries(PHONES)) {
  test.describe(`mobile interactions ${size}`, () => {
    test.use(device(vp));

    test("every control is reachable within 2 taps from collapsed", async ({ page }) => {
      // The mode badge stays in the DOM, hidden in the tray: the pill shows the mode, Controls opens its panel.
      await openLab(page, "playing-collapsed");
      expect(await page.locator("#gsBar #modeBadge").count()).toBe(1);
      for (const [sel, effect] of CONTROLS) {
        await openLab(page, "playing-collapsed");
        await expect(page.locator(sel), `${sel} hidden while collapsed`).toBeHidden();
        let taps = 0;
        const pill = await tapTarget(page, "#gsPill");
        await page.touchscreen.tap(pill.x, pill.y);
        taps++;
        const t = await tapTarget(page, sel);
        expect(t.r.w, `${sel} width`).toBeGreaterThanOrEqual(BUDGET.touch);
        expect(t.r.h, `${sel} height`).toBeGreaterThanOrEqual(BUDGET.touch);
        if (effect === "focus") {
          await page.locator(sel).focus(); // native picker: a tap focuses + opens it
          await expect(page.locator(sel)).toBeFocused();
        } else {
          await page.touchscreen.tap(t.x, t.y);
        }
        taps++;
        expect(taps).toBeLessThanOrEqual(2);
        if (effect === "controls") await expect(page.locator("#gsControlsSheet")).toBeVisible();
        if (effect === "guide") await expect(page.locator("#gestureGuide")).toBeVisible();
        if (effect === "help") await expect(page.locator("#helpModal")).toBeVisible();
        if (effect === "hud") await expect(page.locator("body")).toHaveClass(/gs-hud-min/);
      }
    });

    test("expanded: touch targets >= 44 px, tray inside the screen, tap outside collapses", async ({ page }) => {
      await openLab(page, "expanded");
      const small = await page.evaluate((min) => {
        const out = [];
        for (const e of document.querySelectorAll("#gsBar button, #gsBar select")) {
          const r = e.getBoundingClientRect();
          if (r.width && (r.width < min || r.height < min)) out.push(`${e.id || e.className} ${r.width}x${r.height}`);
        }
        return out;
      }, BUDGET.touch);
      expect(small).toEqual([]);
      const bar = await page.locator("#gsBar").boundingBox();
      expect(bar.x + bar.width).toBeLessThanOrEqual(vp.width);
      expect(bar.y + bar.height).toBeLessThanOrEqual(vp.height * 0.5);
      await page.touchscreen.tap(vp.width / 2, vp.height * 0.6);
      await expect(page.locator("#gsBar")).not.toHaveClass(/open/);
      await expect(page.locator("#keySelect")).toBeHidden();
    });

    test("controls sheet: 44 px targets; closes via ✕, drag and Escape", async ({ page }) => {
      await openLab(page, "controls-sheet");
      const sheet = page.locator("#gsControlsSheet");
      await expect(sheet).toBeVisible();
      const small = await page.evaluate((min) => {
        const out = [];
        for (const e of document.querySelectorAll("#gsControlsSheet button:not(.gs-switch), #gsControlsSheet select, #gsControlsSheet input")) {
          const r = e.getBoundingClientRect();
          if (r.width && (r.width < min || r.height < min)) out.push(`${e.textContent || e.className} ${r.width}x${r.height}`);
        }
        return out;
      }, BUDGET.touch);
      expect(small).toEqual([]);

      await page.locator("#gsControlsSheet .gs-close").click();
      await expect(sheet).toBeHidden();
      await expect(page.locator("#controlsPanel")).toBeHidden();

      // Drag the handle (down in portrait, right in landscape).
      await page.evaluate(() => window.__mobileLab.mobile.openSheet("controls"));
      await expect(sheet).toBeVisible();
      const head = await page.locator("#gsControlsSheet .gs-sheet-head").boundingBox();
      const landscape = vp.height < 500;
      const x0 = head.x + (landscape ? 12 : head.width / 2);
      const y0 = head.y + (landscape ? head.height / 2 : 10);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x0 + (landscape ? 140 : 0), y0 + (landscape ? 0 : 140), { steps: 6 });
      await page.mouse.up();
      await expect(sheet).toBeHidden();

      await page.evaluate(() => window.__mobileLab.mobile.openSheet("controls"));
      await expect(sheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    });

    test("help sheet closes via ✕ and backdrop; guide strip via ✕ and its toggle", async ({ page }) => {
      await openLab(page, "help");
      const modal = page.locator("#helpModal");
      await expect(modal).toBeVisible();
      const close = await tapTarget(page, "#closeHelp");
      expect(close.r.w).toBeGreaterThanOrEqual(BUDGET.touch);
      await page.touchscreen.tap(close.x, close.y);
      await expect(modal).toBeHidden();
      await page.evaluate(() => window.__mobileLab.mobile.openSheet("help"));
      await expect(modal).toBeVisible();
      await page.mouse.click(vp.width / 2, 3); // backdrop above the sheet
      if (vp.height >= 500) await expect(modal).toBeHidden();
      else await page.keyboard.press("Escape"); // landscape: the sheet is full height, no backdrop
      await expect(modal).toBeHidden();

      await openLab(page, "guide-sheet");
      const guide = page.locator("#gestureGuide");
      await expect(guide).toBeVisible();
      const x = await tapTarget(page, "#gsGuideClose");
      expect(x.r.h).toBeGreaterThanOrEqual(BUDGET.touch);
      await page.touchscreen.tap(x.x, x.y);
      await expect(guide).toBeHidden();
      await expect(page.locator("#gsGuideClose")).toBeHidden();
    });

    test("the bar auto-collapses once playing, and never auto-expands", async ({ page }) => {
      await openLab(page, "expanded");
      await expect(page.locator("#gsBar")).toHaveClass(/open/);
      await page.evaluate(() => window.__mobileLab.mobile.setPlaying(true));
      await expect(page.locator("#gsBar")).not.toHaveClass(/open/, { timeout: 4000 });
      await page.evaluate(() => window.__mobileLab.mobile.setPlaying(false));
      await page.waitForTimeout(300);
      await expect(page.locator("#gsBar")).not.toHaveClass(/open/);
    });
  });
}

// =====================================================================================================
// The mobile system on the REAL app (handlers from controls.js), injected the way Phase B will mount it.
async function mountInApp(page, opts = { intro: false }) {
  await page.evaluate(async (opts) => {
    const m = await import("/src/ui/mobile/mobile-ui.js");
    window.__mobile = m.mountMobileUI(opts);
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
      await expect(page.locator("#volumeMeter")).toBeVisible();
      await page.locator("#gsPill").click();
      await page.locator("#gsHudToggle").click();
      await expect(page.locator("body")).toHaveClass(/gs-hud-min/);
      await expect(page.locator("#volumeMeter")).toBeHidden();
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
      await setHands(leftHand(1), rightHand(1));
      await page.evaluate(() => window.__mobile.setPlaying(true));
      await expect(page.locator("#gsBar")).not.toHaveClass(/open/, { timeout: 4000 });
      await page.evaluate(() => window.__mobile.destroy());
      await mountInApp(page, {});
      await expect(page.locator("#gsBar")).not.toHaveClass(/open/);
    });

    test("blocked storage: no errors, toggle still works", async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
      });
      await page.goto("/?mockHands");
      await page.locator("#startOverlay").click();
      await mountInApp(page, {}); // intro on: storage throws, so the tray opens (every load) and nothing breaks
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

  test("1280x800: mounting changes nothing; mobile -> desktop resize restores every node", async ({ synthPage: page }) => {
    await page.locator("#guideToggle").click();
    const before = await boxes(page);
    await mountInApp(page);
    expect(await page.evaluate(() => document.body.classList.contains("gs-mobile"))).toBe(false);
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

  test("lab at 1280x800 matches the planned desktop chrome", async ({ page }) => {
    await page.goto("/labs/ui-lab.html?state=arp-play&clean");
    await page.waitForFunction(() => window.__uiLab?.ready);
    const ref = await boxes(page);
    await openLab(page, "mode-arp");
    expect(await page.evaluate(() => window.__mobileLab.mobile.isMobile())).toBe(false);
    expect(await boxes(page)).toEqual(ref);
  });
});
