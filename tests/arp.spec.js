// Arp engine (milestone 1.1), proven on recorded audio from labs/arp-lab.html.
// Timing is checked three ways: onset-to-onset intervals, drift against an ideal grid over 10 s (1/8; 4 s at 1/16),
// and each onset against the play time the clock scheduled (via onStep), after fitting the constant
// capture offset.
import fs from "node:fs";
import { test, expect, SCREENS_DIR } from "./fixtures.js";
import { writeWav, et, retryOnCaptureGlitch } from "./helpers/audio.js";
import {
  startRecording, stopRecording, detectOnsets, noteLengths, pitchAt, pitchesAt, hzToMidi,
  peakAbs, clickStats, matchToSchedule, stats,
} from "./helpers/arp-analysis.js";

const WAV_DIR = "test-results/audio";
const TOL = 0.003; // ±3 ms
const A3 = 57;
// Expected notes from music theory, independent of the app code.
const A_MAJOR_V1 = [A3, A3 + 7, A3 + 12, A3 + 16]; // A3 E4 A4 C#5
const D_MAJOR_V1 = [62, 69, 74, 78]; // IV in A: D4 A4 D5 F#5

// The audio tests in this file measure timing; run them one after another (not alongside each other).
test.describe.configure({ mode: "default" });

async function openLab(page, settings = {}) {
  await page.goto("/labs/arp-lab.html");
  await page.waitForFunction(() => window.__lab);
  await page.evaluate((s) => {
    const lab = window.__lab;
    if (s.chord) lab.pick(s.chord);
    lab.arp.set(s);
    lab.start();
  }, settings);
  await page.waitForTimeout(250); // first step + steady state
}

async function record(page, ms) {
  const recStart = await startRecording(page);
  await page.waitForTimeout(ms);
  const rec = await stopRecording(page);
  const lab = await page.evaluate(() => ({
    steps: window.__lab.arp.steps.map((s) => ({ step: s.step, pos: s.pos, time: s.time, midi: s.midi, beat: s.beat, beats: s.beats })),
    stepLog: window.__lab.stepLog,
  }));
  return { ...rec, recStart, ...lab };
}

const midiOf = (samples, sr, t, size = 8192) => Math.round(hzToMidi(pitchAt(samples, sr, t + 0.004, size)));

function checkClean(samples, sampleRate, onsets, label) {
  // No clipping, with headroom for the shared master chain.
  expect(peakAbs(samples), `${label}: output peak`).toBeLessThan(0.5);
  // No clicks: the sharpest corner at note starts/ends is no sharper than inside the notes.
  const lens = noteLengths(samples, sampleRate, onsets);
  const bounds = onsets.concat(onsets.map((t, i) => t + lens[i]));
  const c = clickStats(samples, sampleRate, bounds);
  expect(c.atBoundary, `${label}: click metric at note edges vs body ${c.body}`).toBeLessThanOrEqual(c.body * 1.2);
}

