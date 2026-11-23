// Milestone 1 integration: radial menu + Arp mode in the real app (?mockHands), the decided hand-role
// changes (left height = master volume, right fist = menu), and sound continuity across mode switches.
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { hand, leftHand, rightHand, fist, DESKTOP_VIEW, masterAt } from "./helpers/hands.js";
import { MASTER_VOLUME } from "../src/router.js";
import { recordAudio, rms, writeWav } from "./helpers/audio.js";
import { detectOnsets, noteLengths, peakAbs } from "./helpers/arp-analysis.js";

const WAV_DIR = "test-results/audio";
// The switch tests measure audio continuity; keep them off each other's CPU.
test.describe.configure({ mode: "default" });

// Display-space positions (DESKTOP_VIEW: fake camera 640x480 on a 1280x800 canvas).
// Hand size ~0.11 canvas widths -> select radius ~0.1 width (x) / ~0.15 height (y).
const R0 = { x: 0.3, y: 0.42 }; // right hand home (screen left: the video is mirrored)
const STEP = { right: [0.014, 0], left: [-0.014, 0], up: [0, -0.022], down: [0, 0.022] };

const at = (p) => ({ pos: p, view: DESKTOP_VIEW });
const openRight = (q = 1, p = R0, o = {}) => rightHand(q, { ...at(p), ...o });
const fistAt = (p = R0, o = {}) => fist({ ...at(p), ...o });
const LEFT = leftHand(1); // A major, left height 0.5 (master volume 2/3)

const bus = (page, name) => page.evaluate((n) => window.__gsTest.bus.get(n), name);
const menu = (page) => bus(page, "menu");
const modeId = (page) => bus(page, "mode");

/** Logs mode/menu changes and arp/chord note events with page + AudioContext times. */
async function installLog(page) {
  await page.evaluate(() => {
    const { bus, ctx } = window.__gsTest;
    window.__log = [];
    const ac = () => ctx.audio.ac?.currentTime ?? 0;
    bus.subscribe(
      {
        onSet: (n, v) => window.__log.push({ n, v: v && typeof v === "object" ? { ...v } : v, t: performance.now(), ac: ac() }),
        onEvent: (n, d, pt) => window.__log.push({ n, d: { ...d }, pt, t: performance.now(), ac: ac() }),
      },
      ["mode", "menu", "note/on", "note/cancel"]
    );
  });
}
const log = (page) => page.evaluate(() => window.__log);

/**
 * Fist at `from` -> menu opens -> move toward `dir` until `expectId` is selected (null: stay in the
 * center zone). Leaves the fist at the final point; returns that point.
 */
async function fistSelect(page, setHands, { left = LEFT, from = R0, dir = "right", steps = 10, expectId, shot } = {}) {
  await setHands(left, fistAt(from));
  await expect.poll(async () => (await menu(page))?.state, { timeout: 2000 }).toBe("open");
  if (shot?.open) await page.screenshot({ path: `${SCREENS_DIR}/${shot.open}` });
  let p = from;
  for (let i = 1; i <= steps; i++) {
    p = { x: from.x + STEP[dir][0] * i, y: from.y + STEP[dir][1] * i };
    await setHands(left, fistAt(p));
    await page.waitForTimeout(35);
  }
  await expect.poll(async () => (await menu(page))?.selectedId ?? null, { timeout: 2000 }).toBe(expectId ?? null);
  return p;
}

/** Full gesture switch: fist, move, open hand. Resolves once the countdown is over. */
async function switchMode(page, setHands, { dir, expectId, left = LEFT, from = R0, open = (p) => openRight(1, p), shots = {} }) {
  const p = await fistSelect(page, setHands, { left, from, dir, expectId, shot: shots });
  if (shots.selected) await page.screenshot({ path: `${SCREENS_DIR}/${shots.selected}` });
  await setHands(left, open(p));
  await expect.poll(() => modeId(page), { timeout: 1000 }).toBe(expectId);
  if (shots.countdown) {
    await page.waitForTimeout(180);
    await page.screenshot({ path: `${SCREENS_DIR}/${shots.countdown}` });
  }
  await expect.poll(async () => (await menu(page)) ?? null, { timeout: 2000 }).toBe(null);
  return p;
}

