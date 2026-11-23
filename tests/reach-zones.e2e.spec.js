// Reach zones + sideways axes in the real app (?mockHands).
// User feedback after real-camera testing: the up/down range "keeps changing. It should just be 75% of the size of the
// screen." -> height = palm y over the FIXED middle 75 % of the display height (12.5 % = 1 .. 87.5 % = 0), both hands
// (src/input/reach-zones.js BAND). Plus: right hand sideways = Drive, left hand sideways = Space (src/core/axes.js),
// each with a neutral middle, a Controls switch and an at-hand tick scale. Drive / Space are EXPERIMENTAL and OFF by
// default (user: "Mark it as an experimental feature and disable it for the moment"): every ON test turns the switch
// on first, through the Controls panel's "Experimental" group.
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { leftHand, rightHand, hand, DESKTOP_VIEW } from "./helpers/hands.js";
import { recordAudio, rms, spectrum, centroid, writeWav } from "./helpers/audio.js";
import { createScreencast } from "./helpers/screencast.js";

const WAV_DIR = "test-results/audio";
const dB = (x) => 20 * Math.log10(x);
const bus = (page, name) => page.evaluate((n) => window.__gsTest.bus.get(n), name);
const shot = (page, state) => page.screenshot({ path: `${SCREENS_DIR}/reach-${state}.png` });

/** Sets the Drive / Space switches through the Controls panel ("Experimental" group), then closes the panel. */
async function setAxes(page, want) {
  await page.locator("#controlsToggle").click();
  for (const [id, on] of Object.entries(want)) {
    const sw = page.locator(`[data-control="axis-${id}"]`);
    if ((await sw.getAttribute("aria-pressed")) !== String(on)) await sw.click();
    await expect(sw).toHaveAttribute("aria-pressed", String(on));
    await expect.poll(() => bus(page, `${id}/on`)).toBe(on);
  }
  await page.locator("#controlsToggle").click();
  await expect(page.locator("#controlsPanel")).toBeHidden();
}
const axesOn = (page) => setAxes(page, { drive: true, space: true });

const BAND_TOP = 0.125; // display fractions, src/input/reach-zones.js BAND (spelled out: the user's numbers)
const BAND_BOTTOM = 0.875;
/** A hand whose palm is at display y `y` (built with `pos`, no reach-zone math: independent of the implementation). */
const palmAt = (y, { handedness = "Right", x = handedness === "Right" ? 0.7 : 0.28, scale = 1, fingers = ["index", "middle", "ring", "pinky"] } = {}) =>
  hand({ handedness, fingers, pos: { x, y }, view: DESKTOP_VIEW, scale });

