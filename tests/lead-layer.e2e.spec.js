// Lead layer in the real app (?mockHands): Lead plays ON TOP of the base mode (Chords / Arp) instead of replacing it
// (docs/architecture.md "Lead layer"; spec deviation noted in docs/spec/requirements.md). Pure rules (router, menu
// items, same-item): tests/lead-layer.unit.spec.js. Gain staging with the layer: tests/gain-staging.e2e.spec.js.
//   - Arp -> Lead: arp keeps sounding at the held gate / tempo / voicing, left-hand chords reach it, lead on top,
//     no gap/click across the switch
//   - Chords -> Lead: the chord keeps sounding at the held voicing / volume, left-hand chords still change it
//   - Lead again = no change; the base underneath = layer off + Return crossfade; the other base = switch
//   - held base values from the Controls panel while Lead is on
//   - UI: two-part badge, base visuals, held meter, menu markers, mobile pill, layout at 1280x800 / 390x844
//   - screenshots test-results/screens/layer-*.png + a video with sound (test-results/videos/lead-layer.webm)
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { recordAudio, spectrum, peaks, rms, writeWav, retryOnCaptureGlitch } from "./helpers/audio.js";
import { peakAbs } from "./helpers/arp-analysis.js";
import { createScreencast } from "./helpers/screencast.js";
import { scene, setHands, openApp, bus, frames, startRec, longestSilence, maxD2, overlaps, yFor, ladder } from "./helpers/m2-lead.js";
import { clearArea } from "../src/ui/theme.js";

const WAV_DIR = "test-results/audio";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const SC = scene(DESKTOP); // chord hand on the screen right -> expression hand + ladder on the LEFT
const STEP = { right: [0.014, 0], left: [-0.014, 0], up: [0, -0.022], down: [0, 0.022] };
const mod12 = (n) => ((n % 12) + 12) % 12;
const pcOf = (f) => mod12(Math.round(69 + 12 * Math.log2(f / 440)));

test.describe.configure({ mode: "default" }); // audio measurements: keep this file's tests off each other's CPU

const state = (page) =>
  page.evaluate(() => {
    const t = window.__gsTest;
    return { mode: t.bus.get("mode"), layer: t.bus.get("layer"), right: t.router.rightModeId };
  });

/**
 * Fist menu: fist at `from`, move toward `dir` until `expectSel` is selected, open with `open(p)`. Resolves once the
 * menu is closed. `want` = the {mode, layer} expected after (null layer = off).
 */
async function menuPick(page, { left, from = SC.R, sc = SC, dir, expectSel, open, want, onSelected }) {
  await setHands(page, left, sc.fistAt(from));
  await expect.poll(async () => (await bus(page, "menu"))?.state, { timeout: 2000 }).toBe("open");
  let p = from;
  for (let i = 1; i <= 10; i++) {
    p = { x: from.x + STEP[dir][0] * i, y: from.y + STEP[dir][1] * i };
    await setHands(page, left, sc.fistAt(p));
    await page.waitForTimeout(35);
  }
  await expect.poll(async () => (await bus(page, "menu"))?.selectedId ?? null, { timeout: 2000 }).toBe(expectSel);
  if (onSelected) await onSelected(p);
  await setHands(page, left, open(p));
  if (want) await expect.poll(() => state(page).then((s) => ({ mode: s.mode, layer: s.layer })), { timeout: 1500 }).toEqual(want);
  await expect.poll(async () => (await bus(page, "menu")) ?? null, { timeout: 2000 }).toBe(null);
  return p;
}

async function logNotes(page) {
  await page.evaluate(() => {
    window.__notes = [];
    window.__gsTest.bus.subscribe({ onEvent: (n, d, t) => window.__notes.push({ n, t, ...d }) }, ["note/on", "note/off"]);
  });
}
const notesSince = (page, ms, voice) =>
  page.evaluate(({ ms, voice }) => {
    const ac = window.__gsTest.ctx.audio.ac;
    const t0 = ac.currentTime - ms / 1000;
    return window.__notes.filter((e) => e.n === "note/on" && e.voice === voice && e.t >= t0);
  }, { ms, voice });

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
  await page.mouse.move(vp.width / 2, vp.height / 2); // off Lead's ladder strip
}

