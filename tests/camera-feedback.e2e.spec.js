// Real-camera feedback on Lead (first session with a person + camera), in the REAL app (?mockHands):
//  1. note sets come from distinct shapes: 1/2/3 fingers, 🤘 = 4; an open hand (after a pinch release) never
//     selects a set
//  2. a confirmed setting pops, stays fully visible ~1 s, then fades (note set + octave)
//  3. every ladder line shows its note name; the current note is larger and in the mode color
//  4. moving while pinched steps the pitch (no glide), without clicks
//  5. one filter visual: the arc at the hand with its value; the old top-right readout is hidden (still in the DOM)
// Screens: test-results/screens/feedback-*.png; video with sound: test-results/videos/camera-feedback-lead.webm.
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { writeWav, retryOnCaptureGlitch } from "./helpers/audio.js";
import { hand } from "./helpers/hands.js";
import { createScreencast } from "./helpers/screencast.js";
import { scene, setHands as setHandsOn, openApp, bus, modeId, dbg, ladder, yFor, frames, startRec, overlaps } from "./helpers/m2-lead.js";
import { stepAnalysis, windowPitches, clickRatio, envelope } from "./helpers/lead-pitch.js";
import { midiToFreq, SET_HOLD_MS } from "../src/modes/lead-notes.js";
import { CONFIRM, MODE_COLORS, MOTION } from "../src/ui/theme.js";
import { filterText } from "../src/ui/hand-overlays.js";

const WAV_DIR = "test-results/audio";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const SC = scene(DESKTOP); // chord hand on the screen right -> ladder on the LEFT edge

/** Right-hand set shapes at height y (display) in scene `sc`. 0 = open hand (4 fingers), 5 = open + thumb. */
function shape(sc, n, y = sc.R.y, o = {}) {
  const fingers = { 0: ["index", "middle", "ring", "pinky"], 1: ["index"], 2: ["index", "middle"], 3: ["index", "middle", "ring"],
    4: ["index", "pinky"], 5: ["index", "middle", "ring", "pinky"] }[n];
  return hand({ handedness: "Right", fingers, thumb: n === 5 || !!o.thumb, pos: { x: o.x ?? sc.R.x, y }, view: sc.view, tilt: o.tilt ?? 0 });
}

const isMobile = (page) => page.evaluate(() => document.body.classList.contains("gs-mobile"));
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
/** Any mode via the Controls panel's Mode row. */
async function enterMode(page, id) {
  await openControls(page);
  await page.locator(`#controlsPanel [data-control="mode"] button[data-value="${id}"]`).click();
  await expect.poll(() => modeId(page)).toBe(id);
  await closeControls(page);
}
async function setNoteSet(page, n) {
  await openControls(page);
  await page.locator(`#controlsPanel .lead-controls [data-set="${n}"]`).click();
  await closeControls(page);
  expect((await dbg(page)).setId).toBe(n);
}

test.describe.configure({ mode: "default" }); // one audio test: keep this file's tests off each other's CPU

// =====================================================================================================
// 1. Note-set shapes
// =====================================================================================================