test.describe("reach zones: vertical (the user's bug)", () => {
  test("palm at 12.5 % of the screen height = 1.0, 50 % = 0.5, 87.5 % = 0.0, both hands, any hand size", async ({ synthPage: page, setHands }) => {
    for (const scale of [0.6, 1, 1.3]) {
      for (const [y, want] of [[BAND_TOP, 1], [0.3125, 0.75], [0.5, 0.5], [0.6875, 0.25], [BAND_BOTTOM, 0]]) {
        await setHands(palmAt(y, { handedness: "Left", scale }), palmAt(y, { scale }));
        await expect.poll(() => bus(page, "right/height"), { message: `right palm y ${y} scale ${scale}` }).toBeCloseTo(want, 2);
        await expect.poll(() => bus(page, "left/height"), { message: `left palm y ${y} scale ${scale}` }).toBeCloseTo(want, 2);
      }
    }
    for (const side of ["left", "right"]) {
      const z = await bus(page, `${side}/zone`);
      expect([z.top, z.bottom], side).toEqual([BAND_TOP, BAND_BOTTOM]);
    }
  });

  test("the band never changes: hand size jitter / a closer hand / a fist leave a still palm's height exactly as it was", async ({ synthPage: page, setHands }) => {
    const y = 0.4;
    const want = (BAND_BOTTOM - y) / (BAND_BOTTOM - BAND_TOP);
    const seen = new Set();
    for (const [i, scale] of [0.9, 1.1, 0.9, 1.1, 1.6, 0.7, 1].entries()) {
      const r = i === 5 ? hand({ handedness: "Right", fist: true, pos: { x: 0.7, y }, view: DESKTOP_VIEW, scale }) : palmAt(y, { scale });
      await setHands(palmAt(y, { handedness: "Left", scale }), r);
      await page.waitForTimeout(150); // a few frames at this size (the old band glided for ~1 s after a size change)
      const s = await page.evaluate(() => ({
        rh: window.__gsTest.bus.get("right/height"), lh: window.__gsTest.bus.get("left/height"),
        rz: window.__gsTest.bus.get("right/zone"), lz: window.__gsTest.bus.get("left/zone"),
      }));
      expect(s.rh, `right, scale ${scale}`).toBeCloseTo(want, 3);
      expect(s.lh, `left, scale ${scale}`).toBeCloseTo(want, 3);
      seen.add(`${s.rz.top}|${s.rz.bottom}|${s.lz.top}|${s.lz.bottom}`);
    }
    expect([...seen]).toEqual([`${BAND_TOP}|${BAND_BOTTOM}|${BAND_TOP}|${BAND_BOTTOM}`]);
  });

  test("edge-track markers stay level with the palm (±4 px) across the band and stop at its ends", async ({ synthPage: page, setHands }) => {
    const H = await page.evaluate(() => window.innerHeight);
    // Arp: a mode with a right track (Chords has none since the right height lost its function there).
    await setHands(leftHand(1));
    await page.evaluate(() => window.__gsTest.router.setMode("arp"));
    for (const v of [0, 0.2, 0.5, 0.8, 1]) {
      await setHands(leftHand(1, { volume: v }), rightHand(2, { volume: v }));
      await page.waitForTimeout(250);
      const s = await page.evaluate(() => ({
        tracks: window.__gsTest.ui.tracks,
        l: window.__gsTest.bus.get("left/pos"), r: window.__gsTest.bus.get("right/pos"),
        lh: window.__gsTest.bus.get("left/height"), rh: window.__gsTest.bus.get("right/height"),
      }));
      expect(s.rh).toBeCloseTo(v, 2);
      expect(s.lh).toBeCloseTo(v, 2);
      expect(Math.abs(s.tracks["right-track"].markerY - s.r.y * H), `right marker at ${v}`).toBeLessThanOrEqual(4);
      expect(Math.abs(s.tracks["master-track"].markerY - s.l.y * H), `master marker at ${v}`).toBeLessThanOrEqual(4);
      expect(Math.abs(s.tracks["right-track"].markerY - (BAND_BOTTOM - v * (BAND_BOTTOM - BAND_TOP)) * H), `right marker on the band at ${v}`).toBeLessThanOrEqual(4);
      if (v === 1) await shot(page, "top");
      if (v === 0) await shot(page, "bottom");
    }
    // Beyond the band the value clamps and the marker stays at the band's end.
    const z = await bus(page, "right/zone");
    await setHands(leftHand(1), rightHand(2, { pos: { x: 0.7, y: z.top - 0.06 }, view: DESKTOP_VIEW }));
    await page.waitForTimeout(250);
    expect(await bus(page, "right/height")).toBe(1);
    const m = await page.evaluate(() => window.__gsTest.ui.tracks["right-track"].markerY);
    expect(Math.abs(m - z.top * H)).toBeLessThanOrEqual(4);
  });

  test("Arp gate reaches 0 and 1 inside the band", async ({ synthPage: page, setHands }) => {
    await setHands(leftHand(1));
    await page.evaluate(() => window.__gsTest.router.setMode("arp"));
    for (const v of [1, 0, 1]) {
      await setHands(leftHand(1), rightHand(2, { volume: v }));
      await expect.poll(() => bus(page, "arp/gate"), { message: `gate at ${v}` }).toBeCloseTo(v, 2);
    }
    // ...from a palm at the band's ends (12.5 % / 87.5 % of the screen height) and beyond them (clamped)
    for (const [y, want] of [[BAND_TOP, 1], [BAND_BOTTOM, 0], [0.05, 1], [0.95, 0]]) {
      await setHands(leftHand(1), palmAt(y, { fingers: ["index", "middle"] }));
      await expect.poll(() => bus(page, "arp/gate"), { message: `gate at palm y ${y}` }).toBeCloseTo(want, 2);
    }
    await setHands(leftHand(1), rightHand(2, { volume: 1 }));
    await page.waitForTimeout(300);
    await shot(page, "arp-gate-top");
  });

  test("Lead: the cursor reaches the top and bottom notes and both octave arrows inside the band", async ({ synthPage: page, setHands }) => {
    // Real orientation (chord hand on screen LEFT, melody hand on the RIGHT), placed by palm position.
    const L = palmAt(0.5, { handedness: "Left", x: 0.25, fingers: ["index"] });
    const R = (y) => palmAt(y, { x: 0.75 });
    await setHands(L);
    await page.evaluate(() => window.__gsTest.router.setMode("lead"));
    const dbg = () => page.evaluate(() => window.__gsTest.router.rightMode._debug()); // Lead = a layer on the base
    const placeAtY = async (y) => {
      await setHands(L, R(y));
      await page.waitForTimeout(250);
      return dbg();
    };
    await setHands(L, R(0.5));
    await expect.poll(async () => (await bus(page, "ui/sides"))?.expr).toBe("right");
    await page.waitForTimeout(600); // ladder clearance cache (500 ms) sees the final layout
    const H = await page.evaluate(() => window.innerHeight);
    const z = await bus(page, "right/zone");
    expect([z.top, z.bottom]).toEqual([BAND_TOP, BAND_BOTTOM]);
    let d = await dbg();
    expect(d.geo.side).toBe("right");
    // The ladder spans the fixed band: arrows at its ends (palm at height 1 / 0), lines between. DOM chrome at that
    // edge still wins (the arrows never sit under it): the up arrow is at the band top or below it, never above.
    expect(d.geo.upY).toBeGreaterThanOrEqual(z.top * H - 2);
    expect(Math.abs(d.geo.downY - z.bottom * H)).toBeLessThanOrEqual(2);
    const midis = d.lines.map((l) => l.midi);
    const [lo, hi] = [Math.min(...midis), Math.max(...midis)];
    d = await placeAtY(d.geo.top / H);
    expect(d.preview, "top line").toBe(hi);
    d = await placeAtY(d.geo.bottom / H);
    expect(d.preview, "bottom line").toBe(lo);
    // Height 1 / 0 (palm at the band's ends) = the octave arrows.
    await setHands(L, R(BAND_TOP));
    await expect.poll(async () => (await dbg()).hover).toBe("up");
    await shot(page, "lead-up-arrow");
    await setHands(L, R(BAND_BOTTOM));
    await expect.poll(async () => (await dbg()).hover).toBe("down");
  });

  test("no Range setting: the Controls panel has no band presets (the band is fixed)", async ({ synthPage: page }) => {
    await page.locator("#controlsToggle").click();
    await expect(page.locator("#controlsPanel")).toBeVisible();
    await expect(page.locator('[data-control="range"]')).toHaveCount(0);
    await expect(page.locator("#controlsPanel")).not.toContainText("Comfort");
    expect(await bus(page, "reach/range")).toBeUndefined();
  });
});

