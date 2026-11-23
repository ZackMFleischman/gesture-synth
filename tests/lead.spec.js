// Lead mode (Milestone 2, steps 2.1-2.5): every UX check from the spec as an automated test, run in
// labs/lead-lab.html (real services + router, Lead active) with ?mockHands. The pure logic in
// src/modes/lead-notes.js is unit-tested in lead-notes.unit.spec.js.
import { expect } from "@playwright/test";
import { recordAudio, spectrum, peaks, writeWav, rms, captureHealth, retryOnCaptureGlitch } from "./helpers/audio.js";
import { leftHand, rightHand, pinch, DESKTOP_VIEW } from "./helpers/hands.js";
import { test, SCREENS, rh, preview, play, setHands, dbg, yFor, settle, setKey, setNoteSet, snapWhen, openLab } from "./helpers/lead-lab.js";
import { makeView } from "../src/input/hand-input.js";
import { triad, rng } from "./helpers/theory.js";
import { stepAnalysis, windowPitches, clickRatio } from "./helpers/lead-pitch.js";
import { midiToFreq, rangeLow, mod12, OCTAVE_MIN, OCTAVE_MAX, OCTAVE_DEFAULT } from "../src/modes/lead-notes.js";

const AUDIO_DIR = "test-results/audio";

// =====================================================================================================
// In the lab (browser)
// =====================================================================================================

/** Dominant pitch (Hz) of a recording, via the FFT's strongest peak. */
function pitchOf(samples, sampleRate) {
  const p = peaks(spectrum(samples, sampleRate, 16384), 0.3);
  return p.length ? p[0].freq : 0;
}

/** RMS envelope in `win`-sample windows. */
function envelope(samples, win = 240) {
  const env = [];
  for (let i = 0; i + win <= samples.length; i += win) env.push(rms(samples.subarray(i, i + win)));
  return env;
}

test("lab boots with Lead active, real ctx, mode contract", async ({ lab: page }) => {
  await settle(page);
  const info = await page.evaluate(() => {
    const t = window.__gsTest;
    const m = t.registry.getMode("lead");
    return { id: t.router.modeId, name: m.name, dir: m.direction, color: m.color, signals: m.signals.map((s) => s.name),
      manifest: t.bus.manifest().filter((s) => s.owner === "lead").map((s) => s.name) };
  });
  expect(info).toMatchObject({ id: "lead", name: "Lead", dir: "left", color: "#c08cff" });
  expect(info.manifest).toEqual(expect.arrayContaining(["lead/noteset", "lead/octave"]));
  const d = await dbg(page);
  expect(d.lines.length).toBeGreaterThan(3);
  await page.screenshot({ path: `${SCREENS}/lead-idle.png` });
});

