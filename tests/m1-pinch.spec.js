// Milestone 1.6: right pinch = tempo in Arp mode, in the real app (?mockHands).
// UX check 1.6: the tempo does not jump at the start of a pinch; a pinch never changes the voicing.
// Also: integer BPM steps from the vertical movement (hand-size relative), gate/filter locked while
// pinched, Return state (hollow + solid markers) after the release, no lost/doubled step across a
// pinch tempo change (recorded audio), the `pinch` bus event, the visuals at the hand, screenshots + video.
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { leftHand, rightHand, pinch, DESKTOP_VIEW } from "./helpers/hands.js";
import { recordAudio, writeWav, captureHealth, retryOnCaptureGlitch } from "./helpers/audio.js";
import { detectOnsets, pitchAt, hzToMidi, matchToScheduleAnyOffset } from "./helpers/arp-analysis.js";
import { createScreencast } from "./helpers/screencast.js";
import { PINCH_TEMPO } from "../src/modes/arp.js";

const WAV_DIR = "test-results/audio";
const TOL = 0.003; // ±3 ms (same as tests/arp.spec.js)
// Audio timing is measured here; keep these tests off each other's CPU.
test.describe.configure({ mode: "default" });

// Display-space positions (DESKTOP_VIEW: fake camera 640x480 on a 1280x800 canvas).
const R0 = { x: 0.3, y: 0.55 }; // right hand home (screen left: the video is mirrored)
const at = (p) => ({ pos: p, view: DESKTOP_VIEW });
const openRight = (q = 1, p = R0, o = {}) => rightHand(q, { ...at(p), ...o });
const pinchAt = (p = R0, o = {}) => pinch({ ...at(p), ...o });
const LEFT = leftHand(1); // A major (root A3 = 57)

// Expected arp notes for A major, 1 octave, from music theory (independent of the app code).
const A3 = 57;
const VOICED = {
  1: [0, 7, 12, 16],
  2: [4, 7, 12, 16],
  3: [0, 4, 7, 11], // what the pinch shape (middle+ring+pinky) would read as
  4: [0, 4, 7, 10],
};
const notesOf = (v) => VOICED[v].map((s) => A3 + s);

const bus = (page, name) => page.evaluate((n) => window.__gsTest.bus.get(n), name);
const bpmNow = (page) => page.evaluate(() => window.__gsTest.ctx.clock.bpm);
const arpState = (page) => page.evaluate(() => window.__gsTest.registry.getMode("arp").state);
const pinchState = (page) => page.evaluate(() => window.__gsTest.registry.getMode("arp").pinchTempo);
const drawnTempo = (page) => page.evaluate(() => window.__gsTest.registry.getMode("arp").drawnTempo);
const uiTracks = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__gsTest.ui.tracks)));

/** Logs bus values/events (page time + AudioContext time). */
async function installLog(page, names) {
  await page.evaluate((names) => {
    const { bus, ctx } = window.__gsTest;
    window.__log = [];
    const ac = () => ctx.audio.ac?.currentTime ?? 0;
    const copy = (v) => (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
    bus.subscribe(
      {
        onSet: (n, v) => window.__log.push({ n, v: copy(v), t: performance.now(), ac: ac() }),
        onEvent: (n, d, pt) => window.__log.push({ n, d: copy(d), pt, t: performance.now(), ac: ac() }),
      },
      names
    );
  }, names);
}
const log = (page) => page.evaluate(() => window.__log);

/** The app with ?mockHands, start overlay dismissed (same as the synthPage fixture; for retried tests). */
async function openApp(page) {
  await page.goto("/?mockHands");
  await page.locator("#startOverlay").click();
  await expect(page.locator("#startOverlay")).toBeHidden();
  await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0);
}

/** Arp entered directly through the router (the menu flow is covered by m1-integration), at `bpm`. */
async function enterArp(page, setHands, { bpm = 110, q = 1, p = R0 } = {}) {
  await setHands(LEFT, openRight(q, p));
  await page.waitForTimeout(300);
  await page.evaluate((bpm) => {
    const t = window.__gsTest;
    t.router.setMode("arp");
    t.registry.getMode("arp").set({ bpm });
  }, bpm);
  await page.waitForTimeout(500);
}

/** Display-height y of a hand moved by `k` BPM worth of pinch movement (up = +). */
async function yFor(page, k, from = R0) {
  const size = await bus(page, "right/size"); // handSize, display-height units
  return from.y - (k * size) / PINCH_TEMPO.BPM_PER_HAND;
}

