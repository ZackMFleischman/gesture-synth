// Gesture Synth design tokens + small canvas primitives.
//
// Everything here is pure: functions take a CanvasRenderingContext2D (`g`) and plain options,
// draw, and return the bounding rect they covered ({x, y, w, h}, canvas CSS pixels) so callers
// and tests can check layout. No DOM access, no state. See docs/ui-integration.md for where
// each element goes.
//
// Legibility over live video: every line is drawn with a dark halo under it and every label
// has either a halo or a soft plate (spec, "Notes on the mocks").
//
// Angles are radians in canvas convention: 0 = right (+x), positive = clockwise (towards +y).
// Use `DIR_ANGLE` for menu directions and `deg()` to convert.

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

/** One accent per mode. Chords keeps the app's existing amber, which is also the global chrome color. */
export const MODE_COLORS = Object.freeze({
  chords: "#e8a13d", // existing app accent (selects, chord display, meter) — unchanged
  arp: "#4fb3ff",
  lead: "#c08cff",
});

export const COLORS = Object.freeze({
  /** App chrome / brand accent (existing). Also the Chords mode color. */
  brand: "#e8a13d",
  /** Neutral ink for structure (tracks, outlines, master volume). Warm white. */
  ink: "#f3efe7",
  /** Quiet ink: available-state outlines and quiet labels. */
  quiet: "rgba(243, 239, 231, 0.5)",
  /** Faint ink: track bodies, unlit dots. */
  faint: "rgba(243, 239, 231, 0.22)",
  /** Soft dark plate behind labels/clusters. Matches the existing rgba(20,20,20,x) plates. */
  plate: "rgba(20, 20, 20, 0.62)",
  /** Halo drawn under every line/label so it reads on bright video. */
  halo: "rgba(0, 0, 0, 0.55)",
  /** Good / connected. */
  good: "#5ad17a",
  /** Warning only (hand lost, relayed connection). Not amber: amber is the app/Chords color. */
  warn: "#ff5a5f",
});

/** Line widths in CSS px. Keep lines thin. */
export const STROKE = Object.freeze({
  hair: 1,
  thin: 1.5, // available-state outlines, arcs
  mid: 2, // selected outline, markers
  rim: 3, // selected rim, countdown ring
  halo: 2, // extra width added on each side for the dark halo
});

/** Motion durations (ms). Spec: 120–200 ms; the beat pulse is the only repeating motion. */
export const MOTION = { // mutable: the Tweaks panel may change lostHold / lostFade / firstUse at runtime (read live)
  fast: 120, // fades, dim/undim, cancel (spec says ~100 ms; 120 is our floor)
  base: 150, // ring grow, confirm flash, chord-note line move
  slow: 200, // ladder slide, panel open
  countdown: 400, // get-ready ring (open question in spec; 0.4 s start value)
  hold: 300, // note-set / octave-arrow hold
  bpmLinger: 1000, // big BPM number stays after a pinch
  firstUse: 3000, // first-use labels
  lostHold: 1000, // "hand lost" ring + label stay fully visible this long...
  lostFade: 800, // ...then fade out over this long (real-camera feedback: a lingering ring isn't useful)
};

/**
 * Setting confirmed (note set, octave, any Lead setting): spec "progress first, then a clear confirmed state".
 * A short pop (scale popScale -> 1 + a white flash over popMs), the confirmed state stays fully visible until
 * holdMs after the confirm, then fades out over fadeMs. Real-camera feedback: the old 150 ms flash + 0.5 s
 * linger disappeared before the player could read it.
 */
export const CONFIRM = { // mutable: Tweaks may change holdMs / fadeMs at runtime (read live by confirmPhase)
  popMs: 150,
  popScale: 1.15,
  holdMs: 1000, // fully visible this long after the confirm (pop included)
  fadeMs: 300,
};

/**
 * Where a confirmed-setting visual is `since` ms after the confirm.
 * @param {number} since ms since the confirm (negative / non-finite = never confirmed)
 * @returns {{visible:boolean, alpha:number, scale:number, flash:number}}
 */
