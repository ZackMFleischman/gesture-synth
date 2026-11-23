// Reach zones (src/input/reach-zones.js) + sideways axes (src/core/axes.js) + Drive gain math, in Node.
// User feedback: "I can't reach all the way to the top or bottom because my hand starts to get cut off."
import { test, expect } from "@playwright/test";
import {
  RANGE_PRESETS, ZONE, zoneFor, heightIn, yForHeight, xIn, xForValue, bandPos, deadZone, handExtents,
  createZoneSmoother,
} from "../src/input/reach-zones.js";
import { buildHandFrame, createHandInput, makeView } from "../src/input/hand-input.js";
import { createBus } from "../src/core/bus.js";
import { AXES, createAxes, outward } from "../src/core/axes.js";
import { driveGains, DRIVE } from "../src/services/audio.js";
import { hand, rightHand, leftHand, fist, results, handGeometry, IDENTITY_VIEW, DESKTOP_VIEW } from "./helpers/hands.js";

const VIEWS = { identity: IDENTITY_VIEW, desktop: DESKTOP_VIEW, phone: makeView(640, 480, 390, 844) };
const SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const frameOf = (h, view) => buildHandFrame(h.landmarks, h.handedness, { view });

test.describe("reach zones: vertical", () => {
  for (const [vname, view] of Object.entries(VIEWS)) {
    test(`${vname} view: at height 1 and 0 the whole hand (all 21 landmarks) stays in frame, scales 0.5-2`, () => {
      for (const scale of SCALES) {
        for (const shape of ["open", "fist", "thumb"]) {
          for (const volume of [0, 1]) {
            const opts = { volume, scale, view };
            const h = shape === "fist" ? fist(opts) : rightHand(4, { ...opts, thumb: shape === "thumb" });
            const f = frameOf(h, view);
            const label = `${vname} scale ${scale} ${shape} volume ${volume}`;
            expect(f.height, label).toBeCloseTo(volume, 6);
            const { pts } = handGeometry(h.landmarks, view);
            for (const p of pts) {
              expect(p.y, `${label}: landmark y`).toBeGreaterThanOrEqual(0);
              expect(p.y, `${label}: landmark y`).toBeLessThanOrEqual(1);
            }
            // The margin is kept whenever the hand fits in a band of MIN_SPAN.
            if (f.zone.bottom - f.zone.top > ZONE.MIN_SPAN + 1e-9) {
              const ys = pts.map((p) => p.y);
              expect(Math.min(...ys), label).toBeGreaterThanOrEqual(ZONE.MARGIN - 1e-9);
              expect(Math.max(...ys), label).toBeLessThanOrEqual(1 - ZONE.MARGIN + 1e-9);
            }
          }
        }
      }
    });
  }

  test("comfort band: palm 20%..80% for a small hand; a bigger (closer) hand gets a narrower band inside it", () => {
    const small = zoneFor({ up: 0.05, down: 0.04, side: 0.04 });
    expect(small.top).toBeCloseTo(0.2, 9);
    expect(small.bottom).toBeCloseTo(0.8, 9);
    const big = zoneFor({ up: 0.3, down: 0.22, side: 0.1 });
    expect(big.top).toBeCloseTo(0.33, 9);
    expect(big.bottom).toBeCloseTo(0.75, 9);
  });

  test("presets nest: wide contains comfort contains compact", () => {
    const ext = { up: 0.05, down: 0.04, side: 0.04 };
    const [w, c, k] = ["wide", "comfort", "compact"].map((r) => zoneFor(ext, "right", r));
    expect(w.top).toBeLessThan(c.top);
    expect(c.top).toBeLessThan(k.top);
    expect(w.bottom).toBeGreaterThan(c.bottom);
    expect(c.bottom).toBeGreaterThan(k.bottom);
    expect(zoneFor(ext, "right", "nonsense").range).toBe("comfort");
    expect(Object.keys(RANGE_PRESETS)).toEqual(["comfort", "wide", "compact"]);
  });

  test("clamping: palm above the band = 1, below = 0; yForHeight inverts heightIn", () => {
    const z = zoneFor({ up: 0.05, down: 0.04, side: 0.04 });
    expect(heightIn(z, 0.05)).toBe(1);
    expect(heightIn(z, 0.95)).toBe(0);
    for (const h of [0, 0.1, 0.37, 0.5, 0.9, 1]) expect(heightIn(z, yForHeight(z, h))).toBeCloseTo(h, 9);
    expect(yForHeight(z, 2)).toBeCloseTo(z.top, 12);
  });

  test("a hand too big to fit gets a centered band of MIN_SPAN (no inverted band)", () => {
    const z = zoneFor({ up: 0.6, down: 0.5, side: 0.2 });
    expect(z.bottom - z.top).toBeCloseTo(ZONE.MIN_SPAN, 9);
    expect(heightIn(z, (z.top + z.bottom) / 2)).toBeCloseTo(0.5, 9);
  });

  test("extents: at least the hand-size ratios (a fist does not widen the band), more when the hand reaches further", () => {
    const pos = { x: 0.5, y: 0.5 };
    const tight = handExtents([{ x: 0.5, y: 0.49 }], pos, 0.1);
    expect(tight.up).toBeCloseTo(ZONE.UP * 0.1, 9);
    expect(tight.down).toBeCloseTo(ZONE.DOWN * 0.1, 9);
    const far = handExtents([{ x: 0.5, y: 0.2 }, { x: 0.9, y: 0.5 }], pos, 0.1);
    expect(far.up).toBeCloseTo(0.3, 9);
    expect(far.side).toBeCloseTo(0.4, 9);
    // side is in display WIDTHS: handSize (display heights) / aspect
    expect(handExtents([], pos, 0.1, 2).side).toBeCloseTo((ZONE.SIDE * 0.1) / 2, 9);
  });
});

