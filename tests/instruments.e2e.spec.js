// Instrument plugins on the real engine and voices (src/instruments, src/services/audio.js, arp-voice.js,
// lead-voice.js), rendered offline in the app page (deterministic, no capture glitches) and tapped at the limiter
// input. Gesture / UI side: sound-menu.e2e.spec.js.
//   - loudness: every instrument within ±2 dB (RMS) of the median, per voice (Chords, Arp, Lead)
//   - gain staging: steady play at max settings stays >= 1 dB under the limiter threshold, every instrument, every voice
//     (Electric also with Drive at 1)
//   - pitch: fundamental within ±3 cents for every instrument (Karplus-Strong included), Lead and Arp
//   - timbre: the six harmonic profiles differ; organ has its 16' sub-octave; Electric is far richer than a clean string
//   - Electric: sustain on a held Lead note, decay envelope of a strummed chord, strum order
//   - switching instrument mid-chord / mid-note: no gap, no click
//   - demo WAVs: test-results/audio/instrument-<name>-<mode>.wav
import { test, expect } from "./fixtures.js";
import { writeWav } from "./helpers/audio.js";
import { renderVoice, decodeSamples, finePeak, dftMag, hann, cents, dB } from "./helpers/instrument-render.js";

const IDS = ["warm", "bright", "retro", "organ", "electric", "sax"];
const WAV_DIR = "test-results/audio";
const C4 = 261.63, E4 = 329.63, G4 = 392.0;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

test.describe.configure({ mode: "default" });

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockHands");
  await page.waitForFunction(() => !!window.__gsTest);
});

test("loudness: every instrument within ±2 dB of the median (RMS), in Chords, Arp and Lead", async ({ page }) => {
  test.setTimeout(120_000);
  const table = {};
  for (const voice of ["chords", "arp", "lead"]) {
    const lv = {};
    for (const inst of IDS) {
      const r = await renderVoice(page, { inst, voice, freqs: voice === "lead" ? [440] : [C4, E4, G4], dur: 1.3, windows: [[0.1, 1.1]] });
      lv[inst] = dB(r.windows[0].rms);
    }
    const m = median(Object.values(lv));
    table[voice] = Object.fromEntries(Object.entries(lv).map(([k, v]) => [k, +(v - m).toFixed(2)]));
    console.log(`[instruments] ${voice}: median ${m.toFixed(1)} dBFS, offsets ${JSON.stringify(table[voice])}`);
    for (const [inst, d] of Object.entries(table[voice])) expect(Math.abs(d), `${voice} ${inst} ${d} dB`).toBeLessThanOrEqual(2);
  }
});

test("gain staging: steady play at max settings stays >= 1 dB under the limiter threshold (every instrument and voice)", async ({ page }) => {
  test.setTimeout(180_000);
  const { threshold } = await page.evaluate(async () => (await import("/src/services/audio.js")).LIMITER);
  // close / octave-heavy voicings at filter fully open (tilt 1), master 1
  const chords = await page.evaluate(async () => {
    const { createHarmony } = await import("/src/services/harmony.js");
    const out = [];
    for (const t of [220, 293.66, 392]) {
      const h = createHarmony({ tonicFreq: t });
      for (const [r, maj, v] of [["VI", false, 4], ["IV", true, 3], ["V", true, 4], ["I", true, 1], ["VII", false, 4]]) out.push(h.notes(r, maj, v, false));
    }
    return out;
  });
  let worst = { peak: 0 };
  for (const inst of IDS) {
    const peaks = [];
    for (const fs of chords) {
      const r = await renderVoice(page, { inst, voice: "chords", freqs: fs, dur: 1.0, tilt: 1, windows: [[0.3, 1.0]] });
      peaks.push(r.windows[0].peak);
    }
    const arp = await renderVoice(page, { inst, voice: "arp", freqs: chords[1], dur: 1.6, tilt: 1, gate: 1, arpStep: 0.0625, windows: [[0.3, 1.3]] });
    const lead = await renderVoice(page, { inst, voice: "lead", freqs: [midi(76)], dur: 1.0, tilt: 1, windows: [[0.3, 1.0]] });
    const p = { chords: Math.max(...peaks), arp: arp.windows[0].peak, lead: lead.windows[0].peak };
    console.log(`[instruments] ${inst} max-setting peaks at the limiter input: chords ${dB(p.chords).toFixed(1)}, arp ${dB(p.arp).toFixed(1)}, lead ${dB(p.lead).toFixed(1)} dBFS`);
    for (const [v, pk] of Object.entries(p)) {
      if (pk > worst.peak) worst = { peak: pk, at: `${inst} ${v}` };
      expect(dB(pk), `${inst} ${v}`).toBeLessThan(threshold - 1);
    }
  }
  // Electric with Drive at 1 (right hand sideways) on top: still level-compensated
  const dr = await renderVoice(page, { inst: "electric", voice: "chords", freqs: chords[0], dur: 1.0, tilt: 1, drive: 1, windows: [[0.3, 1.0]] });
  console.log(`[instruments] electric + drive 1: ${dB(dr.windows[0].peak).toFixed(1)} dBFS; worst overall ${dB(worst.peak).toFixed(1)} (${worst.at})`);
  expect(dB(dr.windows[0].peak)).toBeLessThan(threshold - 1);
});