export function confirmPhase(since, c = CONFIRM) {
  if (!(since >= 0) || since >= c.holdMs + c.fadeMs) return { visible: false, alpha: 0, scale: 1, flash: 0 };
  const pop = Math.max(0, 1 - since / c.popMs); // 1 at the confirm -> 0 at popMs
  const fade = since <= c.holdMs ? 0 : (since - c.holdMs) / c.fadeMs;
  return {
    visible: true,
    alpha: 1 - easeOut(fade),
    scale: 1 + (c.popScale - 1) * pop * pop,
    flash: pop,
  };
}

/** Same family as the existing UI (index.html uses `monospace`). */
export const FONT = Object.freeze({
  family: "monospace",
  small: 11,
  label: 13,
  value: 16,
  big: 40, // the one large number/name in change (BPM during pinch, Lead note name)
});

/** Layout constants shared by the overlay + DOM additions (see docs/ui-integration.md §2). */
export const LAYOUT = Object.freeze({
  /** Width reserved at each screen edge for the edge tracks. Existing edge controls sit at x >= gutter. */
  gutter: 20,
  /** Track center distance from the screen edge. */
  trackInset: 9,
  trackWidth: 6,
  /** Marker tick length (centered on the track). */
  markerLength: 14,
  /** Safe margin at top/bottom of the tracks. */
  trackTop: 12,
  trackBottom: 12,
});

export const DIR_ANGLE = Object.freeze({
  up: -Math.PI / 2,
  right: 0,
  down: Math.PI / 2,
  left: Math.PI,
});

/** @param {number} d degrees @returns {number} radians */
export const deg = (d) => (d * Math.PI) / 180;

/** Ease-out cubic for 0..1 animation progress. */
export const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/**
 * The central "clear area": the player in the video. Persistent status UI (edge tracks, badges,
 * transport, chips, existing DOM controls) must never intersect it. Hand-anchored feedback
 * (menu ring, filter arc, cursor, countdown) follows the hand and is exempt.
 * @param {number} w viewport width (CSS px) @param {number} h viewport height
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function clearArea(w, h) {
  const portrait = h > w;
  const fx = 0.22; // fraction trimmed from left/right
  const top = portrait ? 0.19 : 0.16;
  const bottom = portrait ? 0.74 : 0.76;
  return { x: w * fx, y: h * top, w: w * (1 - 2 * fx), h: h * (bottom - top) };
}

/** @returns {boolean} true if two {x,y,w,h} rects overlap by more than `slack` px. */
export function rectsOverlap(a, b, slack = 0) {
  return (
    a.x + a.w - slack > b.x && b.x + b.w - slack > a.x && a.y + a.h - slack > b.y && b.y + b.h - slack > a.y
  );
}

/**
 * Returns `color` with alpha `a`. Accepts #rgb, #rrggbb or rgba()/rgb() strings.
 * @param {string} color @param {number} a 0..1
 */
