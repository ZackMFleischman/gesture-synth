// Milestone 2: Lead mode in the REAL app (?mockHands) -- e2e layer (docs/testing.md, `mN-*.spec.js`).
// The lab (tests/lead.spec.js, labs/lead-lab.html) proves the engine; this file proves each Lead UX check
// (2.1-2.5) where the player meets it: selected from the fist menu, ladder on the expression edge, Controls
// panel rows, DOM note-set badge, menu hold, no gap across mode switches, no clipping, layout.
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { recordAudio, spectrum, peaks, rms, writeWav, retryOnCaptureGlitch } from "./helpers/audio.js";
import { peakAbs } from "./helpers/arp-analysis.js";
import { triad, rng } from "./helpers/theory.js";
import { createScreencast } from "./helpers/screencast.js";
import {
  scene, setHands as setHandsOn, openApp, bus, modeId, dbg, ladder, yFor, frames,
  switchMode, startRec, longestSilence, maxD2, overlaps,
} from "./helpers/m2-lead.js";
import { rangeLow, mod12, midiToFreq, OCTAVE_MIN, OCTAVE_MAX, SET_HOLD_MS } from "../src/modes/lead-notes.js";
import { clearArea } from "../src/ui/theme.js";

const WAV_DIR = "test-results/audio";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const SC = scene(DESKTOP); // real use: chord hand on the screen left -> ladder on the RIGHT edge

/** Dominant pitch (Hz): the FFT's strongest peak. */
function pitchOf(samples, sampleRate) {
  const p = peaks(spectrum(samples, sampleRate, 16384), 0.3);
  return p.length ? p[0].freq : 0;
}

const isMobile = (page) => page.evaluate(() => document.body.classList.contains("gs-mobile"));
/** Opens the Controls panel: the toggle on desktop, the Controls sheet of the phone bar (docs/mobile-ui.md). */
async function openControls(page) {
  if (await isMobile(page)) await page.evaluate(() => window.__gsTest.mobile.openSheet("controls"));
  else await page.locator("#controlsToggle").click();
  await expect(page.locator("#controlsPanel")).toBeVisible();
}
async function closeControls(page) {
  if (await isMobile(page)) await page.evaluate(() => window.__gsTest.mobile.closeSheets());
  else await page.locator("#controlsToggle").click();
  await expect(page.locator("#controlsPanel")).toBeHidden();
  const vp = page.viewportSize();
  await page.mouse.move(vp.width / 2, vp.height / 2); // off the ladder strip
}

/** Lead via the Controls panel's Mode row (the screen path); leaves the mouse off the ladder strip. */
async function enterLeadByPanel(page) {
  await openControls(page);
  await page.locator('#controlsPanel [data-control="mode"] button[data-value="lead"]').click();
  await expect.poll(() => modeId(page)).toBe("lead");
  await closeControls(page);
}

/** Note set through the Controls panel row (opens and closes the panel). */
async function setNoteSet(page, n) {
  await openControls(page);
  await page.locator(`#controlsPanel .lead-controls [data-set="${n}"]`).click();
  await closeControls(page);
  expect((await dbg(page)).setId).toBe(n);
}

// Full gate: this file's tests run one after another (its @full audio measurements stay off each other's CPU).
// Fast run (PW_TIER=fast, no @full tests here): parallel, so the file is not one long serial job.
test.describe.configure({ mode: process.env.PW_TIER === "fast" ? "parallel" : "default" });

// =====================================================================================================
// Menu journeys + sound continuity
// =====================================================================================================

