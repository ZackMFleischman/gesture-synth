// Instrument plugins (src/instruments): registry rules + the plugin boundary (Node). Sound: instruments.e2e.spec.js;
// the Sound menu in the app: sound-menu.e2e.spec.js.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  listInstruments,
  getInstrument,
  registerInstrument,
  instrumentFromTone,
  toneOf,
  traitsOf,
  soundMenuItem,
  DEFAULT_TRAITS,
} from "../src/instruments/index.js";
import { tubeCurve } from "../src/instruments/electric/index.js";
import { fanLayout, MENU_GEOMETRY } from "../src/menu/menu-state.js";

const BUILT_IN = ["warm", "bright", "retro", "organ", "electric", "sax"];

test("built-ins register in Sound-menu order with the plugin interface", () => {
  const ids = listInstruments().map((d) => d.id);
  expect(ids.slice(0, 6)).toEqual(BUILT_IN);
  for (const d of listInstruments()) {
    expect(typeof d.label).toBe("string");
    expect(typeof d.icon).toBe("string");
    expect(d.level).toBeGreaterThan(0);
    expect(typeof d.createSource).toBe("function");
    if (d.createChain) expect(typeof d.createChain).toBe("function");
    for (const k of Object.keys(d.traits || {})) expect(Object.keys(DEFAULT_TRAITS), `${d.id}.traits.${k}`).toContain(k);
  }
});

test("tone-select values keep their historical names for the original three", () => {
  expect(instrumentFromTone("triangle")).toBe("warm");
  expect(instrumentFromTone("sawtooth")).toBe("bright");
  expect(instrumentFromTone("square")).toBe("retro");
  expect(instrumentFromTone("organ")).toBe("organ");
  expect(instrumentFromTone("nope")).toBe(null);
  expect(toneOf("electric")).toBe("electric");
  expect(toneOf("warm")).toBe("triangle");
});

test("traits: defaults + overrides (the voices read only these)", () => {
  expect(traitsOf("warm").releaseTailS).toBe(null); // plain oscillator: stops at once (original behavior)
  expect(traitsOf("electric")).toMatchObject({ strumMs: 9, sustains: false, legato: "hammer-on" });
  expect(traitsOf("organ").legato).toBe("retrigger");
  expect(traitsOf("unknown")).toEqual(DEFAULT_TRAITS);
});

test("Electric's clipper is asymmetric (even harmonics) and bounded", () => {
  const c = tubeCurve(4097);
  const mid = 2048;
  expect(Math.abs(c[mid])).toBeLessThan(1e-6);
  expect(c[4096]).toBeGreaterThan(0.6);
  expect(c[0]).toBeLessThan(-0.95);
  expect(Math.abs(c[mid + 300] + c[mid - 300])).toBeGreaterThan(0.01); // f(x) != -f(-x)
  for (const v of c) expect(Math.abs(v)).toBeLessThanOrEqual(1);
});

test("Sound menu item: a submenu of every registered instrument; Lead sound with the layer on", () => {
  const base = soundMenuItem({ layerOn: false, color: "#e8a13d", current: () => "warm" });
  expect(base).toMatchObject({ id: "sound", type: "submenu", direction: "down", label: "Sound", setting: "sound/base" });
  expect(base.items().map((i) => i.id).slice(0, 6)).toEqual(BUILT_IN);
  expect(base.items().every((i) => i.type === "setting" && i.label && i.icon)).toBe(true);
  const lead = soundMenuItem({ layerOn: true, color: "#c08cff", current: () => "sax" });
  expect(lead).toMatchObject({ label: "Lead sound", setting: "sound/lead" });
  expect(lead.current()).toBe("sax");
  // 6 instruments fan into 50° sectors with nothing straight down
  const f = fanLayout(6, -90, MENU_GEOMETRY.BACK_SPAN_DEG);
  expect(f.span).toBe(50);
});

test("registering a 7th instrument: it appears in the Sound items with no other change", () => {
  const before = listInstruments().length;
  registerInstrument({ id: "unit-test-bell", label: "Bell", icon: "M0 0", level: 1, createSource: () => null });
  const item = soundMenuItem({ layerOn: false, color: "#fff", current: () => "warm" });
  expect(item.items().map((i) => i.id)).toContain("unit-test-bell");
  expect(listInstruments().length).toBe(before + 1);
  expect(getInstrument("unit-test-bell").label).toBe("Bell");
  expect(instrumentFromTone("unit-test-bell")).toBe("unit-test-bell");
});

/** All .js files under a path. */
function jsFiles(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return p.endsWith(".js") ? [p] : [];
  return fs.readdirSync(p).flatMap((n) => jsFiles(path.join(p, n)));
}

test("plugin boundary: core / voice / UI code never names an instrument (only src/instruments does)", () => {
  const roots = ["src/services", "src/modes", "src/router.js", "src/ui", "src/core", "src/menu", "src/output", "main.js"];
  const ids = BUILT_IN.join("|");
  const literal = new RegExp(`["'\`](${ids})["'\`]`);
  const offenders = [];
  for (const f of roots.flatMap((r) => jsFiles(r))) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      if (literal.test(l)) offenders.push(`${f}:${i + 1}: ${l.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});
