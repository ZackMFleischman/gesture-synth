// Tweaks: developer settings for trying out variations (constants, thresholds, behavior switches).
// Pure (no DOM): unit-testable in Node. The panel (panel.js) and the app's tweak definitions (defs.js) are loaded
// only when the URL has `?tweaks` (main.js, dynamic import), so normal players always get the code defaults and
// persisted tweak values never apply without `?tweaks` (lead decision; CLAUDE.md "Conventions: Tweaks").
//
//   defineTweak({ group, key, label, type, default, min, max, step, unit, options, info, apply })
//     type: "toggle" (boolean) | "slider" | "number" (finite number, clamped to [min, max], snapped to step)
//           | "select" (one of `options`: values or {value, label})
//     key:  namespaced, e.g. "menu.selectR". `info` = the ⓘ hover text. `apply(value)` pushes the value into the
//           live system; it runs once at definition (with the stored or default value) and on every change.
//   getTweak(key) · setTweak(key, v) · onTweak(key, cb) -> unsubscribe · resetTweaks(group?) · exportTweaks() -> JSON
//   importTweaks(json) -> {applied, ignored}
//
// Persistence: localStorage["gs.tweaks.v1"] = {version, values: {key: value}} holding only values that differ from
// the default (a changed default in code reaches everyone who did not touch that tweak). Every storage access is in
// try/catch; corrupted JSON, unknown keys and invalid / out-of-range stored values fall back to the defaults.

export const STORAGE_KEY = "gs.tweaks.v1";
export const TWEAKS_VERSION = 1;
const TYPES = new Set(["toggle", "slider", "number", "select"]);

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // e.g. a sandboxed iframe / blocked site data throws on access
  }
}

const optValue = (o) => (o && typeof o === "object" ? o.value : o);

/** Snap to the step grid (relative to min) and round off float noise. */
function snap(v, def) {
  if (!(def.step > 0)) return v;
  const base = Number.isFinite(def.min) ? def.min : 0;
  const n = Math.round((v - base) / def.step);
  const decimals = Math.min(10, (String(def.step).split(".")[1] || "").length);
  return Number((base + n * def.step).toFixed(decimals));
}

/**
 * Validate a value for a tweak.
 * @param {"clamp"|"strict"} mode clamp = setTweak (out of range -> nearest bound); strict = stored/imported values
 *   (out of range -> invalid, so the default is used).
 * @returns {{ok:true, value:any}|{ok:false}}
 */
export function validateTweakValue(def, v, mode = "clamp") {
  switch (def.type) {
    case "toggle":
      return typeof v === "boolean" ? { ok: true, value: v } : { ok: false };
    case "select": {
      const vals = (def.options || []).map(optValue);
      return vals.includes(v) ? { ok: true, value: v } : { ok: false };
    }
    case "slider":
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false };
      const lo = Number.isFinite(def.min) ? def.min : -Infinity;
      const hi = Number.isFinite(def.max) ? def.max : Infinity;
      if (mode === "strict" && (v < lo || v > hi)) return { ok: false };
      return { ok: true, value: Math.min(hi, Math.max(lo, snap(Math.min(hi, Math.max(lo, v)), def))) };
    }
    default:
      return { ok: false };
  }
}

/**
 * A tweaks store. The app uses the shared one (functions exported below); tests make their own.
 * @param {{storage?: Storage|null, storageKey?: string, onError?: (err:any, where:string) => void}} [opts]
 *   storage: default localStorage; null = no persistence (values live for this page only).
 */
