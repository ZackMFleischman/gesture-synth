import { test, expect, SCREENS_DIR } from "./fixtures.js";

// Real pipeline (no mock): fake camera -> MediaPipe HandLandmarker from CDN.
// Verifies the model downloads, initialises and runs frames without errors.
test("real MediaPipe pipeline boots and processes camera frames", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors = [];
  page.on("console", (m) => {
    // The app has no favicon; Chrome's favicon.ico 404 is the one allow-listed error (same as pages.e2e).
    if (m.type() === "error" && !/\/favicon\.ico$/.test(m.location().url)) consoleErrors.push(m.text());
  });

  const modelLoaded = page.waitForResponse((r) => r.url().includes("hand_landmarker.task") && r.ok(), { timeout: 45_000 });
  await page.goto("/");
  await page.locator("#startOverlay").click();
  await modelLoaded;

  // The canvas is only drawn after detectForVideo returns, so non-black pixels
  // in the centre prove frames are flowing through the landmarker.
  await expect
    .poll(
      () => page.evaluate(() => {
        const c = document.getElementById("overlay");
        const d = c.getContext("2d").getImageData(c.width / 2 - 20, c.height / 2 - 20, 40, 40).data;
        return d.some((v, i) => i % 4 !== 3 && v > 0);
      }),
      { timeout: 30_000 }
    )
    .toBe(true);
  await page.screenshot({ path: `${SCREENS_DIR}/00-real-pipeline.png` });
  expect(consoleErrors).toEqual([]);
});
