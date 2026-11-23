// Radial menu lab (labs/menu-lab.html, browser): visuals, screenshots.
// The pure state machine is unit-tested in radial-menu.unit.spec.js.
import { test, expect, SCREENS_DIR } from "./fixtures.js";

const W = 1280;
const H = 800;
const SIZE = 0.12; // lab default hand size (width units)
const px = (s) => s * SIZE * W; // hand sizes -> CSS px

async function openLab(page, query = "manualClock") {
  await page.goto(`/labs/menu-lab.html?${query}`);
  await page.waitForFunction(() => !!window.__menuLab);
}
const step = (page, ms) => page.evaluate((ms) => window.__menuLab.step(ms), ms);
const shot = (page, name) => page.screenshot({ path: `${SCREENS_DIR}/menu-${name}.png` });

test.describe("radial menu lab", () => {
  test("full flow: available -> approach -> selected -> confirmed -> countdown", async ({ page }) => {
    await openLab(page);
    const cx = 640;
    const cy = 430;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await step(page, 70);
    expect((await step(page, 0)).state).toBe("closed");
    await step(page, 60);
    expect((await step(page, 0)).state).toBe("open");
    await step(page, 16); // mid-grow (ring opened ~20 ms ago)
    await shot(page, "enter");
    await step(page, 200);
    await shot(page, "available");

    await page.mouse.move(cx + px(0.6), cy, { steps: 4 });
    let r = await step(page, 200);
    expect(r.hoverId).toBe("arp");
    expect(r.selectedId).toBe(null);
    await shot(page, "approach");

    await page.mouse.move(cx + px(1.0), cy, { steps: 4 });
    r = await step(page, 200);
    expect(r.selectedId).toBe("arp");
    await expect(page.locator("#log")).toContainText("tick");
    await shot(page, "selected");
    await page.screenshot({ path: `${SCREENS_DIR}/menu-selected-crop.png`, clip: { x: 400, y: 230, width: 500, height: 380 } });

    await page.mouse.up();
    await step(page, 48);
    await expect(page.locator("#log")).toContainText("confirmed: arp");
    await expect(page.locator("#badge")).toHaveAttribute("data-mode", "arp");
    expect(await page.evaluate(() => window.__menuLab.last.state)).toBe("countdown");
    await step(page, 30);
    await shot(page, "confirmed");
    await step(page, 250);
    await shot(page, "countdown");
    await step(page, 400);
    expect(await page.evaluate(() => window.__menuLab.last.state)).toBe("closed");
    await expect(page.locator("#log")).toContainText("countdown done");
  });

  test("cancel in the center zone fades with no change", async ({ page }) => {
    await openLab(page);
    await page.mouse.move(640, 430);
    await page.mouse.down();
    await step(page, 400);
    await page.mouse.move(640 + px(0.15), 430 - px(0.1));
    await step(page, 50);
    await shot(page, "deadzone");
    await page.mouse.up();
    await step(page, 64);
    await expect(page.locator("#log")).toContainText("cancelled (empty)");
    await shot(page, "cancel-fade");
    await expect(page.locator("#badge")).toHaveAttribute("data-mode", "chords");
  });

  test("current item selected shows 'Already active' and changes nothing", async ({ page }) => {
    await openLab(page);
    await page.mouse.move(640, 430);
    await page.mouse.down();
    await step(page, 300);
    await page.mouse.move(640, 430 - px(1.0), { steps: 4 });
    const r = await step(page, 200);
    expect(r.selectedId).toBe("chords");
    await shot(page, "selected-current");
    await page.mouse.up();
    await step(page, 64);
    await expect(page.locator("#log")).toContainText("cancelled (same-item)");
  });

  test("lead selected (left) and small hand size", async ({ page }) => {
    await openLab(page);
    await page.locator("#size").fill("0.07");
    await page.mouse.move(700, 420);
    await page.mouse.down();
    await step(page, 300);
    await page.mouse.move(700 - 1.0 * 0.07 * W, 420, { steps: 4 });
    const r = await step(page, 200);
    expect(r.selectedId).toBe("lead");
    await shot(page, "selected-lead-small");
  });

  test("near the frame edge the ring is clamped but movement stays relative", async ({ page }) => {
    await openLab(page);
    // left edge, near the top (panels sit in the corners)
    await page.mouse.move(25, 150);
    await page.mouse.down();
    await step(page, 300);
    expect((await step(page, 0)).state).toBe("open");
    await shot(page, "edge");
    await page.mouse.move(25 + px(1.0), 150, { steps: 4 });
    const r = await step(page, 200);
    expect(r.selectedId).toBe("arp");
    expect(await page.evaluate(() => window.__menuLab.menu.snapshot().center.x)).toBeCloseTo(25 / 1280, 3);
    await shot(page, "edge-selected");
  });

  test("dropped tracking shows hand-lost, then cancels after 0.3 s", async ({ page }) => {
    await openLab(page);
    await page.mouse.move(640, 430);
    await page.mouse.down();
    await step(page, 300);
    await page.mouse.move(640 + px(0.5), 430);
    await step(page, 100);
    await page.locator("#drop").dispatchEvent("click");
    await step(page, 150);
    await shot(page, "tracking-lost");
    expect(await page.evaluate(() => window.__menuLab.last.state)).toBe("open");
    await step(page, 200);
    await expect(page.locator("#log")).toContainText("cancelled (tracking-lost)");
    await page.mouse.up();
  });
});

