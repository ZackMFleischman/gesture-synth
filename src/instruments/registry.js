// Instrument registry (contract: docs/architecture.md "Instrument plugin"). Instruments are plugins, like modes:
// one file per instrument (src/instruments/<id>.js) default-exports a definition and registers itself through
// src/instruments/index.js. Everything else (the audio engine, the voices, the Sound menu, the Controls panel, the
// tone select) works through this registry, the definition's interface and its `traits` — never an instrument id.
//
// Definition:
//   { id, label, icon (24x24 SVG path), level (linear loudness / gain-staging trim on the post chain),
//     tone?: string (tone-select value; default id), toneLabel?: string (tone-select text; default label),
//     createSource(ac, freq, t0, opts) -> Source,
//     createChain?(ac) -> { input, output }   (LINEAR post chain shared by a voice's notes: formants, amp tone, cab),
//     traits?: Partial<DEFAULT_TRAITS>,
//     onReady?(ac) -> Promise|void            (one-time per AudioContext setup, e.g. an AudioWorklet) }
// Source (one note, started at t0): connect(node), disconnect(), stop(t), release(t) (the instrument's own end of
//   a note), excite(t, amount) (a new attack on a sounding source: re-pluck / key click / breath), setFreq(f, t, rampS),
//   frequency.value (Hz), instrument (id), onended (setter), type (oscillator type or id).
// opts: { voice: "chords"|"arp"|"lead", mono?: true (a long-lived mono voice's source: silent until excite(), never
//   ends by itself) }.

/** Traits the voices read (defaults). */
export const DEFAULT_TRAITS = Object.freeze({
  strumMs: 0, // Chords: stagger between the voicing's notes, low to high
  releaseTailS: null, // chord change / note end: null = stop at once (plain oscillators); s = release() then stop after
  sustains: true, // false = the sound decays by itself (a plucked string)
  legato: "retrigger", // Lead note step: "retrigger" (pitch only) | "hammer-on" (pitch + excite(t, hammerOn))
  hammerOn: 0.3,
  leadToneHz: 12000, // Lead's fixed tone low-pass for this instrument (open by default)
});

const defs = [];
const listeners = new Set();

export function registerInstrument(def) {
  if (!def || !def.id || typeof def.createSource !== "function") throw new Error("registerInstrument: needs id + createSource");
  const i = defs.findIndex((d) => d.id === def.id);
  if (i >= 0) defs[i] = def;
  else defs.push(def);
  for (const fn of listeners) {
    try { fn(listInstruments()); } catch (e) { console.error(e); }
  }
  return def;
}

export const getInstrument = (id) => defs.find((d) => d.id === id) || null;
export const listInstruments = () => defs.slice();
export const isInstrument = (id) => !!getInstrument(id);
export const defaultInstrumentId = () => (defs[0] ? defs[0].id : null);
export const traitsOf = (id) => ({ ...DEFAULT_TRAITS, ...(getInstrument(id)?.traits || {}) });
export const toneOf = (id) => {
  const d = getInstrument(id) || defs[0];
  return d ? d.tone ?? d.id : null;
};
/** Tone-select value or id -> instrument id (null if unknown). */
export const instrumentFromTone = (tone) => (defs.find((d) => (d.tone ?? d.id) === tone || d.id === tone) || {}).id || null;

/** fn(list) after every registration (UI lists rebuild). Returns unsubscribe. */
export function onInstrumentsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- per-AudioContext setup -----------------------------------------------------------------------------------
const ready = new WeakMap(); // ac -> Map(id -> promise)
/** Runs def.onReady(ac) once per AudioContext. Returns its promise (or a resolved one). */
export function prepareInstrument(ac, id) {
  const d = getInstrument(id);
  if (!ac || !d || !d.onReady) return Promise.resolve(true);
  let m = ready.get(ac);
  if (!m) ready.set(ac, (m = new Map()));
  if (!m.has(id)) m.set(id, Promise.resolve(d.onReady(ac)).catch((e) => (console.warn(`instrument ${id}: onReady failed`, e), false)));
  return m.get(id);
}
export const prepareInstruments = (ac) => Promise.all(defs.map((d) => prepareInstrument(ac, d.id)));

// ---- sources + post chains --------------------------------------------------------------------------------------

/** A note of instrument `id` (unknown id: the first registered; none registered: a plain triangle oscillator). */
export function createSource(ac, id, freq, t0, opts = {}) {
  const d = getInstrument(id) || defs[0];
  if (d) {
    prepareInstrument(ac, d.id);
    return d.createSource(ac, freq, t0, opts);
  }
  const osc = ac.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = freq;
  osc.start(t0);
  osc.instrument = null;
  osc.release = () => {};
  osc.excite = () => {};
  osc.setFreq = (f, t) => osc.frequency.setValueAtTime(f, t);
  return osc;
}

/** The instrument's post chain + level trim: { input, output }. */
export function createPost(ac, id) {
  const d = getInstrument(id);
  const level = ac.createGain();
  level.gain.value = d?.level ?? 1;
  if (d && d.createChain) {
    const c = d.createChain(ac);
    c.output.connect(level);
    return { input: c.input, output: level };
  }
  return { input: level, output: level };
}

/**
 * A voice's set of post chains, created on first use, all into `dest`.
 * rack.input(id) -> the node a note of instrument `id` connects to (after the voice's envelope).
 */
export function createRack(ac, dest) {
  const posts = new Map();
  return {
    input(id) {
      const key = isInstrument(id) ? id : defaultInstrumentId() ?? "";
      let p = posts.get(key);
      if (!p) {
        p = createPost(ac, key);
        p.output.connect(dest);
        posts.set(key, p);
      }
      return p.input;
    },
    get ids() { return [...posts.keys()]; },
    dest,
  };
}

// ---- the Sound menu item (generic sub-menu, src/menu) -------------------------------------------------------------

export const SOUND_ICON = "M4 10v4h3l5 4V6L7 10H4M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11";

/**
 * Sound arc for the radial menu (down): one setting per registered instrument (in registration order). Sets the
 * base instrument (Chords / Arp), or the lead's while the Lead layer is on ("Lead sound").
 * @param {{ layerOn: boolean, color: string, current: () => string }} o
 */
export function soundMenuItem({ layerOn, color, current }) {
  return {
    id: "sound",
    type: "submenu",
    label: layerOn ? "Lead sound" : "Sound",
    icon: SOUND_ICON,
    color,
    direction: "down",
    setting: layerOn ? "sound/lead" : "sound/base",
    items: () => listInstruments().map((d) => ({ id: d.id, type: "setting", label: d.label, icon: d.icon })),
    current,
  };
}
