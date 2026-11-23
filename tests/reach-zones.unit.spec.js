// Reach zones (src/input/reach-zones.js) + sideways axes (src/core/axes.js) + Drive gain math, in Node.
// User feedback (real camera): the up/down range "keeps changing. It should just be 75% of the size of the screen."
// -> height = palm y over the FIXED middle 75 % of the display height, for both hands, whatever the hand does.
import { test, expect } from "@playwright/test";
import {
  BAND, ZONE, zoneFor, heightIn, yForHeight, xIn, xForValue, bandPos, deadZone,
} from "../src/input/reach-zones.js";
import { buildHandFrame, createHandInput, makeView } from "../src/input/hand-input.js";
import { createBus } from "../src/core/bus.js";
import { AXES, createAxes, outward } from "../src/core/axes.js";
import { driveGains, DRIVE } from "../src/services/audio.js";
import { hand, rightHand, leftHand, fist, results, handGeometry, IDENTITY_VIEW, DESKTOP_VIEW } from "./helpers/hands.js";

const VIEWS = { identity: IDENTITY_VIEW, desktop: DESKTOP_VIEW, phone: makeView(640, 480, 390, 844) };
const SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const frameOf = (h, view) => buildHandFrame(h.landmarks, h.handedness, { view });

test.describe("reach zones: vertical (fixed band, middle 75 % of the screen)", () => {
  test("the band: palm y 12.5 % (height 1) .. 87.5 % (height 0) of the display height, same on both sides", () => {
    expect(BAND.TOP).toBe(0.125);
    expect(BAND.BOTTOM).toBe(0.875);
    expect(BAND.BOTTOM - BAND.TOP).toBeCloseTo(0.75, 12);
    for (const side of ["left", "right"]) {
      const z = zoneFor(side);
      expect(z.top, side).toBe(BAND.TOP);
      expect(z.bottom, side).toBe(BAND.BOTTOM);
      expect(heightIn(z, 0.125), side).toBe(1);
      expect(heightIn(z, 0.875), side).toBe(0);
      expect(heightIn(z, 0.5), side).toBeCloseTo(0.5, 12);
      expect(heightIn(z, 0.3125), side).toBeCloseTo(0.75, 12);
    }
  });

  for (const [vname, view] of Object.entries(VIEWS)) {
    test(`${vname} view: the palm's display y alone sets the height (hand size and shape never move the band)`, () => {
      for (const scale of SCALES) {
        for (const shape of ["open", "fist", "thumb", "pinch"]) {
          for (const volume of [0, 0.25, 0.5, 0.75, 1]) {
            const opts = { volume, scale, view };
            const h = shape === "fist" ? fist(opts) : shape === "pinch" ? hand({ ...opts, handedness: "Right", pinch: true })
              : rightHand(4, { ...opts, thumb: shape === "thumb" });
            const f = frameOf(h, view);
            const label = `${vname} scale ${scale} ${shape} volume ${volume}`;
            expect(f.height, label).toBeCloseTo(volume, 6);
            expect(f.pos.y, label).toBeCloseTo(BAND.BOTTOM - volume * (BAND.BOTTOM - BAND.TOP), 6);
            expect([f.zone.top, f.zone.bottom], label).toEqual([BAND.TOP, BAND.BOTTOM]);
          }
        }
      }
    });
  }

  test("clamping: palm above the band = 1, below = 0; yForHeight inverts heightIn", () => {
    const z = zoneFor("right");
    expect(heightIn(z, 0.05)).toBe(1);
    expect(heightIn(z, 0)).toBe(1);
    expect(heightIn(z, 0.95)).toBe(0);
    expect(heightIn(z, 1)).toBe(0);
    for (const h of [0, 0.1, 0.37, 0.5, 0.9, 1]) expect(heightIn(z, yForHeight(z, h))).toBeCloseTo(h, 9);
    expect(yForHeight(z, 2)).toBeCloseTo(z.top, 12);
    expect(yForHeight(z, -1)).toBeCloseTo(z.bottom, 12);
  });

  test("a still palm keeps exactly its height while the hand size jitters, the hand comes closer or changes shape", () => {
    const bus = createBus();
    const hi = createHandInput({ bus });
    const pos = { x: 0.3, y: 0.4 };
    const want = (BAND.BOTTOM - pos.y) / (BAND.BOTTOM - BAND.TOP);
    const zones = new Set();
    for (let i = 0; i < 120; i++) {
      const scale = i < 60 ? (i % 2 ? 1.1 : 0.9) : 1.6; // ±10 % size jitter at 30 fps, then a much closer hand
      const shape = i % 3 === 0 ? { fist: true } : i % 3 === 1 ? { fingers: ["index", "middle"] } : { pinch: true };
      const r = hi.process(results(hand({ handedness: "Left", pos, scale, ...shape, view: IDENTITY_VIEW })), i * 33);
      expect(r.left.height, `frame ${i}`).toBeCloseTo(want, 9);
      expect(bus.get("left/height"), `frame ${i}`).toBeCloseTo(want, 9);
      const z = bus.get("left/zone");
      zones.add(`${z.top}|${z.bottom}`);
    }
    expect([...zones]).toEqual([`${BAND.TOP}|${BAND.BOTTOM}`]);
  });
});