test.describe("note-set shapes", () => {
  test("releasing a pinch into an open hand (4 fingers, thumb either way) held 1 s never changes the note set", async ({ synthPage: page }) => {
    await setHandsOn(page, SC.preview(0.5));
    await enterMode(page, "lead");
    for (const start of [1, 2, 3, 4]) {
      await setNoteSet(page, start);
      await setHandsOn(page, SC.preview(0.5));
      await page.waitForTimeout(120);
      await setHandsOn(page, SC.play(0.5));
      await page.waitForTimeout(250);
      expect((await dbg(page)).playing).not.toBe(null);
      // Release straight into a wide-open hand, the thumb flapping in and out (5 fingers <-> 4), for 1 s.
      const t0 = Date.now();
      let k = 0;
      while (Date.now() - t0 < 1000) {
        await setHandsOn(page, shape(SC, k++ % 2 ? 0 : 5, 0.5));
        await page.waitForTimeout(90);
        const d = await dbg(page);
        expect(d.setHoldTarget, `no set progress on an open hand (start ${start})`).toBe(null);
      }
      expect((await dbg(page)).setId).toBe(start);
      expect(await bus(page, "lead/noteset")).toBe(start);
    }
  });

  test("1, 2, 3 fingers and the rock sign held 0.3 s select sets 1-4; quick shapes under 0.3 s don't", async ({ synthPage: page }) => {
    await setHandsOn(page, SC.preview(0.5));
    await enterMode(page, "lead");
    await setNoteSet(page, 1);
    // Quick shapes (each < SET_HOLD_MS), then a pinch: nothing changes.
    for (const n of [4, 2, 3, 4, 2]) {
      await setHandsOn(page, shape(SC, n, 0.5));
      await page.waitForTimeout(140);
    }
    await setHandsOn(page, SC.play(0.5));
    await page.waitForTimeout(400);
    expect((await dbg(page)).setId).toBe(1);
    await setHandsOn(page, SC.preview(0.5));
    await page.waitForTimeout(200);
    for (const n of [2, 3, 4, 1, 4]) {
      await setHandsOn(page, shape(SC, n, 0.5, { thumb: n === 4 })); // the rock sign counts with the thumb out too
      await page.waitForTimeout(SET_HOLD_MS / 2);
      const mid = await dbg(page);
      expect(mid.setId, `still the old set halfway through the hold (-> ${n})`).not.toBe(n);
      expect(mid.setHoldTarget).toBe(n);
      await expect.poll(() => bus(page, "lead/noteset"), { timeout: 1000 }).toBe(n);
      await setHandsOn(page, SC.preview(0.5));
      await page.waitForTimeout(150);
    }
    // The DOM badge tooltip names the hand shape.
    await expect(page.locator("#noteSetBadge")).toHaveAttribute("title", "Note set: All notes (hand: 🤘 Rock sign)");
  });

  test("guide, help, first-use labels and the Controls legend show the new shapes", async ({ synthPage: page }) => {
    await setHandsOn(page, SC.preview(0.5));
    await enterMode(page, "lead");
    await page.waitForTimeout(150);
    await page.locator("#guideToggle").click();
    const rows = await page.locator("#gestureGuide .gs-guide-mode").allTextContents();
    expect(rows.join("|")).toContain("1️⃣2️⃣3️⃣🤘Note set");
    await page.locator("#guideToggle").click();
    await page.locator("#helpButton").click();
    const help = page.locator("#helpModal .help-content");
    await expect(help).toContainText("🤘 index + pinky = all notes");
    await expect(help).toContainText("An open hand changes nothing");
    await page.locator("#closeHelp").click();
    await openControls(page);
    await expect(page.locator('#controlsPanel [data-control="noteset-legend"]')).toContainText("🤘 4");
    await expect(page.locator('#controlsPanel .lead-controls [data-set="4"]')).toHaveAttribute("title", /🤘 Rock sign/);
    await closeControls(page);
  });
});

// =====================================================================================================
// 2. Setting confirmed: pop, ~1 s fully visible, fade
// =====================================================================================================

/** Waits (per frame, in the page) for a drawn confirm visual matching `kind`; returns what was drawn first. */
async function firstDrawn(page, kind) {
  const h = await page.waitForFunction((kind) => {
    const d = window.__gsTest.registry.getMode("lead")._debug();
    const v = kind === "set" ? d.setBadge : d.octaveToast;
    const at = kind === "set" ? d.setChangedAt : d.octaveChangedAt;
    if (!v || (kind === "set" && !v.confirmed)) return null;
    return { ...v, since: d.drawnAt - at };
  }, kind, { polling: "raf", timeout: 3000 });
  return h.jsonValue();
}

