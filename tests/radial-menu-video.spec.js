// Real-time video capture of the radial menu lab.
//
// Playwright's `video: "on"` needs its own ffmpeg build (~/.cache/ms-playwright/ffmpeg-*), which is not
// installed on this machine. Instead we capture CDP screencast frames (real page pixels, incl. the
// fake camera and DOM panels) and encode them to WebM with the browser's own MediaRecorder.
// Output: test-results/videos/menu-sequence.webm
import fs from "node:fs";
import { test, expect } from "./fixtures.js";

const W = 1280;
const H = 800;
const px = (s) => s * 0.12 * W; // hand sizes -> CSS px at the lab's default hand size
const OUT = "test-results/videos/menu-sequence.webm";

test("record enter -> approach -> select -> confirm -> countdown", { tag: "@media" }, async ({ page, context }) => {
  test.setTimeout(60_000);
  await page.goto("/labs/menu-lab.html");
  await page.waitForFunction(() => !!window.__menuLab);

  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  const cx = 640;
  const cy = 430;
  await page.mouse.move(cx - 200, cy + 120);
  await page.waitForTimeout(400);
  await page.mouse.move(cx, cy, { steps: 15 });
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.waitForTimeout(700);
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(cx + (px(0.55) * i) / 30, cy - 4 * Math.sin(i / 5));
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(500);
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(cx + px(0.55) + (px(0.5) * i) / 20, cy);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(800);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  await expect(page.locator("#log")).toContainText("confirmed: arp");
  await expect(page.locator("#log")).toContainText("countdown done");
  await cdp.send("Page.stopScreencast");
  expect(frames.length).toBeGreaterThan(20);

  // Encode in a fresh page: replay the JPEG frames at their real timestamps into a canvas stream.
  const enc = await context.newPage();
  await enc.goto("/labs/menu-lab.html?noCamera&manualClock"); // any same-origin page works
  const b64 = await enc.evaluate(
    async ({ frames, W, H }) => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const g = c.getContext("2d");
      const imgs = await Promise.all(
        frames.map(
          (f) =>
            new Promise((res) => {
              const im = new Image();
              im.onload = () => res(im);
              im.src = "data:image/jpeg;base64," + f.data;
            }),
        ),
      );
      g.drawImage(imgs[0], 0, 0, W, H);
      const stream = c.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 6e6 });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((r) => (rec.onstop = r));
      rec.start(250);
      const t0 = performance.now();
      for (let i = 0; i < imgs.length; i++) {
        const due = (frames[i].t - frames[0].t) * 1000;
        const wait = due - (performance.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        g.drawImage(imgs[i], 0, 0, W, H);
      }
      await new Promise((r) => setTimeout(r, 300));
      rec.stop();
      await done;
      const buf = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { frames, W, H },
  );
  fs.mkdirSync("test-results/videos", { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(b64, "base64"));
  expect(fs.statSync(OUT).size).toBeGreaterThan(20_000);
});