test.describe("reach zones: horizontal", () => {
  test("default OFF: hands sideways publish nothing (no left/x, right/x, drive, space) and change no sound", async ({ synthPage: page, setHands }) => {
    expect(await bus(page, "drive/on")).toBe(false);
    expect(await bus(page, "space/on")).toBe(false);
    for (const x of [0, 1, 0.5, 1]) {
      await setHands(leftHand(1, { x }), rightHand(2, { x }));
      await page.waitForTimeout(150);
    }
    for (const n of ["left/x", "right/x", "drive", "space"]) expect(await bus(page, n), n).toBeUndefined();
    const audio = await page.evaluate(() => ({ drive: window.__gsTest.synth.drive, space: window.__gsTest.synth.space, shaper: !!window.__gsTest.synth.waveShaper?.curve, send: !!window.__gsTest.synth.spaceSend }));
    expect(audio).toEqual({ drive: 0, space: 0, shaper: false, send: false }); // Drive bypassed (no curve), no reverb running
  });

  test("left/x and right/x (switched on): 0 inner, 0.5 neutral (band middle), 1 outer; null when the hand is lost", async ({ synthPage: page, setHands }) => {
    await axesOn(page);
    for (const x of [0, 0.5, 1]) {
      await setHands(leftHand(1, { x }), rightHand(2, { x }));
      await page.waitForTimeout(150);
      expect(await bus(page, "left/x"), `left x ${x}`).toBeCloseTo(x, 2);
      expect(await bus(page, "right/x"), `right x ${x}`).toBeCloseTo(x, 2);
    }
    const zl = await bus(page, "left/zone");
    const zr = await bus(page, "right/zone");
    // Each band is on the side the hand is displayed on (`ui/sides`), outer end toward that edge.
    const sides = await bus(page, "ui/sides");
    expect(sides).toEqual({ chord: "left", expr: "right" }); // default hands = real use: chord hand on the screen left
    expect(zl.side).toBe(sides.chord);
    expect(zr.side).toBe(sides.expr);
    expect(zr.side === "left" ? zr.outer < zr.inner : zr.outer > zr.inner).toBe(true);
    await setHands(leftHand(1));
    await page.waitForTimeout(150);
    expect(await bus(page, "right/x")).toBeNull();
    // Default hands (as every other test places them) are neutral: no Drive / Space.
    await setHands(leftHand(1), rightHand(2));
    await page.waitForTimeout(500); // Space glides back from 1 (60 ms smoothing)
    expect(await bus(page, "drive")).toBe(0);
    expect(await bus(page, "space")).toBe(0);
  });
});