// ---------------------------------------------------------------------------------------------
// Real app
// ---------------------------------------------------------------------------------------------

test.describe("1.6 right pinch = tempo (Arp)", () => {
  test("UX 1.6: the tempo does not jump at the start of a pinch (first frames, zero movement, jitter)", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands, { bpm: 110, q: 2 });
    await installLog(page, ["bpm", "pinch"]);
    await setHands(LEFT, pinchAt(R0));
    // Sample the tempo every animation frame for the first ~400 ms of the pinch.
    const samples = await page.evaluate(
      () => new Promise((res) => {
        const out = [];
        const t0 = performance.now();
        const step = () => {
          out.push({ bpm: window.__gsTest.ctx.clock.bpm, pinch: window.__gsTest.bus.get("right/pinch") });
          if (performance.now() - t0 < 400) requestAnimationFrame(step);
          else res(out);
        };
        requestAnimationFrame(step);
      })
    );
    expect(samples.some((s) => s.pinch), "the pinch was detected").toBe(true);
    expect(samples.every((s) => s.bpm === 110), JSON.stringify(samples.map((s) => s.bpm))).toBe(true);
    // Tracking jitter around the start point (±0.004 of the frame height ~ ±0.3 BPM).
    for (const dy of [0.003, -0.004, 0.002, -0.001, 0.004, 0]) {
      await setHands(LEFT, pinchAt({ x: R0.x + dy / 2, y: R0.y + dy }));
      await page.waitForTimeout(60);
    }
    expect(await bpmNow(page)).toBe(110);
    const L = await log(page);
    expect(L.filter((e) => e.n === "bpm"), "no bpm change published").toEqual([]);
    expect(L.filter((e) => e.n === "pinch").map((e) => e.d)).toEqual([1]);
    const ps = await pinchState(page);
    expect(ps).toMatchObject({ startBpm: 110, bpm: 110, pinching: true });
  });

  test("moving up/down changes the tempo by the expected whole BPM steps (published as `bpm`)", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands, { bpm: 110 });
    await setHands(LEFT, pinchAt(R0));
    await page.waitForTimeout(150);
    await installLog(page, ["bpm", "pinch"]);
    for (const k of [6, 13, -9, 0, 3]) {
      await setHands(LEFT, pinchAt({ x: R0.x, y: await yFor(page, k) }));
      await expect.poll(() => bpmNow(page), { timeout: 1000, message: `k=${k}` }).toBe(110 + k);
      expect(await bus(page, "bpm")).toBe(110 + k);
    }
    // Release: the tempo stays where the pinch left it.
    await setHands(LEFT, openRight(1, { x: R0.x, y: await yFor(page, 3) }));
    await page.waitForTimeout(300);
    expect(await bpmNow(page)).toBe(113);
    const L = await log(page);
    expect(L.filter((e) => e.n === "bpm").map((e) => e.v)).toEqual([116, 123, 101, 110, 113]);
    expect(L.filter((e) => e.n === "pinch").map((e) => e.d)).toEqual([0]);
    // The transport shows the live tempo.
    await expect(page.locator("#transport .gs-bpm-n")).toHaveText("113");
  });

  for (const v of [1, 2, 4]) {
    test(`UX 1.6: a pinch from voicing ${v} never changes the voicing (bus + recorded pitches)`, async ({ synthPage: page, setHands }) => {
      test.setTimeout(45_000);
      // Lowish hand: notes ~150 ms (longer than the 85 ms pitch window) with a clear gap between them (clean onsets).
      const LOW = { x: R0.x, y: 0.7 };
      await enterArp(page, setHands, { bpm: 110, q: v, p: LOW });
      await page.waitForTimeout(400);
      expect((await arpState(page)).voicing).toBe(v);
      expect(await bus(page, "voicing")).toBe(v);
      await installLog(page, ["voicing", "pinch"]);
      const acStart = await page.evaluate(() => window.__gsTest.ctx.audio.ac.currentTime);
      // Pinch (reads as 3 fingers) and move up/down for the tempo, ~2 s.
      const yUp = await yFor(page, 8, LOW);
      const rec = recordAudio(page, 2200);
      for (const y of [LOW.y, LOW.y, (LOW.y + yUp) / 2, yUp, yUp, (LOW.y + yUp) / 2, LOW.y, LOW.y, LOW.y, LOW.y]) {
        await setHands(LEFT, pinchAt({ x: LOW.x, y }));
        await page.waitForTimeout(200);
      }
      const { samples, sampleRate } = await rec;
      writeWav(`${WAV_DIR}/m1-pinch-voicing-${v}.wav`, samples, sampleRate);
      const L = await log(page);
      expect(L.filter((e) => e.n === "voicing"), "voicing never changed on the bus").toEqual([]);
      expect(L.filter((e) => e.n === "pinch").map((e) => e.d)).toEqual([1]);
      expect((await arpState(page)).voicing).toBe(v);
      expect(await page.evaluate(() => window.__gsTest.ctx.harmony.voicing)).toBe(v);
      // Every note scheduled during the pinch is from the pre-pinch voicing.
      const midis = await page.evaluate(
        (t0) => window.__gsTest.registry.getMode("arp").steps.filter((s) => s.time > t0).map((s) => s.midi),
        acStart
      );
      expect(midis.length).toBeGreaterThanOrEqual(4); // ~1.2 s of eighths at 110 BPM
      for (const m of midis) expect(notesOf(v), `scheduled ${midis}`).toContain(m);
      // And what was heard: the pitch of each onset is a note of voicing v (not of the pinch shape's 3).
      const onsets = detectOnsets(samples, sampleRate).filter((t) => t < samples.length / sampleRate - 0.2);
      expect(onsets.length).toBeGreaterThanOrEqual(5);
      const heard = onsets.map((t) => Math.round(hzToMidi(pitchAt(samples, sampleRate, t + 0.004, 4096))));
      for (const m of heard) expect(notesOf(v), `heard ${heard}`).toContain(m);
      // The voicing-3 notes that would show a misread (G#4 = 68 for voicing 1/2, F#/G for 4) never sound.
      const wrong = notesOf(3).filter((n) => !notesOf(v).includes(n));
      expect(heard.filter((m) => wrong.includes(m))).toEqual([]);
    });
  }

  // Voicing hold (src/modes/arp.js VOICING_HOLD): the hand reads 3 fingers (index curled, thumb closing in)
  // for a few frames before the pinch is detected. None of it may be heard or published.
  for (const ms of [30, 70, 120]) {
    test(`UX 1.6: a pinch approach reading 3 fingers for ${ms} ms never sounds or publishes voicing 3`, async ({ synthPage: page, setHands }) => {
      test.setTimeout(45_000);
      const P = { x: R0.x, y: 0.7 }; // ~150 ms notes: each fills the pitch window, clean gaps between them
      await enterArp(page, setHands, { bpm: 110, q: 1, p: P });
      await page.waitForTimeout(400);
      expect(await bus(page, "voicing")).toBe(1);
      await installLog(page, ["voicing"]);
      const acStart = await page.evaluate(() => window.__gsTest.ctx.audio.ac.currentTime);
      const rec = recordAudio(page, 2000);
      await page.waitForTimeout(250);
      // Approach: thumb closing on the curled index (distance 0.5 > PINCH_START: not a pinch yet).
      await setHands(LEFT, pinchAt(P, { distance: 0.5 }));
      await page.waitForTimeout(ms);
      await setHands(LEFT, pinchAt(P));
      await page.waitForTimeout(1200);
      await setHands(LEFT, openRight(1, P));
      const { samples, sampleRate } = await rec;
      writeWav(`${WAV_DIR}/m1-pinch-approach-${ms}ms.wav`, samples, sampleRate);
      expect((await log(page)).filter((e) => e.n === "voicing"), "bus `voicing` never changed").toEqual([]);
      expect((await arpState(page)).voicing).toBe(1);
      const midis = await page.evaluate(
        (t0) => window.__gsTest.registry.getMode("arp").steps.filter((s) => s.time > t0).map((s) => s.midi),
        acStart
      );
      expect(midis.length).toBeGreaterThanOrEqual(5);
      for (const m of midis) expect(notesOf(1), `scheduled ${midis}`).toContain(m);
      const onsets = detectOnsets(samples, sampleRate).filter((t) => t < samples.length / sampleRate - 0.2);
      expect(onsets.length).toBeGreaterThanOrEqual(5);
      const heard = onsets.map((t) => Math.round(hzToMidi(pitchAt(samples, sampleRate, t + 0.004, 4096))));
      const v3only = notesOf(3).filter((n) => !notesOf(1).includes(n)); // C#4 61, G#4 68
      expect(heard.filter((m) => v3only.includes(m)), `heard ${heard}`).toEqual([]);
      for (const m of heard) expect(notesOf(1), `heard ${heard}`).toContain(m);
    });
  }

  test("a deliberate change to 3 fingers applies after the ~100 ms hold; a shorter flicker does not", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands, { bpm: 110, q: 1 });
    await page.waitForTimeout(300);
    await installLog(page, ["voicing"]);
    // Flicker: 3 fingers for ~40 ms (about one video frame), then back to 1.
    await setHands(LEFT, openRight(3));
    await page.waitForTimeout(40);
    await setHands(LEFT, openRight(1));
    await page.waitForTimeout(400);
    expect((await log(page)).filter((e) => e.n === "voicing"), "flicker ignored").toEqual([]);
    // Deliberate: 3 fingers held.
    const t0 = await page.evaluate(() => performance.now());
    await setHands(LEFT, openRight(3));
    await expect.poll(() => bus(page, "voicing"), { timeout: 2000 }).toBe(3);
    const set = (await log(page)).find((e) => e.n === "voicing" && e.v === 3);
    // Applied no earlier than the hold (minus one video frame of input latency jitter) and well within ~0.3 s.
    expect(set.t - t0).toBeGreaterThan(90);
    expect(set.t - t0).toBeLessThan(400);
    await page.waitForTimeout(800);
    const recent = await page.evaluate(() => window.__gsTest.registry.getMode("arp").steps.slice(-3).map((s) => s.midi));
    for (const m of recent) expect(notesOf(3)).toContain(m);
    expect(await page.evaluate(() => window.__gsTest.ctx.harmony.voicing)).toBe(3);
  });

  test("gate, filter and double time stay locked while pinched, even if height and tilt change", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands, { bpm: 110, q: 2 });
    await setHands(LEFT, openRight(2, R0, { tilt: 0.3 }));
    await page.waitForTimeout(400);
    const snap = () =>
      page.evaluate(() => {
        const { synth, bus, ctx } = window.__gsTest;
        return { gate: bus.get("arp/gate"), filter: bus.get("filter"), cutoff: synth.filter.frequency.value, dbl: ctx.clock.doubleTime };
      });
    const before = await snap();
    await installLog(page, ["arp/gate", "filter"]);
    await setHands(LEFT, pinchAt(R0, { tilt: 0.3 }));
    await page.waitForTimeout(150);
    // The tempo scale uses the hand size latched at the pinch start (a tilted hand measures differently).
    const size0 = await bus(page, "right/size");
    for (const [k, tilt] of [[5, -0.8], [12, 0.9], [-6, -0.2]]) {
      await setHands(LEFT, pinchAt({ x: R0.x + 0.02, y: R0.y - (k * size0) / PINCH_TEMPO.BPM_PER_HAND }, { tilt }));
      await page.waitForTimeout(200);
      const s = await snap();
      expect(s.gate).toBe(before.gate);
      expect(s.filter).toBe(before.filter);
      expect(s.dbl).toBe(before.dbl);
      expect(Math.abs(s.cutoff - before.cutoff)).toBeLessThan(5);
    }
    expect(await bpmNow(page)).toBe(104);
    expect(await log(page), "no gate/filter publish while pinched").toEqual([]);
    // Held markers: the gate track dims with a hollow marker + "Gate held"; `held` names the held gate.
    expect(await bus(page, "held")).toEqual({ right: true, "arp/gate": before.gate });
    const tr = (await uiTracks(page))["right-track"];
    expect(tr).toMatchObject({ dim: true, markerY: null, heldLabel: "Gate held" });
    expect(tr.heldY).not.toBeNull();
    expect(await page.evaluate(() => window.__gsTest.ui.rightHeld)).toBe(true);
  });

  test("release -> Return (hollow + solid markers, gate held) until the hand reaches the held gate, then live", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands, { bpm: 110 });
    await page.waitForTimeout(300);
    const g0 = await bus(page, "arp/gate");
    await setHands(LEFT, pinchAt(R0));
    await page.waitForTimeout(150);
    const yUp = await yFor(page, 10);
    await setHands(LEFT, pinchAt({ x: R0.x, y: yUp }));
    await expect.poll(() => bpmNow(page)).toBe(120);
    await installLog(page, ["held", "arp/gate", "pinch"]);
    // Release higher up: the gate keeps its held value (the hand is above it).
    await setHands(LEFT, openRight(1, { x: R0.x, y: yUp }));
    await page.waitForTimeout(250);
    expect(await bus(page, "held")).toEqual({ "arp/gate": g0 });
    expect(await bus(page, "arp/gate")).toBe(g0);
    const tr = (await uiTracks(page))["right-track"];
    expect(tr.markerY, "solid marker (hand)").not.toBeNull();
    expect(tr.heldY, "hollow marker (held value)").not.toBeNull();
    expect(tr.heldY).toBeGreaterThan(tr.markerY + 20); // held gate is below the hand
    expect(tr.dim).toBe(false);
    expect(await page.evaluate(() => window.__gsTest.ui.rightHeld)).toBe(false);
    expect((await pinchState(page))?.returning).toBe(true);
    // The big BPM lingers ~1 s after the release, then goes away.
    expect(await drawnTempo(page)).not.toBeNull();
    // Move down towards the held value: the gate stays held on the way...
    const ys = [];
    for (let y = yUp; y < R0.y - 0.03; y += 0.02) ys.push(y);
    for (const y of ys) {
      await setHands(LEFT, openRight(1, { x: R0.x, y }));
      await page.waitForTimeout(50);
      expect(await bus(page, "arp/gate"), `y=${y.toFixed(3)}`).toBe(g0);
    }
    // ...and the hand takes over once it gets there (hollow + solid become one).
    await setHands(LEFT, openRight(1, R0));
    await expect.poll(() => bus(page, "held"), { timeout: 1000 }).toBe(null);
    expect(Math.abs((await bus(page, "arp/gate")) - g0)).toBeLessThan(PINCH_TEMPO.PICKUP + 1e-9);
    await page.waitForTimeout(100);
    expect((await uiTracks(page))["right-track"].heldY).toBeNull();
    // Live again: the gate follows the hand.
    await setHands(LEFT, openRight(1, { x: R0.x, y: R0.y + 0.15 }));
    await page.waitForTimeout(200);
    expect(await bus(page, "arp/gate")).toBeLessThan(g0 - 0.1);
    await page.waitForTimeout(900);
    expect(await drawnTempo(page), "big BPM gone ~1 s after the release").toBeNull();
    const L = await log(page);
    expect(L.filter((e) => e.n === "pinch").map((e) => e.d)).toEqual([0]);
    expect(L.filter((e) => e.n === "held").map((e) => e.v)).toEqual([{ "arp/gate": g0 }, null]);
  });

  test("recorded audio: no lost or doubled step across a tempo change made by pinch", async ({ page, setHands }, info) => {
    test.setTimeout(60_000);
    const LOW = { x: R0.x, y: 0.82 }; // short notes (low gate) so each step is a clean onset
    await retryOnCaptureGlitch(info, async ({ track }) => {
      await openApp(page); // fresh app per attempt (a glitched capture is measured once more)
      await enterArp(page, setHands, { bpm: 110, p: LOW });
      // Log when the clock emits each step (a step emitted after its play time = starved main thread).
      await page.evaluate(() => {
        const { ctx } = window.__gsTest;
        window.__stepLog = [];
        ctx.clock.onStep((i, time) => window.__stepLog.push({ i, time, at: ctx.audio.ac.currentTime }));
      });
      await page.waitForTimeout(400); // steady state
      await setHands(LEFT, pinchAt(LOW));
      await page.waitForTimeout(200);
      const yUp = await yFor(page, 16, LOW);
      await page.evaluate(() => {
        window.__audioCap.chunks = [];
        window.__audioCap.blocks = [];
        window.__audioCap.recording = true;
      });
      await page.waitForTimeout(1000);
      const change = await page.evaluate(() => window.__gsTest.ctx.audio.ac.currentTime);
      await setHands(LEFT, pinchAt({ x: LOW.x, y: yUp }));
      await expect.poll(() => bpmNow(page)).toBe(126);
      await page.waitForTimeout(1300);
      const cap = await page.evaluate(() => {
        window.__audioCap.recording = false;
        const { chunks, blocks, sampleRate } = window.__audioCap;
        return { chunks, blocks, sampleRate, acEnd: window.__gsTest.ctx.audio.ac.currentTime, stepLog: window.__stepLog };
      });
      const recStart = cap.blocks.length ? cap.blocks[0].t : 0;
      const rec = track({
        samples: Float32Array.from(cap.chunks.flat()),
        sampleRate: cap.sampleRate,
        health: captureHealth(cap.blocks, cap.sampleRate),
        lateSteps: cap.stepLog.filter((s) => s.time >= recStart && s.time <= cap.acEnd && s.at > s.time),
      });
      writeWav(`${WAV_DIR}/m1-pinch-tempo-change.wav`, rec.samples, rec.sampleRate);
      const steps = await page.evaluate((t0) => window.__gsTest.registry.getMode("arp").steps
        .filter((s) => s.time >= t0 - 0.5)
        .map((s) => ({ step: s.step, time: s.time, beat: s.beat, beats: s.beats, midi: s.midi })), recStart);
      // Clock: contiguous steps and beats; intervals are 110 BPM then 126 BPM eighths, nothing else.
      const d110 = (0.5 * 60) / 110;
      const d126 = (0.5 * 60) / 126;
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].step).toBe(steps[i - 1].step + 1);
        expect(steps[i].beat).toBe(steps[i - 1].beat + steps[i - 1].beats);
        const d = steps[i].time - steps[i - 1].time;
        expect(Math.min(Math.abs(d - d110), Math.abs(d - d126)), `interval ${d}`).toBeLessThan(1e-9);
        if (steps[i - 1].time > change + 0.25) expect(d).toBeCloseTo(d126, 9);
      }
      expect(steps.some((s, i) => i > 0 && Math.abs(s.time - steps[i - 1].time - d126) < 1e-9), "126 BPM steps").toBe(true);
      // Audio: exactly one onset per scheduled step in the recorded window, each on time (±3 ms).
      const on = detectOnsets(rec.samples, rec.sampleRate);
      // The app's capture offset (~170 ms) exceeds half a step: fit it over every alias (helpers/arp-analysis.js).
      const m = matchToScheduleAnyOffset(on, steps.map((s) => s.time), recStart);
      const inWindow = steps.filter((s) => s.time >= m.pairs[0].sched && s.time <= m.pairs.at(-1).sched);
      const dbg = `onsets ${on.map((t) => (t + recStart).toFixed(4))} | steps ${inWindow.map((s) => s.time.toFixed(4))} | change ${change.toFixed(4)}`;
      expect(on.length, dbg).toBe(inWindow.length);
      expect(new Set(m.pairs.map((p) => p.sched)).size, "no step heard twice").toBe(on.length);
      expect(Math.max(...m.errors.map(Math.abs)), dbg).toBeLessThan(TOL);
      expect(inWindow.length).toBeGreaterThan(8);
      expect(inWindow.some((s) => s.time > change + 0.3), "the window spans the change").toBe(true);
      // Heard intervals: 110 BPM eighths, then 126 BPM eighths.
      const ioi = on.slice(1).map((t, i) => t - on[i]);
      expect(ioi.some((d) => Math.abs(d - d126) < TOL)).toBe(true);
      for (const d of ioi) expect(Math.min(Math.abs(d - d110), Math.abs(d - d126)), `heard interval ${d}`).toBeLessThan(TOL);
    });
  });

  test("visuals: tempo scale + big BPM at the hand, transport delta, Controls tempo row owned by the hand", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands, { bpm: 110 });
    await page.locator("#controlsToggle").click();
    const tempoRow = page.locator('#controlsPanel [data-control="bpm"]').locator("xpath=ancestor::div[contains(@class,'arp-row')][last()]");
    await expect(tempoRow).not.toHaveClass(/gs-owned/);
    await page.locator("#controlsToggle").click(); // close: the hand is drawn again (not under the panel)
    expect(await drawnTempo(page)).toBeNull();
    await setHands(LEFT, pinchAt(R0));
    await page.waitForTimeout(150);
    let d = await drawnTempo(page);
    expect(d).not.toBeNull();
    expect(d.startTickY).toBeCloseTo(d.currentTickY, 5); // delta 0: start tick = current tick
    const k = 6;
    await setHands(LEFT, pinchAt({ x: R0.x, y: await yFor(page, k) }));
    await expect.poll(() => bpmNow(page)).toBe(116);
    await page.waitForTimeout(100);
    d = await drawnTempo(page);
    const handY = (await bus(page, "right/pos")).y * 800;
    expect(Math.abs(d.currentTickY - handY), "current tick level with the hand").toBeLessThan(2);
    expect(d.startTickY - d.currentTickY).toBeCloseTo(k * d.tickStep, 5); // 1 tick = 1 BPM
    expect(d.plate.h).toBeGreaterThan(40); // the one large number
    expect(d.alpha).toBe(1);
    expect(await bus(page, "arp/tempo")).toEqual({ startBpm: 110, bpm: 116, delta: 6, pinching: true });
    // Transport shows the delta inside its plate; x2 pill is hidden while pinched.
    await expect(page.locator("#transport .gs-bpm-n")).toHaveText("116");
    await expect(page.locator("#transport .gs-delta")).toHaveText("+6");
    // Controls panel: the Tempo row carries the hand mark while the pinch owns the tempo.
    await page.locator("#controlsToggle").click();
    await expect(tempoRow).toHaveClass(/gs-owned/);
    await expect(page.locator('#controlsPanel [data-control="bpm"]')).toHaveText("116");
    await setHands(LEFT, openRight(1, { x: R0.x, y: await yFor(page, k) }));
    await expect(tempoRow).not.toHaveClass(/gs-owned/);
    await page.locator("#controlsToggle").click();
  });
});

