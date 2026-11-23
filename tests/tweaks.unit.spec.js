// Tweaks framework (src/tweaks/tweaks.js): define / get / set / on / reset / export / import, validation and
// clamping, persistence with storage available, corrupted, throwing and absent, apply on load + change.
import { test, expect } from "@playwright/test";
import { createTweaks, validateTweakValue, STORAGE_KEY, TWEAKS_VERSION, tweaksRequested } from "../src/tweaks/tweaks.js";

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  };
}
const throwingStorage = () => ({
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceeded"); },
  removeItem() { throw new Error("SecurityError"); },
});
const stored = (s) => JSON.parse(s.getItem(STORAGE_KEY));

function defineSet(t, applied = {}) {
  const log = (k) => (v) => (applied[k] = [...(applied[k] || []), v]);
  t.defineTweak({ group: "Menu", key: "menu.requireOpen", label: "Require open", type: "toggle", default: false, info: "i", apply: log("menu.requireOpen") });
  t.defineTweak({ group: "Menu", key: "menu.holdMs", label: "Hold", type: "slider", default: 0, min: 0, max: 600, step: 10, unit: "ms", apply: log("menu.holdMs") });
  t.defineTweak({ group: "Menu", key: "menu.selectR", label: "Select", type: "slider", default: 0.6, min: 0.3, max: 1.2, step: 0.01, apply: log("menu.selectR") });
  t.defineTweak({ group: "Audio", key: "audio.limit", label: "Limit", type: "number", default: -2, min: -24, max: 0, step: 0.5, apply: log("audio.limit") });
  t.defineTweak({ group: "Audio", key: "audio.curve", label: "Curve", type: "select", default: "lin", options: ["lin", { value: "exp", label: "Exponential" }], apply: log("audio.curve") });
  return applied;
}

