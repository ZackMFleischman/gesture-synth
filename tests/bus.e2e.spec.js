// Signal bus: live checks in the real app via window.__gsTest.bus.
import { expect } from "@playwright/test";
import { test } from "./fixtures.js";
import { leftHand, rightHand, masterAt } from "./helpers/hands.js";

test.describe("bus in the app", () => {
  test("chords state appears on the bus while playing", async ({ synthPage: page, setHands }) => {
    await setHands(leftHand(4), rightHand(3, { volume: 0.75, tilt: 0.5 }));
    await expect(page.locator("#chordDisplay")).toHaveText("D(IV)");
    const s = await page.evaluate(() => {
      const b = window.__gsTest.bus;
      const names = ["mode", "chord", "voicing", "chords/octave", "volume", "filter",
        "left/height", "left/tilt", "right/height", "right/tilt", "right/pos"];
      return { values: Object.fromEntries(names.map((n) => [n, b.get(n)])), manifest: b.manifest() };
    });
    expect(s.values.mode).toBe("chords");
    expect(s.values.chord).toMatchObject({ roman: "IV", degree: 4, isMajor: true, name: "D", rootMidi: 62 });
    expect(s.values.voicing).toBe(3);
    expect(s.values["chords/octave"]).toBe(false);
    // M1 1.3: `volume` is the master volume from the left height (0.5 -> MASTER_VOLUME mapping). It is the only
    // volume in Chords: the right height has no function there (no `chords/volume` signal any more).
    expect(s.values.volume).toBeCloseTo(masterAt(0.5), 3);
    expect(s.values.filter).toBeCloseTo(0.5, 5);
    expect(s.values["right/height"]).toBeCloseTo(0.75, 5);
    expect(s.values["right/tilt"]).toBeCloseTo(0.5, 5);
    expect(s.values["left/tilt"]).toBeCloseTo(0.6, 5);
    expect(s.values["right/pos"].x).toBeLessThan(0.5); // mirrored: right hand shows on the left
    const names = s.manifest.map((m) => m.name);
    for (const n of ["mode", "chord", "voicing", "volume", "filter", "left/height", "right/pinch",
      "note/on", "note/off", "note/cancel", "menu", "right/held"]) {
      expect(names, n).toContain(n);
    }
    expect(names).not.toContain("chords/volume");
  });

  test("indicators read from the bus", async ({ synthPage: page, setHands }) => {
    await setHands(); // no hands: nothing in the app writes the meter param / filter
    await page.evaluate(() => {
      const b = window.__gsTest.bus;
      b.set("volume", 0.5); // the meter shows the active mode's meter param (Chords: the master volume)
      b.set("filter", -0.25);
    });
    await expect(page.locator(".vol-bar.lit")).toHaveCount(4);
    await expect(page.locator("#distortionDisplay")).toHaveText("Filter: -25%");
  });

  test("audio engine emits note/on and note/off per voice", async ({ synthPage: page, setHands }) => {
    await page.evaluate(() => {
      window.__notes = [];
      window.__gsTest.bus.subscribe({ onEvent: (n, d, t) => window.__notes.push({ n, ...d, t }) }, "note/*");
    });
    await setHands(leftHand(1), rightHand(1));
    await expect.poll(() => page.evaluate(() => window.__notes.filter((e) => e.n === "note/on").length)).toBe(4);
    await setHands(leftHand(4), rightHand(1));
    await expect.poll(() => page.evaluate(() => window.__notes.filter((e) => e.n === "note/off").length)).toBe(4);
    const notes = await page.evaluate(() => window.__notes);
    expect(notes.slice(0, 4).map((e) => e.freq.toFixed(1))).toEqual(["220.0", "329.6", "440.0", "554.4"]);
    expect(notes.every((e) => e.voice === "chords" && typeof e.t === "number")).toBe(true);
    // note/on and note/off are paired by a unique id (and carry the MIDI note).
    const ons = notes.filter((e) => e.n === "note/on").slice(0, 4);
    const offs = notes.filter((e) => e.n === "note/off").slice(0, 4);
    expect(new Set(ons.map((e) => e.id)).size).toBe(4);
    expect(offs.map((e) => e.id).sort()).toEqual(ons.map((e) => e.id).sort());
    expect(ons.map((e) => e.midi)).toEqual([57, 64, 69, 73]);
  });
});
