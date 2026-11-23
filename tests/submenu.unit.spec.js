// Radial menu sub-menus (level 1 rings) and setting items: pure state-machine unit tests (Node).
// Spec: docs/spec/requirements.md "Sub-menu behavior". Lab (browser) tests: menu-lab.int.spec.js.
// Auto-select: crossing an item's select radius chooses it (settings: flash; the current one: no change); a submenu arc
// is never chosen, it opens its sub-ring after the SUB_OPEN_MS pass-through.
import { test, expect } from "@playwright/test";
import {
  createMenuState,
  MENU_GEOMETRY as G,
  MENU_TIMING as T,
  fanLayout,
  pickSlot,
  angDist,
  BACK_ID,
} from "../src/menu/menu-state.js";
import { setMenuConfig, resetMenuConfig } from "../src/menu/menu-config.js";

const INSTRUMENTS = ["warm", "bright", "retro", "organ", "electric", "sax"].map((id) => ({ id, label: id }));
// Fan order with the back sector up: up-left, left, down-left, down-right, right, up-right.
const ANGLE = { warm: -145, bright: 165, retro: 115, organ: 65, electric: 15, sax: -35 };
const DT = 16;
const PAST = G.SELECT_R + 0.1; // comfortably past a select radius

function makeItems({ current = () => "warm", children = INSTRUMENTS, setting = "sound/base" } = {}) {
  return [
    { id: "chords", type: "mode", label: "Chords", color: "#e8a13d", direction: "up" },
    { id: "arp", type: "mode", label: "Arp", color: "#4fb3ff", direction: "right" },
    { id: "lead", type: "mode", label: "Lead", color: "#c08cff", direction: "left" },
    { id: "sound", type: "submenu", label: "Sound", color: "#e8a13d", direction: "down", setting, items: children, current },
  ];
}

function rig({ items = makeItems(), current = "chords", aspect = 1, size = 0.1, x = 0.5, y = 0.35 } = {}) {
  const m = createMenuState({ items: () => items, currentId: () => current, aspect });
  const h = { fist: false, x, y, size, visible: true };
  let now = 1000;
  const frame = () =>
    h.visible ? { handedness: "Right", fist: h.fist, pos: { x: h.x, y: h.y }, handSize: h.size, t: now } : null;
  const results = [];
  const run = (ms) => {
    let r;
    const end = now + ms;
    do {
      now += DT;
      r = m.update(frame(), now);
      results.push(r);
    } while (now < end);
    return r;
  };
  /** Place the fist at (angle deg, dist hand sizes) from a center (default: the main ring's entry point). */
  const polar = (deg, d, c = { x, y }) => {
    h.x = c.x + Math.cos((deg * Math.PI) / 180) * d * h.size;
    h.y = c.y + Math.sin((deg * Math.PI) / 180) * d * h.size * aspect;
  };
  const subCenter = () => m.snapshot().center;
  /** Fist until the menu is open and its ring has grown in (selection armed). */
  const open = () => {
    h.fist = true;
    return run(T.ENTER_STABLE_MS + T.LEVEL_ARM_MS + 32);
  };
  /** Open the menu, go down through the Sound arc until the sub-ring opens, hold still while it grows in. */
  const enterSub = () => {
    open();
    polar(90, PAST);
    run(T.SUB_OPEN_MS + 2 * DT);
    return run(T.LEVEL_ARM_MS);
  };
  const release = () => {
    h.fist = false;
    return run(T.OPEN_DEBOUNCE_MS + DT);
  };
  const find = (k) => results.find((r) => r[k]);
  return { m, h, run, polar, subCenter, open, enterSub, release, find, results };
}