// Drift (the AudioContext clock vs the scheduler) grows with run time, not with the rate, so the 10 s run at 1/8 is the
// drift check; 1/16 proves the same ±3 ms per step at the faster rate in 4 s (32 onsets). The scheduler's own math is
// checked over a 2-minute fake-clock run in arp-patterns.spec.js.
for (const { rate, label, step, secs } of [
  { rate: 1 / 8, label: "1/8", step: 0.25, secs: 10 },
  { rate: 1 / 16, label: "1/16", step: 0.125, secs: 4 },
]) {
  test(`timing: 120 BPM ${label} stays on the grid for ${secs} s (no drift, ±3 ms)`, { tag: "@full" }, async ({ page }, info) => {
    test.setTimeout(60_000);
    await retryOnCaptureGlitch(info, async ({ track }) => {
      await openLab(page, { rate, gate: 0.25 });
      const r = await record(page, secs * 1000 + 500);
      track(r); // a failure on a glitched capture is retried once (helpers/audio.js retryOnCaptureGlitch)
      const on = detectOnsets(r.samples, r.sampleRate);
      expect(on.length).toBeGreaterThanOrEqual(Math.floor(secs / step));

      // 1) Scheduled times (onStep) are an exact grid.
      const log = r.stepLog;
      for (let i = 1; i < log.length; i++) {
        expect(log[i].i).toBe(log[i - 1].i + 1);
        expect(Math.abs(log[i].time - log[i - 1].time - step)).toBeLessThan(1e-9);
      }
      // 2) Inter-onset intervals in the audio.
      const ioi = on.slice(1).map((t, i) => t - on[i] - step);
      // 3) Drift: every onset against the ideal grid from the first onset.
      const drift = on.map((t, k) => t - on[0] - k * step);
      // 4) Expected (scheduled) vs actual.
      const m = matchToSchedule(on, r.steps.map((s) => s.time), r.recStart);
      const res = { ioi: stats(ioi), drift: stats(drift), vsSchedule: stats(m.errors), captureOffsetMs: m.offset * 1000,
        capture: { blocks: r.health.blocks, samples: r.health.capturedSamples, maxCallbackLagMs: +r.health.maxCallbackLagMs.toFixed(1),
          discontinuities: r.health.discontinuities.length, lateSteps: r.lateSteps.length } };
      console.log(`[arp timing ${label}] ${on.length} onsets over ${(on.at(-1) - on[0]).toFixed(2)} s`, JSON.stringify(res));
      info.annotations.push({ type: "timing", description: JSON.stringify(res) });
      expect(res.ioi.maxAbs).toBeLessThan(TOL);
      expect(res.drift.maxAbs).toBeLessThan(TOL);
      expect(res.vsSchedule.maxAbs).toBeLessThan(TOL);
      expect(Math.abs(drift.at(-1))).toBeLessThan(0.001); // end of the run: < 1 ms
      checkClean(r.samples, r.sampleRate, on, label);
      writeWav(`${WAV_DIR}/arp-timing-${label.replace("/", "_")}.wav`, r.samples, r.sampleRate);
    });
  });
}

test("pitches: A major voicing 1, up -> A3 E4 A4 C#5 ...", async ({ page }) => {
  await openLab(page, { chord: { key: "A", degree: 1, isMajor: true }, voicing: 1, pattern: "up", octaves: 1, gate: 0.4 });
  const r = await record(page, 2600);
  const on = detectOnsets(r.samples, r.sampleRate);
  expect(on.length).toBeGreaterThanOrEqual(9);
  const m = matchToSchedule(on, r.steps.map((s) => s.time), r.recStart);
  for (const { onset, sched } of m.pairs.slice(0, -1)) {
    const step = r.steps.find((s) => s.time === sched);
    const heard = midiOf(r.samples, r.sampleRate, onset - r.recStart);
    expect(heard, `step ${step.step} (pos ${step.pos})`).toBe(A_MAJOR_V1[step.pos % 4]);
    expect(step.midi).toBe(A_MAJOR_V1[step.pos % 4]);
  }
  // The notes really are A3/E4/A4/C#5 in Hz (not just the right MIDI rounding).
  const first = on[0];
  const f = pitchAt(r.samples, r.sampleRate, first + 0.004);
  const pos0 = r.steps.find((s) => s.time === m.pairs[0].sched).pos;
  expect(Math.abs(f / et(220, [0, 7, 12, 16][pos0 % 4]) - 1)).toBeLessThan(0.01);
});

test("pitches: down / up-down / 2 octaves / minor 7th follow the pattern", { tag: "@full" }, async ({ page }) => {
  // B minor 7 (ii, voicing 3): B3 D4 F#4 A4, two octaves, up-down.
  await openLab(page, { chord: { key: "A", degree: 2, isMajor: false }, voicing: 3, pattern: "updown", octaves: 2, gate: 0.4 });
  const notes = [59, 62, 66, 69, 71, 74, 78, 81];
  const period = 2 * notes.length - 2;
  const idx = (p) => (p % period < notes.length ? p % period : period - (p % period));
  const r = await record(page, 3600);
  const on = detectOnsets(r.samples, r.sampleRate);
  const m = matchToSchedule(on, r.steps.map((s) => s.time), r.recStart);
  expect(m.pairs.length).toBeGreaterThanOrEqual(13);
  for (const { onset, sched } of m.pairs.slice(0, -1)) {
    const step = r.steps.find((s) => s.time === sched);
    expect(midiOf(r.samples, r.sampleRate, onset - r.recStart), `pos ${step.pos}`).toBe(notes[idx(step.pos)]);
  }
});