test.describe("tweaks: define / get / set", () => {
  test("defaults, apply on load (once each) and on change only", () => {
    const t = createTweaks({ storage: null });
    const applied = defineSet(t);
    expect(t.getTweak("menu.holdMs")).toBe(0);
    expect(t.getTweak("audio.curve")).toBe("lin");
    for (const k of Object.keys(applied)) expect(applied[k]).toHaveLength(1); // on load, at the default
    t.setTweak("menu.holdMs", 200);
    t.setTweak("menu.holdMs", 200); // unchanged: no second apply
    expect(applied["menu.holdMs"]).toEqual([0, 200]);
    t.setTweak("menu.requireOpen", true);
    expect(applied["menu.requireOpen"]).toEqual([false, true]);
    t.setTweak("audio.curve", "exp");
    expect(t.getTweak("audio.curve")).toBe("exp");
    expect(t.groups()).toEqual(["Menu", "Audio"]);
    expect(t.list().map((d) => d.key)).toEqual(["menu.requireOpen", "menu.holdMs", "menu.selectR", "audio.limit", "audio.curve"]);
  });

  test("clamping, snapping and invalid values", () => {
    const t = createTweaks({ storage: null });
    defineSet(t);
    expect(t.setTweak("menu.holdMs", 9999)).toBe(600);
    expect(t.setTweak("menu.holdMs", -5)).toBe(0);
    expect(t.setTweak("menu.holdMs", 123)).toBe(120); // step 10
    expect(t.setTweak("menu.selectR", 0.7049999)).toBe(0.7); // float noise rounded off
    expect(t.setTweak("audio.limit", -3.3)).toBe(-3.5);
    expect(t.setTweak("menu.holdMs", "300")).toBe(120); // wrong type: ignored
    expect(t.setTweak("menu.holdMs", NaN)).toBe(120);
    expect(t.setTweak("menu.requireOpen", "yes")).toBe(false);
    expect(t.setTweak("audio.curve", "log")).toBe("lin");
    expect(t.setTweak("nope.key", 1)).toBeUndefined();
    expect(validateTweakValue({ type: "slider", min: 0, max: 1 }, 2, "strict").ok).toBe(false);
    expect(validateTweakValue({ type: "slider", min: 0, max: 1 }, 2, "clamp")).toEqual({ ok: true, value: 1 });
  });

  test("definition errors: bad type, slider without range, invalid default, duplicate key", () => {
    const t = createTweaks({ storage: null });
    expect(() => t.defineTweak({ key: "a", type: "knob", default: 1 })).toThrow(/unknown type/);
    expect(() => t.defineTweak({ key: "b", type: "slider", default: 1 })).toThrow(/min and max/);
    expect(() => t.defineTweak({ key: "c", type: "slider", default: 5, min: 0, max: 1 })).toThrow(/invalid default/);
    t.defineTweak({ key: "d", type: "toggle", default: true });
    expect(() => t.defineTweak({ key: "d", type: "toggle", default: true })).toThrow(/duplicate/);
  });

  test("onTweak / onAnyTweak fire on changes; unsubscribe; a throwing apply/listener does not break the store", () => {
    const errors = [];
    const t = createTweaks({ storage: null, onError: (e, where) => errors.push(where) });
    defineSet(t);
    const seen = [];
    const any = [];
    const off = t.onTweak("menu.holdMs", (v, k) => seen.push([k, v]));
    t.onAnyTweak((k, v) => any.push(k));
    t.setTweak("menu.holdMs", 100);
    off();
    t.setTweak("menu.holdMs", 200);
    expect(seen).toEqual([["menu.holdMs", 100]]);
    expect(any).toEqual(["menu.holdMs", "menu.holdMs"]);
    t.defineTweak({ key: "x.bad", type: "toggle", default: false, apply: () => { throw new Error("boom"); } });
    t.onTweak("x.bad", () => { throw new Error("listener"); });
    expect(t.setTweak("x.bad", true)).toBe(true);
    expect(errors).toEqual(["apply x.bad", "apply x.bad", "onTweak x.bad"]);
  });

  test("resetTweaks(group) and resetTweaks()", () => {
    const t = createTweaks({ storage: null });
    const applied = defineSet(t);
    t.setTweak("menu.holdMs", 300);
    t.setTweak("audio.limit", -6);
    t.resetTweaks("Menu");
    expect(t.getTweak("menu.holdMs")).toBe(0);
    expect(t.getTweak("audio.limit")).toBe(-6);
    expect(applied["menu.holdMs"]).toEqual([0, 300, 0]);
    t.resetTweaks();
    expect(t.getTweak("audio.limit")).toBe(-2);
    expect(t.isDefault("audio.limit")).toBe(true);
  });
});

test.describe("tweaks: export / import", () => {
  test("export has every current value; import applies, clamps and ignores unknown/invalid keys", () => {
    const t = createTweaks({ storage: null });
    defineSet(t);
    t.setTweak("menu.holdMs", 250);
    const blob = JSON.parse(t.exportTweaks());
    expect(blob).toEqual({
      version: TWEAKS_VERSION,
      values: { "menu.requireOpen": false, "menu.holdMs": 250, "menu.selectR": 0.6, "audio.limit": -2, "audio.curve": "lin" },
    });

    const u = createTweaks({ storage: null });
    const applied = defineSet(u);
    const r = u.importTweaks(JSON.stringify({ version: 1, values: { "menu.holdMs": 250, "menu.selectR": 5, "audio.curve": "bogus", "zz.unknown": 1 } }));
    expect(r.applied.sort()).toEqual(["menu.holdMs", "menu.selectR"]);
    expect(r.ignored.sort()).toEqual(["audio.curve", "zz.unknown"]);
    expect(u.getTweak("menu.holdMs")).toBe(250);
    expect(u.getTweak("menu.selectR")).toBe(1.2); // clamped
    expect(applied["menu.holdMs"]).toEqual([0, 250]);
    // Round trip
    u.importTweaks(t.exportTweaks());
    expect(u.exportTweaks()).toBe(t.exportTweaks());
  });

  test("import rejects garbage and other versions", () => {
    const t = createTweaks({ storage: null });
    defineSet(t);
    expect(() => t.importTweaks("{not json")).toThrow();
    expect(() => t.importTweaks("42")).toThrow(/not an object/);
    expect(() => t.importTweaks({ version: 2, values: {} })).toThrow(/version/);
    expect(() => t.importTweaks({ version: 1, values: [1, 2] })).toThrow(/no values/);
    // A bare {key: value} map is accepted too
    expect(t.importTweaks({ "menu.holdMs": 40 }).applied).toEqual(["menu.holdMs"]);
  });
});

