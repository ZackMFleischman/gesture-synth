import { test, expect } from "./fixtures.js";
import { leftHand, rightHand } from "./helpers/hands.js";

test("no analytics are sent when running locally", async ({ synthPage: page, setHands }) => {
  const analytics = [];
  page.on("request", (r) => /clarity\.ms/.test(r.url()) && analytics.push(r.url()));

  // Exercise every code path that calls trackClarityEvent.
  await setHands(leftHand(1), rightHand(1));
  await expect(page.locator("#chordDisplay")).toHaveText("A(I)");
  await page.locator("#guideToggle").click();
  await page.locator("#helpButton").click();
  await page.waitForTimeout(500);

  expect(await page.evaluate(() => typeof window.clarity)).toBe("undefined");
  expect(await page.evaluate(() => [...document.scripts].map((s) => s.src).filter((u) => /clarity/.test(u)))).toEqual([]);
  expect(analytics).toEqual([]);
});