/** Longest run (s) below `thresh` inside [t0, t1] s of the recording. */
function longestSilence(samples, sr, t0 = 0, t1 = samples.length / sr, thresh = 0.003) {
  let best = 0, run = 0;
  for (let i = Math.max(0, Math.round(t0 * sr)); i < Math.min(samples.length, Math.round(t1 * sr)); i++) {
    if (Math.abs(samples[i]) < thresh) best = Math.max(best, ++run);
    else run = 0;
  }
  return best / sr;
}

/**
 * Max |second difference| (discontinuity metric from tests/arp.spec.js clickStats).
 * Samples on render-quantum joins (index % 128 in {0, 1}) are skipped: under heavy parallel test load
 * the capture tap (a main-thread ScriptProcessor, recording starts on a quantum boundary) occasionally
 * drops a whole quantum, which shows up as a spike exactly there. App-side gain changes are
 * sample-accurate ramps, so a real click lands anywhere and is still caught.
 */
function maxD2(samples) {
  let m = 0;
  for (let i = 2; i < samples.length; i++) {
    if (i % 128 < 2) continue;
    m = Math.max(m, Math.abs(samples[i] - 2 * samples[i - 1] + samples[i - 2]));
  }
  return m;
}

/** Starts a long recording (resolve with stop()). */
async function startRec(page) {
  await page.evaluate(() => {
    window.__audioCap.chunks = [];
    window.__audioCap.recording = true;
  });
  return async () => {
    const { chunks, sampleRate } = await page.evaluate(() => {
      window.__audioCap.recording = false;
      return { chunks: window.__audioCap.chunks, sampleRate: window.__audioCap.sampleRate };
    });
    return { samples: Float32Array.from(chunks.flat()), sampleRate };
  };
}

