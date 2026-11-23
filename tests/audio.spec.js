import { test, expect } from "./fixtures.js";
import { leftHand, rightHand } from "./helpers/hands.js";
import { MASTER_VOLUME } from "../src/router.js";
import { recordAudio, rms, spectrum, assertNotes, centroid, writeWav, et } from "./helpers/audio.js";

const WAV_DIR = "test-results/audio";
const A = 220;

// Expected pitches computed from music theory, independent of the app's code.
const CASES = [
  { name: "A major (I), root position", left: [1], right: [1],
    notes: [A, et(A, 7), et(A, 12), et(A, 16)] },
  { name: "A major (I), 1st inversion", left: [1], right: [2],
    notes: [et(A, 4), et(A, 7), et(A, 12), et(A, 16)] },
  { name: "Dmaj7 (IV)", left: [4], right: [3],
    notes: [et(A, 5), et(A, 9), et(A, 12), et(A, 16)] },
  { name: "E7 (V dominant)", left: [5], right: [4],
    notes: [et(A, 7), et(A, 11), et(A, 14), et(A, 17)] },
  { name: "F#m (vi)", left: [6, { minor: true }], right: [1],
    notes: [et(A, 9), et(A, 16), et(A, 21), et(A, 24)] },
  { name: "Bm7 (ii7)", left: [2, { minor: true }], right: [3],
    notes: [et(A, 2), et(A, 5), et(A, 9), et(A, 12)] },
  { name: "Bdim7 (ii dim7)", left: [2, { minor: true }], right: [4],
    notes: [et(A, 2), et(A, 5), et(A, 8), et(A, 11)] },
  { name: "G# major (VII), below the tonic", left: [7], right: [1],
    notes: [et(A, -1), et(A, 6), et(A, 11), et(A, 15)] },
  { name: "A major, thumb = octave down", left: [1], right: [1, { thumb: true }],
    notes: [A / 2, et(A / 2, 7), A, et(A, 4)] },
];

test.describe("chords sound the right pitches", () => {
  for (const c of CASES) {
    test(c.name, async ({ synthPage: page, setHands }, info) => {
      await setHands(leftHand(...c.left), rightHand(...c.right));
      await page.waitForTimeout(350); // chord hold + gain ramp
      const { samples, sampleRate } = await recordAudio(page);
      writeWav(`${WAV_DIR}/${info.title.replace(/\W+/g, "_")}.wav`, samples, sampleRate);

      expect(rms(samples)).toBeGreaterThan(0.05);
      const oscFreqs = await page.evaluate(() => window.__gsTest.synth.oscillators.map((o) => o.frequency.value));
      expect(oscFreqs.map((f) => f.toFixed(1))).toEqual(c.notes.map((f) => f.toFixed(1)));
      assertNotes(spectrum(samples, sampleRate), c.notes);
    });
  }

  test("key change transposes (G drops an octave to stay in range)", async ({ synthPage: page, setHands }) => {
    await page.locator("#keySelect").selectOption({ label: "G" });
    await setHands(leftHand(1), rightHand(1));
    await page.waitForTimeout(350);
    const { samples, sampleRate } = await recordAudio(page);
    const G = et(A, -2);
    assertNotes(spectrum(samples, sampleRate), [G, et(G, 7), et(G, 12), et(G, 16)]);
  });
});

