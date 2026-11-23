// Modes UI in the real app (docs/ui-integration.md): layout contract, bus-driven states, screen
// controls, transport, first-use labels, guide/help extensions. Uses ?mockHands; states the engine
// can't produce yet are driven by publishing on window.__gsTest.bus directly.
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { leftHand, rightHand, pinch, fist } from "./helpers/hands.js";
import { makeView } from "../src/input/hand-input.js";
import { ensureArp, ensureLead, ensureMenu, frames, collectLayout } from "./helpers/m1-ui.js";

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};
const DESKTOP = VIEWPORTS.desktop;

const EXISTING = [
  "keySelect", "toneSelect", "guideToggle", "gestureGuide", "volumeMeter",
  "distortionDisplay", "chordDisplay", "qualityDisplay", "helpButton",
];

/**
 * Hands at realistic display positions. Default: chord hand on the screen right (the mock's MediaPipe
 * convention); `swap` puts it on the left. `right`: "open" | "pinch" | "fist" | null (not visible).
 */
function scene(vp, { swap = false, leftY = 0.57, rightY = 0.47, rightX, right = "open", rightOpts = {} } = {}) {
  const view = makeView(640, 480, vp.width, vp.height);
  const scale = vp.height > vp.width ? 0.8 : 1;
  const lx = swap ? 0.25 : 0.75;
  const rx = rightX ?? (swap ? 0.75 : 0.25);
  const L = leftHand(4, { pos: { x: lx, y: leftY }, view, scale });
  if (right === null) return [L];
  const o = { pos: { x: rx, y: rightY }, view, scale, ...rightOpts };
  const R = right === "pinch" ? pinch(o) : right === "fist" ? fist(o) : rightHand(3, { tilt: 0.4, ...o });
  return [L, R];
}

const overlap = (a, b) => a.x + a.w > b.x && b.x + b.w > a.x && a.y + a.h > b.y && b.y + b.h > a.y;

/** Layout contract (same rules as tests/ui-lab.spec.js, against the real app). */
function checkLayout({ existing, newDom, canvas, clear }, vp) {
  const fresh = [...newDom, ...canvas];
  const persistent = fresh.filter((r) => r.kind === "edge" || r.kind === "status");
  const panels = fresh.filter((r) => r.kind === "panel");
  // Phones: the mobile system (docs/mobile-ui.md) folds the badge + Controls toggle into its bar and hides
  // the meter while collapsed, so only the edge tracks (+ transport) remain as new persistent elements.
  expect(persistent.length, "new persistent elements found").toBeGreaterThan(vp.width < 600 ? 1 : 3);
  for (const n of [...persistent, ...panels]) {
    const r = n.rect;
    expect(r.x, `${n.name} left`).toBeGreaterThanOrEqual(0);
    expect(r.y, `${n.name} top`).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w, `${n.name} right`).toBeLessThanOrEqual(vp.width);
    expect(r.y + r.h, `${n.name} bottom`).toBeLessThanOrEqual(vp.height);
    // A mobile bottom sheet is a user-opened layer above everything (it may cover the chord while open).
    if (n.name.endsWith("(sheet)")) continue;
    for (const e of existing) expect(overlap(r, e.rect), `${n.name} overlaps existing ${e.name}`).toBe(false);
  }
  for (let i = 0; i < persistent.length; i++)
    for (let j = i + 1; j < persistent.length; j++)
      expect(overlap(persistent[i].rect, persistent[j].rect), `${persistent[i].name} overlaps ${persistent[j].name}`).toBe(false);
  // Nothing persistent (new or existing) inside the clear area; user-opened panels are exempt.
  for (const n of [...persistent, ...existing.filter((e) => e.name !== "#gestureGuide")])
    expect(overlap(n.rect, clear), `${n.name} intrudes on the clear area`).toBe(false);
}

const shot = (page, state, vpName) => page.screenshot({ path: `${SCREENS_DIR}/m1ui-${state}-${vpName}.png` });
const ui = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__gsTest.ui, panel: undefined })));
const bus = {
  get: (page, name) => page.evaluate((n) => window.__gsTest.bus.get(n), name),
  set: (page, name, v) => page.evaluate(([n, v]) => window.__gsTest.bus.set(n, v), [name, v]),
};