test("chord change mid-pattern lands on the next step, keeps the rhythm and the pattern position", { tag: "@full" }, async ({ page }, info) => {
  await retryOnCaptureGlitch(info, async ({ track }) => {
    await openLab(page, { chord: { key: "A", degree: 1, isMajor: true }, voicing: 1, pattern: "up", gate: 0.3 });
    const recStart = await startRecording(page);
    // Change the chord ~75% into a step: the next step (~60 ms away) is already scheduled with the old
    // chord (lookahead 100 ms), so this exercises re-binding scheduled-but-not-sounding steps.
    const change = await page.evaluate(async () => {
      const { ctx } = window.__lab;
      window.__cancels = [];
      ctx.bus.subscribe({ onEvent: (name, d, t) => name === "note/cancel" && window.__cancels.push(t) });
      await new Promise((res) => setTimeout(res, 1100));
      const ac = ctx.audio.ac;
      for (;;) {
        const frac = (ctx.clock.beatAt(ac.currentTime) * 2) % 1; // position inside a 1/8 step
        if (frac > 0.7 && frac < 0.8) break;
        await new Promise((res) => setTimeout(res, 1));
      }
      const t = ac.currentTime;
      window.__lab.pick({ degree: 4 });
      return { t, cancels: window.__cancels };
    }).then((r) => {
      expect(r.cancels.length, "an already-scheduled step was re-bound").toBe(1);
      return r.t;
    });
    await page.waitForTimeout(1300);
    const rec = await stopRecording(page);
    track(rec); // a failure on a glitched capture is retried once (helpers/audio.js retryOnCaptureGlitch)
    const steps = await page.evaluate(() => window.__lab.arp.steps.map((s) => ({ step: s.step, pos: s.pos, time: s.time, midi: s.midi })));
    const on = detectOnsets(rec.samples, rec.sampleRate);
    const m = matchToSchedule(on, steps.map((s) => s.time), recStart);

    // Rhythm: one onset per step, no gap, no extra onset (all intervals one step ±3 ms).
    for (let i = 1; i < on.length; i++) expect(Math.abs(on[i] - on[i - 1] - 0.25)).toBeLessThan(TOL);
    // The first step after the change already plays the new chord, at the continuing pattern position.
    const firstNew = steps.find((s) => s.time > change);
    expect(firstNew.time - change).toBeLessThan(0.25);
    for (const { onset, sched } of m.pairs.slice(0, -1)) {
      const s = steps.find((x) => x.time === sched);
      const expected = (s.time < firstNew.time ? A_MAJOR_V1 : D_MAJOR_V1)[s.pos % 4];
      expect(midiOf(rec.samples, rec.sampleRate, onset - recStart, 4096), `step ${s.step} pos ${s.pos}`).toBe(expected);
    }
    // Pattern position is continuous across the change.
    const around = steps.filter((s) => Math.abs(s.time - firstNew.time) < 0.6);
    for (let i = 1; i < around.length; i++) expect(around[i].pos).toBe(around[i - 1].pos + 1);
  });
});

test("gate: low = short plucked notes, high = long overlapping notes", { tag: "@full" }, async ({ page }) => {
  await openLab(page, { gate: 0.05, rate: 1 / 8 });
  const low = await record(page, 2000);
  const lowOn = detectOnsets(low.samples, low.sampleRate);
  const lens = noteLengths(low.samples, low.sampleRate, lowOn).slice(0, -1);
  const maxLen = Math.max(...lens);
  console.log(`[arp gate] low gate note length ${(Math.min(...lens) * 1000).toFixed(1)}-${(maxLen * 1000).toFixed(1)} ms (step 250 ms)`);
  expect(maxLen).toBeLessThan(0.1); // short: < 40% of the 250 ms step, incl. release
  expect(lowOn.length).toBeGreaterThanOrEqual(7);

  await page.evaluate(() => window.__lab.arp.set({ gate: 1 }));
  await page.waitForTimeout(700);
  const high = await record(page, 2000);
  // Never silent: notes overlap.
  expect(detectOnsets(high.samples, high.sampleRate).length).toBeLessThanOrEqual(1);
  const sr = high.sampleRate;
  const frame = Math.round(0.005 * sr);
  let minRms = Infinity;
  for (let i = 0; i + frame < high.samples.length; i += frame) {
    let s = 0;
    for (let j = i; j < i + frame; j++) s += high.samples[j] ** 2;
    minRms = Math.min(minRms, Math.sqrt(s / frame));
  }
  expect(minRms).toBeGreaterThan(0.01);
  // Two chord notes sound at once right after a step starts.
  const steps = high.steps.filter((s) => s.time > high.recStart + 0.2 && s.time < high.acEnd - 0.2);
  let overlapping = 0;
  for (const s of steps) {
    const found = pitchesAt(high.samples, sr, s.time - high.recStart + 0.02, 4096, 0.3).map((f) => Math.round(hzToMidi(f)));
    if (A_MAJOR_V1.filter((n) => found.includes(n)).length >= 2) overlapping++;
  }
  expect(overlapping / steps.length).toBeGreaterThan(0.8);
  expect(peakAbs(high.samples), "overlapping notes keep headroom").toBeLessThan(0.6);
});