test.describe("reach zones: horizontal", () => {
  test("band on the hand's own side, inner end near the middle; left side mirrors right", () => {
    const r = zoneFor("right");
    const l = zoneFor("left");
    expect(r.inner).toBeCloseTo(0.56, 9);
    expect(r.outer).toBeCloseTo(0.88, 9);
    expect(l.inner).toBeCloseTo(1 - r.inner, 9);
    expect(l.outer).toBeCloseTo(1 - r.outer, 9);
    expect(xIn(r, 0.95)).toBe(1); // clamped beyond the outer end
    expect(xIn(l, 0.02)).toBe(1);
    expect(xIn(r, 0.3)).toBe(0); // crossed the middle
  });

  test("dead zone: the middle of the band reads exactly 0.5; outside it rescales to reach 0 and 1; monotonic", () => {
    const z = zoneFor("right");
    const mid = (z.inner + z.outer) / 2;
    const w = z.outer - z.inner;
    for (const d of [0, 0.03, -0.03, 0.079, -0.079]) expect(xIn(z, mid + d * w)).toBe(0.5);
    expect(xIn(z, z.inner)).toBe(0);
    expect(xIn(z, z.outer)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = xIn(z, z.inner + (i / 100) * w);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(deadZone(0.5 + ZONE.DEAD_ZONE / 2 + 1e-6)).toBeGreaterThan(0.5);
    for (const v of [0, 0.2, 0.45, 0.5, 0.7, 1]) expect(xIn(z, xForValue(z, v))).toBeCloseTo(v, 9);
    expect(bandPos(z, mid)).toBeCloseTo(0.5, 9);
  });

  test("helper x placement: a hand at x 0 / 1 stays whole in frame on either side (desktop view, default-size hand)", () => {
    for (const handedness of ["Left", "Right"]) {
      for (const xv of [0, 1]) {
        const h = hand({ handedness, fingers: ["index", "middle", "ring", "pinky"], x: xv, view: DESKTOP_VIEW });
        const f = frameOf(h, DESKTOP_VIEW);
        expect(f.x, `${handedness} x ${xv}`).toBeCloseTo(xv, 6);
        for (const p of handGeometry(h.landmarks, DESKTOP_VIEW).pts) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

test.describe("reach zones: hand input", () => {
  test("createHandInput publishes left|right/x (only while its axis is on) and /zone (null when lost), honours ui/sides", () => {
    const bus = createBus();
    const hi = createHandInput({ bus });
    const seen = [];
    bus.subscribe({ onSet: (n, v) => seen.push([n, v]) }, ["left/x", "right/x", "left/zone", "right/zone"]);
    // Drive / Space are experimental and off by default: no x on the bus (nor on the wire).
    hi.process(results(leftHand(1), rightHand(2)), 0);
    expect(bus.get("left/x")).toBeUndefined();
    expect(bus.get("right/x")).toBeUndefined();
    expect(seen.filter(([n]) => n.endsWith("/x"))).toEqual([]);
    expect(typeof hi.process(results(leftHand(1), rightHand(2)), 1).left.x).toBe("number"); // HandFrame.x still computed
    bus.set("space/on", true);
    bus.set("drive/on", true);
    hi.process(results(leftHand(1), rightHand(2)), 2);
    expect(typeof bus.get("left/x")).toBe("number");
    expect(typeof bus.get("right/x")).toBe("number");
    // helper default (real use): left palm displays at x 0.3 (left half), right palm at 0.7 (right half)
    expect(bus.get("left/zone").side).toBe("left");
    expect(bus.get("right/zone").side).toBe("right");
    bus.set("ui/sides", { chord: "right", expr: "left" }); // the UI's decision wins over the palm guess
    hi.process(results(leftHand(1), rightHand(2)), 33);
    expect(bus.get("left/zone").side).toBe("right");
    expect(bus.get("right/zone").side).toBe("left");
    for (const side of ["left", "right"]) {
      expect(bus.get(`${side}/zone`).top).toBe(BAND.TOP);
      expect(bus.get(`${side}/zone`).bottom).toBe(BAND.BOTTOM);
    }
    hi.process(results(leftHand(1)), 99);
    expect(bus.get("right/x")).toBeNull();
    expect(bus.get("right/zone")).toBeNull();
    // Switched off again: x goes null once, then nothing more is published.
    bus.set("space/on", false);
    hi.process(results(leftHand(1)), 132);
    expect(bus.get("left/x")).toBeNull();
    const n = seen.length;
    for (let t = 165; t < 400; t += 33) hi.process(results(leftHand(1, { x: 1 })), t);
    expect(seen.slice(n).filter(([name]) => name === "left/x")).toEqual([]);
  });
});

test.describe("sideways axes (src/core/axes.js)", () => {
  function setup() {
    const bus = createBus();
    const calls = { drive: [], space: [] };
    const audio = { setDrive: (v) => calls.drive.push(v), setSpace: (v) => calls.space.push(v) };
    return { bus, calls, axes: createAxes({ bus, audio }) };
  }
  const f = (x) => ({ x });

  test("the table: right x = Drive, left x = Space; outward from the middle only", () => {
    expect(AXES.map((a) => [a.id, a.source, a.param])).toEqual([["drive", "right/x", "drive"], ["space", "left/x", "space"]]);
    expect(outward(0)).toBe(0);
    expect(outward(0.5)).toBe(0);
    expect(outward(0.75)).toBeCloseTo(0.5, 9);
    expect(outward(1)).toBe(1);
    expect(outward(null)).toBeNull();
  });

  test("experimental: both switches OFF by default; off = no param published, audio untouched, hand ignored", () => {
    const { bus, calls, axes } = setup();
    expect(bus.get("drive/on")).toBe(false);
    expect(bus.get("space/on")).toBe(false);
    expect(axes.isOn("drive")).toBe(false);
    for (let t = 0; t < 600; t += 16) axes.update(f(1), f(1), { now: t });
    expect(bus.get("drive")).toBeUndefined();
    expect(bus.get("space")).toBeUndefined();
    expect(calls.drive).toEqual([]);
    expect(calls.space).toEqual([]);
    expect(axes.values).toEqual({ drive: 0, space: 0 });
  });

  test("switched on: hand x drives the params (smoothed, first frame direct); off again = 0 once, hand ignored", () => {
    const { bus, calls, axes } = setup();
    axes.setOn("drive", true);
    axes.setOn("space", true);
    expect(bus.get("drive/on")).toBe(true);
    axes.update(f(1), f(1), { now: 0 });
    expect(bus.get("drive")).toBe(1);
    expect(bus.get("space")).toBe(1);
    expect(calls.drive.at(-1)).toBe(1);
    axes.update(f(0.5), f(0.5), { now: 16 });
    expect(bus.get("drive")).toBeGreaterThan(0.5); // smoothed (60 ms)
    for (let t = 32; t < 600; t += 16) axes.update(f(0.5), f(0.5), { now: t });
    expect(bus.get("drive")).toBe(0);
    axes.update(f(1), f(1), { now: 650 });
    expect(bus.get("drive")).toBeGreaterThan(0);
    bus.set("drive/on", false);
    const n = calls.drive.length;
    for (let t = 700; t < 1300; t += 16) axes.update(f(1), f(1), { now: t });
    expect(bus.get("drive")).toBe(0);
    expect(calls.drive.slice(n)).toEqual([0]); // neutral sound, once
    expect(bus.get("space")).toBe(1);
    axes.setOn("drive", true);
    for (let t = 1300; t < 1900; t += 16) axes.update(f(1), f(1), { now: t });
    expect(bus.get("drive")).toBe(1);
  });

  test("a lost hand and a held right hand (menu) hold the value", () => {
    const { bus, axes } = setup();
    axes.setOn("drive", true);
    axes.setOn("space", true);
    axes.update(f(0.9), f(0.9), { now: 0 });
    const d = bus.get("drive");
    axes.update(null, null, { now: 16 });
    expect(bus.get("drive")).toBe(d);
    axes.update(f(0.5), f(0.5), { now: 32, rightHeld: true });
    expect(bus.get("drive")).toBe(d);
    expect(bus.get("space")).toBe(0); // left stays live while the menu holds the right hand
  });
});

test.describe("Drive gain math (src/services/audio.js)", () => {
  test("a signal at the reference level keeps its peak (x COMP trim); drive 0 is ~unity", () => {
    for (const d of [0, 0.25, 0.5, 1]) {
      const { pre, post, g } = driveGains(d);
      expect(pre * DRIVE.CURVE_K).toBeCloseTo(g, 9);
      const comp = 1 - (1 - DRIVE.COMP) * d;
      expect(post * Math.tanh(g * DRIVE.REF)).toBeCloseTo(comp * DRIVE.REF, 9);
    }
    const { post, g } = driveGains(0);
    for (const x of [0.05, 0.3, 0.6]) expect(post * Math.tanh(g * x)).toBeCloseTo(x, 3);
    // full drive saturates: a 2x louder input is far less than 2x louder
    const full = driveGains(1);
    expect((full.post * Math.tanh(full.g * 0.6)) / (full.post * Math.tanh(full.g * 0.3))).toBeLessThan(1.1);
  });
});
