// Reach zones: the fixed part of the screen a palm moves over. Pure (no DOM), unit-tested in Node.
//
// Everything is in DISPLAY space (0..1 of the canvas per axis, mirrored like the video; same as HandFrame.pos),
// because that is what the player sees and where the edge tracks / ladder are drawn ("the hand is the pointer").
//
// Vertical (user feedback after real-camera testing: the up/down range "keeps changing. It should just be 75% of the
// size of the screen."): HandFrame.height = palm y mapped over the FIXED middle 75 % of the display height,
// BAND.TOP (height 1) .. BAND.BOTTOM (height 0), clamped. Same band for both hands, every mode, every screen size;
// nothing about the hand (size, extent, distance to the camera) moves it.
// Horizontal (Drive / Space, experimental, off by default; src/core/axes.js): a fixed band on the side of the screen
//   the hand is DISPLAYED on, from `inner` (near the middle) to `outer` (near that edge). HandFrame.x = 0 at the inner
//   end, 1 at the outer end, with a neutral dead zone around the middle of the band (snaps to exactly 0.5).

/** The fixed band (display fractions). TOP/BOTTOM: palm y for height 1 / 0 (the middle 75 % of the height).
 *  INNER/OUTER: palm x for x 0 / 1 on the RIGHT half (mirrored on the left): starts a little past the middle (hands
 *  crossing the center is awkward and the other hand lives there) and ends where an ordinary open hand (the test hand at
 *  the desktop view) still fits whole in frame. */
export const BAND = Object.freeze({ TOP: 0.125, BOTTOM: 0.875, INNER: 0.56, OUTER: 0.88 });

export const ZONE = Object.freeze({
  /** Neutral zone in the middle of the horizontal band, as a fraction of the band width. */
  DEAD_ZONE: 0.16,
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The zone for a hand displayed on `side` ("left" | "right").
 * @returns {{top:number, bottom:number, inner:number, outer:number, side:"left"|"right"}}
 *   top/bottom = palm y for height 1 / 0 (BAND.TOP / BAND.BOTTOM on both sides); inner/outer = palm x for x 0 / 1
 *   (inner < outer on the right side, inner > outer on the left side).
 */
export function zoneFor(side = "right") {
  const right = side !== "left";
  return {
    top: BAND.TOP,
    bottom: BAND.BOTTOM,
    inner: right ? BAND.INNER : 1 - BAND.INNER,
    outer: right ? BAND.OUTER : 1 - BAND.OUTER,
    side: right ? "right" : "left",
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