test.describe("sub-ring layout", () => {
  test("6 children fan around everything except a narrow back sector toward the parent", () => {
    const f = fanLayout(6, -90 + 360 * 0, G.BACK_SPAN_DEG); // back = up
    expect(f.span).toBe(50);
    expect(f.back).toEqual({ angle: -90, span: 60 });
    expect(f.angles.map((a) => Math.round(a))).toEqual([-145, 165, 115, 65, 15, -35]);
    // sectors tile the circle without overlap: every whole degree is in exactly one sector
    const slots = [{ angle: f.back.angle, span: f.back.span }, ...f.angles.map((angle) => ({ angle, span: f.span }))];
    for (let a = -179.5; a < 180; a += 1) {
      expect(slots.filter((s) => angDist(a, s.angle) < s.span / 2).length, `angle ${a}`).toBe(1);
    }
    // no child is centered straight down (the hand is already low): the nearest is 25° off vertical
    expect(Math.min(...f.angles.map((a) => angDist(a, 90)))).toBe(25);
  });

  test("layout follows the parent direction (a submenu on the right gets its back sector on the left)", () => {
    const f = fanLayout(4, 180);
    expect(angDist(f.back.angle, 180)).toBe(0);
    expect(f.span).toBe(75);
    expect(f.angles.map((a) => Math.round(a))).toEqual([112.5, 37.5, -37.5, -112.5].map(Math.round));
  });

  test("pickSlot: hysteresis between neighbouring narrow sectors (capped at 20% of the span)", () => {
    const f = fanLayout(6, -90);
    const slots = [{ key: BACK_ID, ...f.back }, ...f.angles.map((angle, i) => ({ key: INSTRUMENTS[i].id, angle, span: f.span }))];
    // boundary between retro (115) and bright (165) is 140
    expect(pickSlot(138, slots).key).toBe("retro");
    expect(pickSlot(142, slots).key).toBe("bright");
    expect(pickSlot(148, slots, "retro").key).toBe("retro"); // within 25 + 10
    expect(pickSlot(152, slots, "retro").key).toBe("bright");
    // back sector: -90 ± 30, its own hysteresis band ~10°
    expect(pickSlot(-62, slots).key).toBe(BACK_ID);
    expect(pickSlot(-58, slots).key).toBe("sax");
    expect(pickSlot(-52, slots, BACK_ID).key).toBe(BACK_ID);
    expect(pickSlot(-45, slots, BACK_ID).key).toBe("sax");
  });
});

