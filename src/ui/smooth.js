// Display smoothing for visuals that follow the hand (user feedback 2026-11-22: "the filter arc is a bit jittery,
// as are the other visuals connected to the hand"). Pure (no DOM), Node-testable.
//
// DISPLAY ONLY: this smooths what is DRAWN (arc position, dots, pills, plates, markers, guide lines, the menu's fist
// dot). It never touches the values that drive sound or control logic (tilt -> filter cutoff, height -> gate /
// volume / note, menu selection math): those keep reading the raw HandFrame / bus values.
//
// Filter: One-Euro (Casiez et al. 2012) — a one-pole low-pass whose cutoff rises with the (filtered) speed, so a still
// hand gets heavy smoothing (landmark jitter disappears) and a fast move gets almost none (no visible lag).
// The speed is measured against the previous OUTPUT, so while the output lags behind a jump the cutoff stays high and
// it catches up quickly. Vectors ({x, y}) use the speed magnitude, so both axes share one cutoff (no diagonal skew).

/**
 * Default tuning, for positions in display-normalized units (0..1 of the canvas). Measured by
 * tests/smooth.unit.spec.js (seeded jitter + step response): still-hand jitter >= 3x lower, a fast step reaches 90 %
 * within ~120 ms.
 */
export const SMOOTH = Object.freeze({
  MIN_CUTOFF: 1.0, // Hz: cutoff for a still hand (lower = smoother, more lag on slow moves)
  BETA: 2.5, // Hz of cutoff added per unit/s of speed (higher = less lag on fast moves, more residual jitter)
  D_CUTOFF: 4, // Hz: cutoff of the speed estimate itself
  GAP_MS: 250, // no sample for this long (hand lost / not drawn) -> restart from the next value (no slide-in)
});

/** Per-visual tuning presets for values that are not display positions. Speeds scale with the value's range. */
export const SMOOTH_PRESETS = Object.freeze({
  pos: {},
  // Filter value -1..1 (the arc's dot): a tilt swing covers ~7x the range of a palm move (and jitters ~7x more),
  // so beta is scaled down by the same factor.
  filter: { BETA: 0.35 },
  // Hand size (display-height units, ~0.1-0.3): sizes the arc / pill / plate offsets. Same units as a position.
  size: {},
  // Canvas pixels (~1000x display units).
  px: { BETA: 0.0025 },
});

const alphaFor = (cutoffHz, dtS) => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
};

const isVec = (v) => v !== null && typeof v === "object";

/**
 * One filter. filter(value, tMs) -> smoothed value (number, or {x, y} — other keys of the input are copied through).
 * reset() forgets the state (next value is passed through as-is).
 */
export function createOneEuro(opts = {}) {
  const o = { ...SMOOTH, ...opts };
  let prev = null; // {x, y} (numbers use x only)
  let speed = 0;
  let lastT = null;

  return {
    filter(value, t) {
      if (value == null) {
        prev = null;
        lastT = null;
        return value;
      }
      const vec = isVec(value);
      const x = vec ? value.x : value;
      const y = vec ? value.y : 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return value;
      const dtMs = lastT === null ? Infinity : t - lastT;
      if (prev === null || !(dtMs < o.GAP_MS)) {
        prev = { x, y };
        speed = 0;
        lastT = t;
        return value;
      }
      if (dtMs <= 0) return vec ? { ...value, x: prev.x, y: prev.y } : prev.x; // same frame: same answer
      lastT = t;
      const dt = dtMs / 1000;
      const raw = Math.hypot(x - prev.x, y - prev.y) / dt;
      speed += (raw - speed) * alphaFor(o.D_CUTOFF, dt);
      const a = alphaFor(o.MIN_CUTOFF + o.BETA * speed, dt);
      prev = { x: prev.x + (x - prev.x) * a, y: prev.y + (y - prev.y) * a };
      return vec ? { ...value, x: prev.x, y: prev.y } : prev.x;
    },
    reset() {
      prev = null;
      lastT = null;
      speed = 0;
    },
    get value() {
      return prev;
    },
  };
}

/**
 * A bank of filters keyed per visual ("right/pos", "filter", "arp/pinchpt", ...).
 *   const sm = createSmoothers();
 *   const p = sm.get("right/pos", rawPos, nowMs);           // default tuning (display positions)
 *   const f = sm.get("filter", rawFilter, nowMs, "filter"); // a preset name or an options object
 * A null value resets that key (the visual is hidden; it starts fresh where it reappears).
 */
export function createSmoothers(defaults = {}) {
  const bank = new Map();
  return {
    get(key, value, t, preset = "pos") {
      let f = bank.get(key);
      if (!f) {
        const p = typeof preset === "string" ? SMOOTH_PRESETS[preset] || {} : preset || {};
        bank.set(key, (f = createOneEuro({ ...defaults, ...p })));
      }
      return f.filter(value, t);
    },
    reset(key) {
      if (key === undefined) bank.forEach((f) => f.reset());
      else bank.get(key)?.reset();
    },
    has: (key) => bank.has(key),
  };
}