/** First-use labels are never cut by an open panel; the filter arc is not drawn for a hand under it. */
async function noHandFeedbackUnder(page, sel) {
  const b = await page.locator(sel).boundingBox();
  const panel = { x: b.x, y: b.y, w: b.width, h: b.height };
  const regions = (await ui(page)).regions;
  for (const r of regions.filter((r) => r.kind === "transient"))
    expect(overlap(r.rect, panel), `${r.name} drawn under ${sel}`).toBe(false);
  const arc = regions.find((r) => r.name === "filter-arc");
  if (arc) {
    const palm = { x: arc.rect.x + arc.rect.w / 2, y: arc.rect.y + (arc.rect.w - 12) / 2 + 6, w: 1, h: 1 };
    expect(overlap(palm, panel), `filter arc drawn for a hand under ${sel}`).toBe(false);
  }
}

/** Clicks a control; on phones it lives in the mobile bar's tray, so open the tray first. */
async function tapControl(page, sel) {
  if (!(await page.locator(sel).isVisible()) && (await page.locator("#gsPill").isVisible())) await page.locator("#gsPill").click();
  await page.locator(sel).click();
}

async function toArp(page) {
  await ensureArp(page);
  await page.evaluate(() => window.__gsTest.router.setMode("arp"));
  await expect(page.locator("#modeBadge")).toContainText("Arp");
}