test("double time: the rate doubles exactly at the next beat", { tag: "@full" }, async ({ page }, info) => {
  await retryOnCaptureGlitch(info, async ({ track }) => {
    await openLab(page, { rate: 1 / 8, gate: 0.2 });
    const recStart = await startRecording(page);
    const req = await page.evaluate(async () => {
      const { ctx, arp } = window.__lab;
      const ac = ctx.audio.ac;
      await new Promise((res) => setTimeout(res, 900));
      for (;;) {
        const f = ctx.clock.beatAt(ac.currentTime) % 1;
        if (f > 0.85 && f < 0.95) break; // 25-75 ms before the beat: its step is already scheduled
        await new Promise((res) => setTimeout(res, 1));
      }
      const t = ac.currentTime;
      const beat = ctx.clock.beatAt(t);
      arp.set({ doubleTime: true });
      return { t, beat, nextBeat: Math.ceil(beat), nextBeatTime: ctx.clock.nextBeatTime() };
    });
    await page.waitForTimeout(1600);
    const rec = await stopRecording(page);
    track(rec); // a failure on a glitched capture is retried once (helpers/audio.js retryOnCaptureGlitch)
    const log = await page.evaluate(() => window.__lab.stepLog);
    // Clock: 0.5-beat steps up to the boundary, 0.25-beat steps from the boundary on.
    const boundary = log.find((s) => s.beat === req.nextBeat);
    expect(boundary, "a step on the next beat").toBeTruthy();
    expect(Math.abs(boundary.time - req.nextBeatTime)).toBeLessThan(1e-9);
    // Step lengths from consecutive play times (the beat step's emitted `stepBeats` predates the change:
    // its start was already scheduled, only its length changed).
    for (let i = 1; i < log.length; i++) {
      const prev = log[i - 1];
      const want = prev.beat < req.nextBeat ? 0.5 : 0.25;
      expect(log[i].beat - prev.beat, `step at beat ${prev.beat}`).toBe(want);
      expect(Math.abs(log[i].time - prev.time - want * 0.5)).toBeLessThan(1e-9);
    }
    // Audio: intervals 250 ms before the boundary, 125 ms from it.
    const on = detectOnsets(rec.samples, rec.sampleRate);
    const m = matchToSchedule(on, log.map((s) => s.time), recStart);
    const bOnset = m.pairs.find((p) => p.sched === boundary.time);
    expect(bOnset, "an onset at the beat boundary").toBeTruthy();
    const b = bOnset.onset - recStart;
    for (let i = 1; i < on.length; i++) {
      const want = on[i] <= b + 1e-4 ? 0.25 : 0.125;
      expect(Math.abs(on[i] - on[i - 1] - want), `interval ending at ${on[i].toFixed(3)} (boundary ${b.toFixed(3)})`).toBeLessThan(TOL);
    }
    expect(Math.max(...m.errors.map(Math.abs))).toBeLessThan(TOL);
  });
});

