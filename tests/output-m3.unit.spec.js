// M3 hookups, pure pieces (Node): spec mapping of menu / pinch / note ids / note cancel, and the clock's
// transport notifications that make the output re-send its beat grid at once.
import { test, expect } from "@playwright/test";
import {
  addressOf, encodeValue, encodePinch, wireTypeOf, createMenuEncoder, PINCH_SOURCE,
} from "../src/output/protocol.js";
import { createClock } from "../src/services/clock.js";

test("spec signals: pinch, menu, voicing, noteset, octave, bpm, note/cancel map to their /gs addresses", () => {
  expect(addressOf("pinch")).toBe("/gs/pinch");
  expect(addressOf("menu")).toBe("/gs/menu");
  expect(addressOf("mode")).toBe("/gs/mode");
  expect(addressOf("voicing")).toBe("/gs/voicing");
  expect(addressOf("lead/noteset")).toBe("/gs/noteset");
  expect(addressOf("lead/octave")).toBe("/gs/octave");
  expect(addressOf("bpm")).toBe("/gs/bpm");
  expect(addressOf("note/cancel")).toBe("/gs/note/cancel");
  expect(PINCH_SOURCE).toBe("right/pinch");
  // Wire types: `menu` is a bus state but an event on the wire (spec "Events" table); others keep theirs.
  expect(wireTypeOf("menu", "state")).toBe("event");
  expect(wireTypeOf("mode", "state")).toBe("state");
  expect(wireTypeOf("pinch", "event")).toBe("event");
});

test("note events carry the id that pairs on with off / cancel", () => {
  const on = encodeValue("note/on", { freq: 220, midi: 57, voice: "arp", id: 42 });
  expect(on).toEqual({ voice: "arp", id: 42, note: 57, freq: 220 });
  expect(encodeValue("note/off", { freq: 220, midi: 57, voice: "arp", id: 42 }).id).toBe(42);
  expect(encodeValue("note/cancel", { freq: 220, midi: 57, voice: "arp", id: 42 })).toEqual(on);
  expect(encodeValue("note/on", { freq: 440, voice: "lead" })).toEqual({ voice: "lead", note: 69, freq: 440 }); // no id
});

test("pinch: 1 at start, 0 at release (boolean, number or object payloads)", () => {
  expect(encodePinch(true)).toBe(1);
  expect(encodePinch(false)).toBe(0);
  expect(encodePinch(1)).toBe(1);
  expect(encodePinch(0)).toBe(0);
  expect(encodePinch({ on: true, hand: "right" })).toBe(1);
  expect(encodePinch({ down: false })).toBe(0);
  expect(encodeValue("pinch", true)).toBe(1);
});

test("menu encoder: open -> arc/progress updates -> countdown -> close (confirmed) and cancel", () => {
  const enc = createMenuEncoder();
  expect(enc.encode(null)).toBeNull(); // closed and was closed: nothing to send
  expect(enc.encode({ state: "open", hoverId: null, selectedId: null, progress: 0 }))
    .toEqual({ phase: "open", state: "open", arc: null, selected: null, progress: 0 });
  expect(enc.encode({ state: "open", hoverId: "arp", selectedId: null, progress: 0.4 }))
    .toEqual({ phase: "update", state: "open", arc: "arp", selected: null, progress: 0.4 });
  expect(enc.encode({ state: "open", hoverId: "arp", selectedId: "arp", progress: 1 }))
    .toMatchObject({ phase: "update", arc: "arp", selected: "arp", progress: 1 });
  expect(enc.encode({ state: "countdown", hoverId: "arp", selectedId: "arp", confirmedId: "arp", progress: 0.1 }))
    .toEqual({ phase: "countdown", state: "countdown", arc: "arp", selected: "arp", confirmed: "arp", progress: 0.1 });
  expect(enc.encode({ state: "countdown", hoverId: "arp", selectedId: "arp", confirmedId: "arp", progress: 0.6 }).phase).toBe("update");
  expect(enc.open).toBe(true);
  expect(enc.encode(null)).toEqual({ phase: "close", state: "closed", confirmed: "arp", cancelled: false });
  expect(enc.open).toBe(false);
  // Open, then the hand opens with nothing selected: close = cancelled.
  enc.encode({ state: "open", hoverId: "lead", selectedId: null, progress: 0.3 });
  expect(enc.encode(null)).toEqual({ phase: "close", state: "closed", confirmed: null, cancelled: true });
  // A `closed` object counts as closed too.
  expect(enc.encode({ state: "closed" })).toBeNull();
});

test("clock: onTransport reports start / bpm / rate / double / stop once the state reflects the change", () => {
  const ac = { currentTime: 0 };
  const clock = createClock(ac, { startDelay: 0.05, bpm: 120 });
  const log = [];
  const off = clock.onTransport((what) => log.push({ what, running: clock.running, bpm: clock.bpm, rate: clock.rate, dbl: clock.doubleTime }));
  clock.start();
  clock.bpm = 90;
  clock.bpm = 90; // no change -> no notification
  clock.rate = 1 / 16;
  clock.rate = 0.3; // invalid -> ignored
  clock.doubleTime = true;
  clock.stop();
  expect(log).toEqual([
    { what: "start", running: true, bpm: 120, rate: 1 / 8, dbl: false },
    { what: "bpm", running: true, bpm: 90, rate: 1 / 8, dbl: false },
    { what: "rate", running: true, bpm: 90, rate: 1 / 16, dbl: false },
    { what: "double", running: true, bpm: 90, rate: 1 / 16, dbl: true },
    { what: "stop", running: false, bpm: 90, rate: 1 / 16, dbl: true },
  ]);
  off();
  clock.bpm = 100;
  expect(log.length).toBe(5);
  // The grid reference right after start is the first beat (what the output sends at once).
  clock.start();
  expect(clock.nextBeatTime()).toBeCloseTo(0.05, 12);
  expect(Math.round(clock.beatAt(clock.nextBeatTime()))).toBe(0);
  clock.stop();
});
