// Lead layer (docs/architecture.md "Lead layer"): pure router / registry / menu rules in Node.
// App journeys (sound, UI, output): tests/lead-layer.e2e.spec.js.
import { test, expect } from "@playwright/test";
import { createBus } from "../src/core/bus.js";
import { createRegistry } from "../src/core/registry.js";
import { createRouter, RESUME_MS } from "../src/router.js";
import { createMenuState, MENU_GEOMETRY as G } from "../src/menu/menu-state.js";

/** A fake mode that logs what the router calls. */
function fakeMode(id, direction, extra = {}) {
  const log = [];
  return {
    id, name: id[0].toUpperCase() + id.slice(1), color: "#888", icon: "", direction, log,
    rightTrack: { param: `${id}/x`, label: "X" },
    enter: () => log.push("enter"),
    exit: () => log.push("exit"),
    hold: () => log.push("hold"),
    update: (f) => log.push(f ? `update:${f.height.toFixed(3)}` : "update:null"),
    ...extra,
  };
}

function rig() {
  const bus = createBus();
  const registry = createRegistry({ bus });
  const chords = registry.registerMode(fakeMode("chords", "up"));
  const arp = registry.registerMode(fakeMode("arp", "right"));
  const lead = registry.registerMode(fakeMode("lead", "left", { layer: true, rightTrack: null }));
  const harmony = { updateLeft() {} };
  const ctx = { audio: null, bus };
  const router = createRouter({ bus, registry, harmony, ctx });
  const right = (height, tilt = 0) => ({
    handedness: "Right", fist: false, height, tilt, pos: { x: 0.7, y: 1 - height }, handSize: 0.1,
    fingers: { thumb: false, index: true, middle: true, ring: true, pinky: true }, landmarks: [],
  });
  const clear = () => [chords, arp, lead].forEach((m) => (m.log.length = 0));
  return { bus, registry, router, ctx, chords, arp, lead, right, clear };
}

test.describe("Lead layer: router", () => {
  test("Lead goes ON TOP of the base: `mode` stays the base, `layer` = lead, base held + layer driven every frame", () => {
    const { bus, router, ctx, arp, lead, right, clear } = rig();
    router.setMode("arp");
    router.update(null, right(0.6), 0);
    clear();
    expect(router.setMode("lead")).toBe(true);
    expect(bus.get("mode")).toBe("arp");
    expect(bus.get("layer")).toBe("lead");
    expect(router.modeId).toBe("arp");
    expect(router.layerId).toBe("lead");
    expect(router.rightModeId).toBe("lead");
    expect(ctx.layerBase).toBe("arp");
    expect(arp.log).toEqual([]); // the base is NOT exited
    expect(lead.log).toEqual(["enter"]);
    router.update(null, right(0.3), 16);
    expect(arp.log).toEqual(["hold"]); // right-hand values held, left hand live
    expect(lead.log).toEqual(["enter", "update:0.300"]);
    // Lead again = no change.
    expect(router.setMode("lead")).toBe(false);
    expect(bus.get("layer")).toBe("lead");
  });

  test("choosing the base that was underneath: layer off, the right hand returns with the crossfade from the held values", () => {
    const { bus, router, ctx, arp, lead, right, clear } = rig();
    router.setMode("arp");
    router.update(null, right(0.6), 0); // Arp's last frame before the layer: height 0.6
    router.setMode("lead");
    router.update(null, right(0.2), 16);
    clear();
    expect(router.setMode("arp")).toBe(true);
    expect(bus.get("mode")).toBe("arp");
    expect(bus.get("layer")).toBe(null);
    expect(ctx.layerBase).toBe(null);
    expect(lead.log).toEqual(["exit"]);
    expect(arp.log).toEqual([]); // not re-entered
    // First frame after: starts at the held 0.6, reaches the live 0.2 after RESUME_MS.
    router.update(null, right(0.2), 100);
    router.update(null, right(0.2), 100 + RESUME_MS / 2);
    router.update(null, right(0.2), 100 + RESUME_MS + 1);
    router.update(null, right(0.2), 100 + RESUME_MS + 20);
    const h = arp.log.map((s) => Number(s.split(":")[1]));
    expect(h[0]).toBeCloseTo(0.6, 3);
    expect(h[1]).toBeGreaterThan(0.2);
    expect(h[1]).toBeLessThan(0.6);
    expect(h[3]).toBeCloseTo(0.2, 3);
    expect(bus.get("held")).toBe(null);
  });

  test("choosing the other base: base switches, layer off", () => {
    const { bus, router, chords, arp, lead, clear } = rig();
    router.setMode("chords");
    router.setMode("lead");
    clear();
    router.setMode("arp");
    expect(lead.log).toEqual(["exit"]);
    expect(chords.log).toEqual(["exit"]);
    expect(arp.log).toEqual(["enter"]);
    expect(bus.get("mode")).toBe("arp");
    expect(bus.get("layer")).toBe(null);
  });

  test("without a base (lead lab) a layer mode runs alone like a base", () => {
    const bus = createBus();
    const registry = createRegistry({ bus });
    const lead = registry.registerMode(fakeMode("lead", "left", { layer: true }));
    const ctx = { bus };
    const router = createRouter({ bus, registry, harmony: { updateLeft() {} }, ctx });
    router.setMode("lead");
    expect(bus.get("mode")).toBe("lead");
    expect(bus.get("layer")).toBe(null);
    expect(ctx.layerBase).toBe(null);
    expect(lead.log).toEqual(["enter"]);
  });
});

