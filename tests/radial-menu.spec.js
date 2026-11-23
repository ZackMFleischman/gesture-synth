// Radial menu: state-machine unit tests (Node) + lab page tests (browser, screenshots, video).
import { test as base, expect as baseExpect } from "@playwright/test";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { createMenuState, MENU_GEOMETRY as G, MENU_TIMING as T, pickDirection } from "../src/menu/menu-state.js";

// ---------------------------------------------------------------------------------------
// Unit tests: pure state machine
// ---------------------------------------------------------------------------------------

const ITEMS = [
  { id: "chords", type: "mode", label: "Chords", color: "#f2b14c", direction: "up" },
  { id: "arp", type: "mode", label: "Arp", color: "#4fb3ff", direction: "right" },
  { id: "lead", type: "mode", label: "Lead", color: "#5fd08a", direction: "left" },
];
const FOUR = [...ITEMS, { id: "bass", type: "mode", label: "Bass", color: "#c77dff", direction: "down" }];
const DT = 16;

/** Small driver: a fake right hand + clock. Positions in display-normalized coords. */
function rig({ items = ITEMS, current = "chords", aspect = 1, size = 0.1, x = 0.5, y = 0.5 } = {}) {
  let ticks = 0;
  const m = createMenuState({ items: () => items, currentId: () => current, onTick: () => ticks++, aspect });
  const h = { fist: false, x, y, size, thumb: false, visible: true };
  let now = 1000;
  const frame = () =>
    h.visible
      ? {
          handedness: "Right",
          fist: h.fist,
          fingers: { thumb: h.thumb, index: !h.fist, middle: !h.fist, ring: !h.fist, pinky: !h.fist },
          pos: { x: h.x, y: h.y },
          handSize: h.size,
          t: now,
        }
      : null;
  const results = [];
  const run = (ms) => {
    let r;
    const end = now + ms;
    do {
      now += DT;
      r = m.update(frame(), now);
      results.push(r);
    } while (now < end);
    return r;
  };
  /** Move by (dx, dy) in hand sizes, isotropic (dy scaled by aspect). */
  const moveTo = (dxS, dyS, cx = x, cy = y) => {
    h.x = cx + dxS * h.size;
    h.y = cy + dyS * h.size * aspect;
  };
  const open = (ms = 120) => {
    h.fist = true;
    return run(ms);
  };
  const any = (key) => results.some((r) => r[key]);
  return { m, h, run, moveTo, open, results, any, ticks: () => ticks, get now() { return now; } };
}