// ---------- Sound: Drive (right x) and Space (left x) ----------

/** Watches the signal INTO the limiter (masterGain output) and the limiter's gain reduction (gain-staging spec). */
async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__gainProbe) return;
    const s = window.__gsTest.synth;
    const pr = (window.__gainProbe = { on: false, pre: 0, red: 0 });
    const sp = s.ctx.createScriptProcessor(512, 1, 1);
    sp.onaudioprocess = (e) => {
      if (!pr.on) return;
      const d = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) pr.pre = Math.max(pr.pre, Math.abs(d[i]));
      pr.red = Math.min(pr.red, s.limiter.reduction);
    };
    s.masterGain.connect(sp);
    sp.connect(s.ctx.destination);
  });
}
async function measure(page, ms = 800) {
  await installProbe(page);
  await page.evaluate(() => Object.assign(window.__gainProbe, { on: true, pre: 0, red: 0 }));
  const rec = await recordAudio(page, ms);
  const pr = await page.evaluate(() => { window.__gainProbe.on = false; return { ...window.__gainProbe }; });
  let peak = 0;
  for (const s of rec.samples) peak = Math.max(peak, Math.abs(s));
  return { ...rec, rms: rms(rec.samples), peak, pre: pr.pre, reduction: pr.red, centroid: centroid(spectrum(rec.samples, rec.sampleRate)) };
}
const threshold = (page) => page.evaluate(async () => (await import("/src/services/audio.js")).LIMITER.threshold);
async function settleLimiterMeter(page) {
  await expect.poll(() => page.evaluate(() => window.__gsTest.synth.limiter.reduction), { timeout: 10_000 }).toBeGreaterThan(-0.25);
}

