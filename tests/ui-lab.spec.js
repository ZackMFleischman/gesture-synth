// UI integration lab (labs/ui-lab.html): renders every lab state at desktop + mobile size,
// saves screenshots, and checks the layout contract from docs/ui-integration.md:
//  - new edge/status elements never overlap the existing controls,
//  - new elements don't overlap each other,
//  - persistent status UI stays out of the central clear area (src/ui/theme.js clearArea()).
import { test, expect, SCREENS_DIR } from "./fixtures.js";

const STATES = [
  "chords-play",
  "menu-enter",
  "menu-approach",
  "menu-selected",
  "countdown",
  "arp-play",
  "arp-pinch",
  "arp-firstuse",
  "guide-open",
  "lead-preview",
  "lead-playing",
  "controls-panel-open",
  "hand-lost",
];

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

// Existing UI from index.html (must not be covered by anything new).
const EXISTING = [
  "keySelect",
  "toneSelect",
  "guideToggle",
  "gestureGuide",
  "volumeMeter",
  "distortionDisplay",
  "chordDisplay",
  "qualityDisplay",
  "helpButton",
];

const overlap = (a, b) => a.x + a.w > b.x && b.x + b.w > a.x && a.y + a.h > b.y && b.y + b.h > a.y;

async function collect(page) {
  return page.evaluate((EXISTING) => {
    const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none";
    const box = (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const existing = EXISTING.map((id) => document.getElementById(id))
      .filter(vis)
      .map((e) => ({ name: `#${e.id}`, rect: box(e) }));
    const newDom = [...document.querySelectorAll("[data-gs-kind]")]
      .filter(vis)
      .map((e) => ({ name: `#${e.id}`, kind: e.dataset.gsKind, rect: box(e) }));
    const lab = window.__uiLab;
    return { existing, newDom, canvas: lab.regions, clear: lab.clearArea };
  }, EXISTING);
}

function checkLayout({ existing, newDom, canvas, clear }, vp) {
  const fresh = [...newDom, ...canvas];
  // Edge + status elements: the persistent UI that must coexist with the existing controls.
  const persistent = fresh.filter((r) => r.kind === "edge" || r.kind === "status");
  const panels = fresh.filter((r) => r.kind === "panel");

  for (const n of [...persistent, ...panels]) {
    const r = n.rect;
    expect(r.x, `${n.name} left`).toBeGreaterThanOrEqual(0);
    expect(r.y, `${n.name} top`).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w, `${n.name} right`).toBeLessThanOrEqual(vp.width);
    expect(r.y + r.h, `${n.name} bottom`).toBeLessThanOrEqual(vp.height);
    for (const e of existing) {
      expect(overlap(r, e.rect), `${n.name} overlaps existing ${e.name}`).toBe(false);
    }
  }
  for (let i = 0; i < persistent.length; i++)
    for (let j = i + 1; j < persistent.length; j++)
      expect(overlap(persistent[i].rect, persistent[j].rect), `${persistent[i].name} overlaps ${persistent[j].name}`).toBe(false);

  // Clear area: no persistent element (new or existing) inside it. User-opened panels
  // (#gestureGuide, #controlsPanel, help modal) and hand-anchored feedback are exempt.
  for (const n of [...persistent, ...existing.filter((e) => e.name !== "#gestureGuide")]) {
    expect(overlap(n.rect, clear), `${n.name} intrudes on the clear area`).toBe(false);
  }
}

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`ui lab ${vpName}`, () => {
    test.use({ viewport: vp });

    for (const state of STATES) {
      test(state, async ({ page }) => {
        await page.goto(`/labs/ui-lab.html?state=${state}&clean`);
        await page.waitForFunction(() => window.__uiLab?.ready);
        await page.screenshot({ path: `${SCREENS_DIR}/ui-lab-${state}-${vpName}.png` });
        checkLayout(await collect(page), vp);
      });
    }

    // Swapped: chord hand on the screen right (the unusual case; real use = chord hand on the screen left, the
    // lab's default, docs/ui-integration.md Q1). Layout must hold either way.
    for (const state of ["chords-play", "arp-play", "lead-preview"]) {
      test(`${state} (swapped sides)`, async ({ page }) => {
        await page.goto(`/labs/ui-lab.html?state=${state}&clean&swap`);
        await page.waitForFunction(() => window.__uiLab?.ready);
        await page.screenshot({ path: `${SCREENS_DIR}/ui-lab-${state}-swap-${vpName}.png` });
        checkLayout(await collect(page), vp);
      });
    }

    test("debug overlay (clear area + checked regions)", async ({ page }) => {
      await page.goto(`/labs/ui-lab.html?state=arp-play&clean&debug`);
      await page.waitForFunction(() => window.__uiLab?.ready);
      await page.screenshot({ path: `${SCREENS_DIR}/ui-lab-arp-play-debug-${vpName}.png` });
    });

    test("bright background", async ({ page }) => {
      await page.goto(`/labs/ui-lab.html?state=arp-play&clean&bg=bright`);
      await page.waitForFunction(() => window.__uiLab?.ready);
      await page.screenshot({ path: `${SCREENS_DIR}/ui-lab-arp-play-bright-${vpName}.png` });
    });
  });
}
