// Filter arc at the right hand (real app): the dot follows the direction the hand leans ON SCREEN,
// and the arc sits above the fingertips. Both were wrong with a real camera: the dot moved opposite
// to the tilt (tilt is measured on the unmirrored image) and the arc crossed the fingers.
import { test, expect } from "./fixtures.js";
import { leftHand, rightHand } from "./helpers/hands.js";

async function arcAndHand(page) {
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const t = window.__gsTest;
    const arc = t.ui.regions.find((r) => r.name === "filter-arc")?.rect;
    const lm = t.results.landmarks[t.results.handedness.findIndex((h) => h[0].categoryName === "Right")];
    const W = innerWidth, H = innerHeight;
    const top = t.bus.get("right/top");
    // On-screen lean: display x is mirrored, so compare (1 - x) of the middle fingertip and the wrist.
    const lean = (1 - lm[12].x) - (1 - lm[0].x);
    const palm = t.bus.get("right/pos");
    return { arc, lean, palmX: palm.x * W, tipY: top.y * H };
  });
}

test.describe("filter arc at the right hand", () => {
  for (const tilt of [-1, -0.5, 0.5, 1]) {
    test(`dot moves the way the hand leans on screen (tilt ${tilt})`, async ({ synthPage: page, setHands }) => {
      await setHands(leftHand(1), rightHand(1, { tilt, volume: 0.5 }));
      const { arc, lean, palmX } = await arcAndHand(page);
      expect(arc, "filter arc drawn").toBeTruthy();
      expect(Math.abs(lean)).toBeGreaterThan(0.005); // the synthetic hand really leans
      expect(Math.sign(arc.dot.x - palmX)).toBe(Math.sign(lean));
    });
  }

  for (const tilt of [-1, 0, 1]) {
    test(`arc stays above the highest fingertip (tilt ${tilt})`, async ({ synthPage: page, setHands }) => {
      await setHands(leftHand(1), rightHand(4, { tilt, volume: 0.4 }));
      const { arc, tipY } = await arcAndHand(page);
      // The dot is the arc's lowest point at full tilt; the whole box must end above the fingertips.
      expect(arc.dot.y).toBeLessThan(tipY);
      expect(arc.y + arc.h).toBeLessThan(tipY + 6); // box includes a 6 px stroke margin
    });
  }
});