test.describe("Drive (right hand sideways)", () => {
  test("brightness rises with right x, loudness stays within ±2 dB (default tone, filter neutral)", async ({ synthPage: page, setHands }) => {
    test.setTimeout(60_000);
    await setAxes(page, { drive: true });
    const L = leftHand(4, { volume: 0.7 });
    const levels = [];
    for (const x of [0.5, 0.75, 0.9, 1]) {
      await setHands(L, rightHand(3, { volume: 0.8, x }));
      await page.waitForTimeout(600); // drive glide (30 ms) + chord hold
      const m = await measure(page, 800);
      const drive = await bus(page, "drive");
      levels.push({ x, drive, ...m });
      writeWav(`${WAV_DIR}/reach-drive-${x}.wav`, m.samples, m.sampleRate);
      console.log(`[drive] x ${x} drive ${drive}: rms ${dB(m.rms).toFixed(2)} dB, centroid ${m.centroid.toFixed(0)} Hz, peak ${m.peak.toFixed(3)}`);
    }
    expect(levels[0].drive).toBe(0);
    expect(levels[3].drive).toBe(1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i].drive).toBeGreaterThan(levels[i - 1].drive);
      expect(levels[i].centroid, `centroid at x ${levels[i].x}`).toBeGreaterThan(levels[i - 1].centroid);
    }
    expect(levels[3].centroid / levels[0].centroid).toBeGreaterThan(1.3);
    for (const l of levels) {
      expect(Math.abs(dB(l.rms) - dB(levels[0].rms)), `loudness at x ${l.x}`).toBeLessThanOrEqual(2);
      expect(l.peak).toBeLessThanOrEqual(1);
    }
    await shot(page, "drive-full");
  });

  test("full Drive on loud Chords (sawtooth, filter open, master 1, right 1): no limiting, loudness ±2 dB, peak <= 1", async ({ synthPage: page, setHands }) => {
    test.setTimeout(60_000);
    const th = await threshold(page);
    await setAxes(page, { drive: true });
    await page.locator("#toneSelect").selectOption("sawtooth");
    const L = leftHand(6, { minor: true, volume: 0.95 }); // master 1, a close voicing below
    const out = [];
    for (const x of [0.5, 0.75, 1]) {
      await setHands(L, rightHand(4, { volume: 1, tilt: 1, x }));
      await page.waitForTimeout(700);
      await settleLimiterMeter(page); // Chrome's reduction meter decays slowly after any change
      const m = await measure(page, 800);
      out.push({ x, ...m });
      console.log(`[drive] loud x ${x}: rms ${dB(m.rms).toFixed(2)} dB, centroid ${m.centroid.toFixed(0)} Hz, limiter in ${dB(m.pre).toFixed(2)} dBFS, peak ${m.peak.toFixed(3)}, reduction ${m.reduction.toFixed(2)}`);
    }
    for (const m of out) {
      expect(dB(m.pre), `limiter input at x ${m.x}`).toBeLessThan(th);
      expect(m.reduction, `limiter reduction at x ${m.x}`).toBeGreaterThan(-0.5);
      expect(m.peak).toBeLessThanOrEqual(1);
      expect(Math.abs(dB(m.rms) - dB(out[0].rms)), `loudness at x ${m.x}`).toBeLessThanOrEqual(2);
    }
  });

  test("full Drive on loud Arp (gate 1, x2, max settings): no limiting, peak <= 1", async ({ synthPage: page, setHands }) => {
    const th = await threshold(page);
    await setAxes(page, { drive: true });
    await page.locator("#toneSelect").selectOption("sawtooth");
    await setHands(leftHand(1, { volume: 0.95 }));
    await page.evaluate(() => window.__gsTest.router.setMode("arp"));
    await setHands(leftHand(1, { volume: 0.95 }), rightHand(4, { volume: 1, tilt: 1, thumb: true, x: 1 }));
    await page.waitForTimeout(800);
    await settleLimiterMeter(page);
    expect(await bus(page, "drive")).toBe(1);
    const m = await measure(page, 1500);
    console.log(`[drive] arp: limiter in ${dB(m.pre).toFixed(2)} dBFS, peak ${m.peak.toFixed(3)}, rms ${m.rms.toFixed(4)}, reduction ${m.reduction.toFixed(2)}`);
    expect(m.rms).toBeGreaterThan(0.02);
    expect(dB(m.pre)).toBeLessThan(th);
    expect(m.reduction).toBeGreaterThan(-0.5);
    expect(m.peak).toBeLessThanOrEqual(1);
  });

  test("Drive off (default, and switched off again): right x has no effect (same brightness as neutral)", async ({ synthPage: page, setHands }) => {
    test.setTimeout(60_000);
    await page.locator("#toneSelect").selectOption("sawtooth");
    const L = leftHand(4, { volume: 0.95 });
    await setHands(L, rightHand(3, { volume: 0.8, x: 0.5 }));
    await page.waitForTimeout(900); // tone change + chord hold + ramps settle (steady state only)
    const neutral = await measure(page, 700);
    // Default: off. The hand all the way out changes nothing.
    await setHands(L, rightHand(3, { volume: 0.8, x: 1 }));
    await page.waitForTimeout(900);
    expect(await bus(page, "drive")).toBeUndefined();
    const dflt = await measure(page, 700);
    // On: full Drive. Off again: back to neutral (param 0).
    await setAxes(page, { drive: true });
    await expect.poll(() => bus(page, "drive")).toBe(1);
    await setAxes(page, { drive: false });
    await expect.poll(() => bus(page, "drive")).toBe(0);
    await page.waitForTimeout(900);
    const off = await measure(page, 700);
    for (const [name, m] of [["default", dflt], ["off", off]]) {
      console.log(`[drive-${name}] neutral ${dB(neutral.rms).toFixed(2)} dB ${neutral.centroid.toFixed(0)} Hz; ${name} ${dB(m.rms).toFixed(2)} dB ${m.centroid.toFixed(0)} Hz`);
      expect(Math.abs(m.centroid / neutral.centroid - 1), name).toBeLessThan(0.03);
      expect(Math.abs(dB(m.rms) - dB(neutral.rms)), name).toBeLessThan(0.5);
    }
  });
});