test.describe("sub-menu state machine", () => {
  test.afterEach(() => resetMenuConfig());

  test("a submenu arc selects like any arc (no auto-select); opening the hand on it changes nothing", () => {
    const r = rig();
    r.open();
    r.polar(90, PAST);
    const res = r.run(3 * DT);
    expect(res.state).toBe("open");
    expect(res.selectedId).toBe("sound");
    expect(res.level).toBe(0);
    expect(r.m.snapshot().subPending).toBeGreaterThan(0);
    const end = r.release();
    expect(end.state).toBe("closed");
    expect(r.find("cancelled").reason).toBe("submenu");
    expect(r.find("setting")).toBeUndefined();
    expect(r.find("confirmed")).toBeUndefined();
  });

  test("the sub-ring opens after the fist stays past the outer edge for SUB_OPEN_MS; center = fist there", () => {
    const r = rig();
    r.open();
    r.polar(90, PAST);
    let res = r.run(T.SUB_OPEN_MS - 2 * DT);
    expect(res.level).toBe(0);
    expect(r.find("entered")).toBeUndefined();
    res = r.run(3 * DT);
    expect(res.level).toBe(1);
    expect(res.path).toEqual(["sound"]);
    expect(r.find("entered").entered).toBe("sound");
    const snap = r.m.snapshot();
    expect(snap.center).toEqual({ x: r.h.x, y: r.h.y });
    expect(snap.parent.center).toEqual({ x: 0.5, y: 0.35 });
    expect(snap.parent.hostId).toBe("sound");
    expect(snap.back.angle).toBe(-90);
    expect(snap.items.map((i) => i.id)).toEqual(INSTRUMENTS.map((i) => i.id));
    expect(snap.items.every((i) => i.color === "#e8a13d")).toBe(true); // children inherit the accent
    expect(snap.currentId).toBe("warm");
    // fresh ring: nothing hovered / selected at its center
    expect(res.hoverId).toBe(null);
    expect(res.selectedId).toBe(null);
    expect(r.m.isHoldingRight()).toBe(true);
  });

  test("dipping back inside the outer edge restarts the pass-through timer", () => {
    const r = rig();
    r.open();
    r.polar(90, PAST);
    r.run(T.SUB_OPEN_MS - 3 * DT);
    r.polar(90, (G.DESELECT_R + G.SELECT_R) / 2); // still selected (hysteresis) but inside the edge
    expect(r.run(DT).selectedId).toBe("sound");
    r.polar(90, PAST);
    expect(r.run(T.SUB_OPEN_MS - 3 * DT).level).toBe(0);
    expect(r.run(4 * DT).level).toBe(1);
  });

  test("follow-through: the fist overshooting down right after the sub-ring opens selects nothing while it grows", () => {
    const r = rig();
    r.open();
    r.polar(90, PAST);
    r.run(T.SUB_OPEN_MS + 2 * DT);
    expect(r.results.at(-1).level).toBe(1);
    const c = r.subCenter();
    r.polar(80, PAST, c); // momentum carries the fist on into Organ (65°) within the grow time
    let res = r.run(T.LEVEL_ARM_MS - 3 * DT);
    expect(res.state).toBe("open");
    expect(r.find("setting")).toBeUndefined();
    // drawn back toward the center before the ring is armed: nothing was chosen
    r.polar(80, G.DEAD_R * 0.5, c);
    res = r.run(4 * DT);
    expect(res.state).toBe("open");
    expect(res.selectedId).toBe(null);
    expect(r.find("setting")).toBeUndefined();
  });

  test("each instrument: hover by direction, crossing its radius auto-selects it (the current one = no change)", () => {
    for (const it of INSTRUMENTS) {
      const r = rig();
      r.enterSub();
      const c = r.subCenter();
      r.polar(ANGLE[it.id], (G.DEAD_R + G.SELECT_R) / 2, c);
      let res = r.run(DT);
      expect(res.hoverId, it.id).toBe(it.id);
      expect(res.selectedId).toBe(null);
      expect(res.progress).toBeGreaterThan(0);
      r.polar(ANGLE[it.id], PAST, c);
      res = r.run(DT);
      if (it.id === "warm") {
        expect(res.state).toBe("closed");
        expect(r.find("cancelled").reason).toBe("same-item");
      } else {
        expect(res.setting?.id, it.id).toBe(it.id);
        expect(res.state).toBe("flash");
      }
    }
  });

  test("auto-select a setting: flash only (no countdown), reports the value, then finished — the fist never opens", () => {
    const r = rig();
    r.enterSub();
    r.polar(ANGLE.electric, PAST, r.subCenter());
    const res = r.run(DT);
    expect(res.setting).toEqual({ key: "sound/base", submenu: "sound", id: "electric", value: "electric" });
    expect(r.find("confirmed")).toBeUndefined();
    expect(res.state).toBe("flash");
    expect(r.h.fist).toBe(true);
    expect(r.m.isHoldingRight()).toBe(true);
    expect(r.m.snapshot().confirmKind).toBe("setting");
    expect(r.m.snapshot().confirmedItem.id).toBe("electric");
    const end = r.run(T.FLASH_MS);
    expect(end.state).toBe("closed");
    expect(r.find("finished").finished).toBe("electric");
    expect(r.m.isHoldingRight()).toBe(false);
    // the whole confirm is shorter than a mode change (no countdown)
    const tSet = r.results.findIndex((x) => x.setting);
    const tFin = r.results.findIndex((x) => x.finished);
    expect((tFin - tSet) * DT).toBeLessThan(T.FLASH_MS + T.COUNTDOWN_MS);
    // the still-held fist does not reopen the menu (cooldown)
    expect(r.run(T.REARM_MS - 2 * T.FLASH_MS).state).toBe("closed");
  });

  test("setting value / key overrides: item.value and submenu.setting", () => {
    const items = makeItems({ children: [{ id: "a", label: "A", value: 42 }, { id: "b", label: "B" }], setting: null });
    const r = rig({ items });
    r.enterSub();
    const a = r.m.snapshot().items.find((i) => i.id === "a");
    r.polar(a.angle, PAST, r.subCenter());
    r.run(DT);
    expect(r.find("setting").setting).toEqual({ key: "sound", submenu: "sound", id: "a", value: 42 });
  });

  test("crossing the current value changes nothing ('same-item')", () => {
    const r = rig();
    r.enterSub();
    r.polar(ANGLE.warm, PAST, r.subCenter());
    const res = r.run(DT);
    expect(res.state).toBe("closed");
    expect(r.find("cancelled").reason).toBe("same-item");
    expect(r.find("setting")).toBeUndefined();
  });

  test("open hand anywhere in the sub-ring before choosing cancels all levels", () => {
    const r = rig();
    r.enterSub();
    r.polar(ANGLE.retro, (G.DEAD_R + G.SELECT_R) / 2, r.subCenter()); // approaching only
    expect(r.run(DT).hoverId).toBe("retro");
    const end = r.release();
    expect(end.state).toBe("closed");
    expect(end.level).toBe(0);
    expect(r.find("cancelled").reason).toBe("empty");
    expect(r.m.isHoldingRight()).toBe(false);
    // next open starts at level 0 again
    r.open();
    expect(r.m.snapshot().level).toBe(0);
  });

  test("moving back toward the parent goes back one level; going through again re-opens", () => {
    const r = rig();
    r.enterSub();
    const c = r.subCenter();
    r.polar(-90, G.BACK_R * 0.8, c);
    let res = r.run(DT);
    expect(res.level).toBe(1);
    expect(r.m.snapshot().hoverBack).toBe(true);
    expect(res.hoverId).toBe(null);
    r.polar(-90, G.BACK_R + 0.02, c);
    res = r.run(DT);
    expect(r.find("back").back).toBe(true);
    expect(res.level).toBe(0);
    expect(res.path).toEqual([]);
    const snap = r.m.snapshot();
    expect(snap.center).toEqual({ x: 0.5, y: 0.35 }); // the main ring keeps its entry point
    expect(snap.levelFrom).toBe("back");
    expect(res.selectedId).toBe(null);
    // the fist is back near the main center: the sub-ring does not re-open by itself
    expect(r.run(T.SUB_OPEN_MS * 2).level).toBe(0);
    // the Sound arc opens again when passed through
    r.polar(90, PAST);
    expect(r.run(T.SUB_OPEN_MS + 2 * DT).level).toBe(1);
  });

  test("going back then crossing a mode arc confirms it across levels", () => {
    const r = rig();
    r.enterSub();
    r.polar(-90, G.BACK_R + 0.05, r.subCenter());
    r.run(DT);
    expect(r.find("back")).toBeTruthy();
    r.run(T.LEVEL_ARM_MS); // the main ring re-grows
    r.polar(180, PAST);
    const res = r.run(DT);
    expect(res.confirmed).toBe("lead");
    expect(res.state).toBe("countdown");
  });

  test("sector hysteresis in the sub-ring: jitter across a boundary keeps the hover; crossing picks that arc", () => {
    const r = rig();
    r.enterSub();
    const c = r.subCenter();
    const APPROACH = (G.DEAD_R + G.SELECT_R) / 2;
    r.polar(ANGLE.retro, APPROACH, c);
    expect(r.run(DT).hoverId).toBe("retro");
    for (const a of [138, 143, 147, 141, 149, 136]) {
      r.polar(a, APPROACH, c); // boundary retro|bright is 140; band is ±10
      expect(r.run(DT).hoverId, `angle ${a}`).toBe("retro");
    }
    r.polar(147, PAST, c); // past the radius inside the hysteresis band: still Retro
    expect(r.run(DT).setting?.id).toBe("retro");
  });

  test("jitter around the radius in the sub-ring fires once", () => {
    const r = rig();
    r.enterSub();
    const c = r.subCenter();
    for (let i = 0; i < 30; i++) {
      r.polar(ANGLE.organ, G.SELECT_R + (i % 2 ? 0.02 : -0.02), c);
      r.run(DT);
    }
    expect(r.results.filter((x) => x.setting).length).toBe(1);
    expect(r.find("setting").setting.id).toBe("organ");
  });

  test("tracking lost in the sub-ring: kept for the grace period, then everything cancels", () => {
    const r = rig();
    r.enterSub();
    r.polar(ANGLE.sax, (G.DEAD_R + G.SELECT_R) / 2, r.subCenter());
    r.run(DT);
    r.h.visible = false;
    let res = r.run(T.LOST_GRACE_MS - 50);
    expect(res.state).toBe("open");
    expect(res.level).toBe(1);
    res = r.run(80);
    expect(res.state).toBe("closed");
    expect(r.find("cancelled").reason).toBe("tracking-lost");
  });

  test("scale invariance: the same relative path gives the same result at any hand size", () => {
    for (const size of [0.05, 0.1, 0.22]) {
      const r = rig({ size, y: 0.3 });
      r.enterSub();
      expect(r.results.at(-1).level, `size ${size}`).toBe(1);
      const c = r.subCenter();
      r.polar(ANGLE.bright, (G.DEAD_R + G.SELECT_R) / 2, c);
      let res = r.run(DT);
      expect(res.hoverId).toBe("bright");
      expect(res.progress).toBeCloseTo(0.5, 5);
      r.polar(ANGLE.bright, PAST, c);
      res = r.run(DT);
      expect(res.setting?.id, `size ${size}`).toBe("bright");
      expect(r.m.snapshot().dist).toBeCloseTo(PAST, 5);
    }
  });

  test("aspect: sub-ring distances are isotropic (back = straight up works on a 16:9 canvas)", () => {
    const aspect = 16 / 9;
    const r = rig({ aspect });
    r.enterSub();
    expect(r.results.at(-1).level).toBe(1);
    r.polar(-90, G.BACK_R + 0.02, r.subCenter());
    r.run(DT);
    expect(r.find("back")).toBeTruthy();
  });

  test("edge: a sub-ring opened at the bottom edge is measured relative to the real fist point", () => {
    const r = rig({ y: 0.9 });
    r.enterSub(); // the fist goes down to ~0.97: drawing will clamp, measuring does not
    const c = r.subCenter();
    expect(c.y).toBeGreaterThan(0.95);
    r.polar(ANGLE.electric, PAST, c);
    expect(r.run(DT).setting?.id).toBe("electric");
    expect(r.m.snapshot().offset.x).toBeCloseTo(Math.cos((15 * Math.PI) / 180) * PAST * 0.1, 6);
  });

  test("children are resolved when the sub-ring opens (dynamic items / current); max 2 levels", () => {
    let cur = "bright";
    const kids = () => [
      ...INSTRUMENTS,
      { id: "nested", type: "submenu", label: "Nested", items: [{ id: "x", label: "x" }] }, // dropped: 3rd level
    ];
    const r = rig({ items: makeItems({ children: kids, current: () => cur }) });
    cur = "sax";
    r.enterSub();
    const snap = r.m.snapshot();
    expect(snap.items.map((i) => i.id)).toEqual(INSTRUMENTS.map((i) => i.id));
    expect(snap.currentId).toBe("sax");
  });

  test("more children than MAX_SUB_ITEMS are dropped", () => {
    const many = Array.from({ length: G.MAX_SUB_ITEMS + 3 }, (_, i) => ({ id: `i${i}`, label: `${i}` }));
    const r = rig({ items: makeItems({ children: many }) });
    r.enterSub();
    expect(r.m.snapshot().items.length).toBe(G.MAX_SUB_ITEMS);
  });

  test("a flickering open hand in the sub-ring does not cancel (debounce)", () => {
    const r = rig();
    r.enterSub();
    r.polar(ANGLE.organ, (G.DEAD_R + G.SELECT_R) / 2, r.subCenter());
    r.run(DT);
    r.h.fist = false;
    r.run(DT);
    r.h.fist = true;
    const res = r.run(64);
    expect(res.state).toBe("open");
    expect(res.level).toBe(1);
    expect(res.hoverId).toBe("organ");
  });

  test("requireRelease (live config): the sub-ring item is only selected; opening the hand sets it", () => {
    setMenuConfig({ requireRelease: true });
    const r = rig();
    r.enterSub();
    r.polar(ANGLE.electric, PAST, r.subCenter());
    expect(r.run(DT).selectedId).toBe("electric");
    expect(r.find("setting")).toBeUndefined();
    r.release();
    expect(r.find("setting").setting.id).toBe("electric");
  });
});