test.describe("tweaks: persistence", () => {
  test("changed values are stored (only non-defaults) and restored by a new store", () => {
    const s = memStorage();
    const t = createTweaks({ storage: s });
    defineSet(t);
    expect(s.getItem(STORAGE_KEY)).toBeNull(); // nothing changed yet
    t.setTweak("menu.holdMs", 300);
    t.setTweak("menu.requireOpen", true);
    expect(stored(s)).toEqual({ version: 1, values: { "menu.holdMs": 300, "menu.requireOpen": true } });

    const u = createTweaks({ storage: s });
    const applied = defineSet(u);
    expect(u.getTweak("menu.holdMs")).toBe(300);
    expect(applied["menu.holdMs"]).toEqual([300]); // applied on load with the stored value
    expect(applied["menu.requireOpen"]).toEqual([true]);

    u.setTweak("menu.holdMs", 0); // back to the default: dropped from storage
    expect(stored(s).values).toEqual({ "menu.requireOpen": true });
    u.resetTweaks();
    expect(s.getItem(STORAGE_KEY)).toBeNull();
  });

  test("stored values of tweaks not defined on this page are kept", () => {
    const s = memStorage({ [STORAGE_KEY]: JSON.stringify({ version: 1, values: { "other.page": 7 } }) });
    const t = createTweaks({ storage: s });
    defineSet(t);
    t.setTweak("menu.holdMs", 10);
    expect(stored(s).values).toEqual({ "other.page": 7, "menu.holdMs": 10 });
  });

  test("corrupted, wrong-version, out-of-range and wrong-type stored values fall back to defaults", () => {
    for (const raw of ["{oops", "null", "[]", JSON.stringify({ version: 99, values: { "menu.holdMs": 300 } }), JSON.stringify({ version: 1, values: "x" })]) {
      const t = createTweaks({ storage: memStorage({ [STORAGE_KEY]: raw }) });
      defineSet(t);
      expect(t.getTweak("menu.holdMs"), raw).toBe(0);
    }
    const s = memStorage({
      [STORAGE_KEY]: JSON.stringify({ version: 1, values: { "menu.holdMs": 5000, "menu.selectR": "0.8", "menu.requireOpen": 1, "audio.curve": "nope", "audio.limit": -6 } }),
    });
    const t = createTweaks({ storage: s });
    defineSet(t);
    expect(t.getTweak("menu.holdMs")).toBe(0); // out of range: default, not clamped
    expect(t.getTweak("menu.selectR")).toBe(0.6);
    expect(t.getTweak("menu.requireOpen")).toBe(false);
    expect(t.getTweak("audio.curve")).toBe("lin");
    expect(t.getTweak("audio.limit")).toBe(-6); // the valid one survives
  });

  test("storage that throws (blocked) or is absent: everything still works for this page", () => {
    for (const storage of [throwingStorage(), null]) {
      const t = createTweaks({ storage });
      const applied = defineSet(t);
      expect(t.setTweak("menu.holdMs", 200)).toBe(200);
      expect(applied["menu.holdMs"]).toEqual([0, 200]);
      t.resetTweaks();
      expect(t.getTweak("menu.holdMs")).toBe(0);
      expect(JSON.parse(t.exportTweaks()).values["menu.holdMs"]).toBe(0);
    }
  });
});

test("tweaksRequested: ?tweaks, ?tweaks=true, not =false / absent", () => {
  expect(tweaksRequested("?tweaks")).toBe(true);
  expect(tweaksRequested("?tweaks=true")).toBe(true);
  expect(tweaksRequested("?mockHands&tweaks=1")).toBe(true);
  expect(tweaksRequested("?tweaks=false")).toBe(false);
  expect(tweaksRequested("?tweaks=0")).toBe(false);
  expect(tweaksRequested("?mockHands")).toBe(false);
  expect(tweaksRequested("")).toBe(false);
});