test.describe("mode switching with the fist menu", () => {
  test("fist -> right -> open: Chords -> Arp; arp notes start after the countdown; same flow back", async ({ synthPage: page, setHands }) => {
    await installLog(page);
    await setHands(LEFT, openRight(1));
    await page.waitForTimeout(400);
    expect(await modeId(page)).toBe("chords");

    await switchMode(page, setHands, { dir: "right", expectId: "arp" });
    const L = await log(page);
    const confirm = L.find((e) => e.n === "mode" && e.v === "arp");
    const countdown = L.find((e) => e.n === "menu" && e.v?.state === "countdown");
    expect(countdown, "a countdown ran").toBeTruthy();
    // The badge / mode signal switches at the start of the countdown (same router frame).
    expect(Math.abs(confirm.t - countdown.t)).toBeLessThan(50);
    await page.waitForTimeout(600);
    const arpOns = (await log(page)).filter((e) => e.n === "note/on" && e.d.voice === "arp");
    expect(arpOns.length).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(() => window.__gsTest.ctx.clock.running)).toBe(true);

    // ... and back to Chords (up).
    await switchMode(page, setHands, { dir: "up", expectId: "chords" });
    await page.waitForTimeout(400);
    const L2 = await log(page);
    const back = L2.findLast((e) => e.n === "mode" && e.v === "chords");
    const lateArp = L2.filter((e) => e.n === "note/on" && e.d.voice === "arp" && e.ac > back.ac + 0.15);
    expect(lateArp, "arp stops after leaving Arp").toEqual([]);
    expect(rms((await recordAudio(page, 300)).samples)).toBeGreaterThan(0.05); // chord pad sounds
    expect(await page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBe(4);
    expect(await page.evaluate(() => window.__gsTest.ctx.clock.running), "clock keeps running").toBe(true);
  });

  for (const [from, to, dir] of [["chords", "arp", "right"], ["arp", "chords", "up"]]) {
    test(`no click or gap across ${from} -> ${to} while the left hand holds a chord`, async ({ synthPage: page, setHands }, info) => {
      test.setTimeout(45_000);
      // High right hand: Chords = loud pad, Arp = long overlapping notes (so silence = a real gap).
      const HIGH = { x: 0.3, y: 0.3 };
      const open = (p) => openRight(1, HIGH);
      await setHands(LEFT, open());
      await page.waitForTimeout(400);
      if (from === "arp") {
        await switchMode(page, setHands, { dir: "right", expectId: "arp", from: HIGH, open });
        await page.waitForTimeout(800);
      }
      // Steady-state references for the discontinuity metric.
      const ref1 = (await recordAudio(page, 500)).samples;
      await installLog(page);
      const stop = await startRec(page);
      await page.waitForTimeout(300);
      await switchMode(page, setHands, { dir, expectId: to, from: HIGH, open });
      await page.waitForTimeout(900);
      const rec = await stop();
      const ref2 = (await recordAudio(page, 500)).samples;
      writeWav(`${WAV_DIR}/m1-switch-${from}-${to}.wav`, rec.samples, rec.sampleRate);

      const sr = rec.sampleRate;
      const gap = longestSilence(rec.samples, sr, 0.05, rec.samples.length / sr - 0.05);
      const d2 = maxD2(rec.samples);
      const ref = Math.max(maxD2(ref1), maxD2(ref2));
      info.annotations.push({ type: "continuity", description: JSON.stringify({ gapMs: gap * 1000, d2, ref }) });
      console.log(`[m1 ${from}->${to}] longest silence ${(gap * 1000).toFixed(1)} ms, max d2 ${d2.toFixed(4)} (steady ${ref.toFixed(4)})`);
      expect(gap, "longest silence across the switch").toBeLessThan(0.03);
      expect(d2, "no discontinuity spike beyond steady-state playing").toBeLessThanOrEqual(ref * 1.25 + 1e-3);
      expect(peakAbs(rec.samples)).toBeLessThanOrEqual(1);
    });
  }

  test("open hand in the center zone changes nothing (no countdown)", async ({ synthPage: page, setHands }) => {
    await installLog(page);
    await setHands(LEFT, openRight(2));
    await page.waitForTimeout(300);
    await fistSelect(page, setHands, { dir: "right", steps: 1, expectId: null });
    await setHands(LEFT, openRight(2));
    await expect.poll(async () => (await menu(page)) ?? null).toBe(null);
    await page.waitForTimeout(300);
    const L = await log(page);
    expect(L.some((e) => e.n === "menu" && e.v?.state === "countdown")).toBe(false);
    expect(L.some((e) => e.n === "mode")).toBe(false);
    expect(await modeId(page)).toBe("chords");
  });

  test("tracking lost 0.3 s while the menu is open -> cancel, no change", async ({ synthPage: page, setHands }) => {
    await installLog(page);
    await setHands(LEFT, openRight(1));
    await page.waitForTimeout(300);
    await fistSelect(page, setHands, { dir: "right", expectId: "arp" });
    await setHands(LEFT); // right hand gone with Arp selected
    await page.waitForTimeout(150);
    expect((await menu(page))?.state, "kept during the grace period").toBe("open");
    await expect.poll(async () => (await menu(page)) ?? null, { timeout: 1000 }).toBe(null);
    await setHands(LEFT, openRight(1));
    await page.waitForTimeout(300);
    expect(await modeId(page)).toBe("chords");
    expect((await log(page)).some((e) => e.n === "menu" && e.v?.state === "countdown")).toBe(false);
  });

  test("menu open: right-hand values hold; left-hand chord changes and master volume stay live", async ({ synthPage: page, setHands }) => {
    await setHands(LEFT, openRight(2, R0, { tilt: 0.5 }));
    await page.waitForTimeout(400);
    const snap = () =>
      page.evaluate(() => {
        const { synth, bus } = window.__gsTest;
        return {
          voicing: bus.get("voicing"),
          filter: bus.get("filter"),
          cutoff: synth.filter.frequency.value,
          chordGain: synth.chordGain.gain.value,
          master: bus.get("volume"),
          masterGain: synth.masterGain.gain.value,
          oscs: synth.oscillators.map((o) => Math.round(o.frequency.value)),
          chord: document.getElementById("chordDisplay").textContent,
        };
      });
    const before = await snap();
    await fistSelect(page, setHands, { dir: "right", steps: 1, expectId: null });
    // Fist with a different tilt and height, still in the center zone: nothing on the right changes.
    await setHands(LEFT, fistAt({ x: R0.x, y: R0.y + 0.015 }, { tilt: -0.9 }));
    await page.waitForTimeout(300);
    const held = await snap();
    for (const k of ["voicing", "filter", "chord"]) expect(held[k], k).toEqual(before[k]);
    expect(held.oscs).toEqual(before.oscs);
    expect(Math.abs(held.cutoff - before.cutoff)).toBeLessThan(5);
    expect(Math.abs(held.chordGain - before.chordGain)).toBeLessThan(0.01);

    // Left-hand chord change while the menu is open: it sounds (with the held voicing 2).
    await setHands(leftHand(4), fistAt({ x: R0.x, y: R0.y + 0.015 }, { tilt: -0.9 }));
    await expect(page.locator("#chordDisplay")).toHaveText("D(IV)");
    const changed = await snap();
    expect(changed.oscs).not.toEqual(before.oscs);
    expect(changed.voicing).toBe(2);
    expect(rms((await recordAudio(page, 300)).samples)).toBeGreaterThan(0.05);

    // Left height (master volume) is live while the menu is open.
    await setHands(leftHand(4, { volume: 0.9 }), fistAt({ x: R0.x, y: R0.y + 0.015 }, { tilt: -0.9 }));
    await page.waitForTimeout(500);
    const louder = await snap();
    expect(louder.master).toBeGreaterThan(0.95);
    expect(louder.masterGain).toBeGreaterThan(0.9);
    expect((await menu(page))?.state).toBe("open");
  });
});