test.describe("2.1 screen controls + ladder", () => {
  test("thick ladder lines move to the chord notes at each chord change (several keys + chords)", async ({ lab: page }) => {
    await setNoteSet(page, 3);
    for (const key of ["A", "C", "Eb", "Gb"]) {
      await setKey(page, key);
      for (const [degree, minor] of [[1, false], [4, false], [5, false], [6, true], [2, true], [7, true], [1, true]]) {
        await setHands(page, leftHand(degree, { minor }));
        // chord hold (100 ms) + the 150 ms line move
        await page.waitForFunction(([deg, maj]) => {
          const d = window.__gsTest.lead._debug(window.__gsTest.ctx.now);
          return d.chord && d.chord.degree === deg && d.chord.isMajor === maj && window.__gsTest.ctx.now - d.changeAt > 170;
        }, [degree, !minor]);
        const d = await dbg(page);
        const geo = d.geo;
        const low = rangeLow(key, d.octave);
        const thick = d.lines.filter((l) => l.isChord);
        const want = triad(key, degree, !minor);
        expect(d.chord, `${key} ${degree}`).toEqual({ degree, isMajor: !minor });
        expect([...new Set(thick.map((l) => mod12(l.midi)))].sort((a, b) => a - b), `${key} ${degree}${minor ? "m" : ""}`).toEqual(want);
        // every chord-tone pitch in range is a thick line, at its pitch height
        const expectedMidis = [];
        for (let m = low; m <= low + 24; m++) if (want.includes(mod12(m))) expectedMidis.push(m);
        expect(thick.map((l) => l.midi)).toEqual(expectedMidis);
        for (const l of thick) {
          const y = geo.bottom - ((l.midi - low) / 24) * (geo.bottom - geo.top);
          expect(Math.abs(l.y - y)).toBeLessThan(0.5);
        }
      }
    }
  });

  test("chord lines animate ~150 ms from the old chord notes to the new ones", async ({ lab: page }) => {
    await setNoteSet(page, 1);
    await setHands(page, leftHand(1));
    await settle(page, 300);
    const before = (await dbg(page)).lines.map((l) => l.y);
    await setHands(page, leftHand(4));
    await page.waitForFunction(() => window.__gsTest.lead._debug().chord?.degree === 4);
    const d = await dbg(page);
    const mid = await dbg(page, d.changeAt + 60);
    const end = await dbg(page, d.changeAt + 150);
    const final = end.lines.map((l) => l.y);
    // midway, lines sit between an old chord line and their target
    const moving = mid.lines.filter((l, i) => Math.abs(l.y - final[i]) > 2);
    expect(moving.length).toBeGreaterThan(0);
    for (const l of moving) {
      const i = mid.lines.indexOf(l);
      const nearestOld = before.reduce((a, b) => (Math.abs(b - final[i]) < Math.abs(a - final[i]) ? b : a));
      expect(Math.min(nearestOld, final[i]) - 1).toBeLessThanOrEqual(l.y);
      expect(l.y).toBeLessThanOrEqual(Math.max(nearestOld, final[i]) + 1);
    }
    // at 150 ms they are on the new notes
    const lad = await page.evaluate(() => window.__gsTest.lead._controller.state.ladder.notes.map((n) => n.midi));
    expect(end.lines.map((l) => l.midi)).toEqual(lad);
    await setHands(page, leftHand(4), preview(0.45, 0.66));
    await settle(page, 300);
    await setHands(page, leftHand(5), preview(0.45, 0.66));
    await snapWhen(page, "chord-change", (s, now) => s.chord?.degree === 5 && now - s.contextChangedAt > 60);
  });

  test("mouse: the cursor follows the pointer on the ladder; press plays the previewed note", async ({ lab: page }) => {
    await setNoteSet(page, 2);
    const geo = (await dbg(page)).geo;
    const x = geo.W - 60;
    for (const frac of [0.1, 0.35, 0.62, 0.9]) {
      const y = geo.top + frac * (geo.bottom - geo.top);
      await page.mouse.move(x, y);
      await settle(page, 80);
      const d = await dbg(page);
      expect(d.usingVirtual).toBe(true);
      // the cursor is on the line nearest the pointer
      const nearest = d.lines.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
      expect(d.cursor.midi).toBe(nearest.midi);
      await page.mouse.down();
      await settle(page, 120);
      const p = await dbg(page);
      expect(p.playing).toBe(d.cursor.midi);
      expect(p.sounding).toBeCloseTo(midiToFreq(d.cursor.midi), 3);
      await page.mouse.up();
      await settle(page, 60);
      expect((await dbg(page)).sounding).toBe(null);
    }
  });

  test("keyboard: A-row keys play ladder notes from the bottom, 1-4 sets, -/= octave, arrows + space", async ({ lab: page }) => {
    await page.mouse.move(400, 400);
    await page.keyboard.press("Digit2");
    await settle(page, 50);
    expect((await dbg(page)).setId).toBe(2);
    const notes = await page.evaluate(() => window.__gsTest.lead._controller.state.ladder.notes.map((n) => n.midi));
    await page.keyboard.down("KeyA");
    await settle(page, 300);
    let d = await dbg(page);
    expect(d.playing).toBe(notes[0]);
    const { samples, sampleRate } = await recordAudio(page, 400);
    expect(Math.abs(pitchOf(samples, sampleRate) / midiToFreq(notes[0]) - 1)).toBeLessThan(0.01);
    await page.keyboard.down("KeyD"); // legato: glides to the 3rd note
    await settle(page, 80);
    expect((await dbg(page)).playing).toBe(notes[2]);
    await page.keyboard.up("KeyD");
    await settle(page, 50);
    expect((await dbg(page)).playing).toBe(notes[0]); // back to the still-held key
    await page.keyboard.up("KeyA");
    await settle(page, 50);
    expect((await dbg(page)).playing).toBe(null);
    await page.keyboard.press("ArrowUp");
    await settle(page, 50);
    expect((await dbg(page)).cursor.midi).toBe(notes[1]);
    await page.keyboard.down("Space");
    await settle(page, 60);
    expect((await dbg(page)).playing).toBe(notes[1]);
    await page.keyboard.up("Space");
    await page.keyboard.press("Equal");
    await settle(page, 50);
    d = await dbg(page);
    expect(d.octave).toBe(OCTAVE_DEFAULT + 1);
    await page.keyboard.press("Equal");
    await page.keyboard.press("Equal");
    await settle(page, 50);
    expect((await dbg(page)).octave).toBe(OCTAVE_MAX);
    await expect(page.locator('.lead-controls [data-oct="1"]')).toBeDisabled();
    await page.keyboard.press("Minus");
    await settle(page, 50);
    expect((await dbg(page)).octave).toBe(OCTAVE_MAX - 1);
    expect(await page.evaluate(() => window.__gsTest.bus.get("lead/octave"))).toBe(OCTAVE_MAX - 1);
    expect(await page.evaluate(() => window.__gsTest.bus.get("lead/noteset"))).toBe(2);
  });

  test("the hand takes control back from a screen control once it moves", async ({ lab: page }) => {
    const geo = (await dbg(page)).geo;
    await page.mouse.move(geo.W - 60, geo.top + 20);
    await settle(page, 60);
    await page.mouse.move(400, 400); // leave the strip
    await setHands(page, preview(0.6));
    await settle(page, 100);
    expect((await dbg(page)).usingVirtual).toBe(true); // hand has not moved yet
    await setHands(page, preview(0.5));
    await settle(page, 100);
    const d = await dbg(page);
    expect(d.usingVirtual).toBe(false);
    expect(Math.abs(d.cursor.y - 0.5 * geo.H)).toBeLessThan(40);
  });

  test("left-hand chord plays as a soft pad, quieter than Chords; lead sits on top", async ({ lab: page }) => {
    await setHands(page, leftHand(1));
    await settle(page, 600);
    const d = await dbg(page);
    expect(d.pad.length).toBe(4);
    const padOnly = await recordAudio(page, 500);
    const padRms = rms(padOnly.samples);
    expect(padRms).toBeGreaterThan(0.005);
    expect(padRms).toBeLessThan(0.08);
    const want = await page.evaluate(() => {
      const h = window.__gsTest.harmony;
      return h.notes(h.chord.roman, h.chord.isMajor, 1);
    });
    const found = peaks(spectrum(padOnly.samples, padOnly.sampleRate, 16384), 0.3).map((p) => p.freq);
    for (const f of found) expect(want.some((w) => Math.abs(f / w - 1) < 0.01), `pad peak ${f}`).toBe(true);
    // with a lead note on top, the lead is the strongest peak
    const y = 0.45;
    await setHands(page, leftHand(1), preview(y));
    await settle(page, 100);
    const note = (await dbg(page)).cursor.midi;
    await setHands(page, leftHand(1), play(y));
    await settle(page, 300);
    const both = await recordAudio(page, 500);
    expect(Math.abs(pitchOf(both.samples, both.sampleRate) / midiToFreq(note) - 1)).toBeLessThan(0.01);
    writeWav(`${AUDIO_DIR}/lead-pad-and-lead.wav`, both.samples, both.sampleRate);
  });
});