test("tempo change: no lost or doubled step", { tag: "@full" }, async ({ page }, info) => {
  await retryOnCaptureGlitch(info, async ({ track }) => {
    await openLab(page, { rate: 1 / 8, gate: 0.2 });
    const recStart = await startRecording(page);
    const change = await page.evaluate(async () => {
      await new Promise((res) => setTimeout(res, 1030));
      const t = window.__lab.ctx.audio.ac.currentTime;
      window.__lab.arp.set({ bpm: 100 });
      return t;
    });
    await page.waitForTimeout(1500);
    const rec = await stopRecording(page);
    track(rec); // a failure on a glitched capture is retried once (helpers/audio.js retryOnCaptureGlitch)
    const log = await page.evaluate(() => window.__lab.stepLog);
    // Clock: contiguous indices and beats; intervals are 0.25 s (120) then 0.3 s (100), nothing else.
    for (let i = 1; i < log.length; i++) {
      expect(log[i].i).toBe(log[i - 1].i + 1);
      expect(log[i].beat).toBe(log[i - 1].beat + 0.5);
      const d = log[i].time - log[i - 1].time;
      expect(Math.min(Math.abs(d - 0.25), Math.abs(d - 0.3))).toBeLessThan(1e-9);
      if (log[i - 1].time > change + 0.11) expect(d).toBeCloseTo(0.3, 9);
    }
    // Audio: exactly one onset per scheduled step in the window, all on time.
    const on = detectOnsets(rec.samples, rec.sampleRate);
    const m = matchToSchedule(on, log.map((s) => s.time), recStart);
    const inWindow = log.filter((s) => s.time >= m.pairs[0].sched && s.time <= m.pairs.at(-1).sched);
    const dbg = `onsets ${on.map((t) => (t + recStart).toFixed(4))} | steps ${inWindow.map((s) => s.time.toFixed(4))} | change ${change.toFixed(4)}`;
    expect(on.length, dbg).toBe(inWindow.length);
    expect(new Set(m.pairs.map((p) => p.sched)).size).toBe(on.length);
    expect(Math.max(...m.errors.map(Math.abs))).toBeLessThan(TOL);
    const ioi = on.slice(1).map((t, i) => t - on[i]);
    expect(ioi.some((d) => Math.abs(d - 0.3) < TOL)).toBe(true);
    for (const d of ioi) expect(Math.min(Math.abs(d - 0.25), Math.abs(d - 0.3))).toBeLessThan(TOL);
  });
});

test("left fist: the arp rests while the clock keeps counting, then resumes in phase", { tag: "@full" }, async ({ page }, info) => {
  await retryOnCaptureGlitch(info, async ({ track }) => {
    await openLab(page, { chord: { key: "A", degree: 1, isMajor: true }, voicing: 1, pattern: "up", rate: 1 / 8, gate: 0.25 });
    const recStart = await startRecording(page);
    const marks = await page.evaluate(async () => {
      const lab = window.__lab;
      const ac = lab.ctx.audio.ac;
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      await sleep(700);
      const restAt = ac.currentTime;
      lab.pick({ rest: true });
      await sleep(1100);
      const resumeAt = ac.currentTime;
      lab.pick({ rest: false });
      return { restAt, resumeAt };
    });
    await page.waitForTimeout(900);
    const rec = await stopRecording(page);
    track(rec); // a failure on a glitched capture is retried once (helpers/audio.js retryOnCaptureGlitch)
    const steps = await page.evaluate(() => window.__lab.arp.steps.map((s) => ({ step: s.step, pos: s.pos, time: s.time, midi: s.midi })));
    const log = await page.evaluate(() => window.__lab.stepLog);

    // Clock kept counting at a steady rate through the rest.
    for (let i = 1; i < log.length; i++) expect(Math.abs(log[i].time - log[i - 1].time - 0.25)).toBeLessThan(1e-9);
    const rests = steps.filter((s) => s.midi == null);
    expect(rests.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < steps.length; i++) expect(steps[i].pos).toBe(steps[i - 1].pos + 1);

    // Audio: silence during the rest (after the note that was sounding has ended).
    const sr = rec.sampleRate;
    const quietFrom = rests[0].time - recStart;
    const quietTo = rests.at(-1).time + 0.25 - recStart;
    let quietPeak = 0;
    for (let i = Math.round(quietFrom * sr); i < Math.round(quietTo * sr); i++) quietPeak = Math.max(quietPeak, Math.abs(rec.samples[i]));
    expect(quietPeak).toBeLessThan(0.002);

    // Resumes in phase: every onset (before and after) is on the same grid, and the first note after
    // the rest plays the pattern note of its step position (as if it had never stopped).
    const on = detectOnsets(rec.samples, sr);
    for (const t of on) {
      const k = (t - on[0]) / 0.25;
      expect(Math.abs(k - Math.round(k)) * 0.25).toBeLessThan(TOL);
    }
    const m = matchToSchedule(on, steps.filter((s) => s.midi != null).map((s) => s.time), recStart);
    const firstBack = steps.find((s) => s.time > marks.resumeAt && s.midi != null);
    const pair = m.pairs.find((p) => p.sched === firstBack.time);
    expect(pair).toBeTruthy();
    expect(midiOf(rec.samples, sr, pair.onset - recStart, 4096)).toBe(A_MAJOR_V1[firstBack.pos % 4]);
    expect(firstBack.pos).toBe(firstBack.step); // pattern position == clock step: no restart, no skip
  });
});

