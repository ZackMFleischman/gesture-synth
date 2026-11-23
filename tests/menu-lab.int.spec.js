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
