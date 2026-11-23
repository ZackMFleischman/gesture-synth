import { test, expect, SCREENS_DIR } from "./fixtures.js";

// Real pipeline (no mock): fake camera -> MediaPipe HandLandmarker from CDN.
// Verifies the camera shows at once (before the model loads), the model downloads and initialises, the
// loading notice goes away, and frames keep flowing without errors.
test("real MediaPipe pipeline boots and processes camera frames", async ({ page }) => {
  test.setTimeout(100_000);
  const consoleErrors = [];
  page.on("console", (m) => {
    // The app has no favicon; Chrome's favicon.ico 404 is the one allow-listed error (same as pages.e2e).
    if (m.type() === "error" && !/\/favicon\.ico$/.test(m.location().url)) consoleErrors.push(m.text());
  });

  // Count clearly lit pixels in the centre. The page background is #111 (17,17,17), so a plain "> 0" check
  // passes on an empty canvas; Chrome's fake camera pattern is bright green, so require real brightness.
  const litPixels = () =>
    page.evaluate(() => {
      const c = document.getElementById("overlay");
      const d = c.getContext("2d").getImageData(c.width / 2 - 20, c.height / 2 - 20, 40, 40).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++;
      return n;
    });

  const modelLoaded = page.waitForResponse((r) => r.url().includes("hand_landmarker.task") && r.ok(), { timeout: 45_000 });
  await page.goto("/");
  await page.locator("#startOverlay").click();

  // The camera shows within a few seconds, without waiting for the hand model.
  await expect.poll(litPixels, { timeout: 8_000 }).toBeGreaterThan(200);

  await modelLoaded;
  // The model can take long to initialise in headless Chrome (software GL; 38 s measured under load).
  await expect(page.locator("#trackingStatus")).toHaveCount(0, { timeout: 80_000 });
  await expect.poll(litPixels, { timeout: 5_000 }).toBeGreaterThan(200);
  await page.screenshot({ path: `${SCREENS_DIR}/00-real-pipeline.png` });
  expect(consoleErrors).toEqual([]);
});