/** Samples what draw() showed for `kind` until `untilMs` after the confirm: [{since, alpha, scale}] (alpha 0 = not drawn). */
async function sampleConfirm(page, kind, untilMs) {
  return page.evaluate(({ kind, untilMs }) => new Promise((res) => {
    const out = [];
    const step = () => {
      const d = window.__gsTest.registry.getMode("lead")._debug();
      const v = kind === "set" ? d.setBadge : d.octaveToast;
      const since = d.drawnAt - (kind === "set" ? d.setChangedAt : d.octaveChangedAt);
      out.push({ since, alpha: v ? v.alpha : 0, scale: v ? v.scale : 1 });
      if (since >= untilMs) res(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), { kind, untilMs });
}

function assertConfirmTimeline(samples, label) {
  const full = samples.filter((s) => s.since >= 0 && s.since <= 900);
  expect(full.length, `${label}: frames in the first 0.9 s`).toBeGreaterThan(10);
  for (const s of full) expect(s.alpha, `${label}: fully visible at ${s.since.toFixed(0)} ms`).toBe(1);
  const late = samples.filter((s) => s.since >= CONFIRM.holdMs + CONFIRM.fadeMs);
  expect(late.length, `${label}: frames after the fade`).toBeGreaterThan(0);
  for (const s of late) expect(s.alpha, `${label}: gone at ${s.since.toFixed(0)} ms`).toBe(0);
  expect(CONFIRM.holdMs + CONFIRM.fadeMs).toBeLessThanOrEqual(1500);
  const fading = samples.filter((s) => s.since > CONFIRM.holdMs + 30 && s.since < CONFIRM.holdMs + CONFIRM.fadeMs - 30);
  for (const s of fading) expect(s.alpha, `${label}: fading at ${s.since.toFixed(0)} ms`).toBeLessThan(1);
}

test.describe("setting confirmed", () => {
  test("note set by hand: pop at the confirm, fully visible >= 0.9 s, gone by 1.5 s (+ screens)", async ({ synthPage: page }) => {
    fs.mkdirSync(SCREENS_DIR, { recursive: true });
    await setHandsOn(page, SC.left(1), SC.preview(0.5));
    await enterMode(page, "lead");
    await setNoteSet(page, 1);
    await setHandsOn(page, SC.left(1), shape(SC, 3, 0.5));
    const pop = await firstDrawn(page, "set");
    await page.screenshot({ path: `${SCREENS_DIR}/feedback-noteset-confirm-pop.png` });
    expect(pop.since, "first confirmed frame comes right after the confirm").toBeLessThan(CONFIRM.popMs);
    expect(pop.scale, "pop: scaled up at the confirm").toBeGreaterThan(1.02);
    expect(pop.flash, "pop: flash at the confirm").toBeGreaterThan(0);
    // Keep the shape: the badge must still read "Full scale" (not a new hold) for the whole second.
    const samples = await sampleConfirm(page, "set", 1600);
    assertConfirmTimeline(samples, "note-set badge");
    const settled = samples.filter((s) => s.since > CONFIRM.popMs + 20 && s.alpha > 0);
    for (const s of settled) expect(s.scale).toBe(1);
  });

  test("note-set badge at ~1 s still fully visible (screenshot); octave by arrow: same pop + linger + fade", async ({ synthPage: page }) => {
    fs.mkdirSync(SCREENS_DIR, { recursive: true });
    await setHandsOn(page, SC.left(1), SC.preview(0.5));
    await enterMode(page, "lead");
    await setNoteSet(page, 2);
    await setHandsOn(page, SC.left(1), shape(SC, 4, 0.5));
    await firstDrawn(page, "set");
    // The first frame drawn >= 0.9 s after the confirm (a busy machine may skip frames: only a frame inside
    // the 1 s hold must be fully opaque; the timeline test above samples every frame).
    const at1s = await (await page.waitForFunction(() => {
      const d = window.__gsTest.registry.getMode("lead")._debug();
      const since = d.drawnAt - d.setChangedAt;
      return since >= 900 ? { since, alpha: d.setBadge?.alpha ?? 0 } : null;
    }, null, { polling: "raf" })).jsonValue();
    await page.screenshot({ path: `${SCREENS_DIR}/feedback-noteset-confirm-1s.png` });
    if (at1s.since <= CONFIRM.holdMs) expect(at1s.alpha, `badge at ${at1s.since.toFixed(0)} ms`).toBe(1);
    else expect(at1s.alpha, `badge at ${at1s.since.toFixed(0)} ms (fading)`).toBeGreaterThan(0);
    // Octave: pinch on the up arrow and hold.
    const d = await dbg(page);
    const upY = d.geo.upY / d.geo.H;
    await setHandsOn(page, SC.left(1), SC.preview(upY));
    await page.waitForTimeout(250);
    await setHandsOn(page, SC.left(1), SC.play(upY));
    const pop = await firstDrawn(page, "octave");
    expect(pop.scale).toBeGreaterThan(1.02);
    expect(pop.flash).toBeGreaterThan(0);
    const samples = await sampleConfirm(page, "octave", 1600);
    assertConfirmTimeline(samples, "octave toast");
    expect((await dbg(page)).octave).toBe(d.octave + 1);
  });
});

// =====================================================================================================
// 3. Ladder labels
// =====================================================================================================

const CONTROLS = ["keySelect", "toneSelect", "guideToggle", "controlsToggle", "modeBadge", "noteSetBadge", "helpButton",
  "chordDisplay", "qualityDisplay", "outputChip", "transport", "volumeMeter", "gsBar", "gsPill"];

for (const [vpName, vp] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
  test.describe(`ladder labels ${vpName} ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });
    for (const swap of [false, true]) {
      test(`every line labelled; current note larger + mode-colored; no overlaps${swap ? " (ladder right)" : " (ladder left)"}`, async ({ synthPage: page }) => {
        const sc = scene(vp, { swap });
        await setHandsOn(page, sc.left(1), sc.preview(0.5));
        await enterMode(page, "lead");
        for (const set of [4, 3, 1]) {
          await setNoteSet(page, set);
          const notes = await ladder(page);
          const y = await yFor(page, notes[Math.floor(notes.length / 2)]);
          await setHandsOn(page, sc.left(1), sc.preview(y));
          await page.waitForTimeout(900); // side lock (600 ms) + set confirm visuals settle a bit
          await frames(page, 3);
          const d = await dbg(page);
          expect(d.side).toBe(sc.exprSide);
          // Every visible line has a label (the current one is the larger plate).
          const labelled = new Set(d.labels.map((l) => l.midi));
          expect(d.current, "current note plate").toBeTruthy();
          labelled.add(d.current.midi);
          const visible = d.lines.filter((l) => l.alpha > 0.5).map((l) => l.midi);
          for (const m of visible) expect(labelled.has(m), `set ${set}: line ${m} labelled`).toBe(true);
          expect(d.labels.length + 1).toBe(visible.length);
          // Current: larger, in the mode color (text on a dark plate while previewing).
          expect(d.current.size).toBeGreaterThan(Math.max(...d.labels.map((l) => l.size)));
          expect(d.current.color.toLowerCase()).toBe(MODE_COLORS.lead);
          // Chord notes brighter than the other notes.
          const chord = d.labels.find((l) => l.chord);
          const other = d.labels.find((l) => !l.chord);
          if (chord && other) expect(chord.color).not.toBe(other.color);
          // No label overlaps another label or the current plate.
          const rects = [...d.labels.map((l) => l.rect), d.current.rect];
          for (let i = 0; i < rects.length; i++)
            for (let j = i + 1; j < rects.length; j++)
              expect(overlaps(rects[i], rects[j]), `set ${set}: labels ${i} / ${j} overlap ${JSON.stringify(rects[i])} ${JSON.stringify(rects[j])}`).toBe(false);
          // On screen, clear of the DOM controls and the master track.
          const info = await page.evaluate((ids) => {
            const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
            const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
            return {
              controls: ids.map((id) => document.getElementById(id)).filter(vis).map((e) => ({ name: e.id, rect: box(e) })),
              master: window.__gsTest.ui.regions.find((r) => r.name === "master-track")?.rect ?? null,
            };
          }, CONTROLS);
          for (const r of rects) {
            expect(r.x).toBeGreaterThanOrEqual(0);
            expect(r.x + r.w).toBeLessThanOrEqual(vp.width);
            for (const c of info.controls) expect(overlaps(r, c.rect), `label vs #${c.name}`).toBe(false);
            if (info.master) expect(overlaps(r, info.master), "label vs master track").toBe(false);
          }
          if (set === 3 && !swap) await page.screenshot({ path: `${SCREENS_DIR}/feedback-ladder-labels${vpName === "mobile" ? "-mobile" : ""}.png` });
        }
      });
    }
  });
}