test("bus: notes are published ~100 ms before they play, with their play time", async ({ page }) => {
  await page.goto("/labs/arp-lab.html");
  await page.waitForFunction(() => window.__lab);
  const ev = await page.evaluate(async () => {
    const { ctx, start } = window.__lab;
    const ac = ctx.audio.ac;
    const out = [];
    ctx.bus.subscribe({ onEvent: (name, data, playTime) => out.push({ name, data, lead: playTime - ac.currentTime }) });
    start();
    await new Promise((res) => setTimeout(res, 1500));
    return out;
  });
  const ons = ev.filter((e) => e.name === "note/on");
  const beats = ev.filter((e) => e.name === "beat");
  expect(ons.length).toBeGreaterThanOrEqual(5);
  expect(beats.length).toBeGreaterThanOrEqual(2);
  expect(ons.every((e) => e.data.voice === "arp" && Number.isInteger(e.data.midi))).toBe(true);
  for (const e of [...ons, ...beats]) {
    expect(e.lead).toBeGreaterThan(0); // always ahead of the sound
    expect(e.lead).toBeLessThanOrEqual(0.101 + 0.03); // lookahead + one wakeup of slack
  }
});

test("mode plugin: contract fields and right-hand mapping", async ({ page }) => {
  await page.goto("/labs/arp-lab.html");
  await page.waitForFunction(() => window.__lab);
  const r = await page.evaluate(async () => {
    const { ctx } = window.__lab;
    const mod = await import("/src/modes/arp.js");
    const arp = mod.default;
    const fields = { id: arp.id, name: arp.name, direction: arp.direction, color: arp.color, signals: arp.signals.map((s) => s.name) };
    arp.enter(ctx);
    const right = (o) => ({ handedness: "Right", fingers: { thumb: false, index: true, middle: true, ring: false, pinky: false },
      voicingCount: 2, fist: false, pinch: false, height: 0.8, tilt: 1, ...o });
    arp.update(right({ t: 880 }), ctx);
    arp.update(right({ t: 1000 }), ctx); // voicing 2 stable for the hold
    const a = { ...arp.state };
    // A new finger count applies once it was stable for the voicing hold (100 ms, src/modes/arp.js VOICING_HOLD).
    arp.update(right({ t: 1050, fingers: { thumb: true }, voicingCount: 3, height: 0.1 }), ctx);
    const b0 = { ...arp.state };
    arp.update(right({ t: 1160, fingers: { thumb: true }, voicingCount: 3, height: 0.1 }), ctx);
    const b = { ...arp.state };
    arp.update(null, ctx); // hand gone: last values stay
    const c = { ...arp.state };
    arp.update(right({ t: 1200, pinch: true, voicingCount: 1, height: 0.9 }), ctx); // pinch holds gate + voicing
    const d = { ...arp.state };
    await new Promise((res) => setTimeout(res, 300));
    const cutoff = ctx.audio.filter.frequency.value;
    const gateOnBus = ctx.bus.get("arp/gate");
    arp.exit();
    ctx.clock.stop();
    return { fields, a, b0, b, c, d, cutoff, gateOnBus };
  });
  expect(r.fields).toMatchObject({ id: "arp", name: "Arp", direction: "right" });
  expect(r.fields.color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(r.fields.signals).toContain("arp/gate");
  expect(r.a).toMatchObject({ voicing: 2, gate: 0.8, doubleTime: false });
  expect(r.b0).toMatchObject({ voicing: 2, gate: 0.1 }); // count not stable yet
  expect(r.b).toMatchObject({ voicing: 3, gate: 0.1, doubleTime: true });
  expect(r.c).toMatchObject({ voicing: 3, gate: 0.1, doubleTime: true });
  expect(r.d).toMatchObject({ voicing: 3, gate: 0.1 });
  expect(r.cutoff).toBeGreaterThan(4500); // tilt 1 -> filter open (same curve as Chords)
  expect(r.gateOnBus).toBe(0.1);
});

test("screen controls drive the arp; lab screenshot", async ({ page }) => {
  await page.goto("/labs/arp-lab.html");
  await page.waitForFunction(() => window.__lab);
  const state = () => page.evaluate(() => window.__lab.arp.state);
  await page.getByRole("button", { name: "Start" }).click();
  await page.locator('[data-control="bpm-up"]').click();
  await page.locator('[data-control="bpm-up"]').click();
  await page.locator('[data-control="bpm-down"]').click();
  await expect(page.locator('[data-control="bpm"]')).toHaveText("121");
  await page.getByRole("radio", { name: "1/16" }).click();
  await page.getByRole("radio", { name: "Up-down" }).click();
  await page.locator('[data-control="octaves"]').getByRole("radio", { name: "2" }).click();
  await page.locator('[data-control="gate"]').fill("0.7");
  await page.locator('[data-control="double"]').click();
  expect(await state()).toMatchObject({ bpm: 121, rate: 1 / 16, pattern: "updown", octaves: 2, gate: 0.7, doubleTime: true });
  await expect(page.getByRole("radio", { name: "Up-down" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-control="double"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-control="double"]').click();
  await page.getByRole("radio", { name: "1/8" }).click();
  await page.locator('[data-control="gate"]').fill("0.4");
  await page.locator('#degrees button[data-degree="6"]').click();
  await page.locator("#minor").click();
  await page.waitForTimeout(1200);
  expect(await state()).toMatchObject({ rate: 1 / 8, doubleTime: false });
  await expect(page.locator("#chordName")).toHaveText("F#m");
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  await page.screenshot({ path: `${SCREENS_DIR}/arp-lab.png`, fullPage: true });
  await page.getByRole("button", { name: "Stop" }).click();
  expect(await page.evaluate(() => window.__lab.ctx.clock.running)).toBe(false);
});

test("demo: 4 bars (I - V - vi - IV) saved as WAV", { tag: "@media" }, async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto("/labs/arp-lab.html");
  await page.waitForFunction(() => window.__lab);
  const recStart = await startRecording(page);
  await page.evaluate(async () => {
    const lab = window.__lab;
    const { clock } = lab.ctx;
    lab.pick({ key: "A", degree: 1, isMajor: true });
    lab.arp.set({ pattern: "updown", octaves: 2, gate: 0.45, voicing: 1, rate: 1 / 8 });
    lab.start();
    const t0 = clock.timeAtBeat(0);
    const bars = [
      { degree: 1, isMajor: true, voicing: 1 },
      { degree: 5, isMajor: true, voicing: 4 },
      { degree: 6, isMajor: false, voicing: 3 },
      { degree: 4, isMajor: true, voicing: 3 },
    ];
    const ac = lab.ctx.audio.ac;
    for (let bar = 1; bar < 4; bar++) {
      // Change just before the downbeat of each bar (like a player would), on the audio clock.
      const at = t0 + (bar * 4 * 60) / clock.bpm - 0.03;
      while (ac.currentTime < at) await new Promise((res) => setTimeout(res, 4));
      lab.pick(bars[bar]);
      lab.arp.set({ voicing: bars[bar].voicing, rate: bar === 3 ? 1 / 16 : 1 / 8 });
    }
    const end = t0 + (16 * 60) / clock.bpm + 0.4;
    while (ac.currentTime < end) await new Promise((res) => setTimeout(res, 10));
    lab.stop();
  });
  const rec = await stopRecording(page);
  writeWav(`${WAV_DIR}/arp-demo.wav`, rec.samples, rec.sampleRate);
  expect(fs.existsSync(`${WAV_DIR}/arp-demo.wav`)).toBe(true);
  expect(rec.samples.length / rec.sampleRate).toBeGreaterThan(8);
  expect(peakAbs(rec.samples)).toBeLessThan(0.6);
  void recStart;
});
