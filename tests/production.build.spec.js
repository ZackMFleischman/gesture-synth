// Production build smoke (layer: build). Runs `vite build` into dist/, serves it with `vite preview` on
// PW_PREVIEW_PORT (PW_PORT + 100), and checks what users actually get:
//   - no dev/test hooks in the bundle (window.__gsTest, ?mockHands, ?replay=),
//   - the app loads cleanly and the start overlay works,
//   - ?mockHands / ?replay= do nothing in production (the real MediaPipe path is taken),
//   - Microsoft Clarity stays off on localhost and loads on a real host (request intercepted, never sent).
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

const PORT = Number(process.env.PW_PREVIEW_PORT);
const ORIGIN = `http://localhost:${PORT}`;
const PROD_HOST = "http://gs-prod.test"; // a non-localhost name, routed to the preview server below
const VITE = path.resolve("node_modules/vite/bin/vite.js");
const DIST = path.resolve("dist");
// Strings that only exist in dev/test code paths (main.js DEV blocks, src/input/replay.js).
const TEST_HOOKS = /__gsTest|mockHands|replayLoop|createReplaySource|gesture-synth-recording/;
const MEDIAPIPE = /hand_landmarker\.task|tasks-vision.*\/wasm/;
const BENIGN_CONSOLE = [/404 \(Not Found\) @ .*\/favicon\.ico$/]; // see pages.e2e.spec.js

test.describe.configure({ mode: "serial" }); // one build + one preview server for the whole file
test.use({
  baseURL: ORIGIN,
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      // Camera access on the fake production host (http) like on a real https deployment.
      `--unsafely-treat-insecure-origin-as-secure=${PROD_HOST}`,
    ],
  },
});

let preview;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  execFileSync(process.execPath, [VITE, "build", "--logLevel", "warn"], { stdio: "pipe" });
  preview = spawn(process.execPath, [VITE, "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
  let log = "";
  preview.stdout.on("data", (d) => (log += d));
  preview.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(ORIGIN)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`vite preview did not start on ${PORT}:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(() => preview?.kill());

function watch(page) {
  const w = { pageErrors: [], consoleErrors: [], requests: [] };
  page.on("pageerror", (e) => w.pageErrors.push(e.message));
  page.on("console", (m) => {
    const text = `${m.text()} @ ${m.location().url}`;
    if (m.type() === "error" && !BENIGN_CONSOLE.some((re) => re.test(text))) w.consoleErrors.push(text);
  });
  page.on("request", (r) => w.requests.push(r.url()));
  return w;
}

test("dist/ contains no dev or test hooks", () => {
  const files = fs.readdirSync(DIST, { recursive: true }).filter((f) => /\.(js|html|css|map)$/.test(f));
  expect(files.some((f) => f.endsWith(".js"))).toBe(true);
  const hits = files.filter((f) => TEST_HOOKS.test(fs.readFileSync(path.join(DIST, f), "utf8")));
  expect(hits, `test-only code shipped (matches ${TEST_HOOKS})`).toEqual([]);
});

test("production app loads cleanly; the start overlay goes away and the real hand tracker loads", async ({ page }) => {
  const w = watch(page);
  const mediapipe = page.waitForRequest((r) => MEDIAPIPE.test(r.url()), { timeout: 15_000 });
  await page.goto("/");
  await expect(page.locator("#startOverlay")).toBeVisible();
  await expect(page.locator("#overlay")).toHaveClass(/dimmed/);
  await page.locator("#startOverlay").click();
  await expect(page.locator("#startOverlay")).toBeHidden();
  await expect(page.locator("#overlay")).not.toHaveClass(/dimmed/);
  await mediapipe; // the real hand tracker is being loaded
  await page.waitForTimeout(300);
  expect(w.pageErrors).toEqual([]);
  expect(w.consoleErrors).toEqual([]);
});

test("?mockHands and ?replay= are inert in production", async ({ page }) => {
  const w = watch(page);
  const mediapipe = page.waitForRequest((r) => MEDIAPIPE.test(r.url()), { timeout: 15_000 });
  await page.goto("/?mockHands&replay=/tests/fixtures/sample-recording.json&replayLoop");
  await page.locator("#startOverlay").click();
  await mediapipe; // real MediaPipe path, not the mock/replay source
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => typeof window.__gsTest)).toBe("undefined");
  expect(w.requests.filter((u) => new URL(u).pathname.endsWith("sample-recording.json"))).toEqual([]);
  expect(w.pageErrors).toEqual([]);
});

test("Clarity: never on localhost", async ({ page }) => {
  const w = watch(page);
  await page.goto("/");
  await page.locator("#startOverlay").click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => typeof window.clarity)).toBe("undefined");
  expect(w.requests.filter((u) => /clarity\.ms/.test(u))).toEqual([]);
});

test("Clarity: loads on a real host (request intercepted, nothing is sent)", async ({ page }) => {
  // The fake host is served by the preview server; Clarity's tag is answered locally.
  await page.route(`${PROD_HOST}/**`, async (route) => {
    const url = route.request().url().replace(PROD_HOST, ORIGIN);
    route.fulfill({ response: await route.fetch({ url }) });
  });
  const clarity = [];
  await page.route(/clarity\.ms/, (route) => {
    clarity.push(route.request().url());
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
  });
  const w = watch(page);
  await page.goto(`${PROD_HOST}/`);
  await expect.poll(() => clarity.length).toBeGreaterThan(0);
  expect(clarity[0]).toMatch(/clarity\.ms\/tag\/xzz1v75lj8/);
  expect(await page.evaluate(() => typeof window.clarity)).toBe("function");
  await page.locator("#startOverlay").click();
  await expect(page.locator("#startOverlay")).toBeHidden();
  // Custom events reach Clarity's queue (the stub tag never drains it).
  await page.locator("#guideToggle").click();
  await page.locator("#helpButton").click();
  const events = await page.evaluate(() => (window.clarity.q || []).map((a) => [...a]).filter((a) => a[0] === "event").map((a) => a[1]));
  expect(events).toEqual(expect.arrayContaining(["guide_opened", "help_opened"]));
  expect(w.pageErrors).toEqual([]);
});