test.describe("expression", () => {
  // M1 meaning change: a closed right hand is no longer a mute. After 100 ms it opens the mode menu,
  // and Chords holds its last right-hand values while the menu is open. So a fist that appears
  // without a previous open right hand stays silent (nothing to hold), and a fist made while playing
  // keeps the chord sounding. No right hand at all is still a rest.
  test("silent with no right hand; a closed right hand holds (it opens the menu, not a mute)", async ({ synthPage: page, setHands }) => {
    await setHands(leftHand(1));
    await page.waitForTimeout(300);
    expect(rms((await recordAudio(page, 400)).samples)).toBeLessThan(0.001);

    // Fist with no open right hand before it: menu opens, nothing to hold -> still silent.
    await setHands(leftHand(1), rightHand(0));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__gsTest.router.rightHeld)).toBe(true);
    expect(rms((await recordAudio(page, 400)).samples)).toBeLessThan(0.001);

    // Playing, then a fist: the chord keeps sounding at the held level.
    await setHands();
    await page.waitForTimeout(400); // menu cancels (tracking lost)
    await setHands(leftHand(1), rightHand(1));
    await page.waitForTimeout(400);
    const playing = rms((await recordAudio(page, 300)).samples);
    await setHands(leftHand(1), rightHand(0));
    await page.waitForTimeout(300);
    const held = rms((await recordAudio(page, 300)).samples);
    expect(playing).toBeGreaterThan(0.05);
    expect(held / playing).toBeGreaterThan(0.9);
    expect(held / playing).toBeLessThan(1.1);
  });

  test("silent with only a right hand", async ({ synthPage: page, setHands }) => {
    await setHands(rightHand(1));
    await page.waitForTimeout(300);
    expect(rms((await recordAudio(page, 400)).samples)).toBeLessThan(0.001);
  });

  test("hand height scales loudness", { tag: "@full" }, async ({ synthPage: page, setHands }) => {
    // Chords' volume is the LEFT hand's height (the master volume) since the right height lost its function in Chords
    // (this test used the right-hand volume 0.3 vs 0.9). Same intent and margins: volume 0.9 vs 0.3 -> loudness ~3x.
    // The hand is placed so the router's dead-zoned anchor lands on the height for that volume (the anchor trails a
    // moving hand by DEAD_ZONE), and the published master is checked before recording.
    const { LOW, HIGH, DEAD_ZONE } = MASTER_VOLUME;
    const level = async (volume, dir) => {
      const height = LOW + volume * (HIGH - LOW) + dir * DEAD_ZONE; // dir: 0 first frame, -1 moving down
      await setHands(leftHand(1, { volume: height }), rightHand(1));
      await expect.poll(() => page.evaluate(() => window.__gsTest.bus.get("volume"))).toBeCloseTo(volume, 2);
      await page.waitForTimeout(350);
      return rms((await recordAudio(page, 500)).samples);
    };
    const loud = await level(0.9, 0);
    const soft = await level(0.3, -1);
    expect(loud / soft).toBeGreaterThan(2.4);
    expect(loud / soft).toBeLessThan(3.6);
  });

  test("tilt opens/closes the lowpass filter", { tag: "@full" }, async ({ synthPage: page, setHands }) => {
    const filterAt = async (tilt) => {
      await setHands(leftHand(1), rightHand(1, { tilt }));
      await page.waitForTimeout(400);
      const { samples, sampleRate } = await recordAudio(page, 700);
      const f = await page.evaluate(() => window.__gsTest.synth.filter.frequency.value);
      return { cutoff: f, bright: centroid(spectrum(samples, sampleRate)) };
    };
    // Bright synth has lots of harmonics, so the filter effect is audible in the spectrum.
    await page.locator("#toneSelect").selectOption("sawtooth");
    const closed = await filterAt(-1);
    const neutral = await filterAt(0);
    const open = await filterAt(1);
    expect(closed.cutoff).toBeCloseTo(250, -1);
    expect(neutral.cutoff).toBeCloseTo(1200, -1);
    expect(open.cutoff).toBeCloseTo(5000, -1);
    expect(closed.bright).toBeLessThan(neutral.bright);
    expect(neutral.bright).toBeLessThan(open.bright);
  });

  test("tone select changes the timbre", { tag: "@full" }, async ({ synthPage: page, setHands }) => {
    const brightness = {};
    for (const wave of ["triangle", "square", "sawtooth"]) {
      await page.locator("#toneSelect").selectOption(wave);
      await setHands(leftHand(1), rightHand(1, { tilt: 1 }));
      await page.waitForTimeout(350);
      const types = await page.evaluate(() => window.__gsTest.synth.oscillators.map((o) => o.type));
      expect(types).toEqual([wave, wave, wave, wave]);
      const { samples, sampleRate } = await recordAudio(page, 700);
      brightness[wave] = centroid(spectrum(samples, sampleRate));
    }
    expect(brightness.triangle).toBeLessThan(brightness.square);
    expect(brightness.triangle).toBeLessThan(brightness.sawtooth);
  });

  test("rapid chord changes don't leak oscillators", async ({ synthPage: page, setHands }) => {
    for (let i = 0; i < 12; i++) {
      await setHands(leftHand((i % 7) + 1), rightHand((i % 4) + 1));
      await page.waitForTimeout(160);
    }
    expect(await page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBe(4);
  });

  test("output never clips", { tag: "@full" }, async ({ synthPage: page, setHands }) => {
    // Fixed in M1: chord oscillators leave headroom and the master has a limiter + soft clipper.
    // Worst case: right volume 1 and the left hand high (master volume 1).
    let peak = 0;
    for (let i = 0; i < 7; i++) {
      await setHands(leftHand(i + 1, { volume: 0.95 }), rightHand((i % 4) + 1, { volume: 1 }));
      await page.waitForTimeout(250);
      const { samples } = await recordAudio(page, 150);
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
    }
    expect(peak, "output peak (>1 clips)").toBeLessThanOrEqual(1);
  });
});