test("pitch: every instrument's fundamental within ±3 cents (Lead notes, Arp notes; Karplus-Strong included)", async ({ page }) => {
  test.setTimeout(180_000);
  for (const inst of IDS) {
    const errs = [];
    for (const f of [midi(57), midi(64), midi(69), midi(76), midi(83)]) {
      // 0.05..0.3 s: before the sax's delayed vibrato (a few cycles of it in a window bias the estimate)
      const r = await renderVoice(page, { inst, voice: "lead", freqs: [f], dur: 0.6, keep: true });
      const x = decodeSamples(r).subarray(Math.round(0.05 * 48000), Math.round(0.3 * 48000));
      const pk = finePeak(x, 48000, f);
      errs.push(cents(pk.f, f));
      // the fundamental is really there (not only harmonics): within 20 dB of the strongest of the first 8 partials
      const w = hann(x);
      const mags = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => dftMag(w, 48000, f * k));
      expect(dB(mags[0] / Math.max(...mags)), `${inst} ${f.toFixed(1)} Hz fundamental level`).toBeGreaterThan(-20);
    }
    const a = await renderVoice(page, { inst, voice: "arp", freqs: [midi(67)], dur: 1.2, arpStep: 0.5, gate: 0.95, keep: true });
    const xa = decodeSamples(a).subarray(Math.round(0.05 * 48000), Math.round(0.45 * 48000));
    errs.push(cents(finePeak(xa, 48000, midi(67)).f, midi(67)));
    console.log(`[instruments] ${inst} pitch error (cents): ${errs.map((e) => e.toFixed(2)).join(", ")}`);
    for (const e of errs) expect(Math.abs(e), inst).toBeLessThan(3);
  }
});

/** Harmonic profile (dB re the fundamental) of the first n partials. */
function profile(x, sr, f, n = 10) {
  const w = hann(x);
  const m1 = dftMag(w, sr, f);
  return Array.from({ length: n }, (_, k) => dB(dftMag(w, sr, f * (k + 1)) / m1));
}

test("timbre: six distinct harmonic profiles; organ's 16' sub-octave; Electric far richer than a clean string", async ({ page }) => {
  test.setTimeout(120_000);
  const f = midi(57); // A3
  const prof = {};
  for (const inst of IDS) {
    const r = await renderVoice(page, { inst, voice: "lead", freqs: [f], dur: 1.2, keep: true });
    const x = decodeSamples(r).subarray(Math.round(0.2 * 48000), Math.round(1.0 * 48000));
    prof[inst] = profile(x, 48000, f);
    if (inst === "organ") {
      const sub = dB(dftMag(hann(x), 48000, f / 2) / dftMag(hann(x), 48000, f));
      console.log(`[instruments] organ 16' (f/2) re 8': ${sub.toFixed(1)} dB`);
      expect(sub).toBeGreaterThan(-20);
    }
  }
  for (const inst of IDS) console.log(`[instruments] ${inst} partials 2..10 re f: ${prof[inst].slice(1).map((v) => v.toFixed(0)).join(" ")}`);
  // triangle: odd harmonics only (2nd far down); sawtooth & square: 2nd strong / absent respectively
  expect(prof.warm[1]).toBeLessThan(-30);
  expect(prof.bright[1]).toBeGreaterThan(-12);
  expect(prof.retro[1]).toBeLessThan(-30);
  expect(prof.retro[2]).toBeGreaterThan(-16); // square: 3rd at -9.5 dB (filtered a bit)
  // every pair differs clearly (RMS distance of the profiles, clamped at -60 dB)
  const clamp = (v) => Math.max(-60, v);
  for (let i = 0; i < IDS.length; i++)
    for (let j = i + 1; j < IDS.length; j++) {
      const a = prof[IDS[i]], b = prof[IDS[j]];
      const d = Math.sqrt(a.reduce((s, v, k) => s + (clamp(v) - clamp(b[k])) ** 2, 0) / a.length);
      expect(d, `${IDS[i]} vs ${IDS[j]} profile distance ${d.toFixed(1)} dB`).toBeGreaterThan(4);
    }
  // Electric vs the same string with no amp: much more harmonic energy (overdrive)
  // ... measured once the pick's own brightness has died away (0.8..1.4 s, partials 5..16): the clean string's loop
  // low-pass has taken its upper partials down by then; the overdriven one keeps making them (same string, same cab)
  const clean = await renderVoice(page, { inst: "electric", voice: "ks-clean", freqs: [f], dur: 2.3, keep: true });
  const elec = await renderVoice(page, { inst: "electric", voice: "source", freqs: [f], dur: 2.3, keep: true });
  const late = (r) => decodeSamples(r).subarray(Math.round(0.8 * 48000), Math.round(1.4 * 48000));
  const upper = (x) => 10 * Math.log10(profile(x, 48000, f, 16).slice(4).reduce((s, v) => s + 10 ** (v / 10), 0)); // re f, dB
  const hc = upper(late(clean));
  const he = upper(late(elec));
  console.log(`[instruments] partials 5..16 re f at 0.8-1.4 s: electric ${he.toFixed(1)} dB, clean string ${hc.toFixed(1)} dB`);
  expect(he - hc).toBeGreaterThan(6); // measured ~8 dB (4x+ the upper-partial energy)
});