base.describe("radial menu state machine", () => {
  const expect = baseExpect;

  base("enters only after ~100 ms of stable fist", () => {
    const r = rig();
    r.h.fist = true;
    expect(r.run(64).state).toBe("closed");
    expect(r.m.isHoldingRight()).toBe(false);
    const res = r.run(64); // total >= 100 ms
    expect(res.state).toBe("open");
    expect(r.any("opened")).toBe(true);
    expect(r.m.isHoldingRight()).toBe(true);
    expect(r.m.snapshot().center).toEqual({ x: 0.5, y: 0.5 });
  });

  base("a flickering fist never opens the menu", () => {
    const r = rig();
    for (let i = 0; i < 20; i++) {
      r.h.fist = true;
      r.run(64);
      r.h.fist = false;
      r.run(16);
    }
    expect(r.results.every((x) => x.state === "closed")).toBe(true);
  });

  base("thumb state is irrelevant for entry", () => {
    const r = rig();
    r.h.fist = true;
    for (let i = 0; i < 8; i++) {
      r.h.thumb = !r.h.thumb;
      r.run(16);
    }
    expect(r.results.at(-1).state).toBe("open");
  });

  base("angle from the entry point picks the arc in all 4 directions", () => {
    const cases = [
      [0, -1, "chords"],
      [1, 0, "arp"],
      [0, 1, "bass"],
      [-1, 0, "lead"],
      [0.7, -0.5, "arp"], // within the right sector
      [-0.3, -0.8, "chords"],
    ];
    for (const [dx, dy, id] of cases) {
      const r = rig({ items: FOUR });
      r.open();
      r.moveTo(dx * 0.6, dy * 0.6);
      const res = r.run(16);
      expect(res.hoverId, `${dx},${dy}`).toBe(id);
      expect(res.selectedId).toBe(null);
      expect(res.progress).toBeGreaterThan(0);
      expect(res.progress).toBeLessThan(1);
    }
  });

  base("empty direction (down, no item) lights nothing", () => {
    const r = rig();
    r.open();
    r.moveTo(0, 1.2);
    const res = r.run(16);
    expect(res.hoverId).toBe(null);
    expect(res.selectedId).toBe(null);
  });

  base("center dead zone: no arc lit, progress grows with distance", () => {
    const r = rig();
    r.open();
    r.moveTo(G.DEAD_R * 0.8, 0);
    let res = r.run(16);
    expect(res.hoverId).toBe(null);
    expect(res.progress).toBe(0);
    const ps = [];
    for (const d of [0.35, 0.5, 0.7]) {
      r.moveTo(d, 0);
      ps.push(r.run(16).progress);
    }
    expect(ps[0]).toBeLessThan(ps[1]);
    expect(ps[1]).toBeLessThan(ps[2]);
    r.moveTo(G.SELECT_R + 0.05, 0);
    res = r.run(16);
    expect(res.progress).toBe(1);
  });

  base("selection at the select radius with hysteresis, tick fires once", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R - 0.05, 0);
    expect(r.run(16).selectedId).toBe(null);
    r.moveTo(G.SELECT_R + 0.02, 0);
    expect(r.run(16).selectedId).toBe("arp");
    expect(r.ticks()).toBe(1);
    // jitter around the select radius: stays selected, no extra ticks
    for (const d of [G.SELECT_R - 0.1, G.SELECT_R + 0.01, G.DESELECT_R + 0.03, G.SELECT_R]) {
      r.moveTo(d, 0);
      expect(r.run(16).selectedId).toBe("arp");
    }
    expect(r.ticks()).toBe(1);
    // well back inside: deselects
    r.moveTo(G.DESELECT_R - 0.05, 0);
    expect(r.run(16).selectedId).toBe(null);
    // and re-selecting ticks again
    r.moveTo(G.SELECT_R + 0.1, 0);
    expect(r.run(16).selectedId).toBe("arp");
    expect(r.ticks()).toBe(2);
  });

  base("moving across to another arc beyond the radius switches selection", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    expect(r.run(16).selectedId).toBe("arp");
    r.moveTo(0, -(G.SELECT_R + 0.1));
    expect(r.run(16).selectedId).toBe("chords");
    expect(r.ticks()).toBe(2);
    r.moveTo(0, G.SELECT_R + 0.1); // empty "down" sector
    expect(r.run(16).selectedId).toBe(null);
  });

  base("sector hysteresis: a diagonal does not flicker between arcs", () => {
    expect(pickDirection(-40, null)).toBe("right");
    expect(pickDirection(-50, null)).toBe("up");
    expect(pickDirection(-50, "right")).toBe("right"); // within 45 + 10
    expect(pickDirection(-60, "right")).toBe("up");
  });

  base("confirm: open hand on a selected item -> confirmed, countdown, closed", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    r.h.fist = false;
    const res = r.run(T.OPEN_DEBOUNCE_MS + 16);
    expect(r.any("confirmed")).toBe(true);
    expect(r.results.find((x) => x.confirmed).confirmed).toBe("arp");
    expect(res.state).toBe("countdown");
    expect(r.m.isHoldingRight()).toBe(true);
    expect(r.any("cancelled")).toBe(false);
    r.run(T.FLASH_MS + T.COUNTDOWN_MS - 80);
    expect(r.m.isHoldingRight()).toBe(true);
    const end = r.run(120);
    expect(end.state).toBe("closed");
    expect(r.any("finished")).toBe(true);
    expect(r.m.isHoldingRight()).toBe(false);
  });

  base("cancel: open hand with nothing selected -> cancelled, no change", () => {
    const r = rig();
    r.open();
    r.moveTo(0.5, 0); // approaching, not selected
    expect(r.run(16).hoverId).toBe("arp");
    r.h.fist = false;
    const res = r.run(T.OPEN_DEBOUNCE_MS + 16);
    expect(res.state).toBe("closed");
    const c = r.results.find((x) => x.cancelled);
    expect(c.reason).toBe("empty");
    expect(r.any("confirmed")).toBe(false);
    expect(r.m.isHoldingRight()).toBe(false);
  });

  base("a single non-fist frame does not confirm (debounce)", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    r.h.fist = false;
    r.run(16);
    r.h.fist = true;
    const res = r.run(64);
    expect(res.state).toBe("open");
    expect(res.selectedId).toBe("arp");
  });

  base("selecting the current item = no change, no countdown", () => {
    const r = rig({ current: "arp" });
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    expect(r.run(16).selectedId).toBe("arp");
    r.h.fist = false;
    const res = r.run(T.OPEN_DEBOUNCE_MS + 16);
    expect(res.state).toBe("closed");
    expect(r.any("confirmed")).toBe(false);
    expect(r.results.find((x) => x.cancelled).reason).toBe("same-item");
  });

  base("tracking lost: kept for 0.3 s, then cancelled; recovery within grace continues", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    r.h.visible = false;
    let res = r.run(T.LOST_GRACE_MS - 50);
    expect(res.state).toBe("open");
    expect(res.selectedId).toBe("arp");
    r.h.visible = true;
    res = r.run(16);
    expect(res.state).toBe("open");
    expect(res.selectedId).toBe("arp");
    r.h.visible = false;
    res = r.run(T.LOST_GRACE_MS + 20);
    expect(res.state).toBe("closed");
    expect(r.results.find((x) => x.cancelled).reason).toBe("tracking-lost");
    // a fist re-appearing does not immediately reopen; the hand must open first
    r.h.visible = true;
    expect(r.open(200).state).toBe("closed");
    r.h.fist = false;
    r.run(32);
    expect(r.open(120).state).toBe("open");
  });

  base("after a confirm the hand must open again before the menu can reopen", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    r.h.fist = false;
    r.run(64); // confirmed, hand seen open
    r.h.fist = true; // fist during the countdown
    r.run(T.FLASH_MS + T.COUNTDOWN_MS);
    const res = r.run(120); // countdown over, still fist -> reopens (hand was open after confirm)
    expect(res.state).toBe("open");
  });

  base("scale invariance: same relative movement gives same result at any hand size", () => {
    for (const size of [0.05, 0.1, 0.22]) {
      for (const [d, sel] of [
        [0.5, null],
        [G.SELECT_R + 0.05, "arp"],
      ]) {
        const r = rig({ size });
        r.open();
        r.moveTo(d, 0);
        const res = r.run(16);
        expect(res.hoverId, `size ${size}`).toBe("arp");
        expect(res.selectedId, `size ${size} d ${d}`).toBe(sel);
        expect(res.progress).toBeCloseTo(Math.min(1, (d - G.DEAD_R) / (G.SELECT_R - G.DEAD_R)), 5);
      }
    }
  });

  base("aspect: vertical distance is measured isotropically", () => {
    const aspect = 16 / 9;
    const r = rig({ aspect });
    r.open();
    r.moveTo(0, -(G.SELECT_R + 0.05)); // moveTo scales dy by aspect
    expect(r.run(16).selectedId).toBe("chords");
  });

  base("edge entry: movement is measured relative to the real entry point", () => {
    const r = rig({ x: 0.97, y: 0.04 });
    r.open();
    const snap = r.m.snapshot();
    expect(snap.center).toEqual({ x: 0.97, y: 0.04 });
    r.moveTo(-(G.SELECT_R + 0.1), 0, 0.97, 0.04);
    const res = r.run(16);
    expect(res.selectedId).toBe("lead");
    expect(r.m.snapshot().offset.x).toBeCloseTo(-(G.SELECT_R + 0.1) * 0.1, 6);
  });
});

// ---------------------------------------------------------------------------------------
// Lab page (browser): visuals, screenshots
// ---------------------------------------------------------------------------------------

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
