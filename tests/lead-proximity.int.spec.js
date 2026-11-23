// Lead edge feedback (proximity / sweet band / hand marker), the release envelope and the mouse octave click,
// in the Lead lab (?mockHands). Quick first-pass checks; screenshots in test-results/screens/lead-proximity-*.png.
import { test, expect, rh, setHands, dbg, yFor, settle, SCREENS } from "./helpers/lead-lab.js";
import { recordAudio } from "./helpers/audio.js";
import { clickRatio } from "./helpers/lead-pitch.js";

test("edge feedback: proximity rises toward the neighbour, snapped note holds until the switch point", async ({ lab: page }) => {
  await page.locator('.lead-controls [data-set="3"]').click();
  await page.mouse.move(400, 400);
  await setHands(page, rh({ y: 0.5 }));
  await settle(page, 200);
  const d0 = await dbg(page);
  const cur = d0.preview;
  const i = d0.lines.findIndex((l) => l.midi === cur);
  const upper = d0.lines[i + 1];
  const yC = await yFor(page, cur);
  const yU = await yFor(page, upper.midi);
  const at = async (f) => {
    await setHands(page, rh({ y: yC + (yU - yC) * f }));
    await settle(page, 120);
    return dbg(page);
  };
  const c = await at(0);
  expect(Math.abs(c.proximity)).toBeLessThan(0.1);
  expect(c.marker).not.toBeNull();
  expect(c.sweet).not.toBeNull();
  expect(c.nearEdge).toBeNull();
  await page.screenshot({ path: `${SCREENS}/lead-proximity-center.png` });
  let last = c.proximity;
  for (const f of [0.3, 0.5, 0.65, 0.75]) {
    const d = await at(f);
    expect(d.preview, `still on ${cur} at ${f}`).toBe(cur);
    expect(d.proximity).toBeGreaterThan(last);
    last = d.proximity;
  }
  const edge = await dbg(page);
  expect(edge.nearEdge && edge.nearEdge.midi).toBe(upper.midi);
  expect(edge.nearEdge.amount).toBeGreaterThan(0.5);
  await page.screenshot({ path: `${SCREENS}/lead-proximity-near-edge.png` });
  const sw = await at(0.9);
  expect(sw.preview).toBe(upper.midi);
  expect(sw.proximity).toBeLessThan(0);
  await page.screenshot({ path: `${SCREENS}/lead-proximity-after-switch.png` });
});

test("release: the lead fades smoothly (no step, no click); a re-pinch during the fade has no click", async ({ lab: page }) => {
  await setHands(page, rh({ y: 0.5 }));
  await settle(page, 150);
  await setHands(page, rh({ y: 0.5, pinched: true }));
  await settle(page, 300);
  const recP = recordAudio(page, 700);
  await settle(page, 100);
  await setHands(page, rh({ y: 0.5 }));
  const { samples, sampleRate } = await recP;
  const win = Math.round(sampleRate * 0.01);
  const env = [];
  for (let k = 0; k + win <= samples.length; k += win) {
    let m = 0;
    for (let j = k; j < k + win; j++) m = Math.max(m, Math.abs(samples[j]));
    env.push(m);
  }
  const peak = Math.max(...env);
  const start = env.findIndex((v, k) => k > 3 && v < peak * 0.9);
  const end = env.findIndex((v, k) => k > start && v < peak * 0.01);
  const fadeMs = (end - start) * 10;
  expect(fadeMs, `fade ${fadeMs} ms`).toBeGreaterThan(120);
  expect(fadeMs).toBeLessThan(400);
  for (let k = start; k < end; k++) expect(env[k + 1], `no step up at ${k}`).toBeLessThanOrEqual(env[k] * 1.15 + 1e-3);
  expect(clickRatio(samples).ratio).toBeLessThan(1.6);

  // Re-pinch 80 ms into the release.
  await setHands(page, rh({ y: 0.5, pinched: true }));
  await settle(page, 300);
  const rec2 = recordAudio(page, 600);
  await settle(page, 100);
  await setHands(page, rh({ y: 0.5 }));
  await settle(page, 80);
  await setHands(page, rh({ y: 0.5, pinched: true }));
  const r2 = await rec2;
  expect(clickRatio(r2.samples).ratio).toBeLessThan(1.6);
  await setHands(page, rh({ y: 0.5 }));
  await settle(page, 500);
  expect((await dbg(page)).sounding).toBeNull();
});

test("mouse click on an octave arrow steps the octave at once (no hold)", async ({ lab: page }) => {
  await page.evaluate(() => window.__gsTest.lead._setConfig());
  await setHands(page);
  const d = await dbg(page);
  const o = d.octave;
  const box = await page.locator("#overlay").boundingBox();
  const sx = box.width / d.geo.W, sy = box.height / d.geo.H;
  const x = box.x + d.geo.cx * sx, upY = box.y + d.geo.upY * sy, downY = box.y + d.geo.downY * sy;
  const target = o < 3 ? upY : downY;
  await page.mouse.move(x, target);
  await page.mouse.down();
  await page.mouse.up();
  await settle(page, 60);
  const d2 = await dbg(page);
  expect(d2.octave).toBe(o < 3 ? o + 1 : o - 1);
  expect(d2.octaveToast).not.toBeNull();
  expect(d2.sounding).toBeNull();
  await page.mouse.move(x, downY);
  await page.mouse.down();
  await page.mouse.up();
  await settle(page, 60);
  expect((await dbg(page)).octave).toBe(o < 3 ? o : o - 2);
});