// =====================================================================================================
// 4. Discrete pitch in the app
// =====================================================================================================

test("moving while pinched steps between notes: no intermediate pitches (FFT per 85 ms window), no clicks", async ({ context }, info) => {
  await retryOnCaptureGlitch(info, async ({ track }) => {
    const page = await openApp(context, { viewport: DESKTOP });
    try {
      await setHandsOn(page, SC.preview(0.5)); // no left hand: no pad under the lead (clean pitch analysis)
      await enterMode(page, "lead");
      await setNoteSet(page, 3);
      const notes = await ladder(page);
      const path = [notes[5], notes[7], notes[6], notes[9], notes[5]];
      const ys = [];
      for (const m of path) ys.push(await yFor(page, m));
      await setHandsOn(page, SC.preview(ys[0]));
      await page.waitForTimeout(150);
      expect((await dbg(page)).pad).toEqual([]);
      await setHandsOn(page, SC.play(ys[0]));
      await page.waitForTimeout(250);
      const stop = await startRec(page);
      for (const y of ys) {
        await setHandsOn(page, SC.play(y));
        await page.waitForTimeout(280);
      }
      const rec = await stop();
      track(rec);
      const { samples, sampleRate } = rec;
      writeWav(`${WAV_DIR}/feedback-lead-steps.wav`, samples, sampleRate);
      expect((await dbg(page)).playing).toBe(path.at(-1));
      const targets = [...new Set(path)].map(midiToFreq);
      const a = stepAnalysis(samples, sampleRate, targets);
      const heard = a.segments.filter((s) => (s.to - s.from) / sampleRate > 0.05).map((s) => s.target);
      expect(heard).toEqual(path.map((m) => targets.indexOf(midiToFreq(m))));
      // Same bounds as the lab test (tests/lead.spec.js): the two cycles touching a step at most.
      expect(a.maxBetweenRun, `cycles between targets: ${a.between.map((c) => c.f.toFixed(0)).join(",")}`).toBeLessThanOrEqual(2);
      for (const w of windowPitches(samples, sampleRate)) {
        if (w.freq === 0) continue;
        expect(targets.some((t) => Math.abs(w.freq / t - 1) < 0.02), `window @${(w.start / sampleRate).toFixed(3)} s: ${w.freq.toFixed(1)} Hz`).toBe(true);
      }
      const env = envelope(samples);
      const steady = env.slice(2, 20).reduce((s, v) => s + v, 0) / 18;
      expect(Math.min(...env.slice(2)), "legato: no gap at a step").toBeGreaterThan(steady * 0.6);
      const cr = clickRatio(samples);
      expect(cr.ratio, `max jump ${cr.allMax.toFixed(4)} vs steady ${cr.steadyMax.toFixed(4)}`).toBeLessThan(1.6);
      expect(page.__errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

// =====================================================================================================
// 5. One filter visual
// =====================================================================================================

/** Filter visuals on screen: canvas regions named like a filter + visible DOM elements that show a filter value. */
async function filterVisuals(page) {
  return page.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
    const regions = (window.__gsTest.ui.regions || []).filter((r) => /filter/i.test(r.name));
    const lead = window.__gsTest.registry.getMode("lead")._debug?.().regions?.filter((r) => /filter/i.test(r.name)) ?? [];
    const dom = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && /Filter[: ]/.test(e.textContent) && vis(e) &&
      !e.closest("#helpModal, #controlsPanel, #gestureGuide"));
    const el = document.getElementById("distortionDisplay");
    return {
      canvas: regions.map((r) => ({ name: r.name, label: r.rect.label?.text ?? null })),
      lead: window.__gsTest.router.modeId === "lead" ? lead.map((r) => r.name) : [],
      dom: dom.map((e) => e.id || e.className || e.tagName),
      readout: { attached: !!el, visible: vis(el), text: el?.textContent ?? null },
    };
  });
}

for (const [vpName, vp] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
  test.describe(`one filter visual ${vpName}`, () => {
    test.use({ viewport: vp });
    test("exactly one filter visual in each mode; its value label tracks the tilt; the readout is hidden but in the DOM", async ({ synthPage: page }) => {
      const sc = scene(vp);
      await expect(page.locator("body")).toHaveClass(/gs-modes/);
      for (const id of ["chords", "arp", "lead"]) {
        await setHandsOn(page, sc.left(1), sc.open(2));
        if ((await modeId(page)) !== id) await enterMode(page, id);
        for (const tilt of [-0.5, 0.4]) {
          // Lead: an open hand (no set shape) at the side; Chords/Arp: 2 fingers.
          const right = id === "lead" ? shape(sc, 0, sc.R.y, { tilt }) : sc.open(2, sc.R.y, { tilt });
          await setHandsOn(page, sc.left(1), right);
          await page.waitForTimeout(300);
          await frames(page, 3);
          const f = await filterVisuals(page);
          expect(f.canvas.map((c) => c.name), `${id}: canvas filter visuals`).toEqual(["filter-arc"]);
          expect(f.lead, `${id}: Lead draws no filter visual of its own`).toEqual([]);
          expect(f.dom, `${id}: no visible DOM filter readout`).toEqual([]);
          expect(f.readout.attached, "original readout still in the DOM").toBe(true);
          expect(f.readout.visible, "original readout hidden under gs-modes").toBe(false);
          const value = await bus(page, "filter");
          expect(Math.abs(value - tilt), `${id}: filter follows the tilt`).toBeLessThan(0.05);
          expect(f.canvas[0].label, `${id}: arc label`).toBe(filterText(value));
          expect(f.readout.text, "hidden readout still kept up to date").toBe(`Filter: ${filterText(value).slice(7)}`);
        }
        if (id === "lead" && vpName === "desktop") await page.screenshot({ path: `${SCREENS_DIR}/feedback-filter-consolidated.png` });
      }
    });
  });
}

// =====================================================================================================
// Hand lost in Lead: the dashed ring + "Hand lost" plate fade out (same timing as the edge tracks)
// =====================================================================================================

test("Lead hand-lost ring + plate: full for MOTION.lostHold, then fade, then gone; the ladder stays", async ({ synthPage: page }) => {
  await setHandsOn(page, SC.left(1), SC.preview(0.5));
  await enterMode(page, "lead");
  await page.waitForTimeout(300);
  await setHandsOn(page, SC.left(1)); // the right hand drops out
  const lostNames = async () => (await dbg(page)).regions.map((r) => r.name).filter((n) => n === "lead-lost");
  await expect.poll(lostNames, { timeout: 1500 }).toEqual(["lead-lost"]);
  const samples = await page.evaluate(() => new Promise((res) => {
    const out = [];
    const step = () => {
      const d = window.__gsTest.registry.getMode("lead")._debug();
      const since = d.drawnAt - d.lostSince;
      out.push({ since, a: d.lostAlpha, plate: d.regions.some((r) => r.name === "lead-lost") });
      if (since > 2300) res(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
  for (const s of samples.filter((x) => x.since <= MOTION.lostHold - 20)) expect(s.a, `full at ${s.since.toFixed(0)} ms`).toBe(1);
  expect(samples.some((s) => s.a > 0 && s.a < 1), "fades (not a jump)").toBe(true);
  for (const s of samples.filter((x) => x.since >= MOTION.lostHold + MOTION.lostFade + 20)) {
    expect(s.a).toBe(0);
    expect(s.plate).toBe(false);
  }
  for (let i = 1; i < samples.length; i++) expect(samples[i].a).toBeLessThanOrEqual(samples[i - 1].a);
  const d = await dbg(page);
  expect(d.regions.some((r) => r.name === "lead-ladder"), "ladder still drawn").toBe(true);
});

// =====================================================================================================
// Video with sound
// =====================================================================================================

test("video test-results/videos/camera-feedback-lead.webm: labels, discrete steps, rock sign -> All notes, octave toast", async ({ synthPage: page, browser }) => {
  test.setTimeout(90_000);
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
  const L = SC.left(1);
  await setHandsOn(page, L, SC.preview(0.5));
  await enterMode(page, "lead");
  await setNoteSet(page, 3);
  await page.waitForTimeout(600);
  // A little melody: preview, then legato steps while pinched.
  let notes = await ladder(page);
  await setHandsOn(page, L, SC.preview(await yFor(page, notes[5])));
  await page.waitForTimeout(500);
  await setHandsOn(page, L, SC.play(await yFor(page, notes[5])));
  for (const i of [5, 6, 7, 9, 8, 7, 6, 5]) {
    await setHandsOn(page, L, SC.play(await yFor(page, notes[i])));
    await page.waitForTimeout(260);
  }
  await setHandsOn(page, L, SC.preview(0.5));
  await page.waitForTimeout(400);
  // Release into an open hand: nothing changes. Then the rock sign: All notes, with the confirm pop.
  await setHandsOn(page, L, shape(SC, 0, 0.5));
  await page.waitForTimeout(900);
  await setHandsOn(page, L, shape(SC, 4, 0.5));
  await expect.poll(() => bus(page, "lead/noteset")).toBe(4);
  await page.waitForTimeout(1500);
  // Octave up by the arrow.
  const d = await dbg(page);
  const upY = d.geo.upY / d.geo.H;
  await setHandsOn(page, L, SC.preview(upY));
  await page.waitForTimeout(300);
  await setHandsOn(page, SC.left(4), SC.play(upY));
  await expect.poll(async () => (await dbg(page)).octave).toBe(d.octave + 1);
  await page.waitForTimeout(1300);
  notes = await ladder(page);
  await setHandsOn(page, SC.left(4), SC.preview(await yFor(page, notes[12])));
  await page.waitForTimeout(300);
  for (const i of [12, 14, 16, 14, 12]) {
    await setHandsOn(page, SC.left(4), SC.play(await yFor(page, notes[i])));
    await page.waitForTimeout(240);
  }
  await setHandsOn(page, SC.left(4), SC.preview(0.5));
  await page.waitForTimeout(700);
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
  const out = "test-results/videos/camera-feedback-lead.webm";
  const res = await rec.save(browser, out, { layout: ["app"], cellW: 1280, cellH: 800, audio: snd });
  expect(res.frames[0]).toBeGreaterThan(60);
  expect(fs.statSync(out).size).toBeGreaterThan(100_000);
});