test("Electric: a held Lead note sustains far longer than a clean string; a strummed chord rings out and decays smoothly", async ({ page }) => {
  test.setTimeout(120_000);
  const f = midi(64);
  const W = [[0.05, 0.25], [1.0, 1.2], [2.0, 2.2]];
  const el = await renderVoice(page, { inst: "electric", voice: "lead", freqs: [f], dur: 2.4, windows: W });
  const cl = await renderVoice(page, { inst: "electric", voice: "ks-clean", freqs: [f], dur: 2.4, windows: W, t60: 8 });
  const drop = (r, i) => dB(r.windows[i].rms / r.windows[0].rms);
  console.log(`[instruments] sustain at 1 s / 2 s: electric ${drop(el, 1).toFixed(1)} / ${drop(el, 2).toFixed(1)} dB, clean string ${drop(cl, 1).toFixed(1)} / ${drop(cl, 2).toFixed(1)} dB`);
  expect(drop(el, 1)).toBeGreaterThan(drop(cl, 1) + 5);
  expect(drop(el, 1)).toBeGreaterThan(-6); // still singing after a second
  // strummed chord: 100 ms windows over 3 s
  const wins = Array.from({ length: 30 }, (_, i) => [i * 0.1, i * 0.1 + 0.1]);
  const ch = await renderVoice(page, { inst: "electric", voice: "chords", freqs: [C4, E4, G4], dur: 3.0, windows: wins });
  const env = ch.windows.map((w) => dB(w.rms));
  console.log(`[instruments] electric chord envelope (dB, 100 ms): ${env.map((v) => v.toFixed(0)).join(" ")}`);
  // it decays like a ringing string (T60 3.5 s; the clipper holds the first ~0.5 s up): 15..45 dB from 0.5 s to 2.5 s
  expect(env[25] - env[5]).toBeLessThan(-15);
  expect(env[25] - env[5]).toBeGreaterThan(-45);
  for (let i = 3; i < 30; i++) expect(env[i], `no swell at ${i * 100} ms`).toBeLessThan(env[i - 1] + 1.5);
  // strum: the notes start ~9 ms apart, low to high
  const strum = await renderVoice(page, { inst: "electric", voice: "chords", freqs: [G4, C4, E4], dur: 0.2, keep: true });
  const x = decodeSamples(strum);
  const onset = (t0) => {
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > t0) return i / 48;
    return null;
  };
  expect(onset(1e-4)).toBeLessThan(6);
});