test.describe("Space (left hand sideways)", () => {
  /** Plays a chord, then takes the right hand away (Chords = rest) and measures what is left 0.2-0.7 s later. */
  async function tail(page, setHands, leftX) {
    const L = leftHand(4, { volume: 0.9, x: leftX });
    await setHands(L, rightHand(3, { volume: 0.9 }));
    await page.waitForTimeout(900);
    const playing = await measure(page, 400);
    await setHands(L); // note off: the chord fades in 50 ms
    const rec = await recordAudio(page, 1100);
    // The tap runs ~170 ms behind; skip 0.45 s (fade + tap latency), then 0.5 s of tail.
    const sr = rec.sampleRate;
    const seg = rec.samples.slice(Math.round(0.45 * sr), Math.round(0.95 * sr));
    return { playing: playing.rms, tail: rms(seg), samples: rec.samples, sr, space: await bus(page, "space") };
  }

  test("wet tail after note-off with left x high; none at neutral; dry level kept at neutral", async ({ synthPage: page, setHands }) => {
    test.setTimeout(60_000);
    await setAxes(page, { space: true });
    const dry = await tail(page, setHands, 0.5);
    expect(dry.space).toBe(0);
    const wet = await tail(page, setHands, 1);
    expect(wet.space).toBe(1);
    writeWav(`${WAV_DIR}/reach-space-tail.wav`, wet.samples, wet.sr);
    console.log(`[space] playing ${dB(dry.playing).toFixed(1)} / ${dB(wet.playing).toFixed(1)} dB; tail dry ${dB(dry.tail + 1e-9).toFixed(1)} dB, wet ${dB(wet.tail).toFixed(1)} dB`);
    expect(dB(dry.tail + 1e-9) - dB(dry.playing)).toBeLessThan(-50); // silence after the fade
    expect(dB(wet.tail) - dB(wet.playing)).toBeGreaterThan(-30); // a clear reverb tail
    // While playing, the wet mix does not make it louder than ±2 dB (dry trimmed as the send rises).
    expect(Math.abs(dB(wet.playing) - dB(dry.playing))).toBeLessThanOrEqual(2);
  });

  test("full Space on loud Chords: no limiting, peak <= 1", async ({ synthPage: page, setHands }) => {
    const th = await threshold(page);
    await setAxes(page, { space: true });
    await page.locator("#toneSelect").selectOption("sawtooth");
    await setHands(leftHand(6, { minor: true, volume: 0.95, x: 1 }), rightHand(4, { volume: 1, tilt: 1 }));
    await page.waitForTimeout(1500); // reverb builds up to its steady level
    await settleLimiterMeter(page);
    const m = await measure(page, 1000);
    console.log(`[space] loud: limiter in ${dB(m.pre).toFixed(2)} dBFS, peak ${m.peak.toFixed(3)}, reduction ${m.reduction.toFixed(2)}`);
    expect(dB(m.pre)).toBeLessThan(th);
    expect(m.reduction).toBeGreaterThan(-0.5);
    expect(m.peak).toBeLessThanOrEqual(1);
  });

  test("Space off (default, and switched off again): no tail", async ({ synthPage: page, setHands }) => {
    test.setTimeout(60_000);
    const t = await tail(page, setHands, 1);
    expect(t.space).toBeUndefined(); // default off: not published
    expect(dB(t.tail + 1e-9) - dB(t.playing)).toBeLessThan(-50);
    await setAxes(page, { space: true });
    await expect.poll(() => bus(page, "space")).toBe(1);
    await setAxes(page, { space: false });
    const t2 = await tail(page, setHands, 1);
    expect(t2.space).toBe(0);
    expect(dB(t2.tail + 1e-9) - dB(t2.playing)).toBeLessThan(-50);
  });
});

