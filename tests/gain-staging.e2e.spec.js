// Gain staging around the master limiter (src/services/audio.js header): normal playing stays below the limiter
// threshold, so loudness is linear in both volume controls and the limiter only ever catches transients.
// Real app (?mockHands) + the real engine; Lead is not registered in the app yet, so its voice (lead-voice.js:
// lead + pad) is driven directly on the app's graph.
import { test, expect } from "./fixtures.js";
import { leftHand, rightHand } from "./helpers/hands.js";
import { recordAudio, rms, writeWav } from "./helpers/audio.js";

const WAV_DIR = "test-results/audio";
const TONICS = [220.0, 233.08, 246.94, 261.63, 277.18, 293.66, 311.13, 329.63, 349.23, 369.99, 392.0, 415.3];
const dB = (x) => 20 * Math.log10(x);

/** Watches the signal going INTO the limiter (masterGain output) and the limiter's gain reduction, per block. */
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
    sp.connect(s.ctx.destination); // outputs silence; only keeps the processor running
  });
}

/**
 * Chrome's `reduction` meter starts far below 0 dB when the context is created and only decays (over seconds)
 * while signal flows. So: play, wait until the meter has come up above -0.5 dB (it converges to the real
 * reduction if the signal is over the threshold, so a real overload fails here), then measure the window.
 */
async function settleLimiterMeter(page) {
  await expect.poll(() => page.evaluate(() => window.__gsTest.synth.limiter.reduction), { timeout: 10_000 }).toBeGreaterThan(-0.25);
}

/** Records `ms` of output while probing the limiter. */
async function measure(page, ms = 1000) {
  await installProbe(page);
  await page.evaluate(() => Object.assign(window.__gainProbe, { on: true, pre: 0, red: 0 }));
  const rec = await recordAudio(page, ms);
  const pr = await page.evaluate(() => { window.__gainProbe.on = false; return { ...window.__gainProbe }; });
  let peak = 0;
  for (const s of rec.samples) peak = Math.max(peak, Math.abs(s));
  return { ...rec, rms: rms(rec.samples), peak, pre: pr.pre, reduction: pr.red };
}

const threshold = (page) => page.evaluate(async () => (await import("/src/services/audio.js")).LIMITER.threshold);

