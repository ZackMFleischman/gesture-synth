// Sound menu in the real app (?mockHands): the radial menu's DOWN arc opens a sub-ring of the registered instrument
// plugins (src/instruments). It sets the base instrument (Chords / Arp) or, with the Lead layer on, the lead's.
//   - gesture: fist -> down through Sound -> sub-ring -> an instrument -> open hand (flash, no countdown)
//   - Lead on: "Lead sound" sets only the lead; the base keeps its instrument
//   - tone select + Controls rows stay in sync; a 7th instrument registered at runtime shows up everywhere
//   - sound: Arp + Warm under Lead + Bright (two timbres in one FFT); switching while a chord sounds: no gap / click
//   - screenshots test-results/screens/sound-*.png, video with sound test-results/videos/sound-menu.webm
// Engine-level instrument tests (pitch, loudness, timbre, Electric sustain, demo WAVs): instruments.e2e.spec.js.
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { spectrum, writeWav, retryOnCaptureGlitch } from "./helpers/audio.js";
import { createScreencast } from "./helpers/screencast.js";
import { scene, setHands, openApp, bus, startRec, longestSilence, maxD2 } from "./helpers/m2-lead.js";

const WAV_DIR = "test-results/audio";
const DESKTOP = { width: 1280, height: 800 };
const SC = scene(DESKTOP);
const TOP = { x: SC.R.x, y: 0.3 }; // fist start: room below for Sound + its sub-ring

test.describe.configure({ mode: "default" });

const snap = (page) => page.evaluate(() => {
  const s = window.__gsTest.router.menu.snapshot();
  return { level: s.level, center: s.center, handSize: s.handSize, aspect: s.aspect, items: s.items.map((i) => ({ id: i.id, angle: i.angle, label: i.label })), currentId: s.currentId, phase: s.phase };
});
const sounds = (page) => page.evaluate(() => ({ base: window.__gsTest.bus.get("sound/base"), lead: window.__gsTest.bus.get("sound/lead") }));

/**
 * Fist at `from`, down through the Sound arc until the sub-ring opens, then to instrument `id` and open the hand.
 * `onRing(page)` / `onSelected(page)` hooks for screenshots. Resolves when the menu has closed.
 */
async function pickSound(page, id, { left = SC.left(1), from = TOP, open = true, onRing, onSelected } = {}) {
  await setHands(page, left, SC.fistAt(from));
  await expect.poll(async () => (await bus(page, "menu"))?.state, { timeout: 2000 }).toBe("open");
  let p = from;
  for (let i = 1; i <= 24; i++) {
    p = { x: from.x, y: from.y + 0.012 * i };
    await setHands(page, left, SC.fistAt(p));
    await page.waitForTimeout(40);
    if ((await bus(page, "menu"))?.level === 1) break;
  }
  await expect.poll(async () => (await bus(page, "menu"))?.level ?? 0, { timeout: 2000 }).toBe(1);
  await page.waitForTimeout(200);
  if (onRing) await onRing(page);
  const s = await snap(page);
  const it = s.items.find((x) => x.id === id);
  expect(it, `${id} in the sub-ring`).toBeTruthy();
  const a = (it.angle * Math.PI) / 180;
  const c = s.center;
  for (let k = 1; k <= 6; k++) {
    const d = (0.95 * k) / 6;
    p = { x: c.x + Math.cos(a) * d * s.handSize, y: c.y + Math.sin(a) * d * s.handSize * s.aspect };
    await setHands(page, left, SC.fistAt(p));
    await page.waitForTimeout(40);
  }
  await expect.poll(async () => (await bus(page, "menu"))?.selectedId ?? null, { timeout: 2000 }).toBe(id);
  if (onSelected) await onSelected(page, p);
  if (!open) return p;
  await setHands(page, left, SC.open(2, p.y, { x: p.x }));
  await expect.poll(async () => (await bus(page, "menu")) ?? null, { timeout: 2000 }).toBe(null);
  return p;
}

