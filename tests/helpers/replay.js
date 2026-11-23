// Record/replay helpers for tests.
//
// Recordings are the JSON files saved by the "Record" button on labs/gesture-test.html
// (format: src/input/replay.js). Two ways to use one in a test:
//   1. In the browser, real time:   await page.goto(replayUrl("tests/fixtures/my.json"))
//      (works for "/" and "/labs/gesture-test.html"; the dev server serves the repo root).
//   2. In Node, frame by frame:     const frames = replayThrough(loadRecordingFile("tests/fixtures/my.json"))
//      -> [{ t, left, right }] HandFrames from the same createHandInput pipeline, no browser.

import fs from "node:fs";
import { createHandInput, makeView } from "../../src/input/hand-input.js";
import { createBus } from "../../src/core/bus.js";
import { RECORDING_FORMAT, snapshotResults } from "../../src/input/replay.js";
import { results, leftHand, rightHand, pinch } from "./hands.js";

export const SAMPLE_RECORDING = "tests/fixtures/sample-recording.json";

/** URL that replays `file` (repo-relative path) on `page` ("/" = the app). */
export function replayUrl(file, page = "/", { loop = false } = {}) {
  return `${page}?replay=/${file.replace(/^\//, "")}${loop ? "&replayLoop" : ""}`;
}

export function loadRecordingFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Builds a recording from a function of time: handsAt(tMs) -> array of hands.js hands.
 * @returns recording object (same format as the test page saves)
 */
export function buildRecording(handsAt, { durationMs, fps = 20, video = { width: 640, height: 480 }, note } = {}) {
  const frames = [];
  for (let t = 0; t <= durationMs + 1e-9; t += 1000 / fps) {
    frames.push({ t: Math.round(t * 10) / 10, ...snapshotResults(results(...handsAt(t))) });
  }
  return {
    format: RECORDING_FORMAT, version: 1, createdAt: "1970-01-01T00:00:00.000Z",
    durationMs: frames[frames.length - 1].t, video, note, frames,
  };
}

/**
 * Feeds every frame through a fresh createHandInput (Node, no browser).
 * `view` defaults to the recording's camera size on a same-aspect canvas (no crop).
 */
export function replayThrough(rec, { view } = {}) {
  const input = createHandInput({ bus: createBus() });
  const { width = 1, height = 1 } = rec.video || {};
  input.setView(view || makeView(width || 1, height || 1, width || 1, height || 1));
  return rec.frames.map((f) => {
    const { left, right } = input.process(f, f.t);
    return { t: f.t, left, right };
  });
}

/**
 * The checked-in sample (tests/fixtures/sample-recording.json): 4 s at 20 fps.
 * Left hand degree I throughout; right hand voicing 2, a pinch from 1.5-2.7 s (0.2 s approach,
 * index curled onto the thumb = the "OK" shape), then voicing 2 again.
 */
export function sampleRecording() {
  return buildRecording((t) => {
    let right;
    if (t < 1500 || t >= 2700) right = rightHand(2);
    else if (t < 1700) right = pinch({ distance: 0.8 - ((t - 1500) / 200) * 0.7, volume: 0.8 });
    else right = pinch({ distance: 0.1, volume: 0.8 });
    return [leftHand(1), right];
  }, { durationMs: 4000, note: "synthetic: tests/helpers/replay.js sampleRecording()" });
}

/** Regenerate the fixture: node -e 'import("./tests/helpers/replay.js").then(m => m.writeSampleRecording())' */
export function writeSampleRecording(file = SAMPLE_RECORDING) {
  fs.writeFileSync(file, JSON.stringify(sampleRecording()));
}