test.describe("Arp in the app", () => {
  async function enterArp(page, setHands, p = R0) {
    await setHands(LEFT, openRight(1, p));
    await page.waitForTimeout(300);
    await switchMode(page, setHands, { dir: "right", expectId: "arp", from: p, open: () => openRight(1, p) });
    await page.waitForTimeout(500);
  }
  const arpState = (page) => page.evaluate(() => window.__gsTest.registry.getMode("arp").state);

  test("right height = gate (measured note length)", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands);
    // Low hand: short plucked notes.
    await setHands(LEFT, openRight(1, { x: 0.3, y: 0.86 }));
    await page.waitForTimeout(600);
    const lowGate = (await arpState(page)).gate;
    const low = await recordAudio(page, 1500);
    const lowOn = detectOnsets(low.samples, low.sampleRate);
    const lowLens = noteLengths(low.samples, low.sampleRate, lowOn).slice(0, -1);
    // High hand: long overlapping notes.
    await setHands(LEFT, openRight(1, { x: 0.3, y: 0.2 }));
    await page.waitForTimeout(600);
    const highGate = (await arpState(page)).gate;
    const high = await recordAudio(page, 1500);
    console.log(`[m1 gate] low ${lowGate.toFixed(2)}: ${lowLens.map((l) => (l * 1000).toFixed(0)).join(",")} ms; high ${highGate.toFixed(2)}`);
    expect(lowGate).toBeLessThan(0.15);
    expect(highGate).toBeGreaterThan(0.6);
    expect(lowOn.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...lowLens)).toBeLessThan(0.12);
    expect(longestSilence(high.samples, high.sampleRate), "high gate: notes overlap").toBeLessThan(0.01);
    expect(await bus(page, "arp/gate")).toBeCloseTo(highGate, 5);
  });

  test("right tilt = filter", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands);
    const cutoff = async (tilt) => {
      await setHands(LEFT, openRight(1, R0, { tilt }));
      await page.waitForTimeout(400);
      return page.evaluate(() => window.__gsTest.synth.filter.frequency.value);
    };
    expect(await cutoff(1)).toBeGreaterThan(4500);
    expect(await cutoff(-1)).toBeLessThan(300);
    expect(await bus(page, "filter")).toBe(-1);
  });

  test("right thumb = double time from the next beat", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands);
    const req = await page.evaluate(() => {
      const c = window.__gsTest.ctx.clock;
      return { t: c.beatAt(window.__gsTest.ctx.audio.ac.currentTime) };
    });
    await setHands(LEFT, openRight(1, R0, { thumb: true }));
    await page.waitForTimeout(1200);
    const s = await page.evaluate(() => {
      const arp = window.__gsTest.registry.getMode("arp");
      const c = window.__gsTest.ctx.clock;
      return { doubleTime: c.doubleTime, active: c.doubleTimeActive, steps: arp.steps.map((x) => ({ beat: x.beat, beats: x.beats })) };
    });
    expect(s.doubleTime).toBe(true);
    expect(s.active).toBe(true);
    const later = s.steps.filter((x) => x.beat > req.t + 1.5);
    expect(later.length).toBeGreaterThan(3);
    expect(later.every((x) => x.beats === 0.25)).toBe(true);
    // The switch happened on a whole beat.
    const first = s.steps.find((x) => x.beats === 0.25);
    expect(Number.isInteger(first.beat)).toBe(true);
    await setHands(LEFT, openRight(1, R0, { thumb: false }));
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__gsTest.ctx.clock.doubleTimeActive)).toBe(false);
  });

  test("left-hand chord changes reach the arp and the chord display", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands);
    await setHands(leftHand(6, { minor: true }), openRight(1));
    await expect(page.locator("#chordDisplay")).toHaveText("F#m(vi)");
    await page.waitForTimeout(700);
    const midis = await page.evaluate(() => window.__gsTest.registry.getMode("arp").steps.slice(-3).map((s) => s.midi));
    // F#m voicing 1 from F#3 (66): F#3 C#4 F#4 A4.
    for (const m of midis) expect([66, 73, 78, 81]).toContain(m);
    expect(await page.evaluate(() => window.__gsTest.ctx.harmony.chord.rootMidi)).toBe(66);
  });

  test("left fist: the arp rests, the clock keeps counting", async ({ synthPage: page, setHands }) => {
    await enterArp(page, setHands);
    const leftFist = hand({ handedness: "Left", fingers: [] });
    await setHands(leftFist, openRight(1));
    // 800 ms (was 500): R0 is higher in the right hand's reach zone (src/input/reach-zones.js) than on the old
    // whole-image height scale, so the gate is longer (0.71: notes 0.36 s + release) and the last note scheduled before
    // the fist must end before the silence is measured (the tap also runs ~170 ms behind).
    await page.waitForTimeout(800);
    const beat0 = await page.evaluate(() => window.__gsTest.ctx.clock.beatAt(window.__gsTest.ctx.audio.ac.currentTime));
    expect(rms((await recordAudio(page, 600)).samples)).toBeLessThan(0.002);
    const s = await page.evaluate(() => ({
      running: window.__gsTest.ctx.clock.running,
      beat: window.__gsTest.ctx.clock.beatAt(window.__gsTest.ctx.audio.ac.currentTime),
      rests: window.__gsTest.registry.getMode("arp").steps.slice(-3).map((x) => x.midi),
    }));
    expect(s.running).toBe(true);
    expect(s.beat - beat0).toBeGreaterThan(1);
    expect(s.rests).toEqual([null, null, null]);
    await setHands(LEFT, openRight(1));
    await page.waitForTimeout(500);
    expect(rms((await recordAudio(page, 500)).samples)).toBeGreaterThan(0.01);
  });
});