test.describe("2.2 note cursor", () => {
  test("the cursor does not flicker between two notes when the hand is still (seeded jitter at an edge)", async ({ lab: page }) => {
    for (const set of [1, 4]) {
      await setNoteSet(page, set);
      // The ladder spans the right hand's reach zone (src/input/reach-zones.js): read its lines with the hand in view.
      await setHands(page, preview(0.5));
      await settle(page, 300);
      const d0 = await dbg(page);
      const lines = d0.lines;
      // boundary between two middle notes
      const i = Math.floor(lines.length / 2);
      const yEdge = (lines[i].y + lines[i + 1].y) / 2 / d0.geo.H;
      const gap = Math.abs(lines[i].y - lines[i + 1].y) / d0.geo.H;
      const r = rng(42 + set);
      await setHands(page, preview(yEdge + gap * 0.05));
      await settle(page, 100);
      const seen = [];
      for (let k = 0; k < 40; k++) {
        // camera-like jitter: +/- 25% of the gap in y, +/- 0.5% in x
        await setHands(page, preview(yEdge + (r() - 0.5) * gap * 0.5, 0.74 + (r() - 0.5) * 0.01));
        await page.waitForTimeout(35);
        seen.push((await dbg(page)).cursor.midi);
      }
      expect(new Set(seen).size, `set ${set}: ${seen.join(",")}`).toBe(1);
    }
  });

  test("screenshot: preview (hollow ring + note name)", async ({ lab: page }) => {
    await setNoteSet(page, 3);
    await setHands(page, leftHand(4), preview(0.42, 0.7));
    await settle(page, 300);
    await page.screenshot({ path: `${SCREENS}/lead-preview.png` });
  });
});

