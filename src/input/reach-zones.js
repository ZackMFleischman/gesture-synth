// Reach zones: where a hand can actually go while the WHOLE hand stays in frame (user feedback: "I can't reach
// all the way to the top or bottom because my hand starts to get cut off"). Pure (no DOM), unit-tested in Node.
//
// Everything is in DISPLAY space (0..1 of the canvas per axis, mirrored like the video; same as HandFrame.pos),
// because that is what the player sees and where the edge tracks / ladder are drawn ("the hand is the pointer").
//
// Vertical: HandFrame.height = palm y mapped over [zone.top (=1) .. zone.bottom (=0)].
//   zone.top    = max(preset.top,    up   + MARGIN)       palm y at which the fingertips still have MARGIN to the top
//   zone.bottom = min(preset.bottom, 1 - down - MARGIN)   palm y at which the wrist still has MARGIN to the bottom
//   up / down = extent of the hand above / below the palm = max(measured from the 21 landmarks, RATIO x handSize),
//   so a fist (short) or a hand that briefly reads small does not widen the band, and a spread / rotated hand that
//   reaches further than the ratios still fits.
// Horizontal: a band on the side of the screen the hand is DISPLAYED on, from `inner` (near the middle) to `outer`
//   (near that edge, again limited so the whole hand stays in frame). HandFrame.x = 0 at the inner end, 1 at the
//   outer end, with a neutral dead zone around the middle of the band (snaps to exactly 0.5).
// Smoothing: the extents (not the output) go through a one-pole filter (TAU_MS), so the band does not jitter with
//   the hand-size estimate; the first frame after a hand appears sets them directly.

/**
 * Range presets for the palm (Controls panel "Range"). Display fractions.
 *  comfort (default): palm 20%..80% of the height. An open hand of ordinary size (handSize ~0.18 display heights, the
 *    test hand at the desktop view, about arm's length from a laptop camera) gets 0.26..0.80 from the extent rule
 *    below (fingertips need ~1.3 hand sizes + 3 % above the palm, the wrist ~0.9 + 3 % below), so 20/80 only bites for
 *    smaller / further hands: it keeps the travel to the middle 60 % of the screen, where the arm is comfortable and
 *    the top-left / bottom chrome is not under the hand; bigger (closer) hands get a narrower band automatically.
 *  wide: 10%..90% for small/far hands or players who want more travel. compact: 30%..70% (seated, small movements).
 *  Horizontal: the band starts a little past the middle (hands crossing the center is awkward and the other hand
 *  lives there) and ends before the edge.
 */
export const RANGE_PRESETS = Object.freeze({
  comfort: Object.freeze({ top: 0.2, bottom: 0.8, inner: 0.56, outer: 0.92 }),
  wide: Object.freeze({ top: 0.1, bottom: 0.9, inner: 0.53, outer: 0.97 }),
  compact: Object.freeze({ top: 0.3, bottom: 0.7, inner: 0.6, outer: 0.86 }),
});
export const DEFAULT_RANGE = "comfort";

