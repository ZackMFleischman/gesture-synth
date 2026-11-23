// The audio-capture glitch policy (tests/helpers/audio.js; docs/testing.md "Timing tolerance policy").
import { test, expect } from "@playwright/test";
import { captureHealth, glitchReason, retryOnCaptureGlitch, CaptureGlitch } from "./helpers/audio.js";

const SR = 48000;
const N = 4096;
const blocks = (starts) => starts.map((t) => ({ t, n: N, cbAt: t - 0.05 }));
const contiguous = (k, t0 = 1) => blocks(Array.from({ length: k }, (_, i) => t0 + (i * N) / SR));
const info = () => ({ annotations: [] });

test("captureHealth: gap-free blocks are clean; a shifted block is a discontinuity", () => {
  const ok = captureHealth(contiguous(10), SR);
  expect(ok).toMatchObject({ ok: true, blocks: 10, capturedSamples: 10 * N, expectedSamples: 10 * N, discontinuities: [] });

  const b = contiguous(10);
  b[5].t += 512 / SR; // a block reported 512 samples late
  const bad = captureHealth(b, SR);
  expect(bad.ok).toBe(false);
  expect(bad.discontinuities.map((d) => d.deltaSamples)).toEqual([512, -512]);
  expect(bad.reason).toMatch(/2 discontinuities/);

  const dropped = contiguous(10).filter((_, i) => i !== 4); // a whole block lost
  expect(captureHealth(dropped, SR)).toMatchObject({ ok: false, capturedSamples: 9 * N, expectedSamples: 10 * N });
  expect(captureHealth([], SR)).toMatchObject({ ok: false, reason: "no audio blocks captured" });
});

test("glitchReason: capture health and late (starved) steps", () => {
  expect(glitchReason({ health: captureHealth(contiguous(3), SR), lateSteps: [] })).toBe("");
  expect(glitchReason({ health: captureHealth(contiguous(3), SR), lateSteps: [{ time: 1, at: 1.2 }] })).toMatch(/1 step.*200\.0 ms late/);
});

test("retry policy: a pass is never retried; a failure on a clean capture is never retried", async () => {
  let runs = 0;
  await retryOnCaptureGlitch(info(), async ({ track }) => {
    runs++;
    track({ health: { ok: false, reason: "jitter" } }); // glitch flags alone don't matter when the asserts pass
  });
  expect(runs).toBe(1);

  runs = 0;
  const err = await retryOnCaptureGlitch(info(), async ({ track }) => {
    runs++;
    track({ health: captureHealth(contiguous(3), SR) });
    expect(5.3, "drift ms").toBeLessThan(3);
  }).catch((e) => e);
  expect(runs).toBe(1);
  expect(err).not.toBeInstanceOf(CaptureGlitch);
  expect(err.message).toMatch(/drift ms/);
});

test("retry policy: a failure on a glitched capture runs once more; twice -> CaptureGlitch with both reasons", async () => {
  let runs = 0;
  const ti = info();
  await retryOnCaptureGlitch(ti, async ({ track }) => {
    runs++;
    track({ health: runs === 1 ? { ok: false, reason: "2 discontinuities" } : { ok: true } });
    if (runs === 1) expect(5.3).toBeLessThan(3);
  });
  expect(runs).toBe(2);
  expect(ti.annotations.map((a) => a.type)).toEqual(["capture-glitch"]);

  runs = 0;
  const err = await retryOnCaptureGlitch(info(), async ({ track }) => {
    runs++;
    track({ health: { ok: false, reason: "2 discontinuities" } });
    expect(5.3).toBeLessThan(3);
  }).catch((e) => e);
  expect(runs).toBe(2);
  expect(err).toBeInstanceOf(CaptureGlitch);
  expect(err.message).toMatch(/capture glitch.*2 discontinuities.*twice in a row/s);
});