async function openControls(page) {
  await page.locator("#controlsToggle").click();
  await expect(page.locator("#controlsPanel")).toBeVisible();
}

test("Sound menu: fist down through Sound opens the instruments; Electric becomes the base instrument (tone select + Controls follow)", async ({ synthPage: page }) => {
  test.setTimeout(60_000);
  await setHands(page, SC.left(1), SC.open(2, TOP.y));
  await page.waitForTimeout(500);
  expect(await sounds(page)).toEqual({ base: "warm", lead: "warm" });
  let flashSeen = false;
  const unsub = await page.evaluate(() => {
    window.__menuStates = [];
    window.__gsTest.bus.subscribe({ onSet: (n, v) => window.__menuStates.push(v && v.state) }, "menu");
  });
  void unsub;
  await setHands(page, SC.left(1), SC.fistAt(TOP));
  await expect.poll(async () => (await bus(page, "menu"))?.state).toBe("open");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SCREENS_DIR}/sound-main-ring.png` });
  await pickSound(page, "electric", {
    from: TOP,
    onRing: async (pg) => {
      const s = await snap(pg);
      expect(s.items.map((i) => i.id)).toEqual(["warm", "bright", "retro", "organ", "electric", "sax"]);
      expect(s.currentId).toBe("warm");
      await pg.screenshot({ path: `${SCREENS_DIR}/sound-ring.png` });
    },
    onSelected: async (pg) => pg.screenshot({ path: `${SCREENS_DIR}/sound-selected.png` }),
  });
  flashSeen = await page.evaluate(() => window.__menuStates.includes("flash"));
  expect(flashSeen, "setting confirm = flash (no countdown)").toBe(true);
  expect(await page.evaluate(() => window.__menuStates.includes("countdown"))).toBe(false);
  expect(await sounds(page)).toEqual({ base: "electric", lead: "electric" }); // lead follows until picked
  expect(await bus(page, "mode")).toBe("chords");
  await expect(page.locator("#toneSelect")).toHaveValue("electric");
  await openControls(page);
  await expect(page.locator('[data-control="sound-base"]')).toHaveValue("electric");
  await expect(page.locator('[data-control="sound-lead"]')).toBeHidden();
  await page.screenshot({ path: `${SCREENS_DIR}/sound-controls.png` });
  // the chord sounds through the Electric now
  const types = await page.evaluate(() => window.__gsTest.synth.oscillators.map((o) => o.instrument));
  expect(types.every((t) => t === "electric")).toBe(true);
  expect(page.__errors ?? []).toEqual([]);
});

test("Lead on: the arc reads 'Lead sound' and sets only the lead; the base keeps its instrument", async ({ synthPage: page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => window.__gsTest.router.setMode("arp"));
  await page.evaluate(() => window.__gsTest.ctx.audio.setInstrument("base", "organ"));
  await page.evaluate(() => window.__gsTest.router.setMode("lead"));
  expect([await bus(page, "mode"), await bus(page, "layer")]).toEqual(["arp", "lead"]);
  await setHands(page, SC.left(1), SC.preview(TOP.y));
  await page.waitForTimeout(400);
  await pickSound(page, "sax", {
    onRing: async (pg) => {
      const s = await pg.evaluate(() => window.__gsTest.router.menu.snapshot());
      expect(s.parent.items.find((i) => i.id === "sound").label).toBe("Lead sound");
      expect(s.currentId).toBe("organ"); // the lead followed the base so far
      await pg.screenshot({ path: `${SCREENS_DIR}/sound-lead-ring.png` });
    },
    open: true,
  });
  expect(await sounds(page)).toEqual({ base: "organ", lead: "sax" });
  expect([await bus(page, "mode"), await bus(page, "layer")]).toEqual(["arp", "lead"]);
  await openControls(page);
  await expect(page.locator('[data-control="sound-lead"]')).toBeVisible();
  await expect(page.locator('[data-control="sound-lead"]')).toHaveValue("sax");
  await expect(page.locator('[data-control="sound-base"]')).toHaveValue("organ");
  await expect(page.locator("#toneSelect")).toHaveValue("organ");
  await page.screenshot({ path: `${SCREENS_DIR}/sound-controls-lead.png` });
  // a base change from the tone select leaves the picked lead alone
  await page.locator("#toneSelect").selectOption("sawtooth");
  expect(await sounds(page)).toEqual({ base: "bright", lead: "sax" });
  await expect(page.locator('[data-control="sound-base"]')).toHaveValue("bright");
});

test("Controls + tone select: every path sets the same instrument; the wire carries /gs/sound/base and /gs/sound/lead", async ({ synthPage: page }) => {
  await openControls(page);
  await page.locator('[data-control="sound-base"]').selectOption("retro");
  expect(await sounds(page)).toEqual({ base: "retro", lead: "retro" });
  await expect(page.locator("#toneSelect")).toHaveValue("square");
  await page.locator("#toneSelect").selectOption("organ");
  await expect(page.locator('[data-control="sound-base"]')).toHaveValue("organ");
  const { ADDRESS_TABLE } = await page.evaluate(async () => {
    const m = await import("/src/output/protocol.js");
    return { ADDRESS_TABLE: JSON.parse(JSON.stringify(m.ADDRESS_TABLE)) };
  });
  expect(ADDRESS_TABLE["sound/base"].address).toBe("/gs/sound/base");
  expect(ADDRESS_TABLE["sound/lead"].address).toBe("/gs/sound/lead");
  const guide = await page.locator("#gestureGuide .gs-guide-sound").allTextContents();
  expect(guide.join(" ")).toContain("Fist down: sound");
});

test("plugin: a 7th instrument registered at runtime appears in the Sound ring, Controls and the tone select", async ({ synthPage: page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => {
    window.__gsTest.instruments.registerInstrument({
      id: "test-bell",
      label: "Bell",
      icon: "M12 4a5 5 0 0 1 5 5v5l2 3H5l2-3V9a5 5 0 0 1 5-5",
      level: 1,
      createSource(ac, freq, t0) {
        const o = ac.createOscillator();
        o.type = "sine";
        o.frequency.value = freq;
        o.start(t0);
        o.instrument = "test-bell";
        o.release = () => {};
        o.excite = () => {};
        o.setFreq = (f, t) => o.frequency.setValueAtTime(f, t);
        return o;
      },
    });
  });
  await setHands(page, SC.left(1), SC.open(2, TOP.y));
  await page.waitForTimeout(300);
  await pickSound(page, "test-bell", {
    onRing: async (pg) => {
      const s = await snap(pg);
      expect(s.items.map((i) => i.id)).toContain("test-bell");
      expect(s.items.length).toBe(7);
      await pg.screenshot({ path: `${SCREENS_DIR}/sound-ring-7.png` });
    },
  });
  expect((await sounds(page)).base).toBe("test-bell");
  await expect(page.locator("#toneSelect option[value='test-bell']")).toHaveText("Bell");
  await openControls(page);
  await expect(page.locator('[data-control="sound-base"]')).toHaveValue("test-bell");
  const freqs = await page.evaluate(() => window.__gsTest.synth.oscillators.map((o) => o.type));
  expect(freqs.every((t) => t === "sine")).toBe(true);
});

/** Magnitude (dB re the strongest bin) at frequency f: max over ±1 bin. */
function dbAt(spec, f, ref) {
  const i = Math.round(f / spec.binHz);
  let m = 0;
  for (let k = i - 1; k <= i + 1; k++) m = Math.max(m, spec.mags[k] || 0);
  return 20 * Math.log10(m / ref + 1e-12);
}

test("Arp + Warm under Lead + Bright: one recording, two timbres (triangle: no even harmonics; sawtooth: all)", async ({ context }, info) => {
  test.setTimeout(120_000);
  await retryOnCaptureGlitch(info, async ({ track }) => {
    const page = await openApp(context);
    try {
      const L1 = SC.left(1, { volume: 0.9 });
      await setHands(page, L1, SC.open(1, 0.5));
      await page.evaluate(() => window.__gsTest.router.setMode("arp"));
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const a = window.__gsTest.ctx.audio;
        a.setInstrument("base", "warm");
        window.__gsTest.router.setMode("lead");
        a.setInstrument("lead", "bright");
        a.setLayerFilter(1); // open: the lead's harmonics through
        window.__notes = [];
        window.__gsTest.bus.subscribe({ onEvent: (n, d) => window.__notes.push({ n, ...d }) }, ["note/on"]);
      });
      // a held lead note (screen key = a ladder note) whose pitch class is NOT an arp note (its 2nd harmonic then
      // lands clear of the arp's partials): the biggest note set, then the first such ladder key.
      await page.mouse.move(640, 400);
      await page.keyboard.press("Digit4");
      await page.waitForTimeout(700);
      const pc = (f) => (((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12);
      const arpPcs = new Set((await page.evaluate(() => window.__notes)).filter((n) => n.voice === "arp").map((n) => pc(n.freq)));
      let key = null;
      for (const k of ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL"]) {
        await page.keyboard.down(k);
        await page.waitForTimeout(120);
        const l = (await page.evaluate(() => window.__notes)).filter((n) => n.voice === "lead").at(-1);
        if (l && !arpPcs.has(pc(l.freq))) { key = k; break; }
        await page.keyboard.up(k);
        await page.waitForTimeout(60);
      }
      expect(key, "a ladder note outside the arp's chord").toBeTruthy();
      await page.waitForTimeout(500);
      const stop = await startRec(page);
      await page.waitForTimeout(1600);
      const rec = track(await stop());
      await page.keyboard.up(key);
      writeWav(`${WAV_DIR}/sound-arp-warm-lead-bright.wav`, rec.samples, rec.sampleRate);
      const notes = await page.evaluate(() => window.__notes);
      const lead = notes.filter((n) => n.voice === "lead").at(-1);
      const arp = [...new Set(notes.filter((n) => n.voice === "arp").map((n) => Math.round(n.freq * 100) / 100))];
      expect(lead, "a lead note").toBeTruthy();
      expect(arp.length).toBeGreaterThan(0);
      const spec = spectrum(rec.samples, rec.sampleRate, 65536);
      const ref = Math.max(...spec.mags);
      // partials that could land on a frequency: arp fundamentals + odd harmonics (triangle), lead harmonics (saw)
      const near = (f, list) => list.some((g) => Math.abs(1200 * Math.log2(f / g)) < 60);
      const arpPartials = arp.flatMap((f) => [f, 3 * f, 5 * f, 7 * f]);
      const leadPartials = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => k * lead.freq);
      // lead (sawtooth): its 2nd harmonic is strong
      const l2 = 2 * lead.freq;
      expect(near(l2, arpPartials), "lead 2f collides with an arp partial (pick another note)").toBe(false);
      const leadF = dbAt(spec, lead.freq, ref);
      const leadH2 = dbAt(spec, l2, ref);
      // arp (triangle): its 2nd harmonics are (nearly) absent
      const checks = arp.filter((f) => !near(2 * f, [...leadPartials, ...arpPartials]));
      expect(checks.length, "an arp note whose 2f is clear of other partials").toBeGreaterThan(0);
      const arpH2 = Math.max(...checks.map((f) => dbAt(spec, 2 * f, ref) - dbAt(spec, f, ref)));
      console.log(`[sound] lead ${lead.freq.toFixed(1)} Hz: f ${leadF.toFixed(1)} dB, 2f ${(leadH2 - leadF).toFixed(1)} dB re f; arp 2f re f: ${arpH2.toFixed(1)} dB`);
      expect(leadH2 - leadF, "sawtooth lead: 2nd harmonic within 15 dB of its fundamental").toBeGreaterThan(-15);
      expect(arpH2, "triangle arp: 2nd harmonic at least 25 dB under its fundamental").toBeLessThan(-25);
    } finally {
      await page.close();
    }
  });
});

test("switching the instrument while a chord sounds: no gap, no click (Warm -> Organ -> Electric -> Sax -> Warm)", async ({ context }, info) => {
  test.setTimeout(120_000);
  await retryOnCaptureGlitch(info, async ({ track }) => {
    const page = await openApp(context);
    try {
      await setHands(page, SC.left(1, { volume: 0.9 }), SC.open(2, 0.45));
      await page.waitForTimeout(900);
      const stop = await startRec(page);
      const times = [];
      for (const id of ["organ", "electric", "sax", "warm"]) {
        await page.waitForTimeout(500);
        times.push(await page.evaluate((id) => {
          window.__gsTest.ctx.audio.setInstrument("base", id);
          return performance.now();
        }, id));
      }
      await page.waitForTimeout(500);
      const rec = track(await stop());
      writeWav(`${WAV_DIR}/sound-switch-chords.wav`, rec.samples, rec.sampleRate);
      const sr = rec.sampleRate;
      const gap = longestSilence(rec.samples, sr, 0.3, rec.samples.length / sr - 0.1);
      expect(gap, "longest silence while switching").toBeLessThan(0.01);
      // click metric: the worst |2nd difference| over the whole run vs the steady part before any switch
      const steady = maxD2(rec.samples.subarray(Math.round(0.05 * sr), Math.round(0.45 * sr)));
      const all = maxD2(rec.samples);
      console.log(`[sound] switch: maxD2 all ${all.toFixed(4)} vs steady warm ${steady.toFixed(4)}; longest silence ${(gap * 1000).toFixed(1)} ms`);
      // Electric's pick attack is a real (wanted) transient: allow it, but nothing like a step (a click is >> 10x).
      expect(all / steady).toBeLessThan(12);
    } finally {
      await page.close();
    }
  });
});

test("video test-results/videos/sound-menu.webm (with sound): pick Electric for Chords, Lead on top, pick Sax for the lead", async ({ synthPage: page, browser }) => {
  test.setTimeout(120_000);
  const rec = createScreencast();
  await rec.track(page, "app");
  await page.evaluate(() => {
    const s = window.__gsTest.synth;
    const dest = s.ctx.createMediaStreamDestination();
    s.clipper.connect(dest);
    const mr = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    window.__snd = { mr, chunks, done: new Promise((r) => (mr.onstop = r)), startMs: 0 };
    mr.onstart = () => (window.__snd.startMs = Date.now());
    mr.start(250);
  });
  const L = (d) => SC.left(d, { volume: 0.85 });
  await setHands(page, L(1), SC.open(2, TOP.y));
  await page.waitForTimeout(1200);
  await pickSound(page, "electric", { left: L(1) });
  for (const d of [1, 4, 5, 1]) {
    await setHands(page, L(d), SC.open(2, TOP.y));
    await page.waitForTimeout(900);
  }
  await page.evaluate(() => window.__gsTest.router.setMode("lead"));
  await setHands(page, L(1), SC.preview(TOP.y));
  await page.waitForTimeout(500);
  await pickSound(page, "sax", { left: L(1), open: true });
  await setHands(page, L(1), SC.preview(0.4));
  await page.waitForTimeout(300);
  for (const [y, ms] of [[0.4, 500], [0.35, 500], [0.3, 800], [0.38, 900]]) {
    await setHands(page, L(4), SC.play(y));
    await page.waitForTimeout(ms);
  }
  await setHands(page, L(1), SC.preview(0.4));
  await page.waitForTimeout(800);
  const snd = await page.evaluate(async () => {
    const s = window.__snd;
    s.mr.stop();
    await s.done;
    const buf = new Uint8Array(await new Blob(s.chunks, { type: "audio/webm" }).arrayBuffer());
    let b = "";
    for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(b), startMs: s.startMs };
  });
  await rec.untrack(page);
  const out = "test-results/videos/sound-menu.webm";
  const res = await rec.save(browser, out, { layout: ["app"], cellW: 1280, cellH: 800, audio: snd });
  expect(res.frames[0]).toBeGreaterThan(60);
  expect(fs.statSync(out).size).toBeGreaterThan(100_000);
});