// ---------- UI ----------

test.describe("at-hand indicators, guide, help", () => {
  test("tick scales under each palm: none by default; switched on: neutral, active (dot at the hand); hidden when switched off", async ({ synthPage: page, setHands }) => {
    const regions = () => page.evaluate(() => Object.fromEntries(window.__gsTest.ui.regions.filter((r) => r.name.startsWith("axis-")).map((r) => [r.name, r.rect])));
    await setHands(leftHand(1, { x: 1 }), rightHand(2, { x: 1 }));
    await page.waitForTimeout(300);
    let r = await regions();
    expect(Object.keys(r)).toEqual([]); // default off: no at-hand indicators
    await shot(page, "axes-off");
    await axesOn(page);
    await setHands(leftHand(1, { x: 0.5 }), rightHand(2, { x: 0.5 }));
    await expect.poll(() => bus(page, "drive")).toBe(0); // glides back from the x 1 it was switched on at
    await page.waitForTimeout(100);
    r = await regions();
    expect(Object.keys(r).sort()).toEqual(["axis-drive", "axis-space"]);
    expect(r["axis-drive"].active).toBe(false);
    const W = await page.evaluate(() => window.innerWidth);
    const H = await page.evaluate(() => window.innerHeight);
    const rp = await bus(page, "right/pos");
    // under the palm, centered on it
    expect(r["axis-drive"].dot.y).toBeGreaterThan(rp.y * H);
    expect(Math.abs(r["axis-drive"].dot.x - rp.x * W)).toBeLessThan(4);
    await shot(page, "neutral");
    await setHands(leftHand(1, { x: 1 }), rightHand(2, { x: 1 }));
    await page.waitForTimeout(400);
    r = await regions();
    expect(r["axis-drive"].active).toBe(true);
    expect(r["axis-space"].active).toBe(true);
    expect(r["axis-drive"].value).toBe(1);
    // the dot moved outward: toward the right hand's screen edge
    const zr = await bus(page, "right/zone");
    expect(zr.side === "left" ? r["axis-drive"].dot.x < rp.x * W : r["axis-drive"].dot.x > rp.x * W).toBe(true);
    await shot(page, "drive-space-active");
    await setAxes(page, { drive: false });
    await page.waitForTimeout(200);
    r = await regions();
    expect(r["axis-drive"]).toBeUndefined();
    expect(r["axis-space"]).toBeDefined();
  });

  test("Controls panel: Experimental group at the bottom, off; guide + help lines only while switched on", async ({ synthPage: page }) => {
    const guide = page.locator("#gestureGuide");
    const helpLine = (t) => page.locator("#helpModal p").filter({ hasText: t });
    const LINES = ["Right hand sideways → Drive", "Left hand sideways → Space"];
    // Default: off. No guide lines, no help lines.
    await page.locator("#guideToggle").click();
    await expect(guide).toBeVisible();
    for (const t of LINES) await expect(guide).not.toContainText(t);
    await shot(page, "guide-default");
    await page.locator("#guideToggle").click();
    await page.locator("#helpButton").click();
    await expect(page.locator("#helpModal")).toBeVisible();
    await expect(page.locator("#helpExperimental")).toBeHidden();
    for (const t of LINES) await expect(helpLine(t)).toBeHidden();
    await page.locator("#closeHelp").click();
    // The panel: "Experimental" + note, then the two switches (off), after every other row.
    await page.locator("#controlsToggle").click();
    const head = page.locator('#controlsPanel [data-group="experimental"]');
    await expect(head).toBeVisible();
    await expect(head).toContainText("Experimental");
    await expect(head).toContainText("Hand sideways controls");
    const order = await page.evaluate(() => [...document.querySelectorAll("#controlsPanel > *")].map((e) => e.dataset.group || e.querySelector("[data-control]")?.dataset.control || e.dataset.hook || e.querySelector("[data-hook]")?.dataset.hook || ""));
    const at = (k) => order.indexOf(k);
    expect(at("experimental")).toBeGreaterThan(at("output"));
    expect(at("experimental")).toBeGreaterThan(at("master"));
    expect(at("axis-drive")).toBeGreaterThan(at("experimental"));
    expect(at("axis-space")).toBeGreaterThan(at("experimental"));
    for (const c of ["axis-drive", "axis-space"]) {
      await expect(page.locator(`[data-control="${c}"]`)).toBeVisible();
      await expect(page.locator(`[data-control="${c}"]`)).toHaveAttribute("aria-pressed", "false");
    }
    await shot(page, "controls");
    await page.locator("#controlsToggle").click();
    // Switched on: the guide and help show them (as today).
    await axesOn(page);
    await page.locator("#guideToggle").click();
    for (const t of LINES) await expect(guide).toContainText(t);
    await shot(page, "guide");
    await page.locator("#guideToggle").click();
    await page.locator("#helpButton").click();
    await expect(page.locator("#helpExperimental")).toBeVisible();
    for (const t of LINES) await expect(helpLine(t)).toBeVisible();
    await page.locator("#closeHelp").click();
    // Only Drive on: only its lines.
    await setAxes(page, { space: false });
    await page.locator("#helpButton").click();
    await expect(helpLine(LINES[0])).toBeVisible();
    await expect(helpLine(LINES[1])).toBeHidden();
  });

  test("phone 390x844: tick scales are compact and on screen", async ({ page, setHands }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?mockHands");
    await page.locator("#startOverlay").click();
    await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0);
    const { setPlacementView, viewFor } = await import("./helpers/hands.js");
    setPlacementView(viewFor(390, 844));
    const view = viewFor(390, 844);
    await page.evaluate(() => { window.__gsTest.bus.set("drive/on", true); window.__gsTest.bus.set("space/on", true); });
    await setHands(leftHand(1, { pos: { x: 0.25, y: 0.5 }, view, scale: 0.5 }), rightHand(2, { pos: { x: 0.8, y: 0.45 }, view, scale: 0.5 }));
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => window.__gsTest.ui.regions.filter((x) => x.name.startsWith("axis-")).map((x) => x.rect));
    expect(r.length).toBe(2);
    for (const rect of r) {
      expect(rect.w).toBeLessThanOrEqual(92);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(390);
    }
    await shot(page, "phone");
  });
});