export function withAlpha(color, a) {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    const n = parseInt(hex.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return color;
  const [r, g, b, a0 = 1] = m[1].split(",").map((s) => parseFloat(s));
  return `rgba(${r}, ${g}, ${b}, ${a0 * a})`;
}

/** X of the edge-track center for a side. @param {"left"|"right"} side @param {number} viewW */
export function edgeTrackX(side, viewW) {
  return side === "left" ? LAYOUT.trackInset : viewW - LAYOUT.trackInset;
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

const rect = (x, y, w, h) => ({ x, y, w, h });

/** Strokes the current path twice: dark halo, then color. */
function strokeHalo(g, color, width, { dash = null, alpha = 1, halo = true } = {}) {
  g.save();
  g.globalAlpha *= alpha;
  g.setLineDash(dash || []);
  if (halo) {
    g.lineWidth = width + STROKE.halo * 2;
    g.strokeStyle = COLORS.halo;
    g.globalAlpha *= 0.8;
    g.stroke();
    g.globalAlpha /= 0.8;
  }
  g.lineWidth = width;
  g.strokeStyle = color;
  g.stroke();
  g.restore();
}

function roundRectPath(g, x, y, w, h, r) {
  // Clamp at 0: a zero-height fill (value 0) would otherwise give arcTo a negative radius, which throws.
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/**
 * Soft dark plate (rounded rect) behind a label or cluster.
 * @param {CanvasRenderingContext2D} g
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {{radius?:number, alpha?:number, fill?:string, stroke?:string, lineWidth?:number, dash?:number[]}} [o]
 * @returns {{x,y,w,h}}
 */
export function drawPlate(g, x, y, w, h, o = {}) {
  const { radius = 6, alpha = 1, fill = COLORS.plate, stroke = null, lineWidth = STROKE.thin, dash = null } = o;
  g.save();
  g.globalAlpha *= alpha;
  roundRectPath(g, x, y, w, h, radius);
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.setLineDash(dash || []);
    g.lineWidth = lineWidth;
    g.strokeStyle = stroke;
    g.stroke();
  }
  g.restore();
  return rect(x, y, w, h);
}

/**
 * Text with a dark halo (default) or on a soft plate. Labels: max two words.
 * @param {CanvasRenderingContext2D} g
 * @param {string} text
 * @param {number} x @param {number} y anchor (see align/baseline)
 * @param {{size?:number, weight?:number|string, color?:string, align?:CanvasTextAlign,
 *          baseline?:CanvasTextBaseline, plate?:boolean, alpha?:number, padX?:number, padY?:number,
 *          radius?:number}} [o]  radius: plate corner radius (default: pill)
 * @returns {{x,y,w,h}} covered rect (plate rect when plate=true)
 */
export function drawLabel(g, text, x, y, o = {}) {
  const {
    size = FONT.label,
    weight = 400,
    color = COLORS.ink,
    align = "left",
    baseline = "middle",
    plate = false,
    alpha = 1,
    padX = 6,
    padY = 3,
    radius = null,
  } = o;
  g.save();
  g.globalAlpha *= alpha;
  g.font = `${weight} ${size}px ${FONT.family}`;
  g.textAlign = align;
  g.textBaseline = baseline;
  const w = g.measureText(text).width;
  const h = size * 1.15;
  const left = align === "center" ? x - w / 2 : align === "right" || align === "end" ? x - w : x;
  const top = baseline === "middle" ? y - h / 2 : baseline === "bottom" || baseline === "alphabetic" ? y - h : y;
  let r = rect(left, top, w, h);
  if (plate) {
    r = drawPlate(g, left - padX, top - padY, w + padX * 2, h + padY * 2, { radius: radius ?? (h + padY * 2) / 2 });
  } else {
    g.lineJoin = "round";
    g.lineWidth = Math.max(3, size / 5);
    g.strokeStyle = COLORS.halo;
    g.strokeText(text, x, y);
  }
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.restore();
  return r;
}

/**
 * Pill badge (x2, chips, set names). Outline = pending/available, filled = on.
 * @param {CanvasRenderingContext2D} g
 * @param {string} text
 * @param {number} cx center x @param {number} cy center y
 * @param {{color?:string, filled?:boolean, size?:number, alpha?:number, dash?:number[]}} [o]
 * @returns {{x,y,w,h}}
 */
export function drawPill(g, text, cx, cy, o = {}) {
  const { color = COLORS.ink, filled = false, size = FONT.label, alpha = 1, dash = null } = o;
  g.save();
  g.globalAlpha *= alpha;
  g.font = `600 ${size}px ${FONT.family}`;
  const w = g.measureText(text).width + size * 1.2;
  const h = size + 10;
  const x = cx - w / 2;
  const y = cy - h / 2;
  drawPlate(g, x, y, w, h, {
    radius: h / 2,
    fill: filled ? withAlpha(color, 0.9) : COLORS.plate,
    stroke: color,
    lineWidth: STROKE.thin,
    dash,
  });
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = filled ? "#111" : color;
  g.fillText(text, cx, cy + 0.5);
  g.restore();
  return rect(x, y, w, h);
}

/**
 * Straight dotted (or dashed) guide line, e.g. from a track marker to the hand.
 * @param {CanvasRenderingContext2D} g
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {{color?:string, lineWidth?:number, dash?:number[], alpha?:number}} [o]
 */
export function drawGuideLine(g, x0, y0, x1, y1, o = {}) {
  const { color = COLORS.quiet, lineWidth = 1.5, dash = [3, 5], alpha = 1 } = o;
  g.save();
  g.globalAlpha *= alpha;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  // Soft continuous shadow under the dots (a dashed halo would read as beads).
  g.lineCap = "round";
  g.lineWidth = lineWidth + 2.5;
  g.strokeStyle = "rgba(0, 0, 0, 0.3)";
  g.stroke();
  g.lineCap = "butt";
  g.setLineDash(dash);
  g.lineWidth = lineWidth;
  g.strokeStyle = color;
  g.stroke();
  g.restore();
  return rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
}

/**
 * Full-height edge track for one hand: thin rounded outline, fill below the marker, a marker tick
 * level with the hand, optional hollow "held" marker, optional dotted guide to the hand.
 *
 * States: live (default) | dim (held: control not under the hand) | lost (dashed, warning color).
 * Held + live markers together = "Return" state (move the hand to the hollow marker to retake control).
 *
 * @param {CanvasRenderingContext2D} g
 * @param {{
 *   x:number,               // track center x (use edgeTrackX(side, viewW))
 *   top:number, bottom:number,
 *   markerY?:number|null,   // solid marker (hand level); null = no live marker
 *   fillY?:number|null,     // top of the fill (defaults to markerY, or heldY when held)
 *   heldY?:number|null,     // hollow marker at the held value
 *   color?:string,          // mode color (right track) or COLORS.ink (master volume)
 *   fillAlpha?:number,
 *   dim?:boolean, lost?:boolean,
 *   guideTo?:{x:number,y:number}|null,  // hand point for the dotted guide
 * }} o
 * @returns {{x,y,w,h}} the track's rect (marker included)
 */
export function drawEdgeTrack(g, o) {
  const {
    x,
    top,
    bottom,
    markerY = null,
    heldY = null,
    color = COLORS.ink,
    fillAlpha = 0.35,
    dim = false,
    lost = false,
    guideTo = null,
  } = o;
  const fillY = o.fillY ?? markerY ?? heldY;
  const tw = LAYOUT.trackWidth;
  // Lost: the track body dims; only the markers turn into dashed warning marks.
  const c = color;
  const a = dim || lost ? 0.4 : 1;
  g.save();

  // Track body.
  roundRectPath(g, x - tw / 2, top, tw, bottom - top, tw / 2);
  g.save();
  g.fillStyle = "rgba(0,0,0,0.28)";
  g.fill();
  g.restore();
  strokeHalo(g, withAlpha(c, 0.55), STROKE.hair, { alpha: a, halo: false });

  // Fill below the value.
  if (fillY != null) {
    const fy = Math.min(bottom, Math.max(top, fillY));
    roundRectPath(g, x - tw / 2 + 1, fy, tw - 2, bottom - fy - 1, (tw - 2) / 2);
    g.fillStyle = withAlpha(c, fillAlpha * a);
    g.fill();
  }

  // Dotted guide from the marker to the hand.
  if (guideTo && markerY != null) {
    const dir = guideTo.x > x ? 1 : -1;
    drawGuideLine(g, x + dir * (LAYOUT.markerLength / 2 + 4), markerY, guideTo.x, guideTo.y, {
      color: lost ? COLORS.warn : COLORS.quiet,
      dash: lost ? [4, 4] : undefined,
      alpha: lost ? 0.8 : 0.9,
    });
  }

  // Hollow held marker.
  if (heldY != null) {
    g.beginPath();
    g.arc(x, heldY, 5, 0, Math.PI * 2);
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fill();
    strokeHalo(g, lost ? COLORS.warn : c, STROKE.mid, { halo: false, dash: lost ? [2, 2] : null });
  }

  // Solid marker tick, level with the hand.
  if (markerY != null) {
    const ml = LAYOUT.markerLength / 2;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(x - ml, markerY);
    g.lineTo(x + ml, markerY);
    strokeHalo(g, lost ? COLORS.warn : dim ? withAlpha(c, 0.6) : c, STROKE.rim, { dash: lost ? [3, 3] : null });
  }
  g.restore();
  const half = LAYOUT.markerLength / 2 + 1;
  return rect(x - half, top, half * 2, bottom - top);
}

/**
 * Thin circular arc (filter arc track, selected rim, ring progress). Optional dot on the arc.
 * @param {CanvasRenderingContext2D} g
 * @param {{cx:number, cy:number, r:number, a0:number, a1:number, color?:string, lineWidth?:number,
 *          dash?:number[], alpha?:number, dotAt?:number|null, dotColor?:string, dotRadius?:number,
 *          dotHollow?:boolean}} o  dotAt = 0..1 position along a0→a1
 * @returns {{x,y,w,h}} bounding box of the full circle (conservative)
 */
export function drawArc(g, o) {
  const {
    cx,
    cy,
    r,
    a0,
    a1,
    color = COLORS.quiet,
    lineWidth = STROKE.thin,
    dash = null,
    alpha = 1,
    dotAt = null,
    dotColor = color,
    dotRadius = 4.5,
    dotHollow = false,
  } = o;
  g.save();
  g.lineCap = "round";
  g.beginPath();
  g.arc(cx, cy, r, a0, a1, a1 < a0);
  strokeHalo(g, color, lineWidth, { dash, alpha });
  if (dotAt != null) {
    const a = a0 + (a1 - a0) * dotAt;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    g.beginPath();
    g.arc(px, py, dotRadius, 0, Math.PI * 2);
    g.globalAlpha *= alpha;
    g.fillStyle = dotHollow ? "rgba(0,0,0,0.55)" : dotColor;
    g.fill();
    g.lineWidth = dotHollow ? STROKE.mid : 1.5;
    g.strokeStyle = dotHollow ? dotColor : COLORS.halo;
    g.stroke();
  }
  g.restore();
  return rect(cx - r, cy - r, r * 2, r * 2);
}

/**
 * Annular segment (radial-menu arc). Supports the visual-language states:
 * available (outline only), approach (fill from r0 out to `fillTo`), selected (full fill +
 * stronger stroke; draw the rim separately with drawArc at r1 + 5).
 * @param {CanvasRenderingContext2D} g
 * @param {{cx:number, cy:number, r0:number, r1:number, a0:number, a1:number,
 *          stroke?:string, lineWidth?:number, fill?:string|null, fillAlpha?:number,
 *          fillTo?:number, alpha?:number}} o
 * @returns {{x,y,w,h}}
 */
export function drawArcSegment(g, o) {
  const {
    cx,
    cy,
    r0,
    r1,
    a0,
    a1,
    stroke = COLORS.quiet,
    lineWidth = STROKE.thin,
    fill = null,
    fillAlpha = 0.4,
    fillTo = r1,
    alpha = 1,
  } = o;
  const path = (ra, rb) => {
    g.beginPath();
    g.arc(cx, cy, rb, a0, a1);
    g.arc(cx, cy, ra, a1, a0, true);
    g.closePath();
  };
  g.save();
  g.globalAlpha *= alpha;
  // Dark under-fill keeps the segment readable on bright video.
  path(r0, r1);
  g.fillStyle = "rgba(0,0,0,0.14)";
  g.fill();
  if (fill && fillTo > r0) {
    path(r0, Math.min(r1, fillTo));
    g.fillStyle = withAlpha(fill, fillAlpha);
    g.fill();
  }
  path(r0, r1);
  g.lineJoin = "round";
  strokeHalo(g, stroke, lineWidth);
  g.restore();
  return rect(cx - r1, cy - r1, r1 * 2, r1 * 2);
}

/**
 * Ring around a point: note cursor (hollow = preview, filled + glow = active), countdown
 * (progress < 1 draws a partial sweep from `start`), hold-progress rings.
 * @param {CanvasRenderingContext2D} g
 * @param {{cx:number, cy:number, r:number, color?:string, lineWidth?:number, progress?:number,
 *          start?:number, fill?:string|null, glow?:boolean, dash?:number[], alpha?:number,
 *          track?:boolean}} o  track = also draw the faint full circle under a partial sweep
 * @returns {{x,y,w,h}}
 */
export function drawRing(g, o) {
  const {
    cx,
    cy,
    r,
    color = COLORS.ink,
    lineWidth = STROKE.mid,
    progress = 1,
    start = -Math.PI / 2,
    fill = null,
    glow = false,
    dash = null,
    alpha = 1,
    track = false,
  } = o;
  g.save();
  g.globalAlpha *= alpha;
  if (fill) {
    g.save();
    if (glow) {
      g.shadowColor = withAlpha(fill, 0.85);
      g.shadowBlur = r * 1.4;
    }
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = withAlpha(fill, 0.85);
    g.fill();
    g.restore();
  }
  if (track && progress < 1) {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    strokeHalo(g, withAlpha(color, 0.25), lineWidth, { halo: false });
  }
  if (progress > 0) {
    g.lineCap = "round";
    g.beginPath();
    if (progress >= 1) g.arc(cx, cy, r, 0, Math.PI * 2);
    else g.arc(cx, cy, r, start, start + Math.PI * 2 * progress);
    strokeHalo(g, color, lineWidth, { dash });
  }
  g.restore();
  const p = glow ? r * 0.6 : 0;
  return rect(cx - r - p, cy - r - p, (r + p) * 2, (r + p) * 2);
}

/**
 * Row of dots (beat dots, step dots, note-set segments as dots, octave marks).
 * @param {CanvasRenderingContext2D} g
 * @param {{x:number, y:number, count:number, active?:number|number[], r?:number, gap?:number,
 *          color?:string, align?:"left"|"center"|"right", vertical?:boolean, pulse?:number,
 *          hollowInactive?:boolean, alpha?:number}} o
 *   active: index (or indices) drawn filled in `color`; pulse 0..1 scales the first active dot
 * @returns {{x,y,w,h}}
 */
export function drawDots(g, o) {
  const {
    x,
    y,
    count,
    active = -1,
    r = 4,
    gap = 8,
    color = COLORS.ink,
    align = "left",
    vertical = false,
    pulse = 0,
    hollowInactive = true,
    alpha = 1,
  } = o;
  const act = new Set(Array.isArray(active) ? active : [active]);
  const span = count * r * 2 + (count - 1) * gap;
  const start = align === "center" ? -span / 2 : align === "right" ? -span : 0;
  g.save();
  g.globalAlpha *= alpha;
  for (let i = 0; i < count; i++) {
    const off = start + r + i * (r * 2 + gap);
    const px = vertical ? x : x + off;
    const py = vertical ? y + off : y;
    const on = act.has(i);
    const rr = on && pulse ? r * (1 + 0.35 * pulse) : r;
    g.beginPath();
    g.arc(px, py, rr, 0, Math.PI * 2);
    if (on) {
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = COLORS.halo;
      g.stroke();
    } else if (hollowInactive) {
      g.fillStyle = "rgba(0,0,0,0.35)";
      g.fill();
      g.lineWidth = STROKE.hair;
      g.strokeStyle = COLORS.quiet;
      g.stroke();
    } else {
      g.fillStyle = COLORS.faint;
      g.fill();
    }
  }
  g.restore();
  return vertical ? rect(x - r, y + start, r * 2, span) : rect(x + start, y - r, span, r * 2);
}

/**
 * Outline (or filled) triangle pointing up/down/left/right, e.g. Lead octave arrows.
 * @param {CanvasRenderingContext2D} g
 * @param {{cx:number, cy:number, size?:number, dir?:"up"|"down"|"left"|"right", color?:string,
 *          filled?:boolean, alpha?:number}} o
 * @returns {{x,y,w,h}}
 */
export function drawTriangle(g, o) {
  const { cx, cy, size = 12, dir = "up", color = COLORS.ink, filled = false, alpha = 1 } = o;
  const a = DIR_ANGLE[dir];
  const pts = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((t) => [
    cx + Math.cos(a + t) * size * 0.6,
    cy + Math.sin(a + t) * size * 0.6,
  ]);
  g.save();
  g.globalAlpha *= alpha;
  g.beginPath();
  g.moveTo(...pts[0]);
  g.lineTo(...pts[1]);
  g.lineTo(...pts[2]);
  g.closePath();
  g.lineJoin = "round";
  if (filled) {
    g.fillStyle = color;
    g.fill();
  } else {
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fill();
  }
  strokeHalo(g, color, STROKE.thin);
  g.restore();
  return rect(cx - size * 0.6, cy - size * 0.6, size * 1.2, size * 1.2);
}