test.describe("1.3 left height = master volume", () => {
  test("a chord change with the left hand does not move the volume (dead zone + smoothing)", async ({ synthPage: page, setHands }) => {
    await setHands(leftHand(1), openRight(1));
    await page.waitForTimeout(600);
    const read = () => page.evaluate(() => ({ v: window.__gsTest.bus.get("volume"), g: window.__gsTest.synth.masterGain.gain.value }));
    const start = await read();
    const samples = [];
    // Chord changes with a small height wobble (±0.025 of the frame) on every change.
    for (let i = 0; i < 14; i++) {
      const wobble = i % 2 ? 0.025 : -0.025;
      await setHands(leftHand((i % 5) + 1, { volume: 0.5 + wobble }), openRight(1));
      await page.waitForTimeout(110);
      samples.push(await read());
    }
    const maxDev = Math.max(...samples.map((s) => Math.abs(s.v - start.v)));
    const maxGainDev = Math.max(...samples.map((s) => Math.abs(s.g - start.g)));
    console.log(`[m1 master] start ${start.v.toFixed(3)}, max deviation ${maxDev.toFixed(4)} (gain ${maxGainDev.toFixed(4)})`);
    expect(maxDev).toBeLessThan(0.01);
    expect(maxGainDev).toBeLessThan(0.01);

    // A real move does change it: higher = louder, low hand = rest.
    // The move starts near the bottom of the master's range (hands are placed by normalized height in the reach band,
    // ws/reach-zones): from the 0.5 above (master 0.89) a move up to 0.85 saturates at 1 within a frame or two, so the
    // "smoothed" check below raced. Hand at LOW + 0.005 while moving down: the dead-zoned anchor is LOW + 0.045, master
    // ~0.1; the move to 0.85 then spans ~0.9 of the range and still takes several TAU_MS to get there.
    const { LOW } = MASTER_VOLUME;
    await setHands(leftHand(1, { volume: LOW + 0.005 }), openRight(1));
    await expect.poll(async () => (await read()).v, { timeout: 3000 }).toBeLessThan(0.15);
    await page.waitForTimeout(600); // settled (TAU_MS 140)
    await setHands(leftHand(1, { volume: 0.85 }), openRight(1));
    await page.waitForTimeout(80);
    const early = (await read()).v;
    await page.waitForTimeout(600);
    const up = (await read()).v;
    expect(early, "smoothed (not an instant jump)").toBeLessThan(up - 0.05);
    expect(up).toBeGreaterThan(0.95);
    await setHands(leftHand(1, { volume: 0.05 }), openRight(1));
    await page.waitForTimeout(800);
    expect((await read()).v).toBeLessThan(0.01);
    expect(rms((await recordAudio(page, 300)).samples)).toBeLessThan(0.002);
  });

  test("Controls slider (ctx.setMasterVolume) wins until the left hand moves (ui/override)", async ({ synthPage: page, setHands }) => {
    await setHands(leftHand(1), openRight(1));
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__gsTest.bus.set("ui/override", ["master"]);
      window.__gsTest.ctx.setMasterVolume(0.3);
    });
    await page.waitForTimeout(300);
    expect(await bus(page, "volume")).toBeCloseTo(0.3, 5);
    expect(await page.evaluate(() => window.__gsTest.ctx.masterVolume)).toBeCloseTo(0.3, 5);
    // The panel drops the override once the hand moves; the hand then takes over smoothly.
    await page.evaluate(() => window.__gsTest.bus.set("ui/override", []));
    await page.waitForTimeout(80);
    const mid = await bus(page, "volume");
    await page.waitForTimeout(700);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(masterAt(0.5) - 0.02);
    expect(await bus(page, "volume")).toBeCloseTo(masterAt(0.5), 2);
  });

  test("master volume works in Arp too", async ({ synthPage: page, setHands }) => {
    await setHands(LEFT, openRight(1));
    await page.waitForTimeout(300);
    await switchMode(page, setHands, { dir: "right", expectId: "arp" });
    await page.waitForTimeout(500);
    const loud = rms((await recordAudio(page, 1000)).samples);
    await setHands(leftHand(1, { volume: 0.22 }), openRight(1));
    await page.waitForTimeout(700);
    const soft = rms((await recordAudio(page, 1000)).samples);
    expect(loud).toBeGreaterThan(0.01);
    expect(soft / loud).toBeLessThan(0.45);
    expect(soft / loud).toBeGreaterThan(0.05);
  });
});

