// Video capture without Playwright's ffmpeg: CDP screencast frames (JPEG) from one or more
// pages, composited side by side and encoded to WebM by the browser's own MediaRecorder.
// (Playwright's `recordVideo` needs `npx playwright install ffmpeg`, which this machine
// doesn't have; this keeps the demo video fully local.)
//
//   const rec = createScreencast();
//   await rec.track(page, "synth");      // starts capturing; call again for the same slot later
//   await rec.untrack(page);             // (closing the page also ends it)
//   await rec.save(browser, "out.webm", { layout: ["synth", "viz"] });
//   Optional sound track: save(..., { audio: { b64, startMs } }) with a WebM/Opus recording (base64) whose
//   first sample was captured at epoch ms `startMs` (e.g. MediaRecorder on a MediaStreamDestination in the page).
//   `videoBitsPerSecond` (default 5 Mb/s) trades size for quality (scripts/capture-media.mjs uses ~1.5 Mb/s).

import fs from "node:fs";
import path from "node:path";

export function createScreencast() {
  /** slot -> [{t (epoch ms), data (base64 jpeg) | null (= slot empty)}] */
  const slots = new Map();
  const sessions = new Map();

  return {
    async track(page, slot) {
      if (!slots.has(slot)) slots.set(slot, []);
      const frames = slots.get(slot);
      const cdp = await page.context().newCDPSession(page);
      cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
        frames.push({ t: metadata.timestamp * 1000, data });
        cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 860 });
      const end = () => frames.push({ t: Date.now(), data: null });
      page.once("close", end);
      sessions.set(page, { cdp, end });
    },

    async untrack(page) {
      const s = sessions.get(page);
      if (!s) return;
      sessions.delete(page);
      await s.cdp.send("Page.stopScreencast").catch(() => {});
      s.end();
    },

    /** Composite slots left-to-right (each scaled to `cellW` wide) and encode in real time. */
    async save(browser, file, { layout, cellW = 960, cellH = 620, fps = 25, audio = null, videoBitsPerSecond = 5_000_000 } = {}) {
      const all = layout.flatMap((sl) => slots.get(sl) || []);
      const withData = all.filter((f) => f.data);
      if (!withData.length) throw new Error("no frames captured");
      const t0 = Math.min(...withData.map((f) => f.t));
      const t1 = Math.max(...all.map((f) => f.t));
      const tracks = layout.map((sl) => (slots.get(sl) || []).slice().sort((a, b) => a.t - b.t).map((f) => ({ t: f.t - t0, data: f.data })));

      const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } });
      const page = await ctx.newPage();
      await page.setContent("<canvas></canvas>");
      await page.evaluate(({ n, cellW, cellH }) => {
        window.__tracks = Array.from({ length: n }, () => []);
        const c = document.querySelector("canvas");
        c.width = cellW * n;
        c.height = cellH;
      }, { n: tracks.length, cellW, cellH });
      // Upload frames in chunks (keeps each evaluate payload small).
      for (let i = 0; i < tracks.length; i++) {
        for (let j = 0; j < tracks[i].length; j += 40) {
          await page.evaluate(({ i, chunk }) => window.__tracks[i].push(...chunk), { i, chunk: tracks[i].slice(j, j + 40) });
        }
      }
      if (audio) {
        for (let j = 0; j < audio.b64.length; j += 4_000_000) {
          await page.evaluate((part) => (window.__audioB64 = (window.__audioB64 || "") + part), audio.b64.slice(j, j + 4_000_000));
        }
      }
      const audioOffset = audio ? audio.startMs - t0 : 0;
      const b64 = await page.evaluate(async ({ duration, cellW, cellH, fps, labels, audioOffset, videoBitsPerSecond }) => {
        const c = document.querySelector("canvas");
        const g = c.getContext("2d");
        const decoded = await Promise.all(window.__tracks.map((tr) => Promise.all(tr.map(async (f) => ({
          t: f.t,
          img: f.data ? await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${f.data}`)).blob()) : null,
        })))));
        const stream = c.captureStream(fps);
        let startAudio = () => {};
        if (window.__audioB64) {
          // Sound track: decode the recording and play it into the recorder in sync with the frames.
          const ac = new AudioContext();
          const bin = Uint8Array.from(atob(window.__audioB64), (ch) => ch.charCodeAt(0));
          const buf = await ac.decodeAudioData(bin.buffer);
          const dest = ac.createMediaStreamDestination();
          for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
          startAudio = () => {
            const src = ac.createBufferSource();
            src.buffer = buf;
            src.connect(dest);
            const off = audioOffset / 1000;
            if (off >= 0) src.start(ac.currentTime + off);
            else src.start(ac.currentTime, -off);
          };
        }
        const mime = window.__audioB64 ? "video/webm;codecs=vp8,opus" : "video/webm;codecs=vp8";
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const done = new Promise((r) => (rec.onstop = r));
        const draw = (t) => {
          g.fillStyle = "#0b0b0c";
          g.fillRect(0, 0, c.width, c.height);
          decoded.forEach((tr, i) => {
            let f = null;
            for (const x of tr) { if (x.t <= t) f = x; else break; }
            if (f && f.img) {
              const s = Math.min(cellW / f.img.width, cellH / f.img.height);
              const w = f.img.width * s, h = f.img.height * s;
              g.drawImage(f.img, i * cellW + (cellW - w) / 2, (cellH - h) / 2, w, h);
            } else {
              g.fillStyle = "#666";
              g.font = "20px monospace";
              g.fillText(`${labels[i]}: (closed)`, i * cellW + 30, cellH / 2);
            }
          });
        };
        draw(0);
        rec.start(250);
        startAudio();
        const start = performance.now();
        await new Promise((resolve) => {
          const tick = () => {
            const t = performance.now() - start;
            draw(t);
            if (t >= duration) resolve(); else setTimeout(tick, 1000 / fps);
          };
          tick();
        });
        rec.stop();
        await done;
        const buf = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
        let s = "";
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      }, { duration: t1 - t0, cellW, cellH, fps, labels: layout, audioOffset, videoBitsPerSecond });
      await ctx.close();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(b64, "base64"));
      return { file, durationMs: t1 - t0, frames: tracks.map((t) => t.length) };
    },
  };
}
