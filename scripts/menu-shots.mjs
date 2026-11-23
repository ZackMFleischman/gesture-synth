// Quick manual check of the radial menu lab (auto-select): drives labs/menu-lab.html with the mouse on a manual clock,
// saves test-results/screens/menu-autoselect-<state>.png and prints console errors + the event log.
// Usage: dev server running (npx vite --port 5235), then `node scripts/menu-shots.mjs [baseUrl]`.
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.argv[2] || "http://localhost:5235";
const OUT = "test-results/screens";
fs.mkdirSync(OUT, { recursive: true });
const W = 1280;
const H = 800;
const SIZE = 0.12;
const px = (s) => s * SIZE * W;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${BASE}/labs/menu-lab.html?manualClock&noCamera`);
await page.waitForFunction(() => !!window.__menuLab);
const step = (ms) => page.evaluate((ms) => window.__menuLab.step(ms), ms);
const shot = (name) => page.screenshot({ path: `${OUT}/menu-autoselect-${name}.png` });

const cx = 640;
const cy = 430;
await page.mouse.move(cx, cy);
await page.mouse.down();
await step(300);
await page.mouse.move(cx + px(0.45), cy, { steps: 3 });
await step(120);
await shot("approach");
await page.mouse.move(cx + px(0.9), cy, { steps: 3 });
let r = await step(16);
console.log("after crossing:", r.state, r.confirmed ?? r.selectedId);
await step(64);
await shot("bump");
await step(200);
await shot("countdown"); // the chosen arc fading (no ring at the hand)
await step(400);
r = await step(0);
console.log("after countdown:", r.state, "badge:", await page.locator("#badge").getAttribute("data-mode"));
// cooldown: the fist is still held -> nothing for 2 s, then it re-opens
await step(1500);
console.log("held 1.5 s after close:", (await step(0)).state);
await step(700);
console.log("held 2.2 s after close:", (await step(0)).state);
await page.mouse.up();
await step(100);
// Sound sub-menu: choose an instrument by moving only
await page.mouse.move(640, 250);
await page.mouse.down();
await step(300);
await page.mouse.move(640, 250 + px(0.75), { steps: 3 });
await step(260);
const snap = await page.evaluate(() => window.__menuLab.menu.snapshot());
await step(150);
const c = { x: snap.center.x * W, y: snap.center.y * H };
await page.mouse.move(c.x + Math.cos(0.26) * px(0.9), c.y + Math.sin(0.26) * px(0.9), { steps: 3 });
await step(16);
await step(64);
await shot("setting-bump");
await step(600);
await page.mouse.up();
await step(100);
console.log("log:", (await page.evaluate(() => window.__menuLab.events.slice())).join(" | "));
console.log("errors:", errors.length ? errors : "none");
await browser.close();