test.describe("Lead in the fist menu", () => {
  // Lead layer (docs/architecture.md): Lead goes on top of the base (Chords / Arp keep playing, no pad).
  test("fist -> left -> Lead on top of Chords; Lead -> Chords, Lead -> Arp and back to Arp + Lead; chord display from the base, no pad", async ({ synthPage: page }) => {
    const L = SC.left(1);
    const open = (p) => SC.open(4, SC.R.y, { x: p.x });
    await setHandsOn(page, L, SC.open(4));
    await page.waitForTimeout(400);
    expect(await modeId(page)).toBe("chords");
    const common = { left: L, from: SC.R, fistAt: SC.fistAt, open };

    await switchMode(page, { ...common, dir: "left", expectId: "lead" });
    await expect(page.locator("#modeBadge")).toHaveText("Chords+Lead");
    await expect(page.locator("#noteSetBadge")).toBeVisible();
    await expect(page.locator("#chordDisplay")).toHaveText("A(I)"); // Chords' chord (held voicing)
    await page.waitForTimeout(400);
    let d = await dbg(page);
    expect(d.side).toBe("right"); // expression hand on the screen right (real use)
    expect(d.pad).toEqual([]); // no pad: the base is the accompaniment
    expect(await page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBe(4); // Chords keeps playing

    await switchMode(page, { ...common, dir: "up", expectId: "chords" });
    await page.waitForTimeout(300);
    expect((await dbg(page)).pad).toEqual([]);
    expect(await page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBe(4);

    await switchMode(page, { ...common, dir: "left", expectId: "lead" });
    await switchMode(page, { ...common, dir: "right", expectId: "arp" });
    await page.waitForTimeout(500);
    expect((await dbg(page)).pad).toEqual([]);
    const arpOns = await page.evaluate(() => window.__gsTest.registry.getMode("arp").steps.filter((s) => s.midi != null).length);
    expect(arpOns).toBeGreaterThan(0);
    await switchMode(page, { ...common, dir: "left", expectId: "lead" });
    await page.waitForTimeout(300);
    d = await dbg(page);
    expect(d.pad).toEqual([]);
    await expect(page.locator("#modeBadge")).toHaveText("Arp+Lead");
    const arpOns2 = await page.evaluate(() => window.__gsTest.registry.getMode("arp").steps.filter((s) => s.midi != null).length);
    expect(arpOns2, "Arp keeps playing under Lead").toBeGreaterThan(arpOns);
    // The menu shows Lead on the left arc.
    expect(await page.evaluate(() => window.__gsTest.registry.getMode("lead").direction)).toBe("left");
  });

  for (const [from, to, dir] of [["chords", "lead", "left"], ["lead", "chords", "up"], ["lead", "arp", "right"], ["arp", "lead", "left"]]) {
    test(`no click or gap across ${from} -> ${to} while the left hand holds a chord`, { tag: "@full" }, async ({ context }, info) => {
      test.setTimeout(90_000);
      await retryOnCaptureGlitch(info, async ({ track }) => {
        const page = await openApp(context);
        try {
          // High right hand: Chords = loud pad, Arp = long overlapping notes, Lead = preview (pad only).
          const HIGH = { x: SC.R.x, y: 0.3 };
          const L = SC.left(1);
          // The opening hand: Lead gets the pre-pinch claw (preview, no note); Chords/Arp the same open "1" they
          // started with, so the steady state after the switch is the chord their hold() already plays.
          const openFor = (id) => () => (id === "lead" ? SC.preview(HIGH.y, { x: HIGH.x }) : SC.open(1, HIGH.y, { x: HIGH.x }));
          const common = { left: L, from: HIGH, fistAt: SC.fistAt };
          await setHandsOn(page, L, SC.open(1, HIGH.y, { x: HIGH.x }));
          await page.waitForTimeout(400);
          if (from === "lead") await switchMode(page, { ...common, open: openFor("lead"), dir: "left", expectId: "lead" });
          if (from === "arp") await switchMode(page, { ...common, open: openFor("arp"), dir: "right", expectId: "arp" });
          await page.waitForTimeout(800);
          const ref1 = track(await recordAudio(page, 500)).samples;
          const stop = await startRec(page);
          await page.waitForTimeout(300);
          await switchMode(page, { ...common, open: openFor(to), dir, expectId: to });
          await page.waitForTimeout(900);
          const rec = track(await stop());
          const ref2 = track(await recordAudio(page, 500)).samples;
          writeWav(`${WAV_DIR}/m2-switch-${from}-${to}.wav`, rec.samples, rec.sampleRate);
          const sr = rec.sampleRate;
          const gap = longestSilence(rec.samples, sr, 0.05, rec.samples.length / sr - 0.05);
          const d2 = maxD2(rec.samples);
          const ref = Math.max(maxD2(ref1), maxD2(ref2));
          info.annotations.push({ type: "continuity", description: JSON.stringify({ gapMs: gap * 1000, d2, ref }) });
          console.log(`[m2 ${from}->${to}] longest silence ${(gap * 1000).toFixed(1)} ms, max d2 ${d2.toFixed(4)} (steady ${ref.toFixed(4)})`);
          // Same thresholds as the M1 switch tests (tests/m1-integration.spec.js).
          expect(gap, "longest silence across the switch").toBeLessThan(0.03);
          expect(d2, "no discontinuity spike beyond steady-state playing").toBeLessThanOrEqual(ref * 1.25 + 1e-3);
          expect(peakAbs(rec.samples)).toBeLessThanOrEqual(1);
          expect(page.__errors).toEqual([]);
        } finally {
          await page.close();
        }
      });
    });
  }
});

// =====================================================================================================
// UX checks 2.1 - 2.5 in the app
// =====================================================================================================

test.describe("Lead UX checks in the app", () => {
  test("2.1 thick ladder lines move to the chord notes on each chord change (keys A + Eb)", async ({ synthPage: page }) => {
    await setHandsOn(page, SC.left(1), SC.preview(0.5));
    await enterLeadByPanel(page);
    await setNoteSet(page, 3);
    for (const [key, label] of [["A", "A"], ["Eb", "D#/Eb"]]) {
      await page.selectOption("#keySelect", { label });
      await page.mouse.move(640, 400);
      for (const [degree, minor] of [[1, false], [4, false], [5, false], [6, true], [2, true]]) {
        await setHandsOn(page, SC.left(degree, { minor }), SC.preview(0.5));
        await page.waitForFunction(([deg, maj]) => {
          const t = window.__gsTest;
          const d = t.registry.getMode("lead")._debug(t.ctx.now);
          return d.chord && d.chord.degree === deg && d.chord.isMajor === maj && t.ctx.now - d.changeAt > 170;
        }, [degree, !minor]);
        const d = await dbg(page);
        const low = rangeLow(key, d.octave);
        const want = triad(key, degree, !minor);
        const thick = d.lines.filter((l) => l.isChord);
        const expected = [];
        for (let m = low; m <= low + 24; m++) if (want.includes(mod12(m))) expected.push(m);
        expect(thick.map((l) => l.midi), `${key} ${degree}${minor ? "m" : ""}`).toEqual(expected);
        for (const l of thick) expect(Math.abs(l.y - (d.geo.bottom - ((l.midi - low) / 24) * (d.geo.bottom - d.geo.top)))).toBeLessThan(0.5);
        // The base (Chords, under the Lead layer) plays the same chord.
        const c = await bus(page, "chord");
        expect(c && [c.degree, c.isMajor]).toEqual([degree, !minor]);
      }
    }
  });

  test("2.2 the cursor does not flicker when the hand is still (camera jitter at a note edge)", { tag: "@full" }, async ({ synthPage: page }) => {
    await setHandsOn(page, SC.preview(0.5));
    await enterLeadByPanel(page);
    for (const set of [1, 4]) {
      await setNoteSet(page, set);
      const d0 = await dbg(page);
      const i = Math.floor(d0.lines.length / 2);
      const yEdge = (d0.lines[i].y + d0.lines[i + 1].y) / 2 / d0.geo.H;
      const gap = Math.abs(d0.lines[i].y - d0.lines[i + 1].y) / d0.geo.H;
      const r = rng(42 + set);
      await setHandsOn(page, SC.preview(yEdge + gap * 0.05));
      await page.waitForTimeout(100);
      const seen = [];
      for (let k = 0; k < 40; k++) {
        await setHandsOn(page, SC.preview(yEdge + (r() - 0.5) * gap * 0.5, { x: SC.R.x + (r() - 0.5) * 0.01 }));
        await page.waitForTimeout(35);
        seen.push((await dbg(page)).cursor.midi);
      }
      expect(new Set(seen).size, `set ${set}: ${seen.join(",")}`).toBe(1);
    }
  });

  test("2.3 the note that plays is the previewed note (FFT pitch, every set); note events carry app-wide ids", { tag: "@full" }, async ({ synthPage: page }) => {
    await setHandsOn(page, SC.preview(0.5));
    await enterLeadByPanel(page);
    await page.evaluate(() => {
      window.__notes = [];
      window.__gsTest.bus.subscribe({ onEvent: (n, d) => window.__notes.push({ n, ...d }) }, ["note/on", "note/off"]);
    });
    const r = rng(11);
    for (const set of [1, 2, 3, 4]) {
      await setNoteSet(page, set);
      for (let k = 0; k < 2; k++) {
        const y = 0.3 + r() * 0.45;
        await setHandsOn(page, SC.preview(y));
        await page.waitForTimeout(90);
        const pv = (await dbg(page)).cursor.midi;
        await setHandsOn(page, SC.play(y));
        await page.waitForTimeout(200);
        expect((await dbg(page)).playing, `set ${set}`).toBe(pv);
        const { samples, sampleRate } = await recordAudio(page, 380);
        const f = pitchOf(samples, sampleRate);
        expect(Math.abs(f / midiToFreq(pv) - 1), `set ${set}: heard ${f.toFixed(1)} Hz, previewed ${pv}`).toBeLessThan(0.01);
        await setHandsOn(page, SC.preview(y));
        await page.waitForTimeout(120);
      }
    }
    const notes = await page.evaluate(() => window.__notes.filter((e) => e.voice === "lead"));
    const ons = notes.filter((e) => e.n === "note/on");
    expect(ons.length).toBe(8);
    expect(new Set(ons.map((e) => e.id)).size).toBe(8);
    for (const on of ons) {
      expect(typeof on.id).toBe("number");
      expect(on.midi).toBe(Math.round(69 + 12 * Math.log2(on.freq / 440)));
      expect(notes.filter((e) => e.n === "note/off" && e.id === on.id)).toHaveLength(1);
    }
  });

  test("2.4 finger movement before a pinch never changes the note set; a held count does (DOM badge + panel)", async ({ synthPage: page }) => {
    await setHandsOn(page, SC.preview(0.5));
    await enterLeadByPanel(page);
    await setNoteSet(page, 1);
    await expect(page.locator("#noteSetBadge i").nth(0)).toHaveClass(/on/);
    const y = 0.5;
    for (const n of [4, 3, 2]) {
      await setHandsOn(page, SC.open(n, y));
      await page.waitForTimeout(150); // < SET_HOLD_MS each
    }
    await setHandsOn(page, SC.play(y));
    await page.waitForTimeout(500);
    expect((await dbg(page)).setId).toBe(1);
    await setHandsOn(page, SC.preview(y)); // pre-pinch claw for a long time: no change
    await page.waitForTimeout(600);
    expect((await dbg(page)).setId).toBe(1);
    expect(await bus(page, "lead/noteset")).toBe(1);
    // A deliberate "3" held 0.3 s.
    await setHandsOn(page, SC.open(3, y));
    await page.waitForTimeout(SET_HOLD_MS / 2);
    const mid = await dbg(page);
    expect(mid.setId).toBe(1);
    expect(mid.setHoldTarget).toBe(3);
    await expect.poll(() => bus(page, "lead/noteset"), { timeout: 1000 }).toBe(3);
    await expect(page.locator("#noteSetBadge i.on")).toHaveCount(1);
    await expect(page.locator("#noteSetBadge i").nth(2)).toHaveClass(/on/);
    await expect(page.locator("#noteSetBadge")).toHaveAttribute("title", "Note set: Full scale (hand: 3️⃣ 3 fingers)");
    await openControls(page);
    await expect(page.locator('#controlsPanel .lead-controls [data-set="3"]')).toHaveAttribute("aria-pressed", "true");
    await closeControls(page);
    // The toggle sticks through the pinch that follows.
    await setHandsOn(page, SC.play(y));
    await page.waitForTimeout(400);
    expect((await dbg(page)).setId).toBe(3);
  });

  test("2.5 sliding to the arrow during a pinch never changes octave; pinch on the arrow + hold does, once", async ({ synthPage: page }) => {
    await setHandsOn(page, SC.preview(0.5));
    await enterLeadByPanel(page);
    await setNoteSet(page, 2);
    const d0 = await dbg(page);
    const top = d0.lines.at(-1);
    const yTop = top.y / d0.geo.H;
    await setHandsOn(page, SC.preview(yTop + 0.06));
    await page.waitForTimeout(80);
    await setHandsOn(page, SC.play(yTop + 0.06));
    await page.waitForTimeout(80);
    for (let y = yTop + 0.06; y > d0.geo.upY / d0.geo.H - 0.05; y -= 0.01) {
      await setHandsOn(page, SC.play(y));
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(700);
    let d = await dbg(page);
    expect(d.octave).toBe(d0.octave);
    expect(d.playing).toBe(top.midi); // the cursor stopped at the last note
    expect(d.hover).toBe(null);
    // Release, then a pinch that starts ON the up arrow and is held 0.3 s: one octave up.
    const upY = d0.geo.upY / d0.geo.H;
    await setHandsOn(page, SC.preview(upY));
    await page.waitForTimeout(120);
    expect((await dbg(page)).hover).toBe("up");
    await setHandsOn(page, SC.play(upY));
    await page.waitForTimeout(120);
    d = await dbg(page);
    expect(d.octave).toBe(d0.octave);
    expect(d.playing).toBe(null); // the arrow pinch plays nothing
    await expect.poll(async () => (await dbg(page)).octave, { timeout: 1000 }).toBe(d0.octave + 1);
    await page.waitForTimeout(500);
    expect((await dbg(page)).octave).toBe(d0.octave + 1); // one step per pinch
    expect(await bus(page, "lead/octave")).toBe(d0.octave + 1);
    // At the top: the up arrow is grey and does nothing; the panel's + is disabled.
    expect(d0.octave + 1).toBe(OCTAVE_MAX);
    await setHandsOn(page, SC.preview(upY));
    await page.waitForTimeout(100);
    await setHandsOn(page, SC.play(upY));
    await page.waitForTimeout(500);
    expect((await dbg(page)).octave).toBe(OCTAVE_MAX);
    await openControls(page);
    await expect(page.locator('#controlsPanel [data-control="octave-up"]')).toBeDisabled();
    await closeControls(page);
    // Down to the bottom with the down arrow.
    const downY = d0.geo.downY / d0.geo.H;
    for (let k = 0; k < OCTAVE_MAX - OCTAVE_MIN; k++) {
      await setHandsOn(page, SC.preview(downY));
      await page.waitForTimeout(100);
      await setHandsOn(page, SC.play(downY));
      await page.waitForTimeout(420);
    }
    expect((await dbg(page)).octave).toBe(OCTAVE_MIN);
  });

  test("mouse on the ladder strip previews and plays; keyboard keys play ladder notes (screen controls)", async ({ synthPage: page }) => {
    await enterLeadByPanel(page);
    await setNoteSet(page, 2);
    const d0 = await dbg(page);
    const x = d0.side === "left" ? 40 : d0.geo.W - 40;
    const y = d0.geo.top + 0.4 * (d0.geo.bottom - d0.geo.top);
    await page.mouse.move(x, y);
    await page.waitForTimeout(80);
    const d = await dbg(page);
    expect(d.usingVirtual).toBe(true);
    const nearest = d.lines.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
    expect(d.cursor.midi).toBe(nearest.midi);
    await page.mouse.down();
    await page.waitForTimeout(120);
    expect((await dbg(page)).sounding).toBeCloseTo(midiToFreq(nearest.midi), 3);
    await page.mouse.up();
    await page.mouse.move(640, 400);
    const notes = await ladder(page);
    await page.keyboard.down("KeyS");
    await page.waitForTimeout(150);
    expect((await dbg(page)).playing).toBe(notes[1]);
    await page.keyboard.up("KeyS");
    await page.waitForTimeout(60);
    expect((await dbg(page)).sounding).toBe(null);
  });
});

// =====================================================================================================
// Menu hold, clipping
// =====================================================================================================

test.describe("Lead with the menu and the master", () => {
  test("menu hold: the lead note stops, the ladder dims, the base (Chords) keeps playing and follows the chord; cancel returns", async ({ synthPage: page }) => {
    const y = 0.5;
    await setHandsOn(page, SC.left(1), SC.open(2, y)); // Chords plays (the base under the Lead layer)
    await page.waitForTimeout(300);
    await enterLeadByPanel(page);
    await setNoteSet(page, 2);
    await setHandsOn(page, SC.left(1), SC.preview(y));
    await page.waitForTimeout(100);
    await setHandsOn(page, SC.left(1), SC.play(y));
    await page.waitForTimeout(200);
    const before = await dbg(page);
    expect(before.sounding).not.toBe(null);
    const octave = before.octave;

    // Fist: the menu opens and holds the right hand (centre zone, nothing selected).
    const p = SC.R;
    await setHandsOn(page, SC.left(1), SC.fistAt({ x: p.x, y }));
    await expect.poll(async () => (await bus(page, "menu"))?.state, { timeout: 2000 }).toBe("open");
    await page.waitForTimeout(150);
    let d = await dbg(page);
    expect(d.held).toBe(true);
    expect(d.sounding).toBe(null);
    expect(d.pinchMode).toBe("none");
    expect(d.pad).toEqual([]);
    const chordFreqs = await page.evaluate(() => window.__gsTest.synth.oscillators.map((o) => o.frequency.value));
    expect(chordFreqs.length).toBeGreaterThan(0);
    const padRec = await recordAudio(page, 400);
    expect(rms(padRec.samples), "the base keeps playing while the menu is open").toBeGreaterThan(0.003);
    const padPeaks = peaks(spectrum(padRec.samples, padRec.sampleRate, 16384), 0.3).map((pk) => pk.freq);
    for (const f of padPeaks) expect(chordFreqs.some((w) => Math.abs(f / w - 1) < 0.01), `chord peak ${f.toFixed(1)}`).toBe(true);
    await page.screenshot({ path: `${SCREENS_DIR}/m2-menu-held.png` });

    // Left-hand chord change while held: the base's chord and the ladder follow.
    await setHandsOn(page, SC.left(4), SC.fistAt({ x: p.x, y }));
    await expect(page.locator("#chordDisplay")).toHaveText("D(IV)");
    await expect.poll(async () => (await dbg(page)).chord?.degree).toBe(4);
    d = await dbg(page);
    const want = triad("A", 4, true);
    const ivFreqs = await page.evaluate(() => window.__gsTest.synth.oscillators.map((o) => o.frequency.value));
    for (const pc of want) expect(ivFreqs.map((f) => mod12(Math.round(69 + 12 * Math.log2(f / 440))))).toContain(pc);
    expect([...new Set(d.lines.filter((l) => l.isChord).map((l) => mod12(l.midi)))].sort((a, b) => a - b)).toEqual(want);
    expect(d.sounding).toBe(null);

    // Cancel: open the hand in the centre zone -- still pinched. A pinch closed from before never plays.
    await setHandsOn(page, SC.left(4), SC.play(y));
    await expect.poll(async () => (await bus(page, "menu")) ?? null, { timeout: 2000 }).toBe(null);
    await page.waitForTimeout(300);
    d = await dbg(page);
    expect(await modeId(page)).toBe("lead");
    expect(d.held).toBe(false);
    expect(d.sounding).toBe(null);
    expect(d.setId).toBe(2);
    expect(d.octave).toBe(octave);
    // A new pinch plays the previewed note again.
    await setHandsOn(page, SC.left(4), SC.preview(y));
    await page.waitForTimeout(120);
    const pv = (await dbg(page)).cursor.midi;
    await setHandsOn(page, SC.left(4), SC.play(y));
    await page.waitForTimeout(150);
    d = await dbg(page);
    expect(d.playing).toBe(pv);
    expect(d.sounding).toBeCloseTo(midiToFreq(pv), 3);
  });

  test("output never clips: Lead on top of Chords at full master, Bright tone, open resonant filter", { tag: "@full" }, async ({ synthPage: page }) => {
    const L = SC.left(5, { y: 0.1 }); // high left hand = master 1
    await setHandsOn(page, L, SC.preview(0.5));
    await enterLeadByPanel(page);
    await page.selectOption("#toneSelect", "sawtooth");
    await page.mouse.move(640, 400);
    await setNoteSet(page, 4);
    await expect.poll(() => bus(page, "volume"), { timeout: 2000 }).toBe(1);
    let peak = 0;
    for (const [tilt, yf] of [[1, 0.28], [0.6, 0.4], [-1, 0.7], [1, 0.75], [1, 0.3]]) {
      await setHandsOn(page, L, SC.preview(yf, { tilt }));
      await page.waitForTimeout(80);
      await setHandsOn(page, L, SC.play(yf, { tilt }));
      await page.waitForTimeout(150);
      const { samples } = await recordAudio(page, 300);
      peak = Math.max(peak, peakAbs(samples));
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak, "output peak (> 1 clips)").toBeLessThanOrEqual(1);
    // Lead never writes the master gain: it is the router's master volume.
    const mg = await page.evaluate(() => window.__gsTest.synth.masterGain.gain.value);
    expect(mg).toBeGreaterThan(0.98);
  });
});

// =====================================================================================================
// Layout: the ladder on the expression edge, never over existing controls or the master track
// =====================================================================================================

const CONTROLS = ["keySelect", "toneSelect", "guideToggle", "controlsToggle", "modeBadge", "noteSetBadge", "helpButton",
  "distortionDisplay", "chordDisplay", "qualityDisplay", "outputChip", "transport", "volumeMeter", "gsBar", "gsPill"];

for (const [vpName, vp] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
  test.describe(`layout ${vpName} ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });
    for (const swap of [false, true]) {
      test(`ladder on the expression edge, clear of controls + master track${swap ? " (chord hand right)" : ""}`, async ({ synthPage: page }) => {
        const sc = scene(vp, { swap });
        await setHandsOn(page, sc.left(1), sc.preview(0.5));
        await enterLeadByPanel(page);
        await setHandsOn(page, sc.left(1), sc.preview(0.5));
        await page.waitForTimeout(900); // side lock (600 ms) + a few frames
        await frames(page, 4);
        const d = await dbg(page);
        const info = await page.evaluate((ids) => {
          const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
          const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
          return {
            controls: ids.map((id) => document.getElementById(id)).filter(vis).map((e) => ({ name: e.id, rect: box(e) })),
            regions: window.__gsTest.ui.regions,
            chordSide: window.__gsTest.ui.chordSide,
            meterVisible: vis(document.getElementById("volumeMeter")),
          };
        }, CONTROLS);
        expect(info.chordSide).toBe(sc.chordSide);
        expect(d.side).toBe(sc.exprSide);
        // The top-right 8-bar meter is hidden in the modes UI on every layout (body.gs-modes; still in the DOM).
        expect(info.meterVisible, "8-bar meter hidden in the modes UI").toBe(false);
        const lad = d.regions.find((r) => r.name === "lead-ladder").rect;
        const master = info.regions.find((r) => r.name === "master-track")?.rect;
        expect(master, "master track drawn").toBeTruthy();
        // On screen, on the expression edge, opposite the master track.
        expect(lad.x).toBeGreaterThanOrEqual(0);
        expect(lad.x + lad.w).toBeLessThanOrEqual(vp.width);
        expect(lad.y).toBeGreaterThanOrEqual(0);
        expect(lad.y + lad.h).toBeLessThanOrEqual(vp.height);
        if (sc.exprSide === "left") expect(lad.x + lad.w).toBeLessThan(vp.width / 2);
        else expect(lad.x).toBeGreaterThan(vp.width / 2);
        expect(overlaps(lad, master), "ladder vs master track").toBe(false);
        for (const c of info.controls) expect(overlaps(lad, c.rect), `ladder vs #${c.name} ${JSON.stringify(c.rect)} / ${JSON.stringify(lad)}`).toBe(false);
        expect(overlaps(lad, clearArea(vp.width, vp.height)), "ladder stays out of the clear area").toBe(false);
        // Narrower ladder on phones (Q5): 44 px from the edge to the inner end of the chord lines.
        if (vp.width < 520) expect(d.geo.sz.edgeInset + d.geo.sz.lineChord).toBe(44);
        else expect(d.geo.sz.edgeInset + d.geo.sz.lineChord).toBe(64);
        // The note name sits on the inner side of the ladder.
        const name = d.regions.find((r) => r.name === "lead-note-name")?.rect;
        expect(name).toBeTruthy();
        if (sc.exprSide === "left") expect(name.x).toBeGreaterThan(d.geo.inner);
        else expect(name.x + name.w).toBeLessThan(d.geo.inner);
        await page.screenshot({ path: `${SCREENS_DIR}/m2-layout-${vpName}${swap ? "-swap" : ""}.png` });
      });
    }
  });
}