test.describe("radial menu lab: Sound sub-menu", () => {
  const sub = (name) => `${SCREENS_DIR}/submenu-${name}.png`;
  const snap = (page) => page.evaluate(() => window.__menuLab.menu.snapshot());
  const deg = (a) => (a * Math.PI) / 180;
  /** Fist at (angle, dist in hand sizes) from a canvas point. */
  const to = (page, c, a, d, steps = 4) =>
    page.mouse.move(c.x + Math.cos(deg(a)) * px(d), c.y + Math.sin(deg(a)) * px(d), { steps });
  const subCenterPx = async (page) => {
    const s = await snap(page);
    return { x: s.center.x * W, y: s.center.y * H };
  };

  async function enterSound(page, c = { x: 640, y: 250 }) {
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await step(page, 300);
    await to(page, c, 90, 0.75);
    await step(page, 250);
    expect((await step(page, 0)).level).toBe(1);
    return c;
  }

  test("down arc carries the sub-menu mark; passing through opens the sub-ring with a breadcrumb", async ({ page }) => {
    await openLab(page);
    const c = { x: 640, y: 250 };
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await step(page, 300);
    await page.screenshot({ path: sub("main-ring") });
    await page.screenshot({ path: sub("mark"), clip: { x: 440, y: 60, width: 400, height: 400 } });

    await to(page, c, 90, 0.7);
    let r = await step(page, 64); // selected, still passing through
    expect(r.selectedId).toBe("sound");
    expect(r.level).toBe(0);
    expect((await snap(page)).subPending).toBeGreaterThan(0.2);
    await page.screenshot({ path: sub("passing") });

    r = await step(page, 120);
    expect(r.level).toBe(1);
    await expect(page.locator("#log")).toContainText("submenu: sound");
    await step(page, 60); // mid-transition: parent ring shrinking toward the breadcrumb
    await page.screenshot({ path: sub("opening") });
    await step(page, 200);
    await page.screenshot({ path: sub("open") });
    await expect(page.locator("#status")).toHaveAttribute("data-level", "1");
    const s = await snap(page);
    expect(s.items.map((i) => i.id)).toEqual(["warm", "bright", "retro", "organ", "electric", "sax"]);
    expect(s.currentId).toBe("warm");
  });

  test("pick an instrument: approach, selected, flash, value pill; badge updates without a countdown", async ({ page }) => {
    await openLab(page);
    await enterSound(page);
    const c = await subCenterPx(page);
    await to(page, c, 15, 0.42); // Electric (right), approaching
    let r = await step(page, 150);
    expect(r.hoverId).toBe("electric");
    expect(r.selectedId).toBe(null);
    await page.screenshot({ path: sub("approach") });
    await to(page, c, 15, 0.9);
    r = await step(page, 150);
    expect(r.selectedId).toBe("electric");
    await page.screenshot({ path: sub("selected") });
    await page.screenshot({ path: sub("selected-crop"), clip: { x: c.x - 260, y: c.y - 220, width: 520, height: 400 } });

    await page.mouse.up();
    await step(page, 48);
    await expect(page.locator("#log")).toContainText("set sound/base: electric");
    await expect(page.locator("#badge")).toHaveAttribute("data-sound", "electric");
    await expect(page.locator("#badge")).toHaveAttribute("data-mode", "chords"); // mode unchanged
    expect((await page.evaluate(() => window.__menuLab.last)).state).toBe("flash");
    await step(page, 40);
    await page.screenshot({ path: sub("flash") });
    await step(page, 120);
    expect((await page.evaluate(() => window.__menuLab.last)).state).toBe("closed");
    await expect(page.locator("#log")).toContainText("setting done");
    await step(page, 100);
    await page.screenshot({ path: sub("done") });
    await step(page, 400);
    await expect(page.locator("#log")).not.toContainText("confirmed:");
  });

  test("current instrument shows the dot and 'Already set'; release changes nothing", async ({ page }) => {
    await openLab(page);
    await enterSound(page);
    const c = await subCenterPx(page);
    await to(page, c, -145, 0.9); // Warm (up-left) = current
    const r = await step(page, 150);
    expect(r.selectedId).toBe("warm");
    await page.screenshot({ path: sub("selected-current") });
    await page.mouse.up();
    await step(page, 64);
    await expect(page.locator("#log")).toContainText("cancelled (same-item)");
    await expect(page.locator("#badge")).toHaveAttribute("data-sound", "warm");
  });

  test("moving up goes back to the main ring; open hand in the sub-ring center cancels all levels", async ({ page }) => {
    await openLab(page);
    await enterSound(page);
    const c = await subCenterPx(page);
    await to(page, c, -90, 0.45);
    await step(page, 120);
    expect((await snap(page)).hoverBack).toBe(true);
    await page.screenshot({ path: sub("back-hover") });
    await to(page, c, -90, 0.7);
    const r = await step(page, 32);
    expect(r.level).toBe(0);
    await expect(page.locator("#log")).toContainText("back");
    await step(page, 200);
    await page.screenshot({ path: sub("back") });

    // through again, then cancel from the sub-ring's center
    const s0 = await snap(page);
    const main = { x: s0.center.x * W, y: s0.center.y * H };
    await to(page, main, 90, 0.75);
    await step(page, 250);
    expect((await step(page, 0)).level).toBe(1);
    const c2 = await subCenterPx(page);
    await page.mouse.move(c2.x + 5, c2.y + 5);
    await step(page, 50);
    await page.mouse.up();
    await step(page, 64);
    await expect(page.locator("#log")).toContainText("cancelled (empty)");
    await page.screenshot({ path: sub("cancel-fade") });
  });

  test("in Lead the arc becomes 'Lead sound' (Lead color) and sets the lead instrument only", async ({ page }) => {
    await openLab(page);
    // switch to Lead first
    await page.mouse.move(640, 300);
    await page.mouse.down();
    await step(page, 300);
    await page.mouse.move(640 - px(0.9), 300, { steps: 4 });
    await step(page, 150);
    await page.mouse.up();
    await step(page, 700);
    await expect(page.locator("#badge")).toHaveAttribute("data-mode", "lead");
    await page.mouse.move(640, 300);
    await step(page, 50);

    await enterSound(page, { x: 640, y: 300 });
    const s = await snap(page);
    expect(s.parent.items.find((i) => i.id === "sound").label).toBe("Lead sound");
    expect(s.currentId).toBe("bright");
    const c = await subCenterPx(page);
    await to(page, c, -35, 0.9); // Sax (up-right)
    expect((await step(page, 150)).selectedId).toBe("sax");
    await page.screenshot({ path: sub("lead-selected") });
    await page.mouse.up();
    await step(page, 64);
    await expect(page.locator("#log")).toContainText("set sound/lead: sax");
    expect(await page.evaluate(() => ({ ...window.__menuLab.sounds }))).toEqual({ chords: "warm", arp: "warm", lead: "sax" });
  });

  test("bottom edge: the sub-ring is drawn where it fits, selection is relative to the real fist point", async ({ page }) => {
    await openLab(page);
    await enterSound(page, { x: 640, y: 640 });
    const s = await snap(page);
    expect(s.center.y * H).toBeGreaterThan(700); // real entry point stays low
    await step(page, 200);
    await page.screenshot({ path: sub("edge") });
    const c = await subCenterPx(page);
    await to(page, c, 165, 0.9); // Bright (left)
    expect((await step(page, 150)).selectedId).toBe("bright");
    await page.screenshot({ path: sub("edge-selected") });
  });
});