/** Max |2nd difference| in [a, b] s. */
function d2(x, sr, a, b) {
  let m = 0;
  for (let i = Math.max(2, Math.round(a * sr)); i < Math.min(x.length, Math.round(b * sr)); i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
  return m;
}
/** Min RMS of 10 ms windows in [a, b] s. */
function minRms(x, sr, a, b) {
  let m = Infinity;
  for (let t = a; t < b - 0.01; t += 0.005) {
    let s = 0;
    const i0 = Math.round(t * sr), n = Math.round(0.01 * sr);
    for (let i = i0; i < i0 + n; i++) s += x[i] * x[i];
    m = Math.min(m, Math.sqrt(s / n));
  }
  return m;
}

test("switching instrument mid-chord (Chords) and mid-note (Lead): no gap, no click", async ({ page }) => {
  test.setTimeout(180_000);
  const sr = 48000;
  const T = 0.8;
  const pairs = [["warm", "bright"], ["bright", "organ"], ["organ", "sax"], ["sax", "retro"], ["retro", "warm"], ["warm", "electric"], ["electric", "sax"], ["sax", "electric"], ["electric", "organ"]];
  for (const voice of ["chords", "lead"]) {
    for (const [a, b] of pairs) {
      const r = await renderVoice(page, { inst: a, voice, freqs: voice === "lead" ? [midi(69)] : [C4, E4, G4], dur: 1.6, events: [{ t: T, do: "inst", id: b }], keep: true });
      const x = decodeSamples(r);
      const ref = (await renderVoice(page, { inst: b, voice, freqs: voice === "lead" ? [midi(69)] : [C4, E4, G4], dur: 0.8, keep: true }));
      const xr = decodeSamples(ref);
      // steady references: the old instrument before, the new one after (and a FRESH start of the new one: a pluck
      // attack is a wanted transient, so switching to Electric may be as sharp as its own attack, never sharper)
      const steady = Math.max(d2(x, sr, 0.3, T - 0.02), d2(x, sr, T + 0.15, 1.5), d2(xr, sr, 0, 0.2));
      const at = d2(x, sr, T - 0.01, T + 0.08);
      const levelBefore = Math.sqrt(x.subarray(Math.round(0.4 * sr), Math.round((T - 0.05) * sr)).reduce((s, v) => s + v * v, 0) / Math.round((T - 0.45) * sr));
      const dip = minRms(x, sr, T - 0.02, T + 0.1) / levelBefore;
      expect(at / steady, `${voice} ${a} -> ${b}: click (d2 ${at.toFixed(4)} vs ${steady.toFixed(4)})`).toBeLessThan(1.6);
      expect(dip, `${voice} ${a} -> ${b}: gap (min 10 ms level ${(dip * 100).toFixed(0)} %)`).toBeGreaterThan(0.3);
    }
  }
});

test("demo WAVs: test-results/audio/instrument-<name>-<mode>.wav (Chords progression, Arp, Lead melody)", async ({ page }) => {
  test.setTimeout(240_000);
  const I = [C4, E4, G4], IV = [midi(65), midi(69), midi(72)], V = [midi(67), midi(71), midi(74)], VI = [midi(69), midi(72), midi(76)];
  const prog = [[0, I], [1.2, VI], [2.4, IV], [3.6, V], [4.8, I]];
  const melody = [[0, "noteOn", 72], [0.45, "stepTo", 74], [0.7, "stepTo", 76], [1.3, "noteOff"], [1.45, "noteOn", 79], [2.4, "stepTo", 77], [2.65, "stepTo", 76], [2.9, "stepTo", 74], [3.6, "noteOff"], [3.75, "noteOn", 72], [5.2, "noteOff"]];
  for (const inst of IDS) {
    const ch = await renderVoice(page, { inst, voice: "chords", dur: 6.4, events: prog.map(([t, fs]) => ({ t, do: "chord", freqs: fs })), keep: true });
    writeWav(`${WAV_DIR}/instrument-${inst}-chords.wav`, decodeSamples(ch), 48000);
    const arpSeq = prog.map(([t, fs], i) => [t, prog[i + 1]?.[0] ?? 99, [...fs, fs[0] * 2]]);
    const ar = await renderVoice(page, { inst, voice: "arp", dur: 6.4, freqs: I, arpSeq, arpStep: 0.15, gate: 0.6, keep: true });
    writeWav(`${WAV_DIR}/instrument-${inst}-arp.wav`, decodeSamples(ar), 48000);
    const ld = await renderVoice(page, { inst, voice: "lead", dur: 6.0, events: melody.map(([t, d, m]) => ({ t: t + 0.05, do: d, f: m ? midi(m) : undefined })), keep: true });
    writeWav(`${WAV_DIR}/instrument-${inst}-lead.wav`, decodeSamples(ld), 48000);
    for (const r of [ch, ar, ld]) expect(r.windows[0].peak).toBeLessThan(1);
  }
});