test("screenshots: m1-pinch-{pinch-start, pinch-up, after-release-return}", async ({ synthPage: page, setHands }) => {
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  await enterArp(page, setHands, { bpm: 110, q: 3 });
  await setHands(leftHand(4), openRight(3, R0, { tilt: 0.3 }));
  await page.waitForTimeout(3500); // first-use labels gone
  await setHands(leftHand(4), pinchAt(R0, { tilt: 0.3 }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SCREENS_DIR}/m1-pinch-pinch-start.png` });
  const yUp = await yFor(page, 6);
  await setHands(leftHand(4), pinchAt({ x: R0.x, y: yUp }, { tilt: 0.3 }));
  await expect.poll(() => bpmNow(page)).toBe(116);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SCREENS_DIR}/m1-pinch-pinch-up.png` });
  await setHands(leftHand(4), openRight(3, { x: R0.x, y: yUp }, { tilt: 0.3 }));
  await page.waitForTimeout(250);
  expect(await bus(page, "held")).not.toBeNull();
  await page.screenshot({ path: `${SCREENS_DIR}/m1-pinch-after-release-return.png` });
  for (const f of ["pinch-start", "pinch-up", "after-release-return"]) expect(fs.existsSync(`${SCREENS_DIR}/m1-pinch-${f}.png`), f).toBe(true);
});