/** Lead's ladder midi + y for a ladder index (the right hand's preview/play position). */
async function leadY(page, i) {
  const notes = await ladder(page);
  const midi = notes[Math.min(i, notes.length - 1)];
  return { midi, y: await yFor(page, midi) };
}

// =====================================================================================================
// Sound: the base keeps playing under the lead
// =====================================================================================================

test("Arp -> Lead: arp keeps its held gate / tempo / voicing, follows left-hand chords; lead on top; no gap or click", async ({ context }, info) => {
  test.setTimeout(120_000);
  await retryOnCaptureGlitch(info, async ({ track }) => {
    const page = await openApp(context);
    try {
      const HIGH = { x: SC.R.x, y: 0.3 }; // gate ~0.7: long overlapping arp notes
      const L1 = SC.left(1);
      await setHands(page, L1, SC.open(2, HIGH.y, { x: HIGH.x }));
      await page.waitForTimeout(400);
      await menuPick(page, { left: L1, from: HIGH, dir: "right", expectSel: "arp", open: (p) => SC.open(2, HIGH.y, { x: p.x }), want: { mode: "arp", layer: null } });
      await page.waitForTimeout(900);
      const before = await page.evaluate(() => {
        const a = window.__gsTest.registry.getMode("arp").state;
        return { gate: a.gate, bpm: a.bpm, voicing: a.voicing, doubleTime: a.doubleTime, filter: window.__gsTest.synth.filter.frequency.value };
      });
      expect(before.voicing).toBe(2);
      expect(before.gate).toBeGreaterThan(0.5);
      const ref1 = track(await recordAudio(page, 500)).samples;
      await logNotes(page);
      const stop = await startRec(page);
      await page.waitForTimeout(300);
      await menuPick(page, { left: L1, from: HIGH, dir: "left", expectSel: "lead", open: (p) => SC.preview(HIGH.y, { x: p.x }), want: { mode: "arp", layer: "lead" } });
      await page.waitForTimeout(900);
      const rec = track(await stop());
      writeWav(`${WAV_DIR}/layer-switch-arp-lead.wav`, rec.samples, rec.sampleRate);
      const sr = rec.sampleRate;
      const gap = longestSilence(rec.samples, sr, 0.05, rec.samples.length / sr - 0.05);
      const d2 = maxD2(rec.samples);
      // Steady reference after the switch: arp only (the lead previews, plays nothing).
      const ref2 = track(await recordAudio(page, 500)).samples;
      const ref = Math.max(maxD2(ref1), maxD2(ref2));
      console.log(`[layer arp->lead] longest silence ${(gap * 1000).toFixed(1)} ms, max d2 ${d2.toFixed(4)} (steady ${ref.toFixed(4)})`);
      // Same thresholds as the M1/M2 switch tests.
      expect(gap, "longest silence across the switch").toBeLessThan(0.03);
      expect(d2, "no discontinuity spike beyond steady-state playing").toBeLessThanOrEqual(ref * 1.25 + 1e-3);
      expect(peakAbs(rec.samples)).toBeLessThanOrEqual(1);

      // The right hand now plays Lead: moving it (other height, other finger count, thumb out) changes nothing in Arp.
      const { y: yLow } = await leadY(page, 2);
      await setHands(page, L1, SC.open(4, 0.75, { thumb: true }));
      await page.waitForTimeout(500);
      await setHands(page, L1, SC.preview(yLow));
      await page.waitForTimeout(300);
      const held = await page.evaluate(() => {
        const a = window.__gsTest.registry.getMode("arp").state;
        return { gate: a.gate, bpm: a.bpm, voicing: a.voicing, doubleTime: a.doubleTime, filter: window.__gsTest.synth.filter.frequency.value };
      });
      expect(held.gate).toBeCloseTo(before.gate, 5);
      expect(held.bpm).toBe(before.bpm);
      expect(held.voicing).toBe(before.voicing);
      expect(held.doubleTime).toBe(before.doubleTime);
      expect(held.filter, "the shared (base) filter stays at its held value").toBeCloseTo(before.filter, 0);
      expect(await bus(page, "arp/gate")).toBeCloseTo(before.gate, 5);
      // Arp keeps playing.
      expect((await notesSince(page, 800, "arp")).length).toBeGreaterThan(2);
      expect(await bus(page, "voicing")).toBe(2);

      // Left hand: IV -> the arp notes follow (pitch classes of the IV triad).
      await setHands(page, SC.left(4), SC.preview(yLow));
      await expect.poll(() => bus(page, "chord").then((c) => c?.roman)).toBe("IV");
      await page.waitForTimeout(700);
      const ivPcs = await page.evaluate(() => [...new Set(window.__gsTest.ctx.harmony.chord.tones.map((f) => ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12))]);
      const arpIV = await notesSince(page, 500, "arp");
      expect(arpIV.length).toBeGreaterThan(1);
      for (const n of arpIV) expect(ivPcs, `arp note ${n.midi} in IV`).toContain(mod12(n.midi));

      // Lead on top: pinch plays a ladder note; FFT shows the lead pitch AND arp pitches.
      const { midi: leadMidi, y } = await leadY(page, 6);
      await setHands(page, SC.left(4), SC.preview(y));
      await page.waitForTimeout(150);
      await setHands(page, SC.left(4), SC.play(y));
      await page.waitForTimeout(250);
      const both = track(await recordAudio(page, 900));
      writeWav(`${WAV_DIR}/layer-arp-plus-lead.wav`, both.samples, both.sampleRate);
      const pk = peaks(spectrum(both.samples, both.sampleRate, 16384), 0.05).map((p) => p.freq);
      const leadF = 440 * 2 ** ((leadMidi - 69) / 12);
      expect(pk.some((f) => Math.abs(f / leadF - 1) < 0.01), `lead ${leadF.toFixed(1)} Hz in ${pk.map((f) => f.toFixed(0))}`).toBe(true);
      const arpNow = (await notesSince(page, 900, "arp")).map((n) => n.freq);
      expect(arpNow.length).toBeGreaterThan(1);
      expect(pk.some((f) => arpNow.some((a) => Math.abs(f / a - 1) < 0.01) && Math.abs(f / leadF - 1) >= 0.01), "an arp pitch besides the lead").toBe(true);
      expect((await notesSince(page, 900, "lead")).length + (await page.evaluate(() => window.__gsTest.registry.getMode("lead")._debug().sounding ? 1 : 0))).toBeGreaterThan(0);
      // No pad under a base (the base is the accompaniment).
      expect(await page.evaluate(() => window.__gsTest.registry.getMode("lead")._debug().pad)).toEqual([]);
      expect(page.__errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

test("Chords -> Lead: the chord keeps sounding at the held voicing / volume, left-hand chords still change it, lead on top", async ({ context }, info) => {
  test.setTimeout(120_000);
  await retryOnCaptureGlitch(info, async ({ track }) => {
    const page = await openApp(context);
    try {
      const HIGH = { x: SC.R.x, y: 0.35 };
      const L1 = SC.left(1);
      await setHands(page, L1, SC.open(3, HIGH.y, { x: HIGH.x }));
      await page.waitForTimeout(700);
      const before = { vol: await bus(page, "chords/volume"), voicing: await bus(page, "voicing"), key: await page.evaluate(() => window.__gsTest.synth.currentKey) };
      expect(before.voicing).toBe(3);
      const ref1 = track(await recordAudio(page, 500)).samples;
      const stop = await startRec(page);
      await page.waitForTimeout(300);
      await menuPick(page, { left: L1, from: HIGH, dir: "left", expectSel: "lead", open: (p) => SC.preview(HIGH.y, { x: p.x }), want: { mode: "chords", layer: "lead" } });
      await page.waitForTimeout(700);
      const rec = track(await stop());
      writeWav(`${WAV_DIR}/layer-switch-chords-lead.wav`, rec.samples, rec.sampleRate);
      const sr = rec.sampleRate;
      const gap = longestSilence(rec.samples, sr, 0.05, rec.samples.length / sr - 0.05);
      const d2 = maxD2(rec.samples);
      const ref2 = track(await recordAudio(page, 500)).samples;
      const ref = Math.max(maxD2(ref1), maxD2(ref2));
      console.log(`[layer chords->lead] longest silence ${(gap * 1000).toFixed(1)} ms, max d2 ${d2.toFixed(4)} (steady ${ref.toFixed(4)})`);
      expect(gap).toBeLessThan(0.03);
      expect(d2).toBeLessThanOrEqual(ref * 1.25 + 1e-3);

      // Right hand low + other finger count: Chords' volume / voicing stay held; the chord keeps sounding.
      await setHands(page, L1, SC.open(1, 0.8));
      await page.waitForTimeout(500);
      expect(await bus(page, "chords/volume")).toBeCloseTo(before.vol, 5);
      expect(await bus(page, "voicing")).toBe(3);
      expect(await page.evaluate(() => window.__gsTest.synth.currentKey)).toBe(before.key);
      const steady = track(await recordAudio(page, 500));
      expect(rms(steady.samples), "the chord keeps sounding").toBeGreaterThan(0.01);

      // Left-hand chord change: the chord follows (voicing 3 = the 7th chord of V).
      await setHands(page, SC.left(5), SC.open(1, 0.8));
      await expect.poll(() => bus(page, "chord").then((c) => c?.roman)).toBe("V");
      await page.waitForTimeout(400);
      const vFreqs = await page.evaluate(() => window.__gsTest.synth.oscillators.map((o) => o.frequency.value));
      const vPcs = await page.evaluate(() => [...new Set(window.__gsTest.ctx.harmony.chord.tones.map((f) => ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12))]);
      expect(vFreqs.length).toBe(4);
      for (const t of vPcs) expect(vFreqs.map(pcOf), `V chord tone ${t}`).toContain(t);

      // Lead on top: the lead pitch next to the chord's pitches.
      const { midi: leadMidi, y } = await leadY(page, 5);
      await setHands(page, SC.left(5), SC.preview(y));
      await page.waitForTimeout(150);
      await setHands(page, SC.left(5), SC.play(y));
      await page.waitForTimeout(250);
      const both = track(await recordAudio(page, 700));
      writeWav(`${WAV_DIR}/layer-chords-plus-lead.wav`, both.samples, both.sampleRate);
      const pk = peaks(spectrum(both.samples, both.sampleRate, 16384), 0.05).map((p) => p.freq);
      const leadF = 440 * 2 ** ((leadMidi - 69) / 12);
      expect(pk.some((f) => Math.abs(f / leadF - 1) < 0.01), `lead ${leadF.toFixed(1)} in ${pk.map((f) => f.toFixed(0))}`).toBe(true);
      expect(pk.some((f) => vFreqs.some((c) => Math.abs(f / c - 1) < 0.01) && Math.abs(f / leadF - 1) >= 0.01), "a chord pitch besides the lead").toBe(true);
      expect(peakAbs(both.samples)).toBeLessThanOrEqual(1);
      expect(page.__errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

// =====================================================================================================
// Menu rules in the app
// =====================================================================================================

test("menu: Lead again = no change; the base underneath = layer off + Return crossfade; the other base = switch", async ({ synthPage: page }) => {
  const L1 = SC.left(1);
  const Y = 0.35;
  await setHands(page, L1, SC.open(2, Y));
  await page.evaluate(() => window.__gsTest.router.setMode("arp"));
  await setHands(page, L1, SC.open(2, Y));
  await page.waitForTimeout(400);
  const gate0 = await bus(page, "arp/gate");
  await menuPick(page, { left: L1, from: { x: SC.R.x, y: Y }, dir: "left", expectSel: "lead", open: (p) => SC.preview(Y, { x: p.x }), want: { mode: "arp", layer: "lead" } });
  // The menu while the layer is on: Lead = the current item, Arp = secondary (hollow marker) with its hint.
  await setHands(page, L1, SC.fistAt({ x: SC.R.x, y: Y }));
  await expect.poll(async () => (await bus(page, "menu"))?.state).toBe("open");
  const snap = await page.evaluate(() => {
    const s = window.__gsTest.router.menu.snapshot();
    return { currentId: s.currentId, items: s.items.map((i) => ({ id: i.id, type: i.type, secondary: !!i.secondary, hint: i.confirmHint ?? null })) };
  });
  expect(snap.currentId).toBe("lead");
  expect(snap.items).toEqual(expect.arrayContaining([
    { id: "lead", type: "layer", secondary: false, hint: null },
    { id: "arp", type: "mode", secondary: true, hint: "Open hand: Lead off" },
    { id: "chords", type: "mode", secondary: false, hint: null },
  ]));
  await setHands(page, L1, SC.preview(Y)); // cancel (open in the centre)
  await expect.poll(async () => (await bus(page, "menu")) ?? null).toBe(null);
  await page.waitForTimeout(300);

  // Lead again: same-item, nothing changes.
  await menuPick(page, { left: L1, from: { x: SC.R.x, y: Y }, dir: "left", expectSel: "lead", open: (p) => SC.preview(Y, { x: p.x }) });
  expect(await state(page)).toEqual({ mode: "arp", layer: "lead", right: "lead" });
  await page.waitForTimeout(300);

  // Arp (underneath): layer off; the gate starts at its held value and crossfades to the hand (Return).
  const LOW = 0.75; // a different height than the held gate
  await page.evaluate(() => {
    window.__heldLog = [];
    window.__gsTest.bus.subscribe({ onSet: (n, v) => window.__heldLog.push({ n, v: v && JSON.parse(JSON.stringify(v)) }) }, ["held", "arp/gate"]);
  });
  await menuPick(page, {
    left: L1, from: { x: SC.R.x, y: LOW }, dir: "right", expectSel: "arp",
    open: (p) => SC.open(2, LOW, { x: p.x }), want: { mode: "arp", layer: null },
  });
  await page.waitForTimeout(500);
  const log = await page.evaluate(() => window.__heldLog);
  const gates = log.filter((e) => e.n === "arp/gate").map((e) => e.v);
  console.log(`[layer return] gate0 ${gate0.toFixed(3)} gates ${gates.map((g) => g.toFixed(3)).join(" ")} held ${JSON.stringify(log.filter((e) => e.n === "held").map((e) => e.v))}`);
  expect(log.some((e) => e.n === "held" && e.v && !e.v.right), "Return phase published").toBe(true);
  // The Return phase holds the gate Arp had before the layer; from there it glides (monotonic, no jump) to the hand.
  // (The bus notifies on change only, so the crossfade's first frame — equal to the held value — is not logged.)
  const ret = log.find((e) => e.n === "held" && e.v && !e.v.right);
  expect(ret.v["arp/gate"]).toBeCloseTo(gate0, 5);
  for (let i = 1; i < gates.length; i++) expect(gates[i], `gate step ${i}`).toBeLessThanOrEqual(gates[i - 1] + 1e-9);
  expect(gates[0], "the first change starts near the held value, not at the hand").toBeGreaterThan(gates[gates.length - 1] + 0.1);
  expect(gates[gates.length - 1]).toBeLessThan(gate0 - 0.2); // reached the low hand
  expect(await bus(page, "held")).toBe(null);
  expect(await page.evaluate(() => window.__gsTest.ctx.layerBase)).toBe(null);

  // Arp + Lead -> Chords: base switches, layer off.
  await menuPick(page, { left: L1, from: { x: SC.R.x, y: Y }, dir: "left", expectSel: "lead", open: (p) => SC.preview(Y, { x: p.x }), want: { mode: "arp", layer: "lead" } });
  await menuPick(page, { left: L1, from: { x: SC.R.x, y: 0.5 }, dir: "up", expectSel: "chords", open: (p) => SC.open(2, p.y, { x: p.x }), want: { mode: "chords", layer: null } });
  expect(await state(page)).toEqual({ mode: "chords", layer: null, right: "chords" });
});

test("Controls panel while Lead is on: Mode row lights base + Lead; held Arp gate / tempo and Chords volume are settable", async ({ synthPage: page }) => {
  const L1 = SC.left(1);
  await setHands(page, L1, SC.open(2, 0.4));
  await page.evaluate(() => window.__gsTest.router.setMode("arp"));
  await page.waitForTimeout(300);
  await openControls(page);
  await page.locator('#controlsPanel [data-control="mode"] button[data-value="lead"]').click();
  expect(await state(page)).toEqual({ mode: "arp", layer: "lead", right: "lead" });
  const seg = page.locator('#controlsPanel [data-control="mode"]');
  await expect(seg.locator('button[data-value="arp"]')).toHaveClass(/on/);
  await expect(seg.locator('button[data-value="lead"]')).toHaveClass(/on/);
  await expect(seg.locator('button[data-value="chords"]')).not.toHaveClass(/on/);
  const groups = page.locator("#controlsPanel .gs-ctl-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute("data-mode", "arp");
  await expect(groups.nth(0).locator(".gs-ctl-head")).toContainText("Arp");
  await expect(groups.nth(0).locator(".gs-ctl-head")).toContainText("right hand held");
  await expect(groups.nth(1)).toHaveAttribute("data-mode", "lead");
  await expect(groups.nth(1).locator(".lead-controls")).toBeVisible();
  // The right hand moves (plays Lead), the gate row never shows the hand mark.
  await setHands(page, L1, SC.preview(0.6));
  await page.waitForTimeout(150);
  await expect(page.locator('#controlsPanel [data-control="gate"]').locator("xpath=..")).not.toHaveClass(/gs-owned/);
  // Gate slider -> the held gate changes and stays while the hand plays Lead.
  await page.locator('#controlsPanel [data-control="gate"]').fill("0.2");
  await expect.poll(() => bus(page, "arp/gate")).toBeCloseTo(0.2, 2);
  await setHands(page, L1, SC.preview(0.3));
  await page.waitForTimeout(400);
  expect(await bus(page, "arp/gate")).toBeCloseTo(0.2, 2);
  // Tempo +.
  const bpm0 = await bus(page, "bpm");
  await page.locator('#controlsPanel [data-control="bpm-up"]').click();
  await expect.poll(() => bus(page, "bpm")).toBe(bpm0 + 1);
  await page.screenshot({ path: `${SCREENS_DIR}/layer-controls.png` });
  // Chords under Lead: a held Volume row.
  await page.locator('#controlsPanel [data-control="mode"] button[data-value="chords"]').click();
  await page.locator('#controlsPanel [data-control="mode"] button[data-value="lead"]').click();
  expect(await state(page)).toEqual({ mode: "chords", layer: "lead", right: "lead" });
  const vol = page.locator('#controlsPanel [data-control="chords-volume"]');
  await expect(vol).toBeVisible();
  await vol.fill("0.3");
  await expect.poll(() => bus(page, "chords/volume")).toBeCloseTo(0.3, 2);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__gsTest.synth.chordGain.gain.value)).toBeCloseTo(0.3, 1);
  await closeControls(page);
});

// =====================================================================================================
// UI
// =====================================================================================================

const CONTROLS = ["keySelect", "toneSelect", "guideToggle", "controlsToggle", "modeBadge", "noteSetBadge", "helpButton",
  "distortionDisplay", "chordDisplay", "qualityDisplay", "outputChip", "transport", "volumeMeter", "gsBar", "gsPill"];

async function layoutInfo(page) {
  return page.evaluate((ids) => {
    const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
    const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return {
      controls: ids.map((id) => document.getElementById(id)).filter(vis).map((e) => ({ name: e.id, rect: box(e) })),
      regions: window.__gsTest.ui.regions,
      lead: window.__gsTest.registry.getMode("lead")._debug().regions,
    };
  }, CONTROLS);
}

function checkLayout(info, vp) {
  const lad = info.lead.find((r) => r.name === "lead-ladder")?.rect;
  expect(lad, "Lead ladder drawn").toBeTruthy();
  expect(info.regions.find((r) => r.name === "right-track"), "no gate/volume track on canvas under the layer").toBeFalsy();
  const master = info.regions.find((r) => r.name === "master-track")?.rect;
  expect(master).toBeTruthy();
  expect(overlaps(lad, master)).toBe(false);
  for (const c of info.controls) expect(overlaps(lad, c.rect), `ladder vs #${c.name}`).toBe(false);
  expect(overlaps(lad, clearArea(vp.width, vp.height)), "ladder out of the clear area").toBe(false);
  // DOM chrome never overlaps itself (badge, transport, meter …).
  const cs = info.controls;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      if (["gsBar", "gsPill"].includes(cs[i].name) || ["gsBar", "gsPill"].includes(cs[j].name)) continue; // the bar contains the controls
      expect(overlaps(cs[i].rect, cs[j].rect), `#${cs[i].name} vs #${cs[j].name}`).toBe(false);
    }
  }
}

for (const [vpName, vp] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
  test.describe(`layer UI ${vpName} ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });
    test(`badge / pill "Arp + Lead", base visuals running, held meter, layout`, async ({ synthPage: page }) => {
      const sc = scene(vp);
      await setHands(page, sc.left(1), sc.open(2, 0.4));
      await page.evaluate(() => window.__gsTest.router.setMode("arp"));
      await setHands(page, sc.left(1), sc.open(2, 0.4));
      await page.waitForTimeout(300);
      const gate = await bus(page, "arp/gate");
      await page.evaluate(() => window.__gsTest.router.setMode("lead"));
      await setHands(page, sc.left(1), sc.preview(0.5));
      await page.waitForTimeout(900); // side lock + frames
      await frames(page, 4);
      await expect(page.locator("body")).toHaveAttribute("data-mode", "arp");
      await expect(page.locator("body")).toHaveAttribute("data-layer", "lead");
      const mobile = await isMobile(page);
      if (!mobile) {
        const badge = page.locator("#modeBadge");
        await expect(badge).toHaveText("Arp+Lead");
        await expect(badge).toHaveAttribute("aria-label", "Mode: Arp + Lead. Open controls");
        const colors = await badge.evaluate((b) => [...b.querySelectorAll(".gs-part")].map((p) => ({
          color: getComputedStyle(p).color, opacity: Number(getComputedStyle(p).opacity),
        })));
        expect(colors[0].color).toBe("rgb(79, 179, 255)"); // Arp
        expect(colors[1].color).toBe("rgb(192, 140, 255)"); // Lead
        expect(colors[0].opacity).toBeLessThan(colors[1].opacity); // base quieter
        // Transport keeps running (Arp is still playing); meter shows the HELD gate, dimmed.
        await expect(page.locator("#transport")).toBeVisible();
        const lit = await page.locator(".vol-bar.lit").count();
        expect(lit).toBe(Math.round(gate * 8));
        expect(Number(await page.locator("#volumeMeter").evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.6);
        // Gesture guide: the layer note.
        await page.locator("#guideToggle").click();
        await expect(page.locator("#gestureGuide .gs-guide-note")).toContainText("Lead plays on top of Arp");
        await page.locator("#guideToggle").click();
        await page.screenshot({ path: `${SCREENS_DIR}/layer-arp-plus-lead.png` });
      } else {
        const pill = page.locator("#gsPill .gs-pill-mode");
        await expect(pill).toHaveText("Arp+Lead");
        await expect(pill.locator(".gs-pill-base")).toHaveCSS("color", "rgb(79, 179, 255)");
        await expect(pill.locator(".gs-pill-layer")).toHaveCSS("color", "rgb(192, 140, 255)");
        await page.screenshot({ path: `${SCREENS_DIR}/layer-mobile-pill.png` });
      }
      checkLayout(await layoutInfo(page), vp);
      // Chords + Lead.
      await page.evaluate(() => { window.__gsTest.router.setMode("chords"); window.__gsTest.router.setMode("lead"); });
      await setHands(page, sc.left(1), sc.preview(0.5));
      await page.waitForTimeout(300);
      if (!mobile) {
        await expect(page.locator("#modeBadge")).toHaveText("Chords+Lead");
        await page.screenshot({ path: `${SCREENS_DIR}/layer-chords-plus-lead.png` });
      } else await expect(page.locator("#gsPill .gs-pill-mode")).toHaveText("Chords+Lead");
      checkLayout(await layoutInfo(page), vp);
    });
  });
}

test("menu with the layer on: screenshot layer-menu-with-layer.png (Lead current, Arp hollow marker)", async ({ synthPage: page }) => {
  const L1 = SC.left(1);
  await setHands(page, L1, SC.open(2, 0.45));
  await page.evaluate(() => { window.__gsTest.router.setMode("arp"); window.__gsTest.router.setMode("lead"); });
  await setHands(page, L1, SC.preview(0.45));
  await page.waitForTimeout(400);
  await setHands(page, L1, SC.fistAt({ x: 0.4, y: 0.45 }));
  await expect.poll(async () => (await bus(page, "menu"))?.state).toBe("open");
  // Toward Arp (the base underneath): selected, hint "Open hand: Lead off".
  for (let i = 1; i <= 10; i++) {
    await setHands(page, L1, SC.fistAt({ x: 0.4 + 0.014 * i, y: 0.45 }));
    await page.waitForTimeout(35);
  }
  await expect.poll(async () => (await bus(page, "menu"))?.selectedId).toBe("arp");
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SCREENS_DIR}/layer-menu-with-layer.png` });
  await setHands(page, L1, SC.fistAt({ x: 0.4, y: 0.45 }));
  await page.waitForTimeout(200);
  await setHands(page, L1, SC.preview(0.45));
  await expect.poll(async () => (await bus(page, "menu")) ?? null).toBe(null);
  expect(await state(page)).toEqual({ mode: "arp", layer: "lead", right: "lead" });
});

// =====================================================================================================
// Video with sound: Arp -> Lead -> back
// =====================================================================================================

test("video test-results/videos/lead-layer.webm (with sound): Arp -> Lead on top -> back to Arp", async ({ synthPage: page, browser }) => {
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
  const Y = 0.32;
  const L1 = SC.left(1);
  await setHands(page, L1, SC.open(2, Y));
  await page.waitForTimeout(800);
  await menuPick(page, { left: L1, from: { x: SC.R.x, y: Y }, dir: "right", expectSel: "arp", open: (p) => SC.open(2, Y, { x: p.x }), want: { mode: "arp", layer: null } });
  await page.waitForTimeout(1500);
  await menuPick(page, { left: L1, from: { x: SC.R.x, y: Y }, dir: "left", expectSel: "lead", open: (p) => SC.preview(Y, { x: p.x }), want: { mode: "arp", layer: "lead" } });
  await page.waitForTimeout(500);
  for (const [i, chord, ms] of [[4, 1, 400], [5, 1, 400], [6, 1, 600], [6, 4, 400], [5, 4, 400], [4, 4, 700], [3, 5, 400], [4, 5, 700]]) {
    const { y } = await leadY(page, i);
    await setHands(page, SC.left(chord), SC.preview(y));
    await page.waitForTimeout(110);
    await setHands(page, SC.left(chord), SC.play(y));
    await page.waitForTimeout(ms);
  }
  await setHands(page, SC.left(1), SC.preview(Y));
  await page.waitForTimeout(500);
  await menuPick(page, { left: SC.left(1), from: { x: SC.R.x, y: Y }, dir: "right", expectSel: "arp", open: (p) => SC.open(2, Y, { x: p.x }), want: { mode: "arp", layer: null } });
  await page.waitForTimeout(1500);
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
  const out = "test-results/videos/lead-layer.webm";
  const res = await rec.save(browser, out, { layout: ["app"], cellW: 1280, cellH: 800, audio: snd });
  expect(res.frames[0]).toBeGreaterThan(60);
  expect(fs.statSync(out).size).toBeGreaterThan(100_000);
});