export const ZONE = Object.freeze({
  /** Minimum extent above the palm center in hand sizes (palm center -> middle fingertip of a real open hand ~1.2). */
  UP: 1.3,
  /** Minimum extent below the palm center in hand sizes (palm center -> wrist = 0.8, plus the heel of the hand). */
  DOWN: 0.9,
  /** Minimum half width of the hand around the palm center, in hand sizes (thumb / pinky out). */
  SIDE: 0.8,
  /** Gap kept between the hand and the frame edge (display fraction). */
  MARGIN: 0.03,
  /** Band never shorter than this (display fraction); a hand too big to fit gets a centered band of this size. */
  MIN_SPAN: 0.12,
  /** Extent smoothing (one-pole time constant). */
  TAU_MS: 400,
  /** Extent changes below this fraction are ignored (pose changes: tilt, pinch, a fist keep the band still). */
  HYST: 0.12,
  /** Neutral zone in the middle of the horizontal band, as a fraction of the band width. */
  DEAD_ZONE: 0.16,
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Extent of a hand around its palm center (display units: up/down in display heights, side in display widths).
 * `pts` = landmarks already in display space; `aspect` = canvas width / height (handSize is in display-HEIGHT units).
 */
export function handExtents(pts, pos, handSize, aspect = 1) {
  let minY = pos.y, maxY = pos.y, maxDx = 0;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    const dx = Math.abs(p.x - pos.x);
    if (dx > maxDx) maxDx = dx;
  }
  const hs = handSize > 0 ? handSize : 0;
  return {
    up: Math.max(pos.y - minY, ZONE.UP * hs),
    down: Math.max(maxY - pos.y, ZONE.DOWN * hs),
    side: Math.max(maxDx, (ZONE.SIDE * hs) / (aspect > 0 ? aspect : 1)),
  };
}

/** Fit [lo, hi] into a band of at least MIN_SPAN (centered when the hand is too big to fit). */
function fit(lo, hi) {
  if (hi - lo >= ZONE.MIN_SPAN) return [lo, hi];
  const mid = (lo + hi) / 2;
  return [mid - ZONE.MIN_SPAN / 2, mid + ZONE.MIN_SPAN / 2];
}

/**
 * The zone for given extents. side = screen half the hand is displayed on ("left" | "right").
 * @returns {{top:number, bottom:number, inner:number, outer:number, side:"left"|"right", range:string}}
 *   top/bottom = palm y for height 1 / 0; inner/outer = palm x for x 0 / 1 (inner < outer on the right side,
 *   inner > outer on the left side).
 */
export function zoneFor(ext, side = "right", range = DEFAULT_RANGE) {
  const p = RANGE_PRESETS[range] || RANGE_PRESETS[DEFAULT_RANGE];
  const [top, bottom] = fit(Math.max(p.top, ext.up + ZONE.MARGIN), Math.min(p.bottom, 1 - ext.down - ZONE.MARGIN));
  // Right half: inner (near the middle) .. outer (near the right edge, whole hand inside).
  const [inR, outR] = fit(p.inner, Math.min(p.outer, 1 - ext.side - ZONE.MARGIN));
  const right = side !== "left";
  return {
    top, bottom,
    inner: right ? inR : 1 - inR,
    outer: right ? outR : 1 - outR,
    side: right ? "right" : "left",
    range: RANGE_PRESETS[range] ? range : DEFAULT_RANGE,
  };
}

/** Palm y -> height 0 (zone.bottom) .. 1 (zone.top), clamped. */
export function heightIn(zone, y) {
  const span = zone.bottom - zone.top;
  return span > 0 ? clamp01((zone.bottom - y) / span) : 0.5;
}

/** Height 0..1 -> palm y in the zone (inverse of heightIn; edge tracks / ladder draw with it). */
export function yForHeight(zone, h) {
  return zone.bottom - clamp01(h) * (zone.bottom - zone.top);
}

/** Raw position across the band: 0 at the inner end, 1 at the outer end (clamped, no dead zone). */
export function bandPos(zone, x) {
  const span = zone.outer - zone.inner;
  return span !== 0 ? clamp01((x - zone.inner) / span) : 0.5;
}

/** Applies the neutral dead zone around the middle: inside it -> exactly 0.5, outside rescaled to reach 0 / 1. */
export function deadZone(r, dz = ZONE.DEAD_ZONE) {
  const half = dz / 2;
  if (Math.abs(r - 0.5) <= half) return 0.5;
  const k = 0.5 / (0.5 - half);
  return r < 0.5 ? clamp01(0.5 - (0.5 - half - r) * k) : clamp01(0.5 + (r - 0.5 - half) * k);
}

/** Palm x -> HandFrame.x (0 inner .. 0.5 neutral .. 1 outer). */
export function xIn(zone, x) {
  return deadZone(bandPos(zone, x));
}

/** Inverse of xIn for a value outside the dead zone (or 0.5 = band middle): palm x that gives `v`. */
export function xForValue(zone, v) {
  const half = ZONE.DEAD_ZONE / 2;
  const k = 0.5 / (0.5 - half);
  let r = 0.5;
  if (v < 0.5) r = 0.5 - half - (0.5 - v) / k;
  else if (v > 0.5) r = 0.5 + half + (v - 0.5) / k;
  return zone.inner + clamp01(r) * (zone.outer - zone.inner);
}

/**
 * Stateful zone tracker for one hand: smooths the extents. update(ext|null, t) -> smoothed extents (null = hand lost:
 * forget, so the next appearance starts from its own size). A target that stays within HYST of the current one is
 * ignored (a tilt, a pinch or a fist changes the measured hand a little: the value under a still hand must not drift);
 * a bigger change (the hand came closer / went further away) becomes the new target and is glided to over TAU_MS.
 */
export function createZoneSmoother({ tauMs = ZONE.TAU_MS, hyst = ZONE.HYST } = {}) {
  let cur = null;
  let target = null;
  let lastT = null;
  const far = (a, b) => ["up", "down", "side"].some((k) => Math.abs(a[k] - b[k]) > hyst * b[k]);
  return {
    update(ext, t) {
      if (!ext) { cur = null; target = null; lastT = null; return null; }
      if (!cur) { cur = { ...ext }; target = { ...ext }; lastT = t; return cur; }
      if (far(ext, target)) target = { ...ext };
      const dt = Math.max(0, t - (lastT ?? t));
      lastT = t;
      const k = 1 - Math.exp(-dt / tauMs);
      cur = { up: cur.up + (target.up - cur.up) * k, down: cur.down + (target.down - cur.down) * k, side: cur.side + (target.side - cur.side) * k };
      return cur;
    },
    get value() { return cur; },
  };
}
