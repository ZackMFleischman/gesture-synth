import { test, expect } from "./fixtures.js";
import { hand, leftHand, rightHand, heightForMaster } from "./helpers/hands.js";

const A_MAJOR = ["A", "B", "C#", "D", "E", "F#", "G#"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

test.describe("left hand picks the chord", () => {
  for (let degree = 1; degree <= 7; degree++) {
    test(`degree ${degree} major / minor`, async ({ synthPage: page, setHands }) => {
      const chord = page.locator("#chordDisplay");
      const roman = ROMAN[degree - 1];

      await setHands(leftHand(degree), rightHand(1));
      await expect(chord).toHaveText(`${A_MAJOR[degree - 1]}(${roman})`);

      await setHands(leftHand(degree, { minor: true }), rightHand(1));
      await expect(chord).toHaveText(`${A_MAJOR[degree - 1]}m(${roman.toLowerCase()})`);
    });
  }

  test("unrecognised shape (fist) shows no chord", async ({ synthPage: page, setHands }) => {
    await setHands(hand({ handedness: "Left", fingers: [] }), rightHand(1));
    await expect(page.locator("#chordDisplay")).toHaveText("--");
    await expect(page.locator("#qualityDisplay")).toHaveText("--");
  });

  test("chord name follows the selected key", async ({ synthPage: page, setHands }) => {
    await page.locator("#keySelect").selectOption({ label: "G" });
    await setHands(leftHand(5), rightHand(1));
    await expect(page.locator("#chordDisplay")).toHaveText("D(V)");
  });
});

test.describe("right hand picks voicing and expression", () => {
  const MAJOR = { 1: "Major", 2: "Major 1st Inv", 3: "Major 7th", 4: "Dominant 7th" };
  const MINOR = { 1: "Minor", 2: "Minor 1st Inv", 3: "Minor 7th", 4: "Diminished 7th" };

  for (const q of [1, 2, 3, 4]) {
    test(`quality ${q}`, async ({ synthPage: page, setHands }) => {
      const label = page.locator("#qualityDisplay");
      await setHands(leftHand(1), rightHand(q));
      await expect(label).toHaveText(MAJOR[q]);
      await setHands(leftHand(1, { minor: true }), rightHand(q));
      await expect(label).toHaveText(MINOR[q]);
      await setHands(leftHand(1), rightHand(q, { thumb: true }));
      await expect(label).toHaveText(`${MAJOR[q]} (-8ve)`);
    });
  }

  test("height drives the volume meter", async ({ synthPage: page, setHands }) => {
    // The volume is the LEFT hand's height (master) since the right height lost its function in Chords (this test
    // used the right hand). Rising hand: placed so the router's dead-zoned anchor lands on each volume.
    for (const [volume, lit] of [[0, 0], [0.25, 2], [0.5, 4], [1, 8]]) {
      await setHands(leftHand(1, { volume: volume === 0 ? 0 : heightForMaster(volume, 1) }), rightHand(1));
      await expect(page.locator(".vol-bar.lit")).toHaveCount(lit);
    }
  });

  test("tilt drives the filter readout", async ({ synthPage: page, setHands }) => {
    for (const [tilt, text] of [[-1, "-100%"], [-0.5, "-50%"], [0, "0%"], [0.5, "+50%"], [1, "+100%"]]) {
      await setHands(leftHand(1), rightHand(1, { tilt }));
      await expect(page.locator("#distortionDisplay")).toHaveText(`Filter: ${text}`);
    }
  });
});

test("brief tracking dropout does not flicker the chord", async ({ synthPage: page, setHands }) => {
  await setHands(leftHand(3), rightHand(1));
  await expect(page.locator("#chordDisplay")).toHaveText("C#(III)");

  // Record every chord text the UI shows while hands vanish for ~30ms.
  await page.evaluate(() => {
    window.__seen = new Set();
    const el = document.getElementById("chordDisplay");
    new MutationObserver(() => window.__seen.add(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await setHands();
  await page.waitForTimeout(30);
  await setHands(leftHand(3), rightHand(1));
  await page.waitForTimeout(300);
  expect((await page.evaluate(() => [...window.__seen])).filter((t) => t !== "C#(III)")).toEqual([]);
});