// ---------------------------------------------------------------------------------------------
// Layout + screenshots, both viewports, both hand sides
// ---------------------------------------------------------------------------------------------

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`modes UI layout ${vpName}`, () => {
    test.use({ viewport: vp });

    for (const swap of [false, true]) {
      const tag = swap ? " (chord hand left)" : "";
      const sfx = swap ? "-swap" : "";

      test(`chords-play${tag}`, async ({ synthPage: page, setHands }) => {
        await setHands(...scene(vp, { swap }));
        await expect(page.locator("#chordDisplay")).toHaveText("D(IV)");
        await frames(page, 4);
        expect((await ui(page)).chordSide).toBe(swap ? "left" : "right");
        await shot(page, `chords-play${sfx}`, vpName);
        checkLayout(await collectLayout(page, EXISTING), vp);
      });

      test(`arp-play${tag}`, async ({ synthPage: page, setHands }) => {
        await toArp(page);
        await setHands(...scene(vp, { swap }));
        await frames(page, 30);
        await shot(page, `arp-play${sfx}`, vpName);
        checkLayout(await collectLayout(page, EXISTING), vp);
      });
    }

    test("controls-open", async ({ synthPage: page, setHands }) => {
      await toArp(page);
      await setHands(...scene(vp));
      await tapControl(page, "#controlsToggle");
      await expect(page.locator("#controlsPanel")).toBeVisible();
      await frames(page, 4);
      await shot(page, "controls-open", vpName);
      checkLayout(await collectLayout(page, EXISTING), vp);
      await noHandFeedbackUnder(page, "#controlsPanel");
    });

    test("guide-open", async ({ synthPage: page, setHands }) => {
      await toArp(page);
      await setHands(...scene(vp));
      await tapControl(page, "#guideToggle");
      await frames(page, 4);
      await shot(page, "guide-open", vpName);
      await noHandFeedbackUnder(page, "#gestureGuide");
      checkLayout(await collectLayout(page, EXISTING), vp);
    });

    test("menu-open", async ({ synthPage: page, setHands }) => {
      await ensureArp(page);
      await ensureMenu(page);
      await setHands(...scene(vp));
      await frames(page, 6);
      await setHands(...scene(vp, { right: "fist" }));
      await expect.poll(async () => (await ui(page)).menu.state).toBe("open");
      await setHands(...scene(vp, { right: "fist", rightX: 0.25 + (vp.width < 520 ? 0.1 : 0.05) }));
      await frames(page, 8);
      await shot(page, "menu-open", vpName);
      const u = await ui(page);
      expect(u.rightHeld).toBe(true);
      expect(u.tracks["right-track"].dim).toBe(true);
      expect(u.tracks["right-track"].heldY).not.toBeNull();
      checkLayout(await collectLayout(page, EXISTING), vp);
    });

    test("hand-lost", async ({ synthPage: page, setHands }) => {
      await toArp(page);
      await setHands(...scene(vp));
      await frames(page, 6);
      await setHands(...scene(vp, { right: null }));
      await expect.poll(async () => (await ui(page)).tracks["right-track"]?.lost).toBe(true);
      await frames(page, 2);
      await shot(page, "hand-lost", vpName);
      const names = (await ui(page)).regions.map((r) => r.name);
      expect(names).toContain("right-track-lost-label");
      expect(names).toContain("right-track-ghost");
      expect(names).not.toContain("filter-arc");
      await expect(page.locator("body")).toHaveClass(/gs-right-held/);
      checkLayout(await collectLayout(page, EXISTING), vp);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Behavior (desktop)
// ---------------------------------------------------------------------------------------------

test.describe("modes UI behavior", () => {
  test("mode badge follows the bus `mode` and opens the controls panel", async ({ synthPage: page }) => {
    const badge = page.locator("#modeBadge");
    await expect(badge).toHaveText("Chords");
    await expect(page.locator("body")).toHaveAttribute("data-mode", "chords");
    await bus.set(page, "mode", "arp");
    await expect(badge).toHaveText("Arp");
    await expect(page.locator("body")).toHaveAttribute("data-mode", "arp");
    await expect(badge).toHaveCSS("border-top-color", "rgb(79, 179, 255)");
    await bus.set(page, "mode", "chords");
    await expect(badge).toHaveCSS("border-top-color", "rgb(232, 161, 61)");
    await badge.click();
    await expect(page.locator("#controlsPanel")).toBeVisible();
  });

  test("meter shows volume in Chords and gate in Arp, in the mode color", async ({ synthPage: page, setHands }) => {
    await setHands(leftHand(4), rightHand(3, { volume: 0.75, tilt: 0.5 }));
    await expect(page.locator(".vol-bar.lit")).toHaveCount(6);
    await expect(page.locator(".vol-bar.lit").first()).toHaveCSS("background-color", "rgb(232, 161, 61)");

    await toArp(page);
    await setHands(leftHand(4)); // right hand away: Arp keeps its last values
    await frames(page, 3);
    await bus.set(page, "arp/gate", 0.5);
    await expect(page.locator(".vol-bar.lit")).toHaveCount(4);
    await expect(page.locator(".vol-bar.lit").first()).toHaveCSS("background-color", "rgb(79, 179, 255)");
    await bus.set(page, "volume", 0.0); // master/chord volume must not hijack the Arp meter
    await frames(page, 2);
    await expect(page.locator(".vol-bar.lit")).toHaveCount(4);
    await bus.set(page, "arp/gate", 1);
    await expect(page.locator(".vol-bar.lit")).toHaveCount(8);
  });

  test("filter readout follows the right hand in Arp and dims while held", async ({ synthPage: page, setHands }) => {
    await toArp(page);
    await setHands(...scene(DESKTOP, { rightOpts: { tilt: -0.3 } }));
    await expect(page.locator("#distortionDisplay")).toHaveText("Filter: -30%");
    await expect(page.locator("#distortionDisplay")).toHaveCSS("color", "rgb(79, 179, 255)");
    // Real hold (M1 wiring): a right fist opens the menu; Arp publishes `filter` itself, so only a
    // real hold (mode.update not called) freezes it.
    await setHands(...scene(DESKTOP, { right: "fist", rightOpts: { tilt: 0.6 } }));
    await expect.poll(() => bus.get(page, "menu").then((m) => m?.state)).toBe("open");
    await expect(page.locator("#distortionDisplay")).toHaveCSS("opacity", "0.4");
    await frames(page, 4);
    await expect(page.locator("#distortionDisplay")).toHaveText("Filter: -30%"); // frozen while held
    // Open hand in the center zone: the menu cancels and the filter crossfades to the live tilt.
    await setHands(...scene(DESKTOP, { rightOpts: { tilt: 0.6 } }));
    await expect.poll(() => bus.get(page, "menu")).toBe(null);
    await expect(page.locator("#distortionDisplay")).toHaveText("Filter: +60%");
  });

  for (const swap of [false, true]) {
    test(`edge-track markers are level with the hands${swap ? " (swapped)" : ""}`, async ({ synthPage: page, setHands }) => {
      // (0.4, was 0.3: markers stop at the ends of the hand's reach zone, src/input/reach-zones.js, and this tilted
      // synthetic hand's zone starts at 0.36 of the height. Level-with-the-palm inside the band is unchanged.)
      for (const [leftY, rightY] of [[0.57, 0.47], [0.4, 0.7]]) {
        await setHands(...scene(DESKTOP, { swap, leftY, rightY }));
        await frames(page, 4);
        const t = (await ui(page)).tracks;
        const master = swap ? "left" : "right";
        expect(t["master-track"].side).toBe(master);
        expect(t["right-track"].side).toBe(swap ? "right" : "left");
        expect(Math.abs(t["master-track"].markerY - leftY * DESKTOP.height)).toBeLessThanOrEqual(4);
        expect(Math.abs(t["right-track"].markerY - rightY * DESKTOP.height)).toBeLessThanOrEqual(4);
        expect(t["right-track"].heldY).toBeNull();
      }
    });
  }

  test("held state: dim right track + hollow marker; return state shows both markers", async ({ synthPage: page, setHands }) => {
    await toArp(page);
    await setHands(...scene(DESKTOP, { rightY: 0.5 }));
    await frames(page, 4);
    await bus.set(page, "menu", { state: "open" });
    await setHands(...scene(DESKTOP, { rightY: 0.3 }));
    await frames(page, 4);
    let t = (await ui(page)).tracks["right-track"];
    expect(t.dim).toBe(true);
    expect(t.markerY).toBeNull();
    expect(Math.abs(t.heldY - 0.5 * DESKTOP.height)).toBeLessThanOrEqual(4);
    expect((await ui(page)).regions.map((r) => r.name)).not.toContain("filter-arc");
    await shot(page, "held", "desktop");

    // Engine still holds the gate after the menu (`held` signal): hollow at the value + solid at the hand.
    await bus.set(page, "menu", { state: "closed" });
    await bus.set(page, "held", { "arp/gate": 0.25 });
    await frames(page, 3);
    t = (await ui(page)).tracks["right-track"];
    expect(t.dim).toBe(false);
    expect(t.markerY).not.toBeNull();
    expect(t.heldY).not.toBeNull();
    await expect(page.locator("body")).toHaveClass(/gs-right-held/);
    await shot(page, "return", "desktop");
    await bus.set(page, "held", null);
    await frames(page, 3);
    expect((await ui(page)).tracks["right-track"].heldY).toBeNull();
    await expect(page.locator("body")).not.toHaveClass(/gs-right-held/);
  });

  test("held marker stays through a mode switch at countdown start", async ({ synthPage: page, setHands }) => {
    await ensureArp(page);
    await setHands(...scene(DESKTOP));
    await frames(page, 4);
    await bus.set(page, "menu", { state: "countdown", confirmed: "arp" });
    await frames(page, 2);
    await page.evaluate(() => window.__gsTest.router.setMode("arp")); // the router switches at countdown start
    await frames(page, 3);
    const t = (await ui(page)).tracks["right-track"];
    expect(t.dim).toBe(true);
    expect(t.heldY).not.toBeNull();
    await expect(page.locator("#modeBadge")).toHaveText("Arp");
  });

  test("tracks don't swap edges when one hand crosses the middle; they do once both hands swap", async ({ synthPage: page, setHands }) => {
    await setHands(...scene(DESKTOP));
    await frames(page, 4);
    expect((await ui(page)).chordSide).toBe("right");
    const view = makeView(640, 480, 1280, 800);
    await setHands(leftHand(4, { pos: { x: 0.3, y: 0.5 }, view })); // chord hand alone, reaching across
    await page.waitForTimeout(800);
    expect((await ui(page)).chordSide).toBe("right");
    await setHands(...scene(DESKTOP, { swap: true })); // a brief swap is ignored...
    await frames(page, 2);
    expect((await ui(page)).chordSide).toBe("right");
    await expect.poll(async () => (await ui(page)).chordSide, { timeout: 3000 }).toBe("left"); // ...a held one is not
  });

  test("Arp pinch holds the gate track and shows the tempo delta in the transport", async ({ synthPage: page, setHands }) => {
    await toArp(page);
    await setHands(...scene(DESKTOP));
    await frames(page, 4);
    await setHands(...scene(DESKTOP, { right: "pinch" }));
    await expect.poll(async () => (await ui(page)).rightHeld).toBe(true);
    const bpm = await bus.get(page, "bpm");
    await page.evaluate((b) => (window.__gsTest.ctx.clock.bpm = b + 6), bpm);
    await expect(page.locator("#transport .gs-delta")).toHaveText("+6");
    await expect(page.locator("#transport .gs-bpm-n")).toHaveText(String(bpm + 6));
    await setHands(...scene(DESKTOP));
    await expect(page.locator("#transport .gs-delta")).toHaveText("");
  });

  test("Controls panel and gesture guide are mutually exclusive", async ({ synthPage: page }) => {
    const panel = page.locator("#controlsPanel");
    const guide = page.locator("#gestureGuide");
    const ctl = page.locator("#controlsToggle");
    const gt = page.locator("#guideToggle");
    await ctl.click();
    await expect(panel).toBeVisible();
    await expect(ctl).toHaveAttribute("aria-pressed", "true");
    await gt.click();
    await expect(guide).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(ctl).toHaveAttribute("aria-pressed", "false");
    await ctl.click();
    await expect(panel).toBeVisible();
    await expect(guide).toBeHidden();
    await expect(gt).toHaveText("Open Guide");
    await ctl.click();
    await expect(panel).toBeHidden();
    // The guide toggle keeps one width, so "Controls" never crowds "Close Guide".
    const w1 = (await gt.boundingBox()).width;
    await gt.click();
    await expect(gt).toHaveText("Close Guide");
    const w2 = (await gt.boundingBox()).width;
    expect(w2).toBe(w1);
    const gb = await gt.boundingBox();
    const cb = await ctl.boundingBox();
    expect(cb.x - (gb.x + gb.width)).toBeGreaterThanOrEqual(6);
  });

  test("panel rows drive the engine: mode, pattern, rate, octaves, tempo, tap, double", async ({ synthPage: page }) => {
    await ensureArp(page);
    await page.locator("#controlsToggle").click();
    const panel = page.locator("#controlsPanel");
    await panel.locator('[data-control="mode"] button[data-value="arp"]').click();
    await expect.poll(() => bus.get(page, "mode")).toBe("arp");
    await expect(panel.locator('[data-control="mode"] button.on')).toHaveText("Arp");

    await panel.locator('[data-control="pattern"] button[data-value="down"]').click();
    await expect.poll(() => bus.get(page, "arp/pattern")).toBe("down");
    await panel.locator('[data-control="rate"] button[data-value="0.0625"]').click();
    await expect.poll(() => bus.get(page, "arp/rate")).toBe(1 / 16);
    await panel.locator('[data-control="octaves"] button[data-value="2"]').click();
    await expect.poll(() => bus.get(page, "arp/octaves")).toBe(2);

    const bpm0 = await bus.get(page, "bpm");
    await panel.locator('[data-control="bpm-up"]').click();
    await expect.poll(() => bus.get(page, "bpm")).toBe(bpm0 + 1);
    await expect(panel.locator('[data-control="bpm"]')).toHaveText(String(bpm0 + 1));

    const tap = panel.locator('[data-control="bpm-tap"]');
    await expect(tap).toBeVisible();
    // Four taps 500 ms apart (timed in the page so test-runner latency doesn't skew them) -> ~120 BPM.
    await tap.evaluate(async (b) => {
      for (let i = 0; i < 4; i++) {
        b.click();
        if (i < 3) await new Promise((r) => setTimeout(r, 500));
      }
    });
    const tapped = await bus.get(page, "bpm");
    expect(tapped).toBeGreaterThan(108);
    expect(tapped).toBeLessThan(125);

    await panel.locator('[data-control="double"]').click();
    await expect.poll(() => bus.get(page, "arp/double")).toBe(true);

    await expect(panel.locator('[data-hook="output"]')).toContainText("Off");
    await panel.locator('[data-control="mode"] button[data-value="chords"]').click();
    await expect.poll(() => bus.get(page, "mode")).toBe("chords");
    await expect(panel.locator('[data-control="gate"]')).toHaveCount(0);
  });

  test("a moved screen control wins until the hand moves again", async ({ synthPage: page, setHands }) => {
    await toArp(page);
    await setHands(...scene(DESKTOP, { rightY: 0.45 }));
    await frames(page, 4);
    const handGate = await bus.get(page, "arp/gate");
    await page.locator("#controlsToggle").click();
    const gateRow = page.locator('#controlsPanel .arp-controls > .arp-row:has([data-control="gate"])');
    await expect(gateRow).toHaveClass(/gs-owned/); // hand mark: the gesture owns the gate
    await expect(gateRow.locator(".gs-hand")).toBeVisible();

    await page.locator('#controlsPanel [data-control="gate"]').fill("0.1");
    await frames(page, 10); // the hand is still there and still updating every frame
    expect(await bus.get(page, "arp/gate")).toBeCloseTo(0.1, 5);
    expect((await ui(page)).overrides).toContain("arp/gate");
    expect(await bus.get(page, "ui/override")).toContain("arp/gate");
    await expect(gateRow).not.toHaveClass(/gs-owned/);
    expect((await ui(page)).tracks["right-track"].heldY).not.toBeNull(); // hollow = screen value

    await setHands(...scene(DESKTOP, { rightY: 0.3 })); // the hand moves: gesture takes over again
    await expect.poll(() => bus.get(page, "arp/gate")).toBeGreaterThan(handGate + 0.05);
    expect((await ui(page)).overrides).not.toContain("arp/gate");
    await expect(gateRow).toHaveClass(/gs-owned/);

    // Master volume: same rule with the left hand.
    await page.locator('#controlsPanel [data-control="master"]').fill("0.3");
    await frames(page, 4);
    expect(await page.evaluate(() => window.__gsTest.ctx.masterVolume)).toBeCloseTo(0.3, 5);
    expect((await ui(page)).overrides).toContain("master");
    await setHands(...scene(DESKTOP, { rightY: 0.3, leftY: 0.35 }));
    await expect.poll(async () => (await ui(page)).overrides).not.toContain("master");
  });

  test("transport: Arp only; beat dots switch at the beat's playTime and pulse", async ({ synthPage: page }) => {
    const tr = page.locator("#transport");
    await expect(tr).toBeHidden();
    await bus.set(page, "mode", "arp"); // UI only: no clock running, beats come from the bus
    await expect(tr).toBeVisible();
    await bus.set(page, "bpm", 96);
    await expect(tr.locator(".gs-bpm-n")).toHaveText("96");
    const dots = tr.locator(".gs-beats i");
    await expect(tr.locator(".gs-steps i")).toHaveCount(8);

    // A beat scheduled 300 ms ahead: not shown before its playTime, shown (and pulsing) after it.
    await page.evaluate(() => {
      const t = window.__gsTest;
      t.bus.emit("beat", 3, t.ctx.audio.ac.currentTime + 0.3);
    });
    // Watch every frame in the page: when the dot turns on, it must be pulsing (scaled up) in that frame.
    const seen = await page.evaluate(
      () => new Promise((res) => {
        const dot = document.querySelectorAll("#transport .gs-beats i")[2];
        const t0 = performance.now();
        let early = dot.classList.contains("on");
        const step = () => {
          if (performance.now() - t0 < 150 && dot.classList.contains("on")) early = true;
          if (dot.classList.contains("on"))
            return res({ early, after: performance.now() - t0, pulse: document.getElementById("transport").dataset.pulse, scale: dot.style.transform });
          if (performance.now() - t0 > 2000) return res({ early, after: -1 });
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      })
    );
    expect(seen.early, "beat dot switched before its playTime").toBe(false);
    expect(seen.after).toBeGreaterThan(150);
    expect(seen.pulse).toBe("1");
    expect(seen.scale).toMatch(/scale\(1\.[3-5]/);
    await expect(tr).toHaveAttribute("data-pulse", "0");
    await page.evaluate(() => window.__gsTest.bus.emit("beat", 4, window.__gsTest.ctx.audio.ac.currentTime));
    await expect(dots.nth(3)).toHaveClass(/on/);
    await expect(dots.nth(2)).not.toHaveClass(/on/);
    await expect(tr.locator(".gs-steps i.on")).toHaveCount(1);

    await bus.set(page, "mode", "chords");
    await expect(tr).toBeHidden();
  });

  test("transport runs with the real Arp clock", async ({ synthPage: page, setHands }) => {
    await toArp(page);
    await setHands(...scene(DESKTOP));
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(150);
      seen.add(await page.locator("#transport .gs-beats i.on").evaluate((e) => [...e.parentNode.children].indexOf(e)));
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  test("first-use labels show ~3 s in Arp, then go; again while the guide is open", async ({ synthPage: page, setHands }) => {
    await setHands(...scene(DESKTOP));
    await frames(page, 3);
    expect((await ui(page)).firstUse).toBe(false); // Chords: none
    await toArp(page);
    await expect.poll(async () => (await ui(page)).firstUse).toBe(true);
    const names = (await ui(page)).regions.filter((r) => r.kind === "transient").map((r) => r.name);
    expect(names.sort()).toEqual(["first-use-arc", "first-use-thumb", "first-use-track", "first-use-under"]);
    await shot(page, "arp-firstuse", "desktop");
    await page.waitForTimeout(2700);
    await expect.poll(async () => (await ui(page)).firstUse, { timeout: 2000 }).toBe(false);
    await page.locator("#guideToggle").click();
    await expect.poll(async () => (await ui(page)).firstUse).toBe(true);
    await page.locator("#guideToggle").click();
    await expect.poll(async () => (await ui(page)).firstUse).toBe(false);
  });

  test("gesture guide and help modal contain the new gestures", async ({ synthPage: page }) => {
    const guide = page.locator("#gestureGuide");
    await page.locator("#guideToggle").click();
    await expect(guide.locator(".gesture-guide-note")).toHaveCount(7); // existing rows untouched
    await expect(guide.locator(".gs-guide-mode .gs-guide-label")).toHaveText(["Menu", "Volume", "Octave down"]);
    await bus.set(page, "mode", "arp");
    await expect(guide.locator(".gs-guide-head")).toContainText("Arp");
    await expect(guide.locator(".gs-guide-mode .gs-guide-label")).toHaveText(["Menu", "Gate", "Double time", "Tempo"]);
    await page.locator("#keySelect").selectOption({ label: "D" }); // controls.js re-renders the guide
    await expect(guide.locator(".gesture-guide-note").first()).toHaveText("D");
    await expect(guide.locator(".gs-guide-mode .gs-guide-label")).toHaveText(["Menu", "Gate", "Double time", "Tempo"]);

    await page.locator("#helpButton").click();
    const modal = page.locator("#helpModal");
    await expect(modal).toContainText("Modes");
    await expect(modal).toContainText("Right fist");
    await expect(modal).toContainText("master volume");
    await expect(modal).toContainText("Right Hand (Chords mode)");
    await expect(modal).toContainText("Arp mode");
    await expect(modal).toContainText("double time");
    await expect(modal).toContainText("Left Hand");
  });

  test("Output row turns the visualizer output on and off (M3 chip API)", async ({ synthPage: page }) => {
    await page.locator("#controlsToggle").click();
    const sw = page.locator('#controlsPanel [data-control="output"]');
    const note = page.locator('#controlsPanel [data-hook="output-status"]');
    await expect(note).toHaveText("Off");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => window.__gsTest.output.status.state)).not.toBe("off");
    await expect(note).not.toHaveText("Off");
    await sw.click();
    await expect(note).toHaveText("Off");
    await expect.poll(() => page.evaluate(() => window.__gsTest.output.status.state)).toBe("off");
  });

  test("Lead (layer on Chords): no right track (the ladder replaces it), meter = Chords' held volume dimmed, note-set badge in row 1", async ({ synthPage: page, setHands }) => {
    await ensureLead(page);
    await setHands(...scene(DESKTOP));
    await page.evaluate(() => window.__gsTest.router.setMode("lead"));
    await expect(page.locator("#modeBadge")).toHaveText("Chords+Lead");
    await expect(page.locator("#volumeMeter")).toBeVisible();
    await expect.poll(() => page.locator("#volumeMeter").evaluate((e) => Number(getComputedStyle(e).opacity))).toBeLessThan(0.6);
    await expect(page.locator("#noteSetBadge")).toBeVisible();
    await expect(page.locator("#noteSetBadge i.on")).toHaveCount(1);
    await frames(page, 4);
    const t = (await ui(page)).tracks;
    expect(t["master-track"]).toBeTruthy();
    expect(t["right-track"]).toBeUndefined();
    await page.locator("#guideToggle").click();
    await expect(page.locator("#gestureGuide .gs-guide-mode")).not.toHaveCount(0);
    await page.locator("#guideToggle").click();
    await shot(page, "lead-play", "desktop");
    checkLayout(await collectLayout(page, EXISTING), DESKTOP);
  });

  test("bright room legibility (screenshot)", async ({ synthPage: page, setHands }) => {
    await toArp(page);
    await setHands(...scene(DESKTOP));
    // Paint the video area white under the overlays: worst case for the edge tracks and guides.
    await page.addStyleTag({ content: "#overlay{background:#fff}" });
    await page.evaluate(() => {
      const c = document.getElementById("overlay");
      const g = c.getContext("2d");
      const orig = g.drawImage.bind(g);
      g.drawImage = (...a) => {
        orig(...a);
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = "#ece8e0";
        g.fillRect(0, 0, c.width, c.height);
        g.restore();
      };
    });
    await frames(page, 10);
    await shot(page, "arp-bright", "desktop");
  });
});