test.describe("reach zones: horizontal", () => {
  test("band on the hand's own side, inner end near the middle; left side mirrors right", () => {
    const ext = { up: 0.05, down: 0.04, side: 0.04 };
    const r = zoneFor(ext, "right");
    const l = zoneFor(ext, "left");
    expect(r.inner).toBeCloseTo(0.56, 9);
    expect(r.outer).toBeCloseTo(0.92, 9);
    expect(l.inner).toBeCloseTo(1 - r.inner, 9);
    expect(l.outer).toBeCloseTo(1 - r.outer, 9);
    expect(xIn(r, 0.95)).toBe(1); // clamped beyond the outer end
    expect(xIn(l, 0.02)).toBe(1);
    expect(xIn(r, 0.3)).toBe(0); // crossed the middle
    // outer end keeps the whole hand inside: a wide hand pulls it in
    const wide = zoneFor({ up: 0.05, down: 0.04, side: 0.12 }, "right");
    expect(wide.outer).toBeCloseTo(1 - 0.12 - ZONE.MARGIN, 9);
  });

  test("dead zone: the middle of the band reads exactly 0.5; outside it rescales to reach 0 and 1; monotonic", () => {
    const z = zoneFor({ up: 0.05, down: 0.04, side: 0.04 }, "right");
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

  test("helper x placement: a hand at x 0 / 1 stays whole in frame on either side (desktop view)", () => {
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

test.describe("reach zones: smoothing", () => {
  test("first frame sets the extents directly; jittering hand size moves the band far less than raw", () => {
    const sm = createZoneSmoother();
    const base = { up: 0.2, down: 0.15, side: 0.1 };
    expect(sm.update(base, 0)).toEqual(base);
    let rawSpread = 0, smSpread = 0;
    let lo = Infinity, hi = -Infinity, rlo = Infinity, rhi = -Infinity;
    for (let i = 1; i <= 120; i++) {
      const k = i % 2 ? 1.1 : 0.9; // ±10 % hand-size jitter every frame (30 fps)
      const raw = { up: base.up * k, down: base.down * k, side: base.side * k };
      const top = zoneFor(sm.update(raw, i * 33)).top;
      const rtop = zoneFor(raw).top;
      if (i > 30) { lo = Math.min(lo, top); hi = Math.max(hi, top); rlo = Math.min(rlo, rtop); rhi = Math.max(rhi, rtop); }
    }
    rawSpread = rhi - rlo;
    smSpread = hi - lo;
    expect(rawSpread).toBeGreaterThan(0.03);
    expect(smSpread).toBeLessThan(rawSpread / 8);
    // a real size change is followed within ~1 s
    for (let i = 0; i < 40; i++) sm.update({ up: 0.3, down: 0.2, side: 0.1 }, 5000 + i * 33);
    expect(sm.value.up).toBeGreaterThan(0.29);
    expect(sm.update(null, 7000)).toBeNull(); // lost: forget
    expect(sm.update(base, 7100)).toEqual(base);
  });

  test("small pose changes (tilt, pinch, fist: < HYST) leave the band exactly where it was", () => {
    const sm = createZoneSmoother();
    const base = { up: 0.2, down: 0.15, side: 0.1 };
    const z0 = zoneFor(sm.update(base, 0));
    for (let i = 1; i <= 60; i++) {
      const k = 1 + (ZONE.HYST * 0.9) * Math.sin(i);
      expect(zoneFor(sm.update({ up: base.up * k, down: base.down * k, side: base.side * k }, i * 33))).toEqual(z0);
    }
  });

  test("createHandInput publishes left|right/x and /zone (null when lost), honours ui/sides and reach/range", () => {
    const bus = createBus();
    const hi = createHandInput({ bus });
    const seen = [];
    bus.subscribe({ onSet: (n, v) => seen.push([n, v]) }, ["left/x", "right/x", "left/zone", "right/zone"]);
    hi.process(results(leftHand(1), rightHand(2)), 0);
    expect(typeof bus.get("left/x")).toBe("number");
    expect(typeof bus.get("right/x")).toBe("number");
    // helper default (real use): left palm displays at x 0.3 (left half), right palm at 0.7 (right half)
    expect(bus.get("left/zone").side).toBe("left");
    expect(bus.get("right/zone").side).toBe("right");
    bus.set("ui/sides", { chord: "right", expr: "left" }); // the UI's decision wins over the palm guess
    hi.process(results(leftHand(1), rightHand(2)), 33);
    expect(bus.get("left/zone").side).toBe("right");
    expect(bus.get("right/zone").side).toBe("left");
    bus.set("reach/range", "compact");
    hi.process(results(leftHand(1), rightHand(2)), 66);
    expect(bus.get("right/zone").range).toBe("compact");
    expect(bus.get("right/zone").top).toBeCloseTo(RANGE_PRESETS.compact.top, 3);
    hi.process(results(leftHand(1)), 99);
    expect(bus.get("right/x")).toBeNull();
    expect(bus.get("right/zone")).toBeNull();
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

  test("hand x drives the params (smoothed, first frame direct); switches on by default; off = 0, hand ignored", () => {
    const { bus, calls, axes } = setup();
    expect(bus.get("drive/on")).toBe(true);
    axes.update(f(1), f(1), { now: 0 });
    expect(bus.get("drive")).toBe(1);
    expect(bus.get("space")).toBe(1);
    expect(calls.drive.at(-1)).toBe(1);
    axes.update(f(0.5), f(0.5), { now: 16 });
    expect(bus.get("drive")).toBeGreaterThan(0.5); // smoothed (60 ms)
    for (let t = 32; t < 600; t += 16) axes.update(f(0.5), f(0.5), { now: t });
    expect(bus.get("drive")).toBe(0);
    bus.set("drive/on", false);
    for (let t = 700; t < 1300; t += 16) axes.update(f(1), f(1), { now: t });
    expect(bus.get("drive")).toBe(0);
    expect(bus.get("space")).toBe(1);
    axes.setOn("drive", true);
    for (let t = 1300; t < 1900; t += 16) axes.update(f(1), f(1), { now: t });
    expect(bus.get("drive")).toBe(1);
  });

  test("a lost hand and a held right hand (menu) hold the value", () => {
    const { bus, axes } = setup();
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