// =====================================================================================================
// Help, guide, first-use labels
// =====================================================================================================

test("help modal has a Lead section; gesture guide shows Lead rows; first-use labels at the hand", async ({ synthPage: page }) => {
  await setHandsOn(page, SC.left(1), SC.preview(0.5));
  await enterLeadByPanel(page);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__gsTest.ui.firstUse)).toBe(true);
  await page.locator("#guideToggle").click();
  const rows = await page.locator("#gestureGuide .gs-guide-mode .gs-guide-label").allTextContents();
  expect(rows).toEqual(["Menu", "Note", "Play", "Note set", "Pinch arrow: octave"]);
  await expect(page.locator("#gestureGuide .gs-guide-head")).toHaveText("Lead");
  await page.locator("#guideToggle").click();
  await page.locator("#helpButton").click();
  const help = page.locator("#helpModal .help-content");
  await expect(help.locator("h3", { hasText: "Lead mode" })).toBeVisible();
  await expect(help).toContainText("Lead left");
  await expect(help).toContainText("Pinch an arrow");
});

// =====================================================================================================
// Screenshots + real-time video (with sound)
// =====================================================================================================

test("screenshots m2-* and video test-results/videos/m2-lead.webm (Chords -> menu -> Lead play, note set, octave -> Chords)", { tag: "@media" }, async ({ synthPage: page, browser }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  const shot = (name) => page.screenshot({ path: `${SCREENS_DIR}/m2-${name}.png` });
  const rec = createScreencast();
  await rec.track(page, "app");
  // Sound: the master output (after limiter + clipper) into an in-page MediaRecorder.
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

  const L1 = SC.left(1);
  const common = { left: L1, from: SC.R, fistAt: SC.fistAt, open: (p) => SC.preview(SC.R.y, { x: p.x }) };
  await setHandsOn(page, L1, SC.open(2));
  await page.waitForTimeout(1200);
  await switchMode(page, { ...common, dir: "left", expectId: "lead", onSelected: () => shot("menu-to-lead") });
  await page.waitForTimeout(400);
  await setNoteSet(page, 2);
  // Preview + play a few notes over two chords.
  const notes = await ladder(page);
  await setHandsOn(page, L1, SC.preview(await yFor(page, notes[4])));
  await page.waitForTimeout(500);
  await shot("lead-preview");
  for (const [i, chord, ms] of [[4, 1, 350], [5, 1, 350], [6, 1, 500], [7, 4, 350], [6, 4, 350], [5, 4, 600]]) {
    const y = await yFor(page, (await ladder(page))[i]);
    await setHandsOn(page, SC.left(chord), SC.preview(y));
    await page.waitForTimeout(110);
    await setHandsOn(page, SC.left(chord), SC.play(y));
    await page.waitForTimeout(ms);
    if (i === 6 && chord === 1) await shot("lead-playing");
  }
  // Note set: a "3" held -> Full scale.
  await setHandsOn(page, SC.left(4), SC.open(3, 0.5));
  await page.waitForFunction(() => {
    const s = window.__gsTest.registry.getMode("lead")._controller.state;
    return s.setHoldTarget === 3 && s.setHoldProgress > 0.6;
  });
  await shot("noteset-change");
  await expect.poll(() => bus(page, "lead/noteset")).toBe(3);
  await page.waitForTimeout(500);
  // Octave: pinch on the up arrow and hold.
  const d = await dbg(page);
  const upY = d.geo.upY / d.geo.H;
  await setHandsOn(page, SC.left(4), SC.preview(upY));
  await page.waitForTimeout(250);
  await setHandsOn(page, SC.left(4), SC.play(upY));
  await page.waitForFunction(() => window.__gsTest.registry.getMode("lead")._controller.state.arrowProgress > 0.6);
  await shot("octave");
  await expect.poll(async () => (await dbg(page)).octave).toBe(d.octave + 1);
  await setHandsOn(page, SC.left(4), SC.preview(0.45));
  await page.waitForTimeout(400);
  for (const yy of [0.45, 0.4, 0.35]) {
    await setHandsOn(page, SC.left(4), SC.play(yy));
    await page.waitForTimeout(300);
  }
  await setHandsOn(page, SC.left(4), SC.preview(0.4));
  await page.waitForTimeout(400);
  await switchMode(page, { ...common, left: SC.left(4), dir: "up", expectId: "chords", open: (p) => SC.open(2, SC.R.y, { x: p.x }) });
  await page.waitForTimeout(1000);

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
  const out = "test-results/videos/m2-lead.webm";
  const res = await rec.save(browser, out, { layout: ["app"], cellW: 1280, cellH: 800, audio: snd });
  expect(res.frames[0]).toBeGreaterThan(60);
  expect(fs.statSync(out).size).toBeGreaterThan(100_000);
  for (const f of ["menu-to-lead", "lead-preview", "lead-playing", "noteset-change", "octave"]) {
    expect(fs.existsSync(`${SCREENS_DIR}/m2-${f}.png`), f).toBe(true);
  }
});