test.describe("gain staging: steady playing stays out of the limiter", () => {
  test("every chord at max settings (sawtooth, filter fully open, master 1, chord voice CHORDS_LEVEL) peaks under the limiter threshold", async ({ synthPage: page }) => {
    // Offline renders of the real SynthEngine (CHORD_LEVEL, filter curve, chordGain, masterGain), tapped at the
    // limiter input: every key x degree x major/minor x voicing x thumb = 1344 chords. ~3 s alone, more under load.
    test.setTimeout(90_000);
    const r = await page.evaluate(async (tonics) => {
      const { SynthEngine, LIMITER } = await import("/src/services/audio.js");
      const { CHORDS_LEVEL } = await import("/src/modes/chords.js"); // Chords' fixed chord-voice gain
      const { createBus } = await import("/src/core/bus.js");
      const { createHarmony } = await import("/src/services/harmony.js");
      const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
      const sr = 48000, dur = 0.6, from = Math.round(0.3 * sr); // skip the attack + filter/master ramps
      async function renderPeak(freqs, waveform) {
        const off = new OfflineAudioContext(1, Math.round(sr * dur), sr);
        const Orig = window.AudioContext;
        window.AudioContext = function () { return off; };
        const s = new SynthEngine({ bus: createBus(), waveform });
        try { s.ensureContext(); } finally { window.AudioContext = Orig; }
        s.setMasterVolume(1);
        s.chordGain.gain.value = CHORDS_LEVEL;
        s.updateFilterSweep(1);
        s.masterGain.disconnect();
        s.masterGain.connect(off.destination); // the limiter's input
        s.playNotes(freqs);
        const d = (await off.startRendering()).getChannelData(0);
        let pk = 0;
        for (let i = from; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
        return pk;
      }
      const jobs = [];
      for (const t of tonics) {
        const h = createHarmony({ tonicFreq: t });
        for (const roman of ROMAN) for (const major of [true, false]) for (const v of [1, 2, 3, 4]) for (const thumb of [false, true])
          jobs.push({ label: `${t} ${roman}${major ? "" : "m"} v${v}${thumb ? " thumb" : ""}`, freqs: h.notes(roman, major, v, thumb) });
      }
      let worst = { peak: 0 };
      for (let i = 0; i < jobs.length; i += 48) {
        const peaks = await Promise.all(jobs.slice(i, i + 48).map((j) => renderPeak(j.freqs, "sawtooth")));
        peaks.forEach((p, k) => { if (p > worst.peak) worst = { peak: p, label: jobs[i + k].label }; });
      }
      return { n: jobs.length, worst, threshold: LIMITER.threshold };
    }, TONICS);
    console.log(`[gain] ${r.n} chords, worst steady peak at the limiter input ${r.worst.peak.toFixed(3)} (${dB(r.worst.peak).toFixed(2)} dBFS) at ${r.worst.label}; threshold ${r.threshold} dBFS`);
    expect(r.n).toBe(1344);
    // Margin: at least 1 dB under the threshold. Measured worst: 0.641 (-3.9 dBFS) in this 0.3 s window; 0.67
    // (-3.5 dBFS) over 1 s windows (more phase alignments); threshold -2 dBFS.
    expect(dB(r.worst.peak)).toBeLessThan(r.threshold - 1);
  });

  test("Chords: the right-hand height changes nothing (volume = left hand only)", async ({ synthPage: page, setHands }) => {
    // (Replaces "loudness is linear in the right-hand volume": the right height has no function in Chords any more;
    // the chord voice plays at the fixed CHORDS_LEVEL and the left height (master) is the volume.)
    // Full master + sawtooth + filter open = the loud end, where a leftover right-height gain would show most.
    await page.locator("#toneSelect").selectOption("sawtooth");
    const level = async (volume) => {
      await setHands(leftHand(1, { volume: 0.95 }), rightHand(1, { volume, tilt: 1 }));
      await page.waitForTimeout(400); // chord hold + 50 ms volume ramp + filter glide
      const m = await measure(page, 500);
      const s = await page.evaluate(() => {
        const t = window.__gsTest;
        return { master: t.bus.get("volume"), chordVol: t.bus.get("chords/volume"), chordGain: t.synth.chordGain.gain.value };
      });
      return { rms: m.rms, peak: m.peak, ...s };
    };
    const { CHORDS_LEVEL } = await page.evaluate(() => import("/src/modes/chords.js").then((m) => ({ CHORDS_LEVEL: m.CHORDS_LEVEL })));
    const pts = [];
    for (const v of [0.6, 0.15, 0.95, 0.35]) pts.push({ v, ...(await level(v)) });
    const ref = pts[0];
    for (const p of pts) {
      const d = dB(p.rms / ref.rms);
      console.log(`[gain] right ${p.v}: rms ${p.rms.toFixed(4)} (${d >= 0 ? "+" : ""}${d.toFixed(2)} dB), master ${p.master.toFixed(3)}, chordGain ${p.chordGain.toFixed(3)}`);
      expect(p.chordVol).toBeUndefined(); // no right-height signal in Chords
      expect(p.master).toBe(ref.master); // the bus volume does not follow the right hand
      expect(p.chordGain).toBeCloseTo(CHORDS_LEVEL, 3);
      expect(Math.abs(d)).toBeLessThan(0.5);
      expect(p.peak).toBeLessThanOrEqual(1);
    }
    expect(ref.rms).toBeGreaterThan(0.02);
  });

  test("loudness is linear in the master volume (left height)", async ({ synthPage: page, setHands }) => {
    await page.locator("#toneSelect").selectOption("sawtooth");
    const level = async (h) => {
      await setHands(leftHand(1, { volume: h }), rightHand(1, { volume: 1, tilt: 1 }));
      await page.waitForTimeout(900); // master smoothing (140 ms tau) + de-zipper
      const m = await measure(page, 500);
      return { rms: m.rms, master: await page.evaluate(() => window.__gsTest.bus.get("volume")) };
    };
    const pts = [];
    for (const h of [0.2, 0.35, 0.5, 0.6]) pts.push({ h, ...(await level(h)) });
    // (The router's dead zone trails the hand by 0.04 while it rises, so compare against the published master.)
    for (let i = 1; i < pts.length; i++) expect(pts[i].master).toBeGreaterThan(pts[i - 1].master + 0.1);
    expect(pts[0].master).toBeGreaterThan(0.1);
    const top = pts[pts.length - 1];
    for (const p of pts.slice(0, -1)) {
      const ratio = top.rms / p.rms;
      const want = top.master / p.master;
      console.log(`[gain] master ${p.master.toFixed(3)} -> ${top.master.toFixed(3)}: ratio ${ratio.toFixed(3)} (linear ${want.toFixed(3)})`);
      expect(ratio).toBeGreaterThan(want * 0.9);
      expect(ratio).toBeLessThan(want * 1.1);
    }
  });

  test("Chords: no limiting during steady loud playing (max settings, close voicings)", async ({ synthPage: page, setHands }) => {
    const th = await threshold(page);
    await page.locator("#toneSelect").selectOption("sawtooth");
    await installProbe(page);
    // Closest voicings (7ths, dim7) and the octave-heavy ones, all at master 1 / right 1 / filter open.
    const chords = [[leftHand(6, { minor: true, volume: 0.95 }), 4], [leftHand(4, { volume: 0.95 }), 3], [leftHand(5, { volume: 0.95 }), 4], [leftHand(1, { volume: 0.95 }), 1]];
    let worst = { pre: 0, peak: 0, reduction: 0 };
    let last;
    for (const [i, [left, q]] of chords.entries()) {
      await setHands(left, rightHand(q, { volume: 1, tilt: 1 }));
      await page.waitForTimeout(700); // chord change + ramps settle: steady state only
      if (i === 0) await settleLimiterMeter(page);
      last = await measure(page, 800);
      worst = { pre: Math.max(worst.pre, last.pre), peak: Math.max(worst.peak, last.peak), reduction: Math.min(worst.reduction, last.reduction) };
    }
    writeWav(`${WAV_DIR}/gain-chords-loud.wav`, last.samples, last.sampleRate);
    console.log(`[gain] chords: limiter in ${dB(worst.pre).toFixed(2)} dBFS, out peak ${worst.peak.toFixed(3)}, reduction ${worst.reduction.toFixed(2)} dB`);
    expect(dB(worst.pre)).toBeLessThan(th);
    expect(worst.reduction).toBeGreaterThan(-0.5);
    expect(worst.peak).toBeLessThanOrEqual(1);
  });

  test("Arp: no limiting during steady loud playing (gate 1, x2, max settings)", async ({ synthPage: page, setHands }) => {
    const th = await threshold(page);
    await page.locator("#toneSelect").selectOption("sawtooth");
    await setHands(leftHand(1, { volume: 0.95 }));
    await page.evaluate(() => window.__gsTest.router.setMode("arp"));
    await installProbe(page);
    await setHands(leftHand(1, { volume: 0.95 }), rightHand(4, { volume: 1, tilt: 1, thumb: true }));
    await page.waitForTimeout(800);
    await settleLimiterMeter(page);
    expect(await page.evaluate(() => window.__gsTest.bus.get("arp/gate"))).toBeCloseTo(1, 2);
    const m = await measure(page, 1500);
    writeWav(`${WAV_DIR}/gain-arp-loud.wav`, m.samples, m.sampleRate);
    console.log(`[gain] arp: limiter in ${dB(m.pre).toFixed(2)} dBFS, out peak ${m.peak.toFixed(3)}, rms ${m.rms.toFixed(4)}, reduction ${m.reduction.toFixed(2)} dB`);
    expect(m.rms).toBeGreaterThan(0.02);
    expect(dB(m.pre)).toBeLessThan(th);
    expect(m.reduction).toBeGreaterThan(-0.5);
    expect(m.peak).toBeLessThanOrEqual(1);
  });

  test("Lead: no limiting during steady loud playing (lead + pad, max settings)", async ({ synthPage: page, setHands }) => {
    const th = await threshold(page);
    await setHands(leftHand(1, { volume: 0.95 })); // master 1; no right hand, so Chords is silent
    await installProbe(page);
    await page.evaluate(async () => {
      const t = window.__gsTest;
      const { createLeadVoice } = await import("/src/modes/lead-voice.js");
      t.ctx.audio.setWaveform("sawtooth");
      t.ctx.audio.setFilter(1);
      t.ctx.audio.setLayerFilter(1); // the lead voice's own filter (Lead layer routing)
      const v = (window.__leadVoice = createLeadVoice(t.ctx.audio));
      v.setPad(t.ctx.harmony.notes("I", true, 1));
      v.noteOn(440 * 2 ** (4 / 12));
    });
    await page.waitForTimeout(800); // past the lead attack/decay and the pad's fade-in (tau 0.12 s)
    await settleLimiterMeter(page);
    const m = await measure(page, 1000);
    writeWav(`${WAV_DIR}/gain-lead-loud.wav`, m.samples, m.sampleRate);
    console.log(`[gain] lead: limiter in ${dB(m.pre).toFixed(2)} dBFS, out peak ${m.peak.toFixed(3)}, rms ${m.rms.toFixed(4)}, reduction ${m.reduction.toFixed(2)} dB`);
    expect(m.rms).toBeGreaterThan(0.02);
    expect(dB(m.pre)).toBeLessThan(th);
    expect(m.reduction).toBeGreaterThan(-0.5);
    expect(m.peak).toBeLessThanOrEqual(1);
  });

  // Lead layer (docs/architecture.md "Lead layer"): the base keeps playing under the lead. Loud but steady settings:
  // master 1, the base at its loudest (right height 1 before the layer), Bright-ish tone, both filters open.
  for (const base of ["arp", "chords"]) {
    test(`${base === "arp" ? "Arp" : "Chords"} + Lead: no limiting during steady loud playing (base held at max, lead playing, filters open)`, async ({ synthPage: page, setHands }) => {
      const th = await threshold(page);
      await page.locator("#toneSelect").selectOption("sawtooth");
      const L = leftHand(1, { volume: 0.95 });
      await setHands(L, rightHand(base === "arp" ? 4 : 3, { volume: 1, tilt: 1, thumb: base === "arp" }));
      await page.evaluate((b) => window.__gsTest.router.setMode(b), base);
      await setHands(L, rightHand(base === "arp" ? 4 : 3, { volume: 1, tilt: 1, thumb: base === "arp" }));
      await page.waitForTimeout(600);
      await page.evaluate(() => window.__gsTest.router.setMode("lead"));
      expect(await page.evaluate(() => [window.__gsTest.bus.get("mode"), window.__gsTest.bus.get("layer")])).toEqual([base, "lead"]);
      // Lead plays a held note with its filter fully open (tilt 1), through the real mode (screen key = a ladder note).
      await page.evaluate(() => window.__gsTest.ctx.audio.setLayerFilter(1));
      await page.keyboard.down("KeyG");
      await page.waitForTimeout(800);
      await installProbe(page);
      await settleLimiterMeter(page);
      const m = await measure(page, 1200);
      expect(await page.evaluate(() => window.__gsTest.registry.getMode("lead")._debug().sounding), "lead note sounding").not.toBe(null);
      await page.keyboard.up("KeyG");
      writeWav(`${WAV_DIR}/gain-${base}-plus-lead-loud.wav`, m.samples, m.sampleRate);
      console.log(`[gain] ${base}+lead: limiter in ${dB(m.pre).toFixed(2)} dBFS, out peak ${m.peak.toFixed(3)}, rms ${m.rms.toFixed(4)}, reduction ${m.reduction.toFixed(2)} dB`);
      expect(m.rms).toBeGreaterThan(0.02);
      expect(dB(m.pre)).toBeLessThan(th);
      expect(m.reduction).toBeGreaterThan(-0.5);
      expect(m.peak).toBeLessThanOrEqual(1);
    });
  }
});
