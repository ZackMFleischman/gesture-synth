// Pure layout metrics for the mobile UI pass (docs/mobile-ui.md). No DOM: runs in Node (tests) and the browser.
//
// A "rect" is {x, y, w, h} in CSS px. Every function clips to the viewport.

import { clearArea } from "../theme.js";

/** Viewports the mobile pass designs and tests for (CSS px). */
export const MOBILE_SIZES = Object.freeze({
  "390x844": { width: 390, height: 844 }, // iPhone 12-15
  "360x740": { width: 360, height: 740 }, // common Android
  "320x568": { width: 320, height: 568 }, // iPhone SE (1st gen), smallest supported
  "844x390": { width: 844, height: 390 }, // phone landscape
  "768x1024": { width: 768, height: 1024 }, // tablet portrait
});

/** Coverage budgets (fraction of the screen) the mobile system must stay under. */
export const BUDGET = Object.freeze({
  /** Collapsed, playing: all persistent UI (DOM chrome + canvas edge/status regions). */
  playing: 0.12,
  /** Collapsed, playing: DOM chrome only. */
  playingDom: 0.06,
  /** Minimal HUD: DOM chrome only. */
  minimalDom: 0.035,
  /** Smallest phones (< 360 px wide): the two edge tracks alone are ~6 % there. */
  small: { playing: 0.14, playingDom: 0.075, minimalDom: 0.04 },
  /** Minimum touch target edge when expanded (px). */
  touch: 44,
});

/** Budgets for a viewport (the small-phone row below 360 px width). */
export const budgetFor = (W) => (W < 360 ? { ...BUDGET, ...BUDGET.small } : BUDGET);

const clip = (r, W, H) => {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(W, r.x + r.w);
  const y1 = Math.min(H, r.y + r.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
};

/**
 * Area of the union of `rects` inside the W x H viewport (exact, by coordinate compression).
 * @param {{x:number,y:number,w:number,h:number}[]} rects
 */
export function unionArea(rects, W, H) {
  const rs = rects.map((r) => clip(r, W, H)).filter(Boolean);
  if (!rs.length) return 0;
  const xs = [...new Set(rs.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const xa = xs[i];
    const xb = xs[i + 1];
    const spans = rs
      .filter((r) => r.x <= xa && r.x + r.w >= xb)
      .map((r) => [r.y, r.y + r.h])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let cs = -Infinity;
    let ce = -Infinity;
    for (const [s, e] of spans) {
      if (s > ce) {
        covered += ce - cs > 0 ? ce - cs : 0;
        cs = s;
        ce = e;
      } else if (e > ce) ce = e;
    }
    covered += ce - cs > 0 ? ce - cs : 0;
    area += covered * (xb - xa);
  }
  return area;
}

/** Fraction (0..1) of the screen covered by the union of `rects`. */
export const coverage = (rects, W, H) => unionArea(rects, W, H) / (W * H);

/** Area of `r` ∩ `zone`. */
export function overlapArea(r, zone) {
  const x0 = Math.max(r.x, zone.x);
  const y0 = Math.max(r.y, zone.y);
  const x1 = Math.min(r.x + r.w, zone.x + zone.w);
  const y1 = Math.min(r.y + r.h, zone.y + zone.h);
  return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
}

/** Fraction of `zone` covered by the union of `rects`. */
export function zoneCoverage(rects, zone) {
  const local = rects
    .map((r) => {
      const x0 = Math.max(r.x, zone.x);
      const y0 = Math.max(r.y, zone.y);
      const x1 = Math.min(r.x + r.w, zone.x + zone.w);
      const y1 = Math.min(r.y + r.h, zone.y + zone.h);
      return x1 > x0 && y1 > y0 ? { x: x0 - zone.x, y: y0 - zone.y, w: x1 - x0, h: y1 - y0 } : null;
    })
    .filter(Boolean);
  return unionArea(local, zone.w, zone.h) / (zone.w * zone.h);
}

/**
 * Where the hands typically are while playing (same geometry as labs/ui-lab.js): palm ± 0.8 hand spans
 * sideways, fingers up to one span above the palm, wrist half a span below.
 * @returns {{chord:{x,y,w,h}, expr:{x,y,w,h}}}
 */
export function handZones(W, H) {
  const portrait = H > W;
  const hs = portrait ? W * 0.24 : H * 0.14;
  const zone = (cx, cy) => ({ x: cx - hs * 0.8, y: cy - hs * 1.0, w: hs * 1.6, h: hs * 1.5 });
  return {
    chord: zone(W * (portrait ? 0.24 : 0.25), H * (portrait ? 0.6 : 0.57)),
    expr: zone(W * 0.75, H * (portrait ? 0.5 : 0.47)),
  };
}

/** Parts of `rect` that leave the viewport (px beyond each edge; 0 = on screen). */
export function offscreen(r, W, H) {
  return {
    left: Math.max(0, -r.x),
    top: Math.max(0, -r.y),
    right: Math.max(0, r.x + r.w - W),
    bottom: Math.max(0, r.y + r.h - H),
  };
}

/**
 * One-stop summary used by the audit and the tests.
 * @param {{name:string, rect:{x,y,w,h}, dom?:boolean}[]} items persistent UI (user-opened panels excluded by the caller)
 */
export function summarize(items, W, H) {
  const rects = items.map((i) => i.rect);
  const dom = items.filter((i) => i.dom !== false).map((i) => i.rect);
  const clear = clearArea(W, H);
  const hz = handZones(W, H);
  return {
    viewport: `${W}x${H}`,
    coverage: coverage(rects, W, H),
    domCoverage: coverage(dom, W, H),
    clearOverlap: zoneCoverage(rects, clear),
    inClear: items.filter((i) => overlapArea(i.rect, clear) > 0).map((i) => i.name),
    handOverlap: Math.max(zoneCoverage(rects, hz.chord), zoneCoverage(rects, hz.expr)),
    offscreen: items
      .filter((i) => Object.values(offscreen(i.rect, W, H)).some((v) => v > 0.5))
      .map((i) => i.name),
  };
}
