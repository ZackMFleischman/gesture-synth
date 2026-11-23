// Lead lab fixture + hand helpers shared by tests/lead.spec.js and tests/lead-demo.spec.js.
import fs from "node:fs";
import { test as base, expect } from "@playwright/test";
import { AUDIO_TAP_SCRIPT } from "./audio.js";
import { results, rightHand, pinch, DESKTOP_VIEW } from "./hands.js";

export const SCREENS = "test-results/screens";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(AUDIO_TAP_SCRIPT);
    const errors = [];
    page.on("pageerror", (err) => errors.push(err));
    await use(page);
    expect(errors, "uncaught page errors").toEqual([]);
  },
  lab: async ({ page }, use) => {
    await page.goto("/labs/lead-lab.html?mockHands");
    await page.locator("#startOverlay").click();
    await expect(page.locator("#startOverlay")).toBeHidden();
    await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0);
    await page.waitForFunction(() => window.__gsTest.lead._debug().geo.W > 1);
    fs.mkdirSync(SCREENS, { recursive: true });
    await use(page);
  },
});

/** Right hand with the palm at display (x, y). Open hand = 4 fingers (a valid count unless `fingers`). */
export function rh({ y, x = 0.74, pinched = false, fingers = 4, ...rest }) {
  const pos = { x, y };
  if (pinched) return pinch({ pos, view: DESKTOP_VIEW, ...rest });
  return rightHand(fingers, { pos, view: DESKTOP_VIEW, ...rest });
}
/** Pre-pinch "claw": all fingers out, thumb near the index tip (not a deliberate count). */
export const preview = (y, x) => pinch({ pos: { x: x ?? 0.74, y }, view: DESKTOP_VIEW, distance: 0.55, fingers: ["index", "middle", "ring", "pinky"] });
export const play = (y, x) => pinch({ pos: { x: x ?? 0.74, y }, view: DESKTOP_VIEW, fingers: ["index", "middle", "ring", "pinky"] });

export async function setHands(page, ...hands) {
  await page.evaluate((r) => (window.__gsTest.results = r), results(...hands));
}
export const dbg = (page, at) => page.evaluate((at) => window.__gsTest.lead._debug(at ?? window.__gsTest.ctx.now), at);
export const yFor = (page, midi) => page.evaluate((m) => window.__gsTest.lead._yForMidi(m), midi);
export async function settle(page, ms = 120) {
  await page.waitForTimeout(ms);
}
export async function setKey(page, key) {
  await page.selectOption("#keySelect", { label: key === "Bb" ? "A#/Bb" : key === "Db" ? "C#/Db" : key === "Eb" ? "D#/Eb" : key === "Gb" ? "F#/Gb" : key === "Ab" ? "G#/Ab" : key });
}
export async function setNoteSet(page, n) {
  await page.locator(`.lead-controls [data-set="${n}"]`).click();
  await page.mouse.move(400, 400); // off the ladder strip
}

/**
 * Waits (per animation frame) until `cond(s, now)` holds for the Lead controller state `s`, freezes the lab
 * loop, saves test-results/screens/lead-<name>.png, and unfreezes. `cond` is serialized into the page.
 */
export async function snapWhen(page, name, cond, arg) {
  await page.waitForFunction(
    ([src, arg]) => {
      const t = window.__gsTest;
      const ok = new Function("s", "now", "arg", `return (${src})(s, now, arg);`)(t.lead._controller.state, t.ctx.now, arg);
      if (ok) t.freeze(true);
      return ok;
    },
    [cond.toString(), arg],
    { polling: "raf", timeout: 5000 }
  );
  await page.screenshot({ path: `${SCREENS}/lead-${name}.png` });
  await page.evaluate(() => window.__gsTest.freeze(false));
}

export { expect };
