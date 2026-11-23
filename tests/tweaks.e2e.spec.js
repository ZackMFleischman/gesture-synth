// Tweaks panel smoke in the real app (TWEAKS_ALWAYS_ON in src/tweaks/flag.js): present by default, a slider changes a
// live value the app reads every frame, the value survives a reload (localStorage), `?tweaks=false` turns it off.
// The framework itself (define / validate / persist / import) is unit-tested in tweaks.unit.spec.js.
import { test, expect } from "./fixtures.js";

const selectR = (page) => page.evaluate(() => window.__gsTest.router.menu.snapshot().geometry.SELECT_R);

test("panel on by default; the menu select-radius slider changes the live menu geometry and persists", async ({ synthPage: page }) => {
  await expect(page.locator("#tweaksToggle")).toBeVisible();
  await expect(page.locator("#tweaksPanel")).toBeHidden();
  const before = await selectR(page);
  await page.locator("#tweaksToggle").click();
  await expect(page.locator("#tweaksPanel")).toBeVisible();
  const row = page.locator('#tweaksPanel [data-key="menu.selectR"]');
  await expect(row).toBeVisible();
  await row.locator("input[type=range]").fill("0.9");
  await expect(row).toHaveClass(/changed/);
  // The state machine re-reads menuConfig on every update(): the snapshot shows it on the next frame.
  await expect.poll(() => selectR(page)).toBeCloseTo(0.9, 5);
  expect(before).not.toBeCloseTo(0.9, 5);

  await page.reload();
  await expect(page.locator("#tweaksToggle")).toBeVisible();
  await expect.poll(() => selectR(page)).toBeCloseTo(0.9, 5); // stored value applied on load
  await page.locator("#tweaksToggle").click();
  await page.locator('#tweaksPanel [data-action="reset-all"]').click();
  await expect.poll(() => selectR(page)).toBeCloseTo(before, 5);
});

test("?tweaks=false: no panel, no toggle", async ({ page }) => {
  await page.goto("/?mockHands&tweaks=false");
  await page.waitForFunction(() => document.body.classList.contains("gs-modes") && !!window.__gsTest?.router);
  await page.waitForTimeout(300); // the panel chunk would be dynamic-imported by now
  await expect(page.locator("#tweaksToggle")).toHaveCount(0);
  await expect(page.locator("#tweaksPanel")).toHaveCount(0);
});
