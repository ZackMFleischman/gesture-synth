// Every page the dev server serves loads cleanly: no uncaught errors, no console errors (beyond a short,
// justified allow-list), its core element renders, and one core interaction works.
// labs/*.html is discovered at collection time, so a new lab page is smoke-tested without editing this file
// (generic checks; add an entry to PAGES for its core interaction).
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { AUDIO_TAP_SCRIPT } from "./helpers/audio.js";
import { results, leftHand, rightHand } from "./helpers/hands.js";

const SIGNAL = `ws://localhost:${process.env.PW_SIGNAL_PORT}`;

// Console errors that are not bugs. Every entry needs a reason.
const BENIGN_CONSOLE = [
  [/404 \(Not Found\) @ .*\/favicon\.ico$/, "no page ships a favicon; Chrome requests /favicon.ico anyway"],
];
const BENIGN_FAILED = [/\/favicon\.ico$/];

const setResults = (page, ...hands) => page.evaluate((r) => (window.__gsTest.results = r), results(...hands));

/** Per-page core element + interaction. Keys are URL paths (with query) relative to the server root. */
const PAGES = {
  "/": {
    // Real MediaPipe path: only the shell + start overlay here (the model download is smoke.spec.js).
    core: "#startOverlay",
    async interact(page) {
      await expect(page.locator("#overlay")).toHaveClass(/dimmed/);
      await page.locator("#startOverlay").click();
      await expect(page.locator("#startOverlay")).toBeHidden();
      await expect(page.locator("#overlay")).not.toHaveClass(/dimmed/);
    },
  },
  "/?mockHands": {
    core: "#chordDisplay",
    async interact(page) {
      await page.locator("#startOverlay").click();
      await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0);
      await setResults(page, leftHand(4), rightHand(1));
      await expect(page.locator("#chordDisplay")).toHaveText("D(IV)");
      await expect.poll(() => page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBe(4);
    },
  },
  "/labs/menu-lab.html": {
    // Real clock: the mouse is a fake right hand (down = fist). Holding a fist opens the menu.
    core: "#canvas",
    async interact(page) {
      await page.waitForFunction(() => !!window.__menuLab);
      await page.mouse.move(640, 430);
      await page.mouse.down();
      await expect.poll(() => page.evaluate(() => window.__menuLab.last?.state)).toBe("open");
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => window.__menuLab.last?.state)).not.toBe("open");
    },
  },
  "/labs/arp-lab.html": {
    core: "#startBtn",
    async interact(page) {
      await page.waitForFunction(() => !!window.__lab);
      await page.locator("#startBtn").click();
      await expect(page.locator("#startBtn")).toHaveText("Stop");
      await expect.poll(() => page.evaluate(() => window.__lab.arp.steps.length)).toBeGreaterThan(2);
      await page.locator("#startBtn").click();
      await expect(page.locator("#startBtn")).toHaveText("Start");
    },
  },
  "/labs/lead-lab.html?mockHands": {
    core: "#chordDisplay",
    async interact(page) {
      await page.locator("#startOverlay").click();
      await expect(page.locator("#startOverlay")).toBeHidden();
      await page.waitForFunction(() => window.__gsTest.lead._debug().geo.W > 1);
      await page.locator('#row3 [data-deg="5"]').click();
      await expect(page.locator("#chordDisplay")).toHaveText("E(V)");
    },
  },
  "/labs/ui-lab.html": {
    // Clicks through every state in the lab bar (the list comes from the page, so new states are covered).
    core: "#labBar",
    async interact(page) {
      await page.waitForFunction(() => window.__uiLab?.ready);
      const states = await page.locator("#labBar [data-s]").evaluateAll((bs) => bs.map((b) => b.dataset.s));
      expect(states.length).toBeGreaterThan(5);
      for (const s of states) {
        await page.locator(`#labBar [data-s="${s}"]`).click();
        await expect.poll(() => page.evaluate(() => window.__uiLab.state), { message: s }).toBe(s);
      }
    },
  },
  "/labs/gesture-test.html?mockHands": {
    core: "#hands",
    async interact(page) {
      await expect(page.locator("#source")).toContainText("mockHands");
      await setResults(page, leftHand(2), rightHand(3));
      await expect(page.locator("#hand-Right .dot.on")).toHaveCount(3);
      await expect(page.locator("#hand-Left .dot.on")).toHaveCount(2);
    },
  },
  [`/labs/visualizer.html?signal=${encodeURIComponent(SIGNAL)}`]: {
    // No synth hosts this room: the signaling server's answer ("Room not found", or "waiting" once a host
    // exists) proves the page, the client and the server are wired up.
    core: "#connect",
    async interact(page) {
      await expect(page.locator("#connText")).toHaveText("Not connected");
      await page.locator("#room").fill("K7QF-2M");
      await page.locator("#connect").click();
      await expect(page.locator("#connText")).toHaveText(/Room not found|Waiting for synth/);
      await page.locator("#connect").click();
      await expect(page.locator("#connText")).toHaveText("Not connected");
    },
  },
};

// Lab pages that only make sense with a query (or whose plain form needs the network, e.g. MediaPipe):
// the plain URL maps to the tested variant.
const VARIANT = {
  "/labs/lead-lab.html": "/labs/lead-lab.html?mockHands",
  "/labs/gesture-test.html": "/labs/gesture-test.html?mockHands",
  "/labs/visualizer.html": `/labs/visualizer.html?signal=${encodeURIComponent(SIGNAL)}`,
};

const labUrls = fs.readdirSync("labs")
  .filter((f) => f.endsWith(".html"))
  .sort()
  .map((f) => VARIANT[`/labs/${f}`] || `/labs/${f}`);
const urls = [...new Set(["/", "/?mockHands", ...labUrls])];

for (const url of urls) {
  const spec = PAGES[url];
  test(`page loads cleanly: ${url.replace(/\?signal=.*/, "")}`, async ({ page }) => {
    if (!spec) test.info().annotations.push({ type: "todo", description: `add a PAGES entry for ${url}` });
    await page.addInitScript(AUDIO_TAP_SCRIPT);
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = `${m.text()} @ ${m.location().url}`;
      if (!BENIGN_CONSOLE.some(([re]) => re.test(text))) consoleErrors.push(text);
    });
    const failed = [];
    page.on("response", (r) => {
      if (r.status() >= 400 && !BENIGN_FAILED.some((re) => re.test(r.url()))) failed.push(`${r.status()} ${r.url()}`);
    });

    await page.goto(url);
    if (spec) {
      await expect(page.locator(spec.core)).toBeVisible();
      await spec.interact(page);
    } else {
      // Generic: something visible rendered.
      await expect(page.locator("body")).toBeVisible();
      expect(await page.evaluate(() => document.body.innerText.trim().length + document.querySelectorAll("canvas").length)).toBeGreaterThan(0);
    }
    await page.waitForTimeout(300); // let late async errors surface
    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(consoleErrors, "console errors").toEqual([]);
    expect(failed, "failed requests (404s etc.)").toEqual([]);
  });
}