test("video: pinch tempo up and down, release, return (test-results/videos/m1-pinch.webm)", async ({ synthPage: page, setHands, browser }) => {
  test.setTimeout(90_000);
  const OUT = "test-results/videos/m1-pinch.webm";
  await enterArp(page, setHands, { bpm: 110, q: 2 });
  await setHands(LEFT, openRight(2, R0));
  await page.waitForTimeout(3200); // first-use labels show, then go away
  const rec = createScreencast();
  await rec.track(page, "synth");
  await page.waitForTimeout(800);
  await setHands(LEFT, pinchAt(R0));
  await page.waitForTimeout(600);
  const size = await bus(page, "right/size");
  const yAt = (k) => R0.y - (k * size) / PINCH_TEMPO.BPM_PER_HAND;
  // Smooth sweep: up to +12, down to -6, back to +4 (~60 fps of input over ~4 s).
  const path = [];
  for (let k = 0; k <= 12; k += 0.25) path.push(k);
  for (let k = 12; k >= -6; k -= 0.25) path.push(k);
  for (let k = -6; k <= 4; k += 0.25) path.push(k);
  for (const k of path) {
    await setHands(LEFT, pinchAt({ x: R0.x, y: yAt(k) }));
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(500);
  expect(await bpmNow(page)).toBe(114);
  await setHands(LEFT, openRight(2, { x: R0.x, y: yAt(4) }));
  await page.waitForTimeout(900);
  for (let y = yAt(4); y <= R0.y + 0.001; y += 0.01) {
    await setHands(LEFT, openRight(2, { x: R0.x, y }));
    await page.waitForTimeout(60);
  }
  await setHands(LEFT, openRight(2, R0));
  await page.waitForTimeout(1200);
  expect(await bus(page, "held")).toBe(null);
  await rec.untrack(page);
  const r = await rec.save(browser, OUT, { layout: ["synth"], cellW: 1280, cellH: 800 });
  expect(fs.statSync(OUT).size).toBeGreaterThan(50_000);
  expect(r.durationMs).toBeGreaterThan(5000);
});
