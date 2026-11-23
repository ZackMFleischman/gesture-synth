// Timing helpers for the output e2e tests (tests/output.spec.js, tests/m3-output.spec.js). Browser-side only.
//
// Two different things are measured, and kept apart (docs/testing.md "Timing tolerance policy"):
//  1. WHEN the visualizer says a beat / note happens: its beat clock (beat grid + ping-synced offset) and the
//     note playTimes, compared with the synth's AUDIO-clock times of the same beats / notes. This is the spec
//     requirement ("the visualizer shows it at the correct time") and must hold even on a loaded machine.
//  2. WHEN the browser painted it: the first render frame at/after that time. The visualizer's logic is checked
//     strictly (drawn in the first frame at or after its time); the paint delay itself is bounded only for frames
//     that came on time. A frame that came late (rAF gap above the tolerance: a starved main thread) is a
//     "render-stall" — annotated and reported like a capture glitch, not a timing failure of the output.

import { expect } from "@playwright/test";

/**
 * Synth-side log on the shared clock (epoch ms): AudioContext times converted with getOutputTimestamp, the same
 * way the output converts playTime. Logs clock transport changes, beats and note events into window.__m3.
 */
export async function installSynthLog(page) {
  await page.evaluate(() => {
    const { bus, ctx } = window.__gsTest;
    const ac = ctx.audio.ac;
    const toEpoch = (t) => {
      const ts = ac.getOutputTimestamp();
      return performance.timeOrigin + ts.performanceTime + (t - ts.contextTime) * 1000;
    };
    const now = () => performance.timeOrigin + performance.now();
    const L = (window.__m3 = { transport: [], beats: [], notes: [] });
    ctx.clock.onTransport((what) => L.transport.push({ what, epoch: now(), bpm: ctx.clock.bpm, running: ctx.clock.running }));
    bus.subscribe(
      {
        onEvent(n, d, pt) {
          if (n === "beat") L.beats.push({ beat: d, epoch: toEpoch(pt), sent: now() });
          else L.notes.push({ n, id: d.id, midi: d.midi, voice: d.voice, epoch: toEpoch(pt), sent: now() });
        },
      },
      ["beat", "note/on", "note/off", "note/cancel"]
    );
  });
}

// A grid re-anchor (one per beat) can move a computed beat time by a few ms after the frame before it was drawn.
const REANCHOR_SLACK_MS = 5;

/**
 * Render check for items the visualizer drew: [{due, shown, prevFrame}] in visualizer-page ms (due = the time
 * it was due by the visualizer's clock, shown = the rAF time it was drawn, prevFrame = the frame before).
 * Asserts the first-frame rule for every item and `shown - due < lateMs` for every item whose frame was not
 * stalled. Stalled frames are annotated on the test (type "render-stall") and returned.
 */
export function checkRender(info, label, items, { lateMs, longTasks = [] }) {
  const stalls = [];
  for (const it of items) {
    expect(it.shown - it.due, `${label}: drawn before it was due`).toBeGreaterThanOrEqual(0);
    expect(it.prevFrame - it.due, `${label}: not drawn in the first frame at/after its time`).toBeLessThan(REANCHOR_SLACK_MS);
    const gap = it.shown - it.prevFrame;
    if (gap >= lateMs) {
      stalls.push({ late: +(it.shown - it.due).toFixed(1), frameGap: +gap.toFixed(1) });
      continue;
    }
    expect(it.shown - it.due, `${label}: paint delay on a frame that came on time`).toBeLessThan(lateMs);
  }
  if (stalls.length) {
    const lt = longTasks.length ? `; ${longTasks.length} long task(s) in the visualizer, longest ${Math.max(...longTasks.map((t) => t.duration)).toFixed(0)} ms` : "";
    info.annotations.push({
      type: "render-stall",
      description: `${label}: ${stalls.length}/${items.length} drawn on a late frame (main thread starved, test environment): ${JSON.stringify(stalls)}${lt}`,
    });
    console.log(`[render-stall] ${label}: ${JSON.stringify(stalls)}${lt}`);
  }
  // With several items, most frames must come on time: otherwise the visualizer itself is too slow (not a stall).
  if (items.length >= 4) expect(stalls.length, `${label}: render stalls on most frames`).toBeLessThanOrEqual(Math.floor(items.length / 2));
  return stalls;
}
