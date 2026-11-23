// Demo capture for the lead: a short melody in Lead mode.
//  - test-results/screens/lead-melody.webm: the overlay canvas (video + Lead visuals) WITH the synth audio,
//    recorded in the page (MediaRecorder), so it works without Playwright's ffmpeg.
//  - If Playwright's ffmpeg is installed (`npx playwright install ffmpeg`), the regular Playwright video
//    (whole page, no audio) is recorded too: test-results/lead-demo-a-short-melody/video.webm.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { leftHand } from "./helpers/hands.js";
import { test, expect, SCREENS, setNoteSet, setHands, preview, play, yFor } from "./helpers/lead-lab.js";

const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
const hasFfmpeg = fs.existsSync(cache) && fs.readdirSync(cache).some((d) => d.startsWith("ffmpeg"));
test.use({ video: hasFfmpeg ? { mode: "on", size: { width: 1280, height: 800 } } : "off" });

test("a short melody", { tag: "@media" }, async ({ lab: page }, testInfo) => {
  test.setTimeout(45_000);
  await setNoteSet(page, 2);
  const notes = await page.evaluate(() => window.__gsTest.lead._controller.state.ladder.notes.map((n) => n.midi));

  // Start the in-page recorder: canvas frames + the synth's master output.
  await page.evaluate(() => {
    const t = window.__gsTest;
    const canvas = document.getElementById("overlay");
    const stream = canvas.captureStream(30);
    const ac = t.synth.ctx;
    const dest = ac.createMediaStreamDestination();
    t.synth.masterGain.connect(dest);
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    window.__demo = { rec, chunks, done: new Promise((res) => (rec.onstop = res)) };
    rec.start(250);
  });

  const melody = [
    [3, 1, 300], [4, 1, 300], [5, 1, 300], [7, 1, 600],
    [6, 4, 300], [5, 4, 300], [4, 4, 600],
    [3, 5, 300], [5, 5, 300], [4, 1, 800],
  ];
  for (const [i, chord, ms] of melody) {
    const y = await yFor(page, notes[i]);
    await setHands(page, leftHand(chord), preview(y, 0.7));
    await page.waitForTimeout(110);
    await setHands(page, leftHand(chord), play(y, 0.7));
    await page.waitForTimeout(ms);
  }
  await setHands(page, leftHand(1), preview(0.5, 0.7));
  await page.waitForTimeout(500);

  const b64 = await page.evaluate(async () => {
    const d = window.__demo;
    d.rec.stop();
    await d.done;
    const buf = await new Blob(d.chunks, { type: "video/webm" }).arrayBuffer();
    let s = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const out = path.join(SCREENS, "lead-melody.webm");
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  expect(fs.statSync(out).size).toBeGreaterThan(20_000);
  testInfo.annotations.push({ type: "video", description: out });
  if (hasFfmpeg) testInfo.annotations.push({ type: "video", description: testInfo.outputPath("video.webm") });
});
