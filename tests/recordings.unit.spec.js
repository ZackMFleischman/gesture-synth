// Hand recordings as regression tests (Node, no browser). Every tests/fixtures/**/<name>.expect.json is a
// test: it replays <name>.json (saved by labs/gesture-test.html "Record") through createHandInput and checks
// the per-hand metrics it lists. Adding a real-hand case = drop the two files in tests/fixtures/, no code.
//
// <name>.expect.json:
//   { "description": "what the person did on camera",
//     "expect": { "right.pinchStarts": 3, "right.voicingChanges": { "max": 2 }, "left.framesSeen": { "min": 100 } } }
// A value is an exact number or { min, max }. Metrics: see METRICS below (per hand: left.* / right.*).
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { replayThrough, loadRecordingFile } from "./helpers/replay.js";

const FIXTURES = path.resolve("tests/fixtures");

/** Counts rising edges of `pred` over the frames where the hand is seen. */
const starts = (pred) => (fs) => fs.reduce((n, f, i) => n + (pred(f) && (i === 0 || !pred(fs[i - 1])) ? 1 : 0), 0);
/** Counts changes of `val` between consecutive frames where the hand is seen. */
const changes = (val, when = () => true) => (fs) => {
  const vs = fs.filter(when).map(val);
  return vs.reduce((n, v, i) => n + (i > 0 && v !== vs[i - 1] ? 1 : 0), 0);
};
const METRICS = {
  framesSeen: (fs) => fs.length,
  pinchStarts: starts((f) => f.pinch),
  pinchEnds: (fs) => starts((f) => !f.pinch)(fs) - (fs.length && !fs[0].pinch ? 1 : 0),
  fistStarts: starts((f) => f.fist),
  fistFrames: (fs) => fs.filter((f) => f.fist).length,
  fingerCountChanges: changes((f) => f.fingerCount),
  voicingChanges: changes((f) => f.voicingCount, (f) => !f.pinch && !f.fist), // flicker while playing
  thumbChanges: changes((f) => f.fingers.thumb, (f) => !f.pinch),
};

function handMetrics(frames) {
  const out = {};
  for (const hand of ["left", "right"]) {
    const seen = frames.map((f) => f[hand]).filter(Boolean);
    for (const [name, fn] of Object.entries(METRICS)) out[`${hand}.${name}`] = fn(seen);
  }
  return out;
}

const cases = fs.readdirSync(FIXTURES, { recursive: true }).filter((f) => f.endsWith(".expect.json")).sort();

test("at least one recording case is checked in", () => {
  expect(cases.length).toBeGreaterThan(0);
});

for (const file of cases) {
  test(`recording: ${file.replace(/\.expect\.json$/, "")}`, () => {
    const spec = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
    const rec = loadRecordingFile(path.join(FIXTURES, file.replace(/\.expect\.json$/, ".json")));
    const got = handMetrics(replayThrough(rec));
    test.info().annotations.push({ type: "metrics", description: JSON.stringify(got) });
    for (const [name, want] of Object.entries(spec.expect || {})) {
      expect(Object.keys(got), `unknown metric "${name}"`).toContain(name);
      if (typeof want === "number") expect(got[name], name).toBe(want);
      else {
        if (want.min != null) expect(got[name], `${name} >= ${want.min}`).toBeGreaterThanOrEqual(want.min);
        if (want.max != null) expect(got[name], `${name} <= ${want.max}`).toBeLessThanOrEqual(want.max);
      }
    }
  });
}