test.describe("Lead layer: menu items + menu rules", () => {
  test("registry: Lead is a `layer` item; with the layer on the base item is `secondary` with a hint", () => {
    const { registry } = rig();
    const off = registry.menuItems("arp");
    expect(off.find((i) => i.id === "lead").type).toBe("layer");
    expect(off.some((i) => i.secondary)).toBe(false);
    const on = registry.menuItems("arp", { layerId: "lead" });
    const arp = on.find((i) => i.id === "arp");
    expect(arp.secondary).toBe(true);
    expect(arp.confirmHint).toBe("Lead off");
    expect(on.find((i) => i.id === "chords").secondary).toBeUndefined();
  });

  function choose(items, currentId, dir) {
    const m = createMenuState({ items: () => items, currentId: () => currentId, aspect: 1 });
    const hand = (fist, x, y) => ({ fist, pos: { x, y }, handSize: 0.1 });
    let t = 0;
    m.update(hand(false, 0.5, 0.5), (t += 16));
    for (let i = 0; i < 10; i++) m.update(hand(true, 0.5, 0.5), (t += 16));
    const v = { left: [-1, 0], right: [1, 0], up: [0, -1] }[dir];
    const d = G.SELECT_R * 0.1 * 1.3;
    // Auto-select: holding past the select radius chooses (once the ring has grown in); the hand opens afterwards.
    for (let i = 0; i < 15; i++) m.update(hand(true, 0.5 + v[0] * d, 0.5 + v[1] * d), (t += 16));
    let r;
    for (let i = 0; i < 5; i++) r = m.update(hand(false, 0.5 + v[0] * d, 0.5 + v[1] * d), (t += 16)) || r;
    return { r, snap: m.snapshot() };
  }

  test("menu: Lead while Lead is on = no change (same-item); the base underneath = a change (countdown)", () => {
    const { registry } = rig();
    const items = registry.menuItems("arp", { layerId: "lead" });
    // currentId = the mode the right hand drives (router.rightModeId)
    const a = choose(items, "lead", "left");
    expect(a.snap.closeReason).toBe("same-item");
    expect(a.snap.confirmedId).toBe(null);
    const b = choose(items, "lead", "right");
    expect(b.snap.confirmedId).toBe("arp");
    // Without the layer, Lead is a normal change and the current base is a no-change.
    const c = choose(registry.menuItems("arp"), "arp", "left");
    expect(c.snap.confirmedId).toBe("lead");
    const d = choose(registry.menuItems("arp"), "arp", "right");
    expect(d.snap.closeReason).toBe("same-item");
  });
});