test.describe("2.3 pinch to play", () => {
  test("the note that plays is always the previewed note (FFT pitch, several notes and sets)", async ({ lab: page }) => {
    const r = rng(11);
    for (const set of [1, 2, 3, 4]) {
      await setNoteSet(page, set);
      for (let k = 0; k < 2; k++) {
        const y = 0.25 + r() * 0.55;
        await setHands(page, preview(y));
        await settle(page, 90);
        const pv = (await dbg(page)).cursor.midi;
        await setHands(page, play(y));
        await settle(page, 200);
        const d = await dbg(page);
        expect(d.playing, `set ${set}`).toBe(pv);
        const { samples, sampleRate } = await recordAudio(page, 380);
        const f = pitchOf(samples, sampleRate);
        expect(Math.abs(f / midiToFreq(pv) - 1), `set ${set}: heard ${f.toFixed(1)} Hz, previewed ${pv}`).toBeLessThan(0.01);
        await setHands(page, preview(y));
        await settle(page, 120);
      }
    }
  });

  // Camera feedback: the 70 ms glide sounded like a slide guitar. Moving while pinched now STEPS to the next note.
  test("moving while pinched steps to the next note: no intermediate pitches, no gap, no click", async ({ context }, info) => {
    await retryOnCaptureGlitch(info, async ({ track }) => {
      const page = await openLab(context);
      try {
        await setNoteSet(page, 3);
        const notes = await page.evaluate(() => window.__gsTest.lead._controller.state.ladder.notes.map((n) => n.midi));
        const path = [notes[4], notes[6], notes[5], notes[8], notes[4]];
        // The ladder spans the right hand's reach zone (src/input/reach-zones.js): place it with the hand in view.
        await setHands(page, preview(0.5));
        await settle(page, 300);
        const ys = [];
        for (const m of path) ys.push(await yFor(page, m));
        await setHands(page, preview(ys[0]));
        await settle(page, 80);
        await setHands(page, play(ys[0]));
        await settle(page, 250);
        await page.evaluate(() => { window.__audioCap.chunks = []; window.__audioCap.blocks = []; window.__audioCap.recording = true; });
        for (let i = 0; i < path.length; i++) {
          await setHands(page, play(ys[i]));
          await page.waitForTimeout(260);
        }
        const { chunks, blocks, sampleRate } = await page.evaluate(() => {
          window.__audioCap.recording = false;
          return { chunks: window.__audioCap.chunks, blocks: window.__audioCap.blocks, sampleRate: window.__audioCap.sampleRate };
        });
        const samples = Float32Array.from(chunks.flat());
        track({ samples, sampleRate, health: captureHealth(blocks, sampleRate) });
        writeWav(`${AUDIO_DIR}/lead-steps.wav`, samples, sampleRate);
        expect((await dbg(page)).playing).toBe(path.at(-1));
        const targets = [...new Set(path)].map(midiToFreq);
        const a = stepAnalysis(samples, sampleRate, targets);
        // Every move is heard as its own run of cycles on the target pitch, in order.
        const heard = a.segments.filter((s) => (s.to - s.from) / sampleRate > 0.05).map((s) => s.target);
        const want = path.map((m) => targets.indexOf(midiToFreq(m)));
        expect(heard, `segments ${JSON.stringify(a.segments.map((s) => [s.target, Math.round(s.from), Math.round(s.to)]))}`).toEqual(want);
        // No intermediate pitches: at most the two cycles that touch a step read as a mixed period (measured: 4
        // such cycles over 4 steps, longest run 2, ~3 ms at 700 Hz); the old 70 ms glide gave ~25 in a row.
        expect(a.maxBetweenRun, `cycles between targets: ${a.between.map((c) => c.f.toFixed(0)).join(",")}`).toBeLessThanOrEqual(2);
        expect(a.between.length).toBeLessThanOrEqual(2 * (path.length - 1));
        // FFT per 85 ms window: the first window that starts at a step already shows the new note, and no window
        // anywhere shows a pitch that is none of the notes.
        const wins = windowPitches(samples, sampleRate);
        for (const w of wins) {
          if (w.freq === 0) continue;
          expect(targets.some((t) => Math.abs(w.freq / t - 1) < 0.02), `window @${(w.start / sampleRate).toFixed(3)} s: ${w.freq.toFixed(1)} Hz`).toBe(true);
        }
        for (let i = 1; i < a.segments.length; i++) {
          const s = a.segments[i];
          if ((s.to - s.from) / sampleRate < 0.1) continue;
          const w = wins.find((x) => x.start >= s.from);
          expect(Math.abs(w.freq / targets[s.target] - 1), `first window after step ${i}`).toBeLessThan(0.02);
        }
        // No gap (legato: the level never drops) and no click at the steps.
        const env = envelope(samples);
        const steady = env.slice(2, 20).reduce((sum, v) => sum + v, 0) / 18;
        expect(Math.min(...env.slice(2))).toBeGreaterThan(steady * 0.6);
        const cr = clickRatio(samples);
        expect(cr.ratio, `max jump ${cr.allMax.toFixed(4)} vs steady ${cr.steadyMax.toFixed(4)}`).toBeLessThan(1.6);
        expect(page.__errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  });

  test("a new pinch retriggers the note (a second onset)", async ({ lab: page }) => {
    await setNoteSet(page, 2);
    const y = 0.5;
    await setHands(page, preview(y));
    await settle(page, 80);
    const onsets = await page.evaluate(() => {
      const t = window.__gsTest;
      window.__noteOns = [];
      window.__offNotes = t.bus.subscribe({ onEvent: (n, d) => d.voice === "lead" && window.__noteOns.push(n) }, ["note/on", "note/off"]);
      return true;
    });
    expect(onsets).toBe(true);
    await page.evaluate(() => { window.__audioCap.chunks = []; window.__audioCap.recording = true; });
    await setHands(page, play(y));
    await page.waitForTimeout(250);
    await setHands(page, preview(y));
    await page.waitForTimeout(90); // quick release
    await setHands(page, play(y));
    await page.waitForTimeout(300);
    const { chunks, sampleRate } = await page.evaluate(() => {
      window.__audioCap.recording = false;
      return { chunks: window.__audioCap.chunks, sampleRate: window.__audioCap.sampleRate };
    });
    const samples = Float32Array.from(chunks.flat());
    writeWav(`${AUDIO_DIR}/lead-retrigger.wav`, samples, sampleRate);
    const env = envelope(samples, Math.round(sampleRate * 0.005));
    const peak = Math.max(...env);
    // count rising edges through 70% of the peak after being below 25%
    let below = true;
    let count = 0;
    for (const v of env) {
      if (below && v > 0.7 * peak) { count++; below = false; }
      if (v < 0.25 * peak) below = true;
    }
    expect(count).toBe(2);
    const evs = await page.evaluate(() => window.__noteOns);
    expect(evs).toEqual(["note/on", "note/off", "note/on"]);
  });

  test("screenshot: playing (filled ring + glow)", async ({ lab: page }) => {
    await setNoteSet(page, 3);
    await setHands(page, leftHand(4), preview(0.42, 0.7));
    await settle(page, 200);
    await setHands(page, leftHand(4), play(0.42, 0.7));
    await settle(page, 200);
    await page.screenshot({ path: `${SCREENS}/lead-playing.png` });
  });
});

test.describe("2.4 note-set toggle", () => {
  test("finger movement before a pinch never changes the set; a count held 0.3 s does", async ({ lab: page }) => {
    await setNoteSet(page, 1);
    const y = 0.5;
    // fingers 4 -> 3 -> 2 quickly (each < 0.3 s), then the pinch
    for (const n of [4, 3, 2]) {
      await setHands(page, rh({ y, fingers: n }));
      await page.waitForTimeout(150);
    }
    await setHands(page, play(y));
    await page.waitForTimeout(500);
    expect((await dbg(page)).setId).toBe(1);
    // after the release, the half-open hand (index curled) lingers: no change
    await setHands(page, pinch({ pos: { x: 0.74, y }, view: DESKTOP_VIEW, distance: 0.9 }));
    await page.waitForTimeout(600);
    expect((await dbg(page)).setId).toBe(1);
    // the pre-pinch claw (all fingers out, thumb near index) for a long time: no change
    await setHands(page, preview(y));
    await page.waitForTimeout(600);
    expect((await dbg(page)).setId).toBe(1);
    // a deliberate "3" held 0.3 s
    await setHands(page, rh({ y, fingers: 3 }));
    await page.waitForTimeout(120);
    const mid = await dbg(page);
    expect(mid.setId).toBe(1);
    expect(mid.setHoldTarget).toBe(3);
    expect(mid.setHoldProgress).toBeGreaterThan(0.1);
    expect(mid.setHoldProgress).toBeLessThan(0.95);
    await snapWhen(page, "noteset-hold", (s) => s.setHoldTarget === 3 && s.setHoldProgress > 0.5);
    await snapWhen(page, "noteset-confirmed", (s, now) => s.setId === 3 && now - s.setChangedAt < 120);
    const done = await dbg(page);
    expect(done.setId).toBe(3);
    expect(await page.evaluate(() => window.__gsTest.bus.get("lead/noteset"))).toBe(3);
    // the toggle sticks after the fingers change to the pinch
    await setHands(page, play(y));
    await page.waitForTimeout(400);
    expect((await dbg(page)).setId).toBe(3);
  });
});

test.describe("2.5 octave arrows", () => {
  test("sliding to the top note / arrow during a pinch never changes the octave", async ({ lab: page }) => {
    await setNoteSet(page, 2);
    const d0 = await dbg(page);
    const top = d0.lines.at(-1);
    const yTop = top.y / d0.geo.H;
    await setHands(page, preview(yTop + 0.06));
    await settle(page, 80);
    await setHands(page, play(yTop + 0.06));
    await settle(page, 80);
    for (let y = yTop + 0.06; y > d0.geo.upY / d0.geo.H - 0.05; y -= 0.01) {
      await setHands(page, play(y));
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(700);
    const d = await dbg(page);
    expect(d.octave).toBe(d0.octave);
    expect(d.playing).toBe(top.midi);
    expect(d.hover).toBe(null);
  });

  test("pinch started on an arrow and held 0.3 s changes the octave once; limits grey the arrow", async ({ lab: page }) => {
    const d0 = await dbg(page);
    const upY = d0.geo.upY / d0.geo.H;
    const downY = d0.geo.downY / d0.geo.H;
    await setHands(page, preview(upY));
    await settle(page, 100);
    expect((await dbg(page)).hover).toBe("up");
    await page.screenshot({ path: `${SCREENS}/lead-arrow-hover.png` });
    await setHands(page, play(upY));
    await page.waitForTimeout(120);
    const mid = await dbg(page);
    expect(mid.octave).toBe(d0.octave);
    expect(mid.arrowProgress).toBeGreaterThan(0.1);
    expect(mid.playing).toBe(null); // the arrow pinch plays nothing
    await snapWhen(page, "octave-hold", (s) => s.pinchMode === "arrow" && s.arrowProgress > 0.55);
    await snapWhen(page, "octave-slide", (s, now, o) => s.octave === o && now - s.octaveChangedAt > 50, d0.octave + 1);
    expect((await dbg(page)).octave).toBe(d0.octave + 1);
    await page.waitForTimeout(500);
    expect((await dbg(page)).octave).toBe(d0.octave + 1); // one step per pinch
    expect(await page.evaluate(() => window.__gsTest.bus.get("lead/octave"))).toBe(d0.octave + 1);
    // now at the max: up arrow is grey and does nothing
    expect(d0.octave + 1).toBe(OCTAVE_MAX);
    await setHands(page, preview(upY));
    await settle(page, 100);
    await setHands(page, play(upY));
    await page.waitForTimeout(500);
    expect((await dbg(page)).octave).toBe(OCTAVE_MAX);
    await page.screenshot({ path: `${SCREENS}/lead-octave-limit.png` });
    // down to the min with the down arrow
    for (let k = 0; k < 4; k++) {
      await setHands(page, preview(downY));
      await settle(page, 100);
      await setHands(page, play(downY));
      await page.waitForTimeout(420);
    }
    expect((await dbg(page)).octave).toBe(OCTAVE_MIN);
  });
});

test.describe("audio quality", () => {
  // A capture glitch (the main-thread tap starved under heavy parallel load) splices the waveform, which
  // reads exactly like a click; such a failure is retried once (docs/testing.md "Capture glitches").
  test("no clicks at note on/off/retrigger; the pitch is right", async ({ context }, info) => {
    await retryOnCaptureGlitch(info, async ({ track }) => {
      const page = await openLab(context);
      try {
        await setNoteSet(page, 3);
        const y = 0.5;
        await setHands(page, preview(y));
        await settle(page, 100);
        await page.evaluate(() => { window.__audioCap.chunks = []; window.__audioCap.blocks = []; window.__audioCap.recording = true; });
        for (let k = 0; k < 4; k++) {
          await setHands(page, play(y + k * 0.03));
          await page.waitForTimeout(220);
          await setHands(page, preview(y + k * 0.03));
          await page.waitForTimeout(k % 2 ? 60 : 200);
        }
        const { chunks, blocks, sampleRate } = await page.evaluate(() => {
          window.__audioCap.recording = false;
          return { chunks: window.__audioCap.chunks, blocks: window.__audioCap.blocks, sampleRate: window.__audioCap.sampleRate };
        });
        const samples = Float32Array.from(chunks.flat());
        track({ samples, sampleRate, health: captureHealth(blocks, sampleRate) });
        writeWav(`${AUDIO_DIR}/lead-onoff.wav`, samples, sampleRate);
        // A click is a sample-to-sample jump far above what the sounding waveform produces. The triangle's
        // steepest slope is 4*A*f/sr; allow 1.6x of the steady-state max jump.
        let steadyMax = 0;
        let allMax = 0;
        const env = envelope(samples, 240);
        const peakEnv = Math.max(...env);
        for (let i = 1; i < samples.length; i++) {
          const d = Math.abs(samples[i] - samples[i - 1]);
          allMax = Math.max(allMax, d);
          const w = Math.floor(i / 240);
          if (env[w] > 0.9 * peakEnv && env[w - 1] > 0.9 * peakEnv && env[w + 1] > 0.9 * peakEnv) steadyMax = Math.max(steadyMax, d);
        }
        expect(steadyMax).toBeGreaterThan(0);
        expect(allMax / steadyMax, `max jump ${allMax.toFixed(4)} vs steady ${steadyMax.toFixed(4)}`).toBeLessThan(1.6);
        expect(page.__errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  });

  test("output peak stays <= 1 (bright tone, open filter, pad + top notes)", async ({ lab: page }) => {
    await page.selectOption("#toneSelect", "sawtooth");
    await setNoteSet(page, 4);
    let peak = 0;
    for (const [tilt, yf] of [[1, 0.25], [0.6, 0.4], [-1, 0.7], [1, 0.75]]) {
      await setHands(page, leftHand(5), preview(yf));
      await settle(page, 80);
      await setHands(page, leftHand(5), pinch({ pos: { x: 0.74, y: yf }, view: DESKTOP_VIEW, tilt, fingers: ["index", "middle", "ring", "pinky"] }));
      await settle(page, 150);
      const { samples } = await recordAudio(page, 300);
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak, "output peak (>1 clips)").toBeLessThanOrEqual(1);
  });
});

test.describe("mode switch", () => {
  // Lead layer (docs/architecture.md): from Chords, Lead goes ON TOP of Chords (the drone keeps playing, no pad).
  test("Chords -> Lead: the left hand keeps sounding (Chords keeps its drone under the Lead layer, no gap); Lead -> Chords works", async ({ lab: page }) => {
    await page.evaluate(() => window.__gsTest.router.setMode("chords"));
    await setHands(page, leftHand(1), rightHand(2, { volume: 0.5 }));
    await settle(page, 500);
    expect(await page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBe(4);
    await page.evaluate(() => { window.__audioCap.chunks = []; window.__audioCap.recording = true; });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__gsTest.router.setMode("lead"));
    await setHands(page, leftHand(1), preview(0.5));
    await page.waitForTimeout(900);
    const { chunks, sampleRate } = await page.evaluate(() => {
      window.__audioCap.recording = false;
      return { chunks: window.__audioCap.chunks, sampleRate: window.__audioCap.sampleRate };
    });
    const samples = Float32Array.from(chunks.flat());
    writeWav(`${AUDIO_DIR}/lead-switch-from-chords.wav`, samples, sampleRate);
    const env = envelope(samples, Math.round(sampleRate * 0.01));
    const padLevel = env.slice(-20).reduce((a, b) => a + b, 0) / 20; // the held Chords drone
    expect(padLevel).toBeGreaterThan(0.005);
    // from the switch to the end, the level never drops below half the final pad level (no gap)
    const switchAt = Math.floor(0.25 / 0.01);
    expect(Math.min(...env.slice(switchAt))).toBeGreaterThan(padLevel * 0.5);
    expect(await page.evaluate(() => [window.__gsTest.bus.get("mode"), window.__gsTest.bus.get("layer")])).toEqual(["chords", "lead"]);
    expect(await page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBe(4); // Chords keeps playing
    expect((await dbg(page)).pad.length).toBe(0); // no pad over a base
    // and back: Chords plays its drone again, the Lead voices are released
    await page.evaluate(() => window.__gsTest.router.setMode("chords"));
    await setHands(page, leftHand(1), rightHand(2, { volume: 0.5 }));
    await settle(page, 400);
    expect(await page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBe(4);
    expect((await dbg(page)).pad.length).toBe(0);
  });
});

test.describe("radial menu hold", () => {
  test("while the menu holds the right hand, the note stops and the ladder dims (held state)", async ({ lab: page }) => {
    await setNoteSet(page, 2);
    await setHands(page, preview(0.5));
    await settle(page, 80);
    await setHands(page, play(0.5));
    await settle(page, 150);
    expect((await dbg(page)).sounding).not.toBe(null);
    await page.evaluate(() => {
      window.__menuHold = true;
      window.__gsTest.router.setMenu({ update: () => ({}), isHoldingRight: () => window.__menuHold, draw() {} });
    });
    await settle(page, 300);
    const d = await dbg(page);
    expect(d.sounding).toBe(null);
    expect(d.pinchMode).toBe("none");
    await page.screenshot({ path: `${SCREENS}/lead-menu-held.png` });
    await page.evaluate(() => (window.__menuHold = false));
    await setHands(page, preview(0.5));
    await settle(page, 120);
    await setHands(page, play(0.5));
    await settle(page, 120);
    expect((await dbg(page)).sounding).not.toBe(null);
  });
});

test.describe("visual states", () => {
  test("screenshot: hand lost (dashed warning cursor)", async ({ lab: page }) => {
    await setNoteSet(page, 3);
    await setHands(page, leftHand(4), play(0.42, 0.7));
    await settle(page, 250);
    await setHands(page, leftHand(4));
    await settle(page, 300);
    const d = await dbg(page);
    expect(d.present).toBe(false);
    expect(d.playing).toBe(null);
    expect(d.sounding).toBe(null);
    await page.screenshot({ path: `${SCREENS}/lead-hand-lost.png` });
  });

  test("screenshot: mobile portrait layout", async ({ lab: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page, 200);
    const view = makeView(640, 480, 390, 844);
    await setHands(page, leftHand(2, { minor: true }), pinch({ pos: { x: 0.6, y: 0.5 }, view, distance: 0.55, fingers: ["index", "middle", "ring", "pinky"] }));
    await settle(page, 300);
    await page.screenshot({ path: `${SCREENS}/lead-mobile.png` });
  });
});