test("video: reaching up/down and sideways (test-results/videos/reach-zones.webm)", async ({ synthPage: page, setHands, browser }) => {
  test.setTimeout(90_000);
  const OUT = "test-results/videos/reach-zones.webm";
  await axesOn(page); // sideways = experimental Drive / Space, switched on for the video
  await setHands(leftHand(1), rightHand(2));
  await page.waitForTimeout(500);
  const rec = createScreencast();
  await rec.track(page, "synth");
  // up and down through the whole band, then sideways out and back, both hands (~60 fps input, real time)
  const steps = [];
  for (let v = 0.5; v <= 1; v += 0.02) steps.push({ v, x: 0.5 });
  for (let v = 1; v >= 0; v -= 0.02) steps.push({ v, x: 0.5 });
  for (let v = 0; v <= 0.5; v += 0.02) steps.push({ v, x: 0.5 });
  for (let x = 0.5; x >= 0; x -= 0.025) steps.push({ v: 0.5, x });
  for (let x = 0; x <= 1; x += 0.025) steps.push({ v: 0.5, x });
  for (let x = 1; x >= 0.5; x -= 0.025) steps.push({ v: 0.5, x });
  for (const s of steps) {
    await setHands(leftHand(1, { volume: Math.max(0.3, s.v), x: s.x }), rightHand(2, { volume: s.v, x: s.x }));
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(400);
  await rec.untrack(page);
  const r = await rec.save(browser, OUT, { layout: ["synth"], cellW: 1280, cellH: 800 });
  expect(fs.statSync(OUT).size).toBeGreaterThan(50_000);
  expect(r.durationMs).toBeGreaterThan(4000);
});