export function createTweaks(opts = {}) {
  const storage = "storage" in opts ? opts.storage : defaultStorage();
  const storageKey = opts.storageKey ?? STORAGE_KEY;
  const onError = opts.onError ?? ((err, where) => console.error(`[tweaks] ${where}:`, err));
  const defs = new Map(); // key -> definition (in definition order)
  const values = new Map(); // key -> current value
  const listeners = new Map(); // key -> Set(cb)
  const anyListeners = new Set(); // cb(key, value) for every change (the panel)

  function readStored() {
    if (!storage) return {};
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return {};
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object" || data.version !== TWEAKS_VERSION) return {};
      const v = data.values;
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {}; // corrupted JSON or storage that throws: defaults
    }
  }
  let stored = readStored();

  function persist() {
    if (!storage) return;
    const out = {};
    // Keep stored values of tweaks not defined (yet) on this page, so a page that defines fewer tweaks doesn't erase them.
    for (const [k, v] of Object.entries(stored)) if (!defs.has(k)) out[k] = v;
    for (const [k, def] of defs) if (values.get(k) !== def.default) out[k] = values.get(k);
    stored = out;
    try {
      if (Object.keys(out).length) storage.setItem(storageKey, JSON.stringify({ version: TWEAKS_VERSION, values: out }));
      else storage.removeItem(storageKey);
    } catch {
      /* storage full or blocked: the value still applies for this page */
    }
  }

  function runApply(def, v) {
    if (typeof def.apply !== "function") return;
    try {
      def.apply(v);
    } catch (err) {
      onError(err, `apply ${def.key}`);
    }
  }

  function notify(key, v) {
    for (const cb of listeners.get(key) ?? []) {
      try {
        cb(v, key);
      } catch (err) {
        onError(err, `onTweak ${key}`);
      }
    }
    for (const cb of anyListeners) {
      try {
        cb(key, v);
      } catch (err) {
        onError(err, "onAnyTweak");
      }
    }
  }

  function assign(key, v, { save = true } = {}) {
    const def = defs.get(key);
    const changed = values.get(key) !== v;
    values.set(key, v);
    if (changed) {
      runApply(def, v);
      notify(key, v);
    }
    if (save) persist();
    return v;
  }

  const api = {
    /** Define a tweak; returns its current value (stored, if valid, else the default). Applies it at once. */
    defineTweak(spec) {
      if (!spec || typeof spec.key !== "string" || !spec.key) throw new Error("defineTweak: key required");
      if (!TYPES.has(spec.type)) throw new Error(`defineTweak ${spec.key}: unknown type ${spec.type}`);
      const def = {
        group: "General",
        label: spec.key,
        info: "",
        unit: "",
        ...spec,
      };
      if (def.type === "slider" && !(Number.isFinite(def.min) && Number.isFinite(def.max))) {
        throw new Error(`defineTweak ${def.key}: a slider needs min and max`);
      }
      const d = validateTweakValue(def, def.default, "strict");
      if (!d.ok) throw new Error(`defineTweak ${def.key}: invalid default ${JSON.stringify(def.default)}`);
      def.default = d.value;
      if (defs.has(def.key)) throw new Error(`defineTweak: duplicate key ${def.key}`);
      defs.set(def.key, def);
      let v = def.default;
      if (Object.prototype.hasOwnProperty.call(stored, def.key)) {
        const s = validateTweakValue(def, stored[def.key], "strict");
        if (s.ok) v = s.value;
      }
      values.set(def.key, v);
      runApply(def, v); // on load, always (even at the default) so the live system and the tweak agree
      return v;
    },

    getTweak(key) {
      return values.get(key);
    },

    /** Set a value (clamped / snapped; invalid values are ignored). Returns the value now in effect. */
    setTweak(key, v) {
      const def = defs.get(key);
      if (!def) return undefined;
      const r = validateTweakValue(def, v, "clamp");
      if (!r.ok) return values.get(key);
      return assign(key, r.value);
    },

    /** cb(value, key) after each change of `key`. Returns an unsubscribe function. */
    onTweak(key, cb) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(cb);
      return () => listeners.get(key)?.delete(cb);
    },

    /** cb(key, value) after any change (used by the panel). Returns an unsubscribe function. */
    onAnyTweak(cb) {
      anyListeners.add(cb);
      return () => anyListeners.delete(cb);
    },

    /** Back to the defaults: every tweak, or only those of `group`. */
    resetTweaks(group) {
      for (const [k, def] of defs) if (group === undefined || def.group === group) assign(k, def.default, { save: false });
      persist();
    },

    /** All current values as JSON: {"version":1,"values":{key: value}} (pretty-printed). */
    exportTweaks() {
      const out = {};
      for (const k of defs.keys()) out[k] = values.get(k);
      return JSON.stringify({ version: TWEAKS_VERSION, values: out }, null, 2);
    },

    /**
     * Apply an exported blob (string or object). Unknown keys and invalid values are ignored (reported).
     * Out-of-range numbers are clamped. Throws on unparseable JSON or a wrong shape.
     */
    importTweaks(json) {
      const data = typeof json === "string" ? JSON.parse(json) : json;
      if (!data || typeof data !== "object") throw new Error("importTweaks: not an object");
      if (data.version !== undefined && data.version !== TWEAKS_VERSION) {
        throw new Error(`importTweaks: version ${data.version} (expected ${TWEAKS_VERSION})`);
      }
      const vals = data.values ?? data;
      if (!vals || typeof vals !== "object" || Array.isArray(vals)) throw new Error("importTweaks: no values");
      const applied = [];
      const ignored = [];
      for (const [k, v] of Object.entries(vals)) {
        if (k === "version") continue;
        const def = defs.get(k);
        const r = def ? validateTweakValue(def, v, "clamp") : { ok: false };
        if (!r.ok) {
          ignored.push(k);
          continue;
        }
        assign(k, r.value, { save: false });
        applied.push(k);
      }
      persist();
      return { applied, ignored };
    },

    /** Definitions in order (read-only use). */
    list() {
      return [...defs.values()];
    },

    /** Group names in definition order. */
    groups() {
      return [...new Set([...defs.values()].map((d) => d.group))];
    },

    getDefinition(key) {
      return defs.get(key);
    },

    isDefault(key) {
      return defs.has(key) && values.get(key) === defs.get(key).default;
    },
  };
  return api;
}

// ---- The shared store (the app's tweaks) ----
let shared = null;
/** The app's tweaks store (created on first use, with localStorage). */
export function sharedTweaks() {
  if (!shared) shared = createTweaks();
  return shared;
}
export const defineTweak = (spec) => sharedTweaks().defineTweak(spec);
export const getTweak = (key) => sharedTweaks().getTweak(key);
export const setTweak = (key, v) => sharedTweaks().setTweak(key, v);
export const onTweak = (key, cb) => sharedTweaks().onTweak(key, cb);
export const resetTweaks = (group) => sharedTweaks().resetTweaks(group);
export const exportTweaks = () => sharedTweaks().exportTweaks();
export const importTweaks = (json) => sharedTweaks().importTweaks(json);

export { tweaksRequested } from "./flag.js";