test("screenshots: chords-play, menu-open, menu-selected-arp, countdown, arp-play", async ({ synthPage: page, setHands }) => {
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  await setHands(leftHand(4), openRight(3, R0, { tilt: 0.4 }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENS_DIR}/m1-chords-play.png` });
  await switchMode(page, setHands, {
    dir: "right",
    expectId: "arp",
    left: leftHand(4),
    open: (p) => openRight(3, p, { tilt: 0.4 }),
    shots: { open: "m1-menu-open.png", selected: "m1-menu-selected-arp.png", countdown: "m1-countdown.png" },
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SCREENS_DIR}/m1-arp-play.png` });
  for (const f of ["chords-play", "menu-open", "menu-selected-arp", "countdown", "arp-play"]) {
    expect(fs.existsSync(`${SCREENS_DIR}/m1-${f}.png`), f).toBe(true);
  }
});

// Real-time video of the whole Chords -> Arp -> Chords switch. Playwright's `video: "on"` needs an
// ffmpeg build that is not installed here, so (as in tests/radial-menu-video.spec.js) CDP screencast
// frames are re-timed into a canvas stream and encoded with the browser's MediaRecorder.
test("video: Chords -> Arp -> Chords (test-results/videos/m1-switch.webm)", async ({ synthPage: page, setHands, context }) => {
  test.setTimeout(90_000);
  const W = 1280, H = 800, OUT = "test-results/videos/m1-switch.webm";
  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  await setHands(leftHand(1), openRight(1));
  await page.waitForTimeout(1200);
  await switchMode(page, setHands, { dir: "right", expectId: "arp", left: leftHand(1) });
  await page.waitForTimeout(800);
  await setHands(leftHand(4), openRight(2, { x: 0.3, y: 0.35 }));
  await page.waitForTimeout(1200);
  await switchMode(page, setHands, { dir: "up", expectId: "chords", left: leftHand(4) });
  await page.waitForTimeout(1200);
  await cdp.send("Page.stopScreencast");
  expect(frames.length).toBeGreaterThan(30);

  const enc = await context.newPage();
  await enc.goto("/labs/menu-lab.html?noCamera&manualClock"); // any same-origin page
  const b64 = await enc.evaluate(
    async ({ frames, W, H }) => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const g = c.getContext("2d");
      const imgs = await Promise.all(
        frames.map((f) => new Promise((res) => {
          const im = new Image();
          im.onload = () => res(im);
          im.src = "data:image/jpeg;base64," + f.data;
        }))
      );
      g.drawImage(imgs[0], 0, 0, W, H);
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 6e6 });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((r) => (rec.onstop = r));
      rec.start(250);
      const t0 = performance.now();
      for (let i = 0; i < imgs.length; i++) {
        const wait = (frames[i].t - frames[0].t) * 1000 - (performance.now() - t0);
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
    { frames, W, H }
  );
  await enc.close();
  fs.mkdirSync("test-results/videos", { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(b64, "base64"));
  expect(fs.statSync(OUT).size).toBeGreaterThan(50_000);
});
