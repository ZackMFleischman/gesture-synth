// Lead mode: the left hand holds a chord as a soft pad; the right hand plays one melody line on top.
//   right height  -> note (snapped, hysteresis)       pinch -> play (discrete steps while moving, retrigger on re-pinch)
//   right shape   -> note set (1/2/3 fingers, 🤘 = 4; held 0.3 s; open hand = nothing)   tilt -> shared filter
//   pinch held 0.3 s on an octave arrow (pinch must start on it) -> octave +/-1
//   thumb: no function (the pinch uses it)
// Screen controls (2.1): mouse on the ladder, keyboard, note-set + octave buttons (rows in the Controls panel).
//
// The note ladder sits on the screen edge of the right (expression) hand: bus `ui/sides`.expr (published by
// src/ui/mode-ui.js; "right" when nobody publishes it, e.g. in labs/lead-lab.html). Mirrored when swapped.
// The master volume is the router's (left height); Chords' `exit` releases its own chord. Lead touches neither.
//
// Publishes: lead/noteset, lead/octave (state); chord + voicing (state: the pad chord, voicing 1 = the pad's
// triad, so the chord/quality displays and the energy wave read it); filter (continuous, right tilt);
// note/on + note/off with voice "lead" (and "pad" for the pad notes), ids from ctx.audio.nextNoteId.
// hold(ctx) (radial menu holds the right hand): the lead note stops, the ladder dims, the pad keeps playing
// and follows the left-hand chord.
// Lead layer (docs/architecture.md "Lead layer"): in the app Lead is a LAYER (`layer: true`) on top of a base mode
// (ctx.layerBase = "chords"|"arp"). Then the base is the accompaniment: no pad, no chord/voicing publishing, no
// energy wave of its own, and the tilt drives only the lead's own filter (ctx.audio.setLayerFilter). Without a base
// (labs/lead-lab.html) Lead plays its pad as before.

import {
  createLeadController,
  validCount,
  midiToFreq,
  noteName,
  NOTE_SETS,
  SET_SHAPES,
  OCTAVE_MIN,
  OCTAVE_MAX,
  ARROW_ENTER,
} from "./lead-notes.js";
import { createLeadVoice } from "./lead-voice.js";
import { leadConfig, setLeadConfig } from "./lead-config.js";
import { drawEnergy } from "./chords.js";
import { MODE_COLORS, COLORS, FONT as THEME_FONT, MOTION, withAlpha, easeOut, confirmPhase, drawLabel, rectsOverlap } from "../ui/theme.js";
import { createSafeArea } from "../ui/mobile/safe-area.js";
import { lostAlpha } from "../ui/edge-tracks.js";
import { BAND } from "../input/reach-zones.js";
import { createSmoothers } from "../ui/smooth.js";

// ---- Look: shared tokens from src/ui/theme.js; Lead-specific geometry below ----
export const LEAD_COLOR = MODE_COLORS.lead;
const C = {
  ink: COLORS.ink,
  quiet: COLORS.quiet,
  faint: COLORS.faint,
  plate: COLORS.plate,
  halo: COLORS.halo,
  warn: COLORS.warn, // hand lost (UI pass D2: coral, not amber)
};
const FONT = THEME_FONT.family;
/** Below this canvas width the ladder is narrower (docs/ui-integration.md Q5): 44 px wide, 22 px note name. */
export const NARROW_PX = 520;
const SIZE_WIDE = {
  edgeInset: 8, // ladder lines end this far from the screen edge
  lineThin: 40, // scale-note line length
  lineChord: 56, // chord-note line length
  widthThin: 1.5,
  widthChord: 4,
  arrowGap: 28, // arrow centre beyond the end lines
  arrowSize: 18,
  cursorR: 12,
  nameSize: 28,
};
const SIZE_NARROW = {
  edgeInset: 6,
  lineThin: 26,
  lineChord: 38, // 6 + 38 = 44 px from the edge
  widthThin: 1.5,
  widthChord: 3.5,
  arrowGap: 24,
  arrowSize: 14,
  cursorR: 10,
  nameSize: 22,
};
const LOOK = {
  topPx: 196, // top note line (below the filter readout / left column; up arrow reachable without the hand leaving the frame)
  bottomInset: 140, // bottom note line = H - this (palm must still reach the down arrow above the frame edge)
  lineMoveMs: MOTION.base, // chord-note lines move to the new chord (150 ms)
  slideMs: MOTION.slow, // ladder slide on an octave change (200 ms)
  flashMs: MOTION.base, // octave-arrow confirm flash (the confirm toasts use CONFIRM from theme.js)
  dimDuringHold: 0.4,
  markerTauMs: 35, // hand marker display smoothing (critically damped, display only)
  bandAlpha: 0.13, // sweet-spot band fill
  leanPx: 0.45, // cursor ring lean toward the approached neighbour, x cursorR at the switch point
};

const STEP_KEYS = ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote",
  "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight"];

/** Radius of an arrow's drawn footprint (lit size 1.25x, hold ring + its halo). */
const arrowReach = (sz) => sz.arrowSize * 1.25 * 1.05 + 5;
/**
 * Note labels on every ladder line (camera feedback: "show where to jump"): a column just inside the chord-line
 * ends. size = small quiet label; gap = column offset from the chord-line end; maxW = widest label (3 chars
 * "C#5" wide; narrow ladders drop the octave digit, see ladderLabelText); currentMin = smallest size of the
 * current note's plate (it shrinks from sz.nameSize so it never covers its neighbours' labels).
 */
/** Octave marks sit this much above the up arrow's centre (clear of the top line's label). */
const MARKS_RAISE = 6;
const LABEL_WIDE = { size: 11, gap: 6, maxW: 24, currentMin: 16, padY: 3 };
const LABEL_NARROW = { size: 10, gap: 4, maxW: 14, currentMin: 15, padY: 3 };
const labelLook = (sz) => (sz === SIZE_NARROW ? LABEL_NARROW : LABEL_WIDE);
/** Width of the ladder's footprint from the screen edge (lines, arrows, octave marks, note labels). */
const footprint = (sz) => Math.max(
  sz.edgeInset + sz.lineChord / 2 + sz.arrowSize * 1.35 + 10 + 8,
  sz.edgeInset + sz.lineChord + labelLook(sz).gap + labelLook(sz).maxW + 3,
);

/**
 * Ladder geometry in canvas px. side = screen edge of the expression hand ("left" | "right"); inset = safe-area
 * inset on that edge; clear = {top, bottom}: the band of that edge that is free of DOM controls (the arrows stay
 * inside it). `dir` points from the edge inward; `edge` = outer end of the lines, `inner` = inner end of the
 * chord lines. band = {top, bottom} in px: the right hand's vertical reach zone (palm y for height 1 / 0, bus
 * `right/zone`; src/input/reach-zones.js). With it the arrows sit at the band's ends and the lines between them, so
 * the whole ladder incl. both arrows is reachable with the whole hand in frame ("the hand is the pointer").
 */
export function ladderGeometry(W, H, side = "right", inset = 0, clear = null, band = null) {
  const sz = W < NARROW_PX ? SIZE_NARROW : SIZE_WIDE;
  const dir = side === "left" ? 1 : -1;
  const edge = side === "left" ? inset + sz.edgeInset : W - inset - sz.edgeInset;
  const reach = sz.arrowGap + arrowReach(sz) + 6;
  let top = Math.min(LOOK.topPx, Math.round(H * 0.24));
  let bottom = H - LOOK.bottomInset;
  if (band && band.bottom > band.top) {
    top = Math.round(band.top + sz.arrowGap);
    bottom = Math.round(band.bottom - sz.arrowGap);
  }
  if (clear) {
    top = Math.max(top, Math.ceil(clear.top + reach));
    bottom = Math.min(bottom, Math.floor(clear.bottom - reach));
  }
  bottom = Math.max(top + 120, bottom);
  return {
    W, H, side, dir, sz, edge, top, bottom,
    narrow: W < NARROW_PX,
    inner: edge + dir * sz.lineChord,
    cx: edge + (dir * sz.lineChord) / 2,
    upY: top - sz.arrowGap,
    downY: bottom + sz.arrowGap,
  };
}

// ---- DOM controls at the ladder's edge (status chips, readouts, left column, help button) ----
// The ladder's arrows must never sit under them. Measured at most every 500 ms (layout reads are not free).
const CLEAR_SEL = '#keySelect, #toneSelect, #guideToggle, #helpButton, #volumeMeter, #distortionDisplay, #outputChip, ' +
  '[data-gs-kind="status"], #gsBar, #gsPill';
const clearCache = { key: "", at: -Infinity, value: null };
function edgeClearance(W, H, side, now) {
  if (typeof document === "undefined") return null;
  const key = `${W}x${H}|${side}`;
  if (key === clearCache.key && now - clearCache.at < 500) return clearCache.value;
  const band = footprint(W < NARROW_PX ? SIZE_NARROW : SIZE_WIDE) + 4;
  const x0 = side === "left" ? 0 : W - band;
  let top = 0;
  let bottom = H;
  for (const el of document.querySelectorAll(CLEAR_SEL)) {
    if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.right <= x0 || r.left >= x0 + band) continue;
    if (r.top < H * 0.4) top = Math.max(top, r.bottom);
    else if (r.bottom > H * 0.6) bottom = Math.min(bottom, r.top);
  }
  clearCache.key = key;
  clearCache.at = now;
  clearCache.value = { top, bottom };
  return clearCache.value;
}
const uToY = (geo, u) => geo.bottom - u * (geo.bottom - geo.top);
const yToU = (geo, y) => (geo.bottom - y) / (geo.bottom - geo.top);
const ox = (geo, d) => geo.edge + geo.dir * d; // x at distance d inward from the line ends

// ---- Safe-area insets (landscape phones): the shared probe from src/ui/mobile/safe-area.js ----
let safeArea = null;
function safeInsets() {
  if (typeof document === "undefined" || !document.body) return { left: 0, right: 0 };
  if (!safeArea) safeArea = createSafeArea(document);
  return safeArea.get();
}

// ---- Mode state (module singleton, like chords.js) ----
const ctrl = createLeadController();
const S = ctrl.state;
let voice = null;
let filterParam = null;
let padChord = undefined;
let padApplied = false;
let lastGeo = ladderGeometry(1280, 800);

// Screen-control input (mouse / keyboard). It wins until the real hand moves.
const virt = {
  inside: false, down: false, y: 0.5, // pointer (display-normalized y)
  keys: [], // held note keys (ladder indices), last = sounding
  space: false, keyIdx: null, // arrow-key cursor + space bar
  touched: false, anchor: null, // hand position when the screen control took over
};

// What draw() renders.
const handSmooth = createSmoothers();
const view = {
  held: false, // the radial menu holds the right hand (router calls hold() instead of update())
  resumeGuard: false, // after a hold: a pinch still closed from before must open once before it plays
  hand: null, // {x,y} canvas px of the right palm as DRAWN (display-smoothed in draw(); null = none / screen control)
  handRaw: null, // the same, raw (set by update())
  handSize: 0,
  usingVirtual: false,
  lines: [], // [{midi, isChord, u, alpha}] displayed ladder lines (animated)
  ladderVersion: -1,
  prevLines: [], // lines before the last ladder change (for the move / slide animations)
  changeAt: -Infinity,
  changeKind: "context", // context | set | octave
  slideDir: 0,
  lastPreviewMidi: null,
  now: 0,
  regions: [], // [{name, kind: "edge"|"hand", rect}] drawn this frame (layout tests)
  padEl: null, // mouse strip on the ladder (screen control)
  padKey: "",
  labels: [], // ladder note labels drawn this frame [{midi, text, rect, size, color, chord}]
  current: null, // the current note's plate {midi, text, size, color, fill, rect}
  setBadge: null, // note-set badge drawn this frame {rect, alpha, scale, flash, confirmed}
  octaveToast: null, // octave confirm toast drawn this frame {rect, alpha, scale, flash}
  drawnAt: -Infinity, // ctx.now of the last draw()
  band: null, // the right hand's reach zone (bus `right/zone`, display fractions; last known)
  marker: null, // hand marker drawn this frame {y, targetY} (display-smoothed), null = hidden
  markerAt: -Infinity,
  sweet: null, // sweet-spot band drawn this frame {top, bottom}
  nearEdge: null, // edge feedback drawn this frame {midi (neighbour), amount 0..1, lean px}
};

/** Edge feedback geometry for the current note (null = nothing to show). Uses the final ladder positions. */
function proximityView(geo, lines, idx) {
  if (idx == null || S.pitch == null) return null;
  const notes = S.ladder.notes;
  const cur = notes[idx];
  if (!cur) return null;
  const lineU = (n) => (n ? lines.find((l) => l.midi === n.midi && !l.old)?.u ?? n.u : null);
  const yC = uToY(geo, lineU(cur));
  const up = notes[idx + 1], dn = notes[idx - 1];
  const yUp = up ? uToY(geo, lineU(up)) : null;
  const yDn = dn ? uToY(geo, lineU(dn)) : null;
  const gUp = yUp != null ? yC - yUp : yDn != null ? yDn - yC : 0;
  const gDn = yDn != null ? yDn - yC : gUp;
  const sw = leadConfig.sweetBand;
  const toward = S.proximityTo != null ? notes[S.proximityTo] : null;
  return {
    yC,
    top: yC - sw * gUp,
    bottom: yC + sw * gDn,
    toward,
    towardY: toward ? uToY(geo, lineU(toward)) : null,
    lean: S.lean,
  };
}

function ensureParams(ctx) {
  if (filterParam) return;
  filterParam = ctx.param("filter", {
    type: "continuous",
    min: -1,
    max: 1,
    onChange: (tilt) => {
      ctx.audio.setLayerFilter?.(tilt); // the lead voice's own filter
      if (!ctx.layerBase) ctx.audio.setFilter(tilt); // the pad's (shared) filter; a base holds its own value
    },
  });
}

function updatePad(ctx) {
  const chord = ctx.layerBase ? null : ctx.harmony.chord; // on top of a base mode: no pad
  const live = !!ctx.audio.ac;
  if (chord === padChord && padApplied === live) return;
  padChord = chord;
  padApplied = live;
  if (!live) return;
  voice.setPad(chord ? ctx.harmony.notes(chord.roman, chord.isMajor, 1) : null);
}

/** Chord display / quality / energy wave read these. The pad plays voicing 1 (the triad + octave). */
function publishChord(ctx) {
  if (ctx.layerBase) return; // the base mode publishes the chord
  const c = ctx.harmony.chord ?? null;
  ctx.bus.set("chord", c);
  ctx.bus.set("voicing", c ? 1 : 0);
  ctx.bus.set("chords/octave", false);
}

function handleEvents(evs, ctx) {
  for (const ev of evs) {
    switch (ev.type) {
      case "noteOn": voice.noteOn(midiToFreq(ev.midi), { midi: ev.midi }); break;
      case "step": voice.stepTo(midiToFreq(ev.midi), { midi: ev.midi }); break;
      case "noteOff": voice.noteOff(); break;
      case "noteset": ctx.bus.set("lead/noteset", ev.value); break;
      case "octave": ctx.bus.set("lead/octave", ev.value); break;
    }
  }
}

function virtualActive(right) {
  if (virt.inside || virt.down || virt.keys.length || virt.space) return true;
  if (!virt.touched) return false;
  if (!right) return true;
  if (!virt.anchor) { virt.anchor = { x: right.pos.x, y: right.pos.y }; return true; }
  if (Math.hypot(right.pos.x - virt.anchor.x, right.pos.y - virt.anchor.y) > 0.04) {
    virt.touched = false; // the hand moved: it takes control again
    return false;
  }
  return true;
}

function touchVirtual() {
  virt.touched = true;
  virt.anchor = null;
}

// ---- Ladder line animation (chord-note moves, fades, octave slide) ----

function captureLadderChange(now) {
  if (S.ladderVersion === view.ladderVersion) return;
  view.prevLines = view.lines.length ? currentLines(now) : [];
  view.ladderVersion = S.ladderVersion;
  view.changeAt = now;
  view.changeKind = S.changeKind;
  view.slideDir = S.octaveDir;
  view.lines = S.ladder.notes.map((n) => ({ midi: n.midi, isChord: n.isChord, u: n.u }));
}

/** Displayed lines at `now`: [{midi, isChord, u, alpha, fromU}] (final positions once the animation is over). */
function currentLines(now) {
  const t = (now - view.changeAt);
  const out = [];
  if (view.changeKind === "octave") {
    const e = easeOut(t / LOOK.slideMs);
    const off = view.slideDir * 0.5 * (1 - e);
    for (const l of view.lines) out.push({ midi: l.midi, isChord: l.isChord, u: l.u + off, alpha: e });
    if (e < 1) for (const l of view.prevLines) out.push({ midi: l.midi, isChord: l.isChord, u: l.u - view.slideDir * 0.5 * e, alpha: 1 - e, old: true });
    return out;
  }
  const e = easeOut(t / LOOK.lineMoveMs);
  const prevChord = view.prevLines.filter((l) => l.isChord && !l.old);
  const prevAll = new Set(view.prevLines.map((l) => l.midi));
  for (const l of view.lines) {
    let u = l.u;
    let alpha = 1;
    if (e < 1) {
      if (l.isChord && prevChord.length) {
        // Chord lines slide from the nearest old chord line: the player sees where the safe notes went.
        let from = prevChord[0].u;
        for (const p of prevChord) if (Math.abs(p.u - l.u) < Math.abs(from - l.u)) from = p.u;
        u = from + (l.u - from) * e;
      } else if (!prevAll.has(l.midi)) {
        alpha = e;
      }
    }
    out.push({ midi: l.midi, isChord: l.isChord, u, alpha });
  }
  return out;
}

// ---- Drawing helpers (halo'd, readable over video) ----

function strokeHalo(g, color, width, dash = null) {
  g.setLineDash(dash || []);
  g.lineWidth = width + 4;
  g.strokeStyle = C.halo;
  g.stroke();
  g.lineWidth = width;
  g.strokeStyle = color;
  g.stroke();
  g.setLineDash([]);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
}

function plateLabel(g, text, x, y, { size = 13, weight = 600, color = C.ink, align = "left", padX = 7, padY = 4, stroke = null, fill = C.plate } = {}) {
  g.font = `${weight} ${size}px ${FONT}`;
  const w = g.measureText(text).width;
  const h = size * 1.15;
  const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  roundRect(g, left - padX, y - h / 2 - padY, w + padX * 2, h + padY * 2, (h + padY * 2) / 2);
  g.fillStyle = fill;
  g.fill();
  if (stroke) { g.lineWidth = 1.5; g.strokeStyle = stroke; g.stroke(); }
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(text, left, y + 1);
  return { x: left - padX, y: y - h / 2 - padY, w: w + padX * 2, h: h + padY * 2 };
}

/** 4 segments of growing height (= more notes). */
function drawSetSegments(g, x, yBase, { active, scale = 1, hScale = 1, target = null, progress = 0, flash = 0, alpha = 1 }) {
  const w = 6 * scale, gap = 3 * scale;
  g.save();
  g.globalAlpha *= alpha;
  for (let i = 1; i <= 4; i++) {
    const h = (4 + i * 3.5) * (scale / (scale > 1.5 ? 1.25 : 1)) * hScale;
    const sx = x + (i - 1) * (w + gap);
    const sy = yBase - h;
    roundRect(g, sx, sy, w, h, Math.min(2 * scale, w / 2));
    if (i === active && target == null) {
      g.fillStyle = LEAD_COLOR;
      g.fill();
    } else {
      g.fillStyle = "rgba(0,0,0,0.4)";
      g.fill();
      g.lineWidth = i === target ? 1.5 : 1;
      g.strokeStyle = i === target ? LEAD_COLOR : i === active ? withAlpha(LEAD_COLOR, 0.7) : C.quiet;
      g.stroke();
      if (i === target && progress > 0) {
        const fh = h * progress;
        roundRect(g, sx, yBase - fh, w, fh, Math.min(2 * scale, w / 2));
        g.fillStyle = withAlpha(LEAD_COLOR, 0.9);
        g.fill();
      }
    }
    if (flash > 0 && i === active) {
      roundRect(g, sx - 2, sy - 2, w + 4, h + 4, 3 * scale);
      g.fillStyle = `rgba(255,255,255,${0.8 * flash})`;
      g.fill();
    }
  }
  g.restore();
  return { w: 4 * w + 3 * gap, h: (4 + 4 * 3.5) * scale };
}

/**
 * Octave arrow. States: available (outline), lit (cursor on it: solid fill, 1.25x), hold (ring fills),
 * confirmed (solid flash), grey (at the limit: solid grey outline, never lights up).
 */
function drawArrow(g, cx, cy, dir, size, { lit, grey, progress, flash = 0 }) {
  const big = (lit || progress > 0) && !grey ? 1.25 : 1;
  const s = size * big;
  const r = s * 1.05;
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = flash > 0 ? withAlpha(LEAD_COLOR, 0.35 + 0.5 * flash) : "rgba(0,0,0,0.4)";
  g.fill();
  g.beginPath();
  const d = dir === "up" ? -1 : 1;
  g.moveTo(cx, cy + d * s * 0.42);
  g.lineTo(cx - s * 0.55, cy - d * s * 0.32);
  g.lineTo(cx + s * 0.55, cy - d * s * 0.32);
  g.closePath();
  g.lineJoin = "round";
  if (flash > 0) {
    g.fillStyle = "#fff";
    g.fill();
  } else if (grey) {
    strokeHalo(g, "rgba(140,140,140,0.9)", 1.5);
  } else {
    g.fillStyle = lit || progress > 0 ? LEAD_COLOR : "rgba(0,0,0,0.35)";
    g.fill();
    strokeHalo(g, lit || progress > 0 ? "#fff" : "rgba(243, 239, 231, 0.85)", lit ? 2 : 1.5);
  }
  if (progress > 0) {
    g.beginPath();
    g.arc(cx, cy, r + 3, 0, Math.PI * 2);
    g.lineWidth = 3;
    g.strokeStyle = withAlpha(LEAD_COLOR, 0.3);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, r + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    g.lineCap = "round";
    strokeHalo(g, LEAD_COLOR, 3.5);
  }
  if (flash > 0) {
    g.beginPath();
    g.arc(cx, cy, r + 3 + 4 * (1 - flash), 0, Math.PI * 2);
    g.lineWidth = 3;
    g.strokeStyle = `rgba(255,255,255,${flash})`;
    g.stroke();
  }
  g.restore();
}

/** Places the mouse strip (screen control) over the ladder band on the expression edge. */
function placePad(geo) {
  const el = view.padEl;
  if (!el) return;
  const w = geo.sz.lineChord + geo.sz.edgeInset + 64;
  const top = Math.max(0, geo.upY - 40);
  const h = geo.downY + 40 - top;
  const key = `${geo.side}|${w}|${top}|${h}`;
  if (key === view.padKey) return;
  view.padKey = key;
  el.style.top = `${top}px`;
  el.style.height = `${h}px`;
  el.style.width = `${w}px`;
  el.style.left = geo.side === "left" ? "0px" : "auto";
  el.style.right = geo.side === "left" ? "auto" : "0px";
}

// ---- Ladder note labels (camera feedback: every line shows its note name) ----

/**
 * Small label text for a ladder line. Wide ladders: the full name ("C#5"). Narrow ladders (phones, below
 * NARROW_PX) drop the octave digit ("C#"): the ladder spans two octaves, the current note's plate keeps the
 * full name, and the column stays ~14 px wide so it does not push into the player on a 390 px screen.
 */
export function ladderLabelText(name, narrow) {
  return narrow ? name.replace(/-?\d+$/, "") : name;
}

/** x of the label column (outer edge of the labels, just inside the chord-line ends). */
const labelColumnX = (geo) => ox(geo, geo.sz.lineChord + labelLook(geo.sz).gap);

/** Is the ladder too tight to label every line? (One semitone is closer than a small label is tall.) */
function labelsTight(geo) {
  return (geo.bottom - geo.top) / 24 < labelLook(geo.sz).size * 1.15 + 1;
}

/**
 * The current note's plate: its size shrinks from sz.nameSize so it never covers its neighbours' labels
 * (25 lines in "All notes" sit one semitone = ~20 px apart at 800 px height), never below LABEL.currentMin.
 * Returns {size, padX, padY, x (text anchor), rect}. `labeled(l)` = does line l get a small label.
 */
function currentPlateLayout(g, geo, lines, cur, labeled) {
  const L = labelLook(geo.sz);
  const smallH = L.size * 1.15;
  let gap = Infinity;
  for (const l of lines) {
    if (l.old || l.midi === cur.midi || !labeled(l)) continue;
    gap = Math.min(gap, Math.abs(uToY(geo, l.u) - cur.y));
  }
  const fitFor = (padY) => (Number.isFinite(gap) ? (2 * (gap - 1) - smallH - 2 * padY) / 1.15 : Infinity);
  let padY = L.padY;
  let size = Math.floor(Math.max(L.currentMin, Math.min(geo.sz.nameSize, fitFor(padY))));
  if (fitFor(padY) < L.currentMin) {
    // Very dense ladder (All notes on a short reach band, ~15 px per semitone): a slimmer plate, down to 2 px
    // above the small labels, so the neighbours' names stay visible.
    padY = 1;
    size = Math.floor(Math.max(L.size + 2, Math.min(L.currentMin, fitFor(padY))));
  }
  const padX = geo.narrow ? 6 : 7;
  g.font = `700 ${size}px ${FONT}`;
  const w = g.measureText(cur.name).width;
  const h = size * 1.15;
  const x0 = labelColumnX(geo); // the plate's outer edge = the column's outer edge
  const left = geo.dir > 0 ? x0 : x0 - w - padX * 2;
  return {
    size, padX, padY,
    x: geo.dir > 0 ? x0 + padX : x0 - padX, // text anchor for plateLabel (align = inner side)
    rect: { x: left, y: cur.y - h / 2 - padY, w: w + padX * 2, h: h + padY * 2 },
  };
}

/**
 * Small, quiet note names on the ladder lines (theme drawLabel: halo, legible over video); chord notes a bit
 * brighter. A label that would collide with the current note's plate or another label is skipped (only in
 * layouts too tight for all of them). Tight (labelsTight: landscape phones) = only chord notes are labelled:
 * the safe notes are the ones to aim for; the current note always shows.
 * Returns [{midi, text, rect, size, color, chord}] for _debug / layout tests.
 */
function drawLadderLabels(g, geo, lines, alphaMul, { skipMidi = null, avoid = [], labeled, emphasis = null }) {
  const L = labelLook(geo.sz);
  const x = labelColumnX(geo);
  const align = geo.dir > 0 ? "left" : "right";
  const placed = [];
  const out = [];
  for (const l of lines) {
    if (l.midi === skipMidi && !l.old) continue;
    if (!labeled(l)) continue;
    const a = alphaMul * l.alpha;
    if (a <= 0.02) continue;
    const name = S.ladder.notes.find((n) => n.midi === l.midi)?.name ?? noteName(l.midi, S.keyName);
    const text = ladderLabelText(name, geo.narrow);
    const y = uToY(geo, l.u);
    g.font = `${l.isChord ? 600 : 400} ${L.size}px ${FONT}`;
    const w = g.measureText(text).width;
    const h = L.size * 1.15;
    const r = { x: align === "left" ? x : x - w, y: y - h / 2, w, h };
    if (!l.old && (avoid.some((b) => rectsOverlap(r, b, 0.5)) || placed.some((b) => rectsOverlap(r, b, 0.5)))) continue;
    const emph = emphasis && !l.old && emphasis.midi === l.midi && emphasis.amount > 0.2 ? emphasis.amount : 0;
    const color = emph ? withAlpha(LEAD_COLOR, 0.55 + 0.45 * emph) : l.isChord ? "rgba(243, 239, 231, 0.92)" : "rgba(243, 239, 231, 0.6)";
    drawLabel(g, text, x, y, { size: L.size, weight: emph || l.isChord ? 600 : 400, color, align, alpha: a });
    if (!l.old) {
      placed.push(r);
      out.push({ midi: l.midi, text, rect: r, size: L.size, color, chord: l.isChord });
    }
  }
  return out;
}

// ---- Setting confirmed: pop, ~1 s fully visible, fade (CONFIRM in src/ui/theme.js) ----

/**
 * The note-set badge: approach fill while a shape is held, then the confirmed state (pop + flash, fully
 * visible ~1 s, fade). At the hand (beside it, towards the screen centre, so the fingers stay visible); with no
 * hand (keyboard / Controls) beside the ladder. Returns {rect, alpha, scale, flash, confirmed} or null.
 */
function drawSetBadge(g, geo, now, { holding, anchorHand }) {
  const ph = confirmPhase(now - S.setChangedAt);
  if (!holding && !ph.visible) return null;
  const W = geo.W, H = geo.H, dir = geo.dir;
  const confirmed = !holding;
  const alpha = holding ? 1 : ph.alpha;
  const scale = holding ? 1 : ph.scale;
  const flash = holding ? 0 : ph.flash;
  const target = holding ? S.setHoldTarget : null;
  const id = holding ? S.setHoldTarget : S.setId;
  const label = NOTE_SETS[id].name;
  const shape = SET_SHAPES[id];
  // Keycap emoji (1️⃣) draw as a bare box in canvas fonts without color emoji: the label says it already.
  const shapeText = shape.emoji.includes("⃣") ? shape.label : `${shape.emoji} ${shape.label}`;
  const sc = 2.2;
  const segW = (4 * 6 + 3 * 3) * sc;
  g.save();
  g.font = `800 15px ${FONT}`;
  const tw = g.measureText(label).width;
  g.font = `600 12px ${FONT}`;
  const sw = g.measureText(shapeText).width;
  const bw = Math.max(segW, tw, sw) + 28;
  const bh = 108;
  let ax, ay;
  if (anchorHand) {
    const hs = Math.max(50, view.handSize || 90);
    ax = view.hand.x + dir * (hs * 0.6 + bw / 2);
    ay = view.hand.y - hs * 0.2;
  } else {
    ax = ox(geo, footprint(geo.sz) + 16) + (dir * bw) / 2;
    ay = geo.top + (geo.bottom - geo.top) * 0.35;
  }
  ax = Math.min(W - bw / 2 - 8, Math.max(bw / 2 + 8, ax));
  ay = Math.min(H - bh / 2 - 8, Math.max(bh / 2 + 8, ay));
  g.globalAlpha = alpha;
  g.translate(ax, ay);
  g.scale(scale, scale);
  g.translate(-ax, -ay);
  roundRect(g, ax - bw / 2, ay - bh / 2, bw, bh, 12);
  g.fillStyle = C.plate;
  g.fill();
  g.lineWidth = confirmed ? 3 : 1.5;
  g.strokeStyle = flash > 0 ? "#fff" : confirmed ? LEAD_COLOR : withAlpha(LEAD_COLOR, 0.55);
  g.stroke();
  if (flash > 0) {
    roundRect(g, ax - bw / 2, ay - bh / 2, bw, bh, 12);
    g.fillStyle = `rgba(255,255,255,${0.3 * flash})`;
    g.fill();
  }
  drawSetSegments(g, ax - segW / 2, ay - 2, { active: S.setId, scale: sc, target, progress: S.setHoldProgress, flash });
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = confirmed ? LEAD_COLOR : C.ink;
  g.font = `${confirmed ? 800 : 600} 15px ${FONT}`;
  g.fillText(label, ax, ay + 14);
  // The hand shape for this set (what to show the camera), quiet.
  g.fillStyle = C.quiet;
  g.font = `600 12px ${FONT}`;
  g.fillText(shapeText, ax, ay + 32);
  // Hold progress along the bottom edge (grows with the hold time; full once confirmed).
  const px0 = ax - bw / 2 + 12;
  const pw = bw - 24;
  const py = ay + bh / 2 - 8;
  g.lineCap = "round";
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(px0, py);
  g.lineTo(px0 + pw, py);
  g.strokeStyle = "rgba(243, 239, 231, 0.18)";
  g.stroke();
  g.beginPath();
  g.moveTo(px0, py);
  g.lineTo(px0 + pw * (holding ? S.setHoldProgress : 1), py);
  g.strokeStyle = LEAD_COLOR;
  g.stroke();
  g.restore();
  const w = bw * scale, h = bh * scale;
  return { rect: { x: ax - w / 2, y: ay - h / 2, w, h }, alpha, scale, flash, confirmed };
}

/**
 * Octave confirmed: "Octave up: A5" plate beside the arrow that was used (inner side), pop + flash, fully
 * visible ~1 s, fade. Returns {rect, alpha, scale, flash} or null.
 */
function drawOctaveToast(g, geo, now) {
  const ph = confirmPhase(now - S.octaveChangedAt);
  if (!ph.visible) return null;
  const up = S.octaveDir >= 0;
  const low = S.ladder.notes.length ? noteName(S.ladder.low, S.keyName) : String(S.octave);
  const text = `Octave ${up ? "up" : "down"}: ${low}`;
  const x = geo.cx + geo.dir * (geo.sz.arrowSize * 1.35 + 30);
  const y = up ? geo.upY : geo.downY;
  g.save();
  g.globalAlpha = ph.alpha;
  g.translate(x, y);
  g.scale(ph.scale, ph.scale);
  g.translate(-x, -y);
  const r = plateLabel(g, text, x, y, {
    size: geo.narrow ? 12 : 14, weight: 800, align: geo.dir > 0 ? "left" : "right",
    color: ph.flash > 0.5 ? "#fff" : LEAD_COLOR, stroke: ph.flash > 0 ? "#fff" : withAlpha(LEAD_COLOR, 0.9),
  });
  g.restore();
  const sx = (v) => x + (v - x) * ph.scale;
  const sy = (v) => y + (v - y) * ph.scale;
  const x0 = sx(r.x), y0 = sy(r.y);
  return { rect: { x: x0, y: y0, w: sx(r.x + r.w) - x0, h: sy(r.y + r.h) - y0 }, alpha: ph.alpha, scale: ph.scale, flash: ph.flash };
}

// ---- The mode ----

const lead = {
  id: "lead",
  name: "Lead",
  icon: "🎵",
  color: LEAD_COLOR,
  direction: "left",
  signals: [
    { name: "lead/noteset", type: "state" },
    { name: "lead/octave", type: "state" },
    { name: "chord", type: "state" }, // the pad chord (chord display, energy wave)
    { name: "voicing", type: "state" },
    { name: "filter", type: "continuous" }, // right tilt
  ],

  enter(ctx) {
    ensureParams(ctx);
    if (!voice) voice = createLeadVoice(ctx.audio, { bus: ctx.bus, nextId: ctx.audio.nextNoteId });
    view.held = false;
    view.resumeGuard = !!ctx.rightLocked; // entered via the menu: wait for an open hand before playing
    padChord = undefined;
    padApplied = false;
    // Start the pad right now (same frame as the previous mode's exit): a slow frame must not open a gap.
    ctrl.setContext(ctx.harmony.keyName, ctx.harmony.chord, ctx.now);
    updatePad(ctx);
    if (ctx.rightLocked && filterParam) filterParam.value = ctx.rightLocked.tilt;
    ctx.bus.set("lead/noteset", S.setId);
    ctx.bus.set("lead/octave", S.octave);
    publishChord(ctx);
  },

  exit() {
    ctrl.release();
    if (voice) voice.stop();
    padChord = undefined;
    padApplied = false;
    view.held = false;
  },

  /** Menu holds the right hand: the lead note stops, the ladder dims; the pad follows the left-hand chord. */
  hold(ctx) {
    const now = ctx.now;
    view.now = now;
    if (!voice) lead.enter(ctx);
    view.held = true;
    view.resumeGuard = true;
    view.handRaw = null;
    if (S.pinchMode !== "none") handleEvents(ctrl.release(), ctx);
    ctrl.setContext(ctx.harmony.keyName, ctx.harmony.chord, now);
    updatePad(ctx);
    captureLadderChange(now);
    publishChord(ctx);
  },

  update(right, ctx) {
    const now = ctx.now;
    view.now = now;
    if (!voice) lead.enter(ctx);
    view.held = false;
    ctrl.setContext(ctx.harmony.keyName, ctx.harmony.chord, now);
    updatePad(ctx);

    // ---- Input: screen control (until the hand moves) or the right hand ----
    const geo = lastGeo;
    const useVirtual = virtualActive(right);
    view.usingVirtual = useVirtual;
    let input;
    if (useVirtual) {
      const keyNote = virt.keys.length ? virt.keys[virt.keys.length - 1] : virt.keyIdx;
      input = {
        present: true,
        u: yToU(geo, virt.y * geo.H),
        pinch: virt.down || virt.keys.length > 0 || virt.space,
        count: null,
        noteIdx: keyNote,
      };
      view.handRaw = null;
    } else if (right) {
      const p = ctx.toCanvas(right.pos);
      view.handRaw = p;
      view.handSize = right.handSize * geo.H;
      input = { present: true, u: yToU(geo, p.y), pinch: right.pinch, count: validCount(right), noteIdx: null };
      if (filterParam) filterParam.value = right.tilt;
    } else {
      input = null;
    }
    // After the menu let go: a pinch still closed from before never plays; it has to open once.
    if (view.resumeGuard) {
      if (input && input.pinch && !useVirtual) input.pinch = false;
      else if (input) view.resumeGuard = false;
    }

    handleEvents(ctrl.step(input, now), ctx);
    // Keyboard notes drive the cursor; once released the cursor stays there for the arrow keys.
    if (useVirtual && input.noteIdx != null) virt.keyIdx = input.noteIdx;
    captureLadderChange(now);
    if (S.preview != null) view.lastPreviewMidi = S.ladder.notes[S.preview].midi;

    publishChord(ctx);
  },

  draw(g, ctx) {
    const now = ctx ? ctx.now : view.now;
    // Display-only smoothing of the hand anchor (guide line to the cursor, set badge); notes use the raw hand.
    view.hand = view.handRaw ? handSmooth.get("hand", view.handRaw, now, "px") : handSmooth.get("hand", null, now);
    const W = g.canvas.width;
    const H = g.canvas.height;
    const sides = ctx?.bus?.get?.("ui/sides");
    const side = sides && sides.expr === "left" ? "left" : "right";
    // Reach zone of the right hand (the fixed height band, src/input/reach-zones.js; BAND before a hand was seen).
    const z = ctx?.bus?.get?.("right/zone");
    if (z && typeof z.top === "number") view.band = z;
    const zb = view.band || { top: BAND.TOP, bottom: BAND.BOTTOM };
    const band = { top: zb.top * H, bottom: zb.bottom * H };
    const geo = (lastGeo = ladderGeometry(W, H, side, safeInsets()[side], edgeClearance(W, H, side, now), band));
    const sz = geo.sz;
    const dir = geo.dir;
    const alignIn = side === "left" ? "left" : "right"; // labels on the inner side of the ladder
    view.regions = [];
    view.drawnAt = now;
    const reg = (name, kind, rect) => (rect && view.regions.push({ name, kind, rect }), rect);
    placePad(geo);
    captureLadderChange(now);
    const lines = currentLines(now);
    const span = geo.bottom - geo.top;
    // Held: the radial menu has the right hand (hold() instead of update()). Ladder dims, nothing sounds.
    const menuHeld = view.held;
    const holding = !menuHeld && S.setHoldTarget != null && S.setHoldProgress > 0;
    const lostNow = !S.present && S.lostSince != null;
    const ladderAlpha = holding || lostNow || menuHeld ? LOOK.dimDuringHold : 1;

    // ---- Energy wave behind the chord display (every mode; the pad chord here) ----
    if (ctx?.harmony && !ctx.layerBase) {
      const ch = ctx.harmony.chord;
      drawEnergy(g, S.pinchMode === "note" ? 0.7 : 0.3, ch ? 1 : 0, filterParam?.value ?? 0, ch ? ch.roman : null);
    }

    g.save();
    // ---- Soft dark backing so the ladder reads over bright video ----
    {
      const x0 = ox(geo, sz.lineChord + 8);
      const xEdge = side === "left" ? 0 : W;
      const grad = g.createLinearGradient(x0, 0, xEdge, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.35, "rgba(0,0,0,0.22)");
      grad.addColorStop(1, "rgba(0,0,0,0.3)");
      roundRect(g, Math.min(x0, xEdge), geo.top - 16, Math.abs(xEdge - x0), span + 32, 10);
      g.fillStyle = grad;
      g.fill();
    }

    // ---- Edge feedback (current note): sweet-spot band under the lines ----
    const pIdx = S.pinchMode === "note" ? S.playIdx : S.preview;
    const pv = !menuHeld && S.present && !S.hover ? proximityView(geo, lines, pIdx) : null;
    view.sweet = null;
    if (pv) {
      roundRect(g, Math.min(geo.edge, ox(geo, sz.lineChord)), pv.top, sz.lineChord, Math.max(2, pv.bottom - pv.top), 4);
      g.fillStyle = withAlpha(LEAD_COLOR, LOOK.bandAlpha);
      g.fill();
      view.sweet = { top: pv.top, bottom: pv.bottom };
    }

    // ---- Ladder lines (clipped to the ladder band during slides) ----
    g.save();
    g.beginPath();
    const clipX = Math.min(ox(geo, -10), ox(geo, sz.lineChord + 10));
    g.rect(clipX, geo.top - 14, sz.lineChord + 20, span + 28);
    g.clip();
    g.lineCap = "round";
    // thin first, chord lines on top
    for (const pass of [false, true]) {
      for (const l of lines) {
        if (l.isChord !== pass) continue;
        const y = uToY(geo, l.u);
        const len = l.isChord ? sz.lineChord : sz.lineThin;
        g.globalAlpha = ladderAlpha * l.alpha;
        g.beginPath();
        g.moveTo(ox(geo, len), y);
        g.lineTo(geo.edge, y);
        strokeHalo(g, l.isChord ? LEAD_COLOR : "rgba(243, 239, 231, 0.6)", l.isChord ? sz.widthChord : sz.widthThin);
      }
    }
    g.restore();
    g.globalAlpha = 1;
    // Approaching a neighbour (hand past the sweet band): its line lights up in the mode color with closeness.
    view.nearEdge = null;
    if (pv && pv.toward && pv.lean > 0) {
      const len = pv.toward.isChord ? sz.lineChord : sz.lineThin;
      g.save();
      g.lineCap = "round";
      g.globalAlpha = 0.25 + 0.75 * pv.lean;
      g.beginPath();
      g.moveTo(ox(geo, len), pv.towardY);
      g.lineTo(geo.edge, pv.towardY);
      const w = (pv.toward.isChord ? sz.widthChord : sz.widthThin) + 1.5 * pv.lean;
      g.lineWidth = w + 7; // soft glow (visible on chord lines, which are already in the mode color)
      g.strokeStyle = withAlpha(LEAD_COLOR, 0.3);
      g.stroke();
      g.lineWidth = w;
      g.strokeStyle = LEAD_COLOR;
      g.stroke();
      g.restore();
      view.nearEdge = { midi: pv.toward.midi, amount: pv.lean, lean: 0 };
    }

    // ---- Octave arrows + marks ----
    const hoverUp = S.hover === "up" && S.present && !menuHeld;
    const hoverDown = S.hover === "down" && S.present && !menuHeld;
    const octFlash = Math.max(0, 1 - (now - S.octaveChangedAt) / LOOK.flashMs);
    const upFlash = S.octaveDir > 0 ? octFlash : 0;
    const downFlash = S.octaveDir < 0 ? octFlash : 0;
    const upGrey = S.octave >= OCTAVE_MAX;
    const downGrey = S.octave <= OCTAVE_MIN;
    g.save();
    g.globalAlpha = menuHeld ? LOOK.dimDuringHold : 1;
    drawArrow(g, geo.cx, geo.upY, "up", sz.arrowSize, {
      lit: hoverUp && !upGrey,
      grey: upGrey,
      progress: !menuHeld && S.pinchMode === "arrow" && S.arrowDir > 0 ? S.arrowProgress : 0,
      flash: upFlash,
    });
    drawArrow(g, geo.cx, geo.downY, "down", sz.arrowSize, {
      lit: hoverDown && !downGrey,
      grey: downGrey,
      progress: !menuHeld && S.pinchMode === "arrow" && S.arrowDir < 0 ? S.arrowProgress : 0,
      flash: downFlash,
    });
    // Octave marks: 4 dots in a column on the inner side of the up arrow (lowest octave at the bottom), one lit.
    const n = OCTAVE_MAX - OCTAVE_MIN + 1;
    const step = geo.narrow ? 9 : 11;
    const mx = geo.cx + dir * (sz.arrowSize * 1.35 + 10);
    // Centred a little above the up arrow so the box stays clear of the top line's note label.
    const yTop = geo.upY - MARKS_RAISE - ((n - 1) * step) / 2;
    roundRect(g, mx - 8, yTop - 8, 16, (n - 1) * step + 16, 8);
    g.fillStyle = "rgba(20,20,20,0.55)";
    g.fill();
    for (let i = OCTAVE_MIN; i <= OCTAVE_MAX; i++) {
      const y = yTop + (OCTAVE_MAX - i) * step;
      const on = i === S.octave;
      g.beginPath();
      g.arc(mx, y, on ? 4.5 : 2.5, 0, Math.PI * 2);
      g.fillStyle = on ? (octFlash > 0 ? "#fff" : LEAD_COLOR) : "rgba(243, 239, 231, 0.5)";
      g.fill();
    }
    g.restore();
    {
      // The ladder's persistent footprint (lines, arrows incl. their lit size + ring, octave marks, label column).
      const ar = arrowReach(sz);
      const L = labelLook(sz);
      const xs = [geo.edge, geo.inner, geo.cx - ar, geo.cx + ar, mx - 8, mx + 8, ox(geo, sz.lineChord + L.gap + L.maxW)];
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(geo.upY - ar, yTop - 8);
      reg("lead-ladder", "edge", { x: x0, y: y0, w: x1 - x0, h: geo.downY + ar - y0 });
    }
    // ---- Setting confirmed (octave): toast beside the arrow; it replaces the hover label while it shows ----
    const octToast = !menuHeld ? drawOctaveToast(g, geo, now) : null;
    if (octToast) reg("lead-octave-toast", "hand", octToast.rect);
    // Arrow label: the value in change (only while the cursor is on an arrow).
    if ((hoverUp || hoverDown) && !octToast) {
      const up = hoverUp;
      const grey = up ? upGrey : downGrey;
      const label = grey ? (up ? "Top octave" : "Bottom octave") : up ? "Octave up" : "Octave down";
      reg("lead-arrow-label", "hand", plateLabel(g, label, geo.cx + dir * (sz.arrowSize * 1.35 + 30), up ? geo.upY : geo.downY, {
        size: geo.narrow ? 12 : 14, weight: 700, align: alignIn, color: grey ? "rgba(200,200,200,0.9)" : C.ink,
        stroke: grey ? null : withAlpha(LEAD_COLOR, 0.8),
      }));
    }

    // ---- Cursor + note name ----
    const lost = !S.present;
    // Hand-lost ring + plate: full for MOTION.lostHold, then fade over lostFade, then gone (the ladder stays dim).
    const lostA = lost ? lostAlpha(now - (S.lostSince ?? -Infinity)) : 1;
    view.lostAlpha = lost ? lostA : null;
    const idx = S.pinchMode === "note" ? S.playIdx : S.preview;
    let cursorMidi = idx != null ? S.ladder.notes[idx]?.midi : null;
    if (cursorMidi == null && lost) cursorMidi = view.lastPreviewMidi;
    let cl = cursorMidi != null ? lines.find((l) => l.midi === cursorMidi && !l.old) : null;
    if (!cl && cursorMidi != null) {
      // The ladder is being rebuilt (chord/set change): never let the cursor blink out.
      const nn = S.ladder.notes.find((x) => x.midi === cursorMidi);
      cl = { midi: cursorMidi, u: nn ? nn.u : (cursorMidi - S.ladder.low) / 24 };
    }
    const onArrow = !lost && !menuHeld && S.hover && S.pinchMode !== "note";
    const playing = S.pinchMode === "note" && !lost && !menuHeld;

    // ---- Note labels on every line; the current note = the larger plate in the mode color (same column) ----
    const tight = labelsTight(geo);
    const labeled = (l) => !tight || l.isChord;
    const showName = cl && !onArrow && !lost && !menuHeld;
    const curName = showName ? S.ladder.notes[idx]?.name ?? noteName(cl.midi, S.keyName) : "";
    const plate = showName ? currentPlateLayout(g, geo, lines, { midi: cl.midi, y: uToY(geo, cl.u), name: curName }, labeled) : null;
    // Octave marks (top) must stay clear of the top line's label.
    const marksRect = { x: mx - 8, y: yTop - 8, w: 16, h: (n - 1) * step + 16 };
    view.labels = drawLadderLabels(g, geo, lines, ladderAlpha, {
      skipMidi: plate ? cl.midi : null,
      avoid: plate ? [plate.rect, marksRect] : [marksRect],
      labeled,
      emphasis: view.nearEdge,
    });
    if (view.labels.length) {
      const xs = view.labels.flatMap((l) => [l.rect.x, l.rect.x + l.rect.w]);
      const x0 = Math.min(...xs);
      reg("lead-ladder-labels", "edge", { x: x0, y: Math.min(...view.labels.map((l) => l.rect.y)), w: Math.max(...xs) - x0, h: Math.max(...view.labels.map((l) => l.rect.y + l.rect.h)) - Math.min(...view.labels.map((l) => l.rect.y)) });
    }

    view.current = null;
    if (cl || onArrow) {
      let cy = onArrow ? (S.hover === "up" ? geo.upY : geo.downY) : uToY(geo, cl.u);
      const cx = geo.cx;
      const nameX = plate ? plate.x : ox(geo, sz.lineChord + labelLook(sz).gap + 7);
      // Dotted guide from the hand to the cursor (stops at the name plate's inner edge).
      const plateInner = plate ? (dir > 0 ? plate.rect.x + plate.rect.w : plate.rect.x) + dir * 8 : nameX + dir * 80;
      const handInside = view.hand && (view.hand.x - plateInner) * dir > 10;
      if (view.hand && handInside && !lost && !menuHeld && !onArrow) {
        g.save();
        g.beginPath();
        g.moveTo(view.hand.x, view.hand.y);
        g.lineTo(plateInner, cy);
        g.lineWidth = 4;
        g.strokeStyle = "rgba(0,0,0,0.3)";
        g.lineCap = "round";
        g.stroke();
        g.setLineDash([3, 5]);
        g.lineWidth = 1.5;
        g.strokeStyle = C.quiet;
        g.stroke();
        g.restore();
      }
      if (!onArrow) {
        const r = sz.cursorR;
        // Edge feedback: the ring leans toward the neighbour being approached (0 inside the sweet band).
        let cyR = cy;
        if (pv && pv.toward && pv.lean > 0 && !lost) {
          const lean = Math.sign(pv.towardY - cy) * pv.lean * r * LOOK.leanPx;
          cyR = cy + lean;
          if (view.nearEdge) view.nearEdge.lean = lean;
        }
        const cy0 = cy;
        cy = cyR;
        g.save();
        if (menuHeld) g.globalAlpha = LOOK.dimDuringHold;
        if (lost) {
          g.globalAlpha *= lostA;
          g.beginPath();
          g.arc(cx, cy, r, 0, Math.PI * 2);
          g.fillStyle = "rgba(0,0,0,0.35)";
          g.fill();
          strokeHalo(g, C.warn, 2, [3, 3]);
        } else if (playing) {
          // Filled + soft glow: "this note plays now".
          const glow = g.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.6);
          glow.addColorStop(0, withAlpha(LEAD_COLOR, 0.75));
          glow.addColorStop(1, withAlpha(LEAD_COLOR, 0));
          g.beginPath();
          g.arc(cx, cy, r * 2.6, 0, Math.PI * 2);
          g.fillStyle = glow;
          g.fill();
          g.beginPath();
          g.arc(cx, cy, r, 0, Math.PI * 2);
          g.fillStyle = LEAD_COLOR;
          g.fill();
          g.lineWidth = 2;
          g.strokeStyle = "#fff";
          g.stroke();
        } else {
          // Hollow: "a pinch will play this note".
          g.beginPath();
          g.arc(cx, cy, r, 0, Math.PI * 2);
          g.fillStyle = "rgba(0,0,0,0.45)";
          g.fill();
          strokeHalo(g, LEAD_COLOR, 3);
        }
        cy = cy0; // the name plate stays on the note's line
        if (plate) {
          // Preview: mode-colored name on a dark plate with a mode-colored rim; playing: filled in the mode color.
          const color = playing ? "#111" : LEAD_COLOR;
          reg("lead-note-name", "hand", plateLabel(g, curName, nameX, cy, {
            size: plate.size,
            weight: 700,
            align: alignIn,
            color,
            fill: playing ? LEAD_COLOR : C.plate,
            stroke: playing ? null : withAlpha(LEAD_COLOR, 0.85),
            padX: plate.padX,
            padY: plate.padY,
          }));
          view.current = { midi: cl.midi, text: curName, size: plate.size, color, fill: playing ? LEAD_COLOR : C.plate, rect: plate.rect };
        }
        g.restore();
      }
      if (lost && lostA > 0) {
        g.save();
        g.globalAlpha *= lostA;
        reg("lead-lost", "hand", plateLabel(g, "Hand lost", nameX, cy, { size: 13, weight: 700, color: C.warn, align: alignIn, stroke: withAlpha(C.warn, 0.7) }));
        g.restore();
      }
    }

    // ---- Hand marker: the hand's exact (unsnapped) height, a small pointer at the screen edge of the ladder ----
    if (pv && leadConfig.showHandMarker && !lost) {
      const ty = uToY(geo, Math.max(-0.06, Math.min(1.06, S.u)));
      const dt = now - view.markerAt;
      const k = view.marker && dt > 0 && dt < 250 ? 1 - Math.exp(-dt / LOOK.markerTauMs) : 1;
      const y = view.marker ? view.marker.y + (ty - view.marker.y) * k : ty;
      view.marker = { y, targetY: ty };
      view.markerAt = now;
      const tip = ox(geo, 11);
      const base = geo.edge + dir * 1;
      g.save();
      g.beginPath();
      g.moveTo(tip, y);
      g.lineTo(base, y - 5);
      g.lineTo(base, y + 5);
      g.closePath();
      g.lineJoin = "round";
      g.lineWidth = 3;
      g.strokeStyle = C.halo;
      g.stroke();
      g.fillStyle = "rgba(255,255,255,0.95)";
      g.fill();
      g.restore();
    } else {
      view.marker = null;
    }

    // ---- Note-set badge: approach fill, then the confirmed state (pop, ~1 s, fade) ----
    view.setBadge = null;
    if (!lost && !menuHeld) {
      const badge = drawSetBadge(g, geo, now, { holding: holding && !!view.hand, anchorHand: !!view.hand });
      if (badge) {
        reg("lead-set-badge", "hand", badge.rect);
        view.setBadge = badge;
      }
    }
    view.octaveToast = octToast;
    g.restore();
  },

  /**
   * Screen controls: rows for the Controls panel (note set, octave, how to play with mouse/keyboard), plus the
   * mouse strip on the ladder (appended to #stage, not to the panel: it must work while the panel is closed).
   */
  controls(container, ctx) {
    const doc = container.ownerDocument || document;
    const win = doc.defaultView || window;
    const root = doc.createElement("div");
    root.className = "lead-controls";
    root.innerHTML = `
      <div class="lead-row"><span class="lead-label">Notes</span>
        <div class="lead-seg" role="group" aria-label="Note set" data-control="noteset">
          ${[1, 2, 3, 4].map((n) => `<button type="button" data-set="${n}" title="${NOTE_SETS[n].name}: hand ${SET_SHAPES[n].emoji} ${SET_SHAPES[n].label} (key ${n})">${n}</button>`).join("")}
        </div><span class="lead-setname" data-hook="setname"></span>
      </div>
      <div class="lead-row lead-hint" data-control="noteset-legend"><span class="lead-label">Hand</span>
        <span>${[1, 2, 3, 4].map((n) => `<span class="lead-shape" data-shape="${n}" title="${SET_SHAPES[n].label}">${SET_SHAPES[n].emoji} ${n}</span>`).join(" · ")} · hold 0.3 s (open hand = no change)</span>
      </div>
      <div class="lead-row"><span class="lead-label">Octave</span>
        <button type="button" class="lead-btn" data-oct="-1" data-control="octave-down" aria-label="Octave down" title="Octave down (-)">−</button><span class="lead-oct" data-control="octave"></span><button type="button" class="lead-btn" data-oct="1" data-control="octave-up" aria-label="Octave up" title="Octave up (=)">+</button>
      </div>
      <div class="lead-row lead-hint" data-control="lead-play-help"><span class="lead-label">Play</span>
        <span>Mouse on the ladder · keys A–' (Q–] higher) · 1–4 notes · −/= octave</span>
      </div>`;
    const pad = doc.createElement("div");
    pad.className = "lead-pad";
    pad.id = "leadPad";
    pad.title = "Lead: hover to preview, press to play";
    pad.style.cssText = "position:absolute;z-index:3;cursor:crosshair;touch-action:none;";
    container.appendChild(root);
    (doc.getElementById("stage") || container).appendChild(pad);
    view.padEl = pad;
    view.padKey = "";
    placePad(lastGeo);

    const setBtns = [...root.querySelectorAll("[data-set]")];
    const setName = root.querySelector('[data-hook="setname"]');
    const octLbl = root.querySelector(".lead-oct");
    const [octDown, octUp] = root.querySelectorAll("[data-oct]");
    function refresh() {
      for (const b of setBtns) {
        const on = Number(b.dataset.set) === S.setId;
        b.setAttribute("aria-pressed", String(on));
        b.classList.toggle("on", on);
      }
      setName.textContent = NOTE_SETS[S.setId].name;
      octLbl.textContent = S.ladder.notes.length ? noteName(S.ladder.low, S.keyName) : String(S.octave);
      octDown.disabled = S.octave <= OCTAVE_MIN;
      octUp.disabled = S.octave >= OCTAVE_MAX;
    }
    refresh();
    const off = ctx.bus.subscribe({ onSet: refresh }, ["lead/noteset", "lead/octave", "chord"]);

    const now = () => (ctx.now || win.performance.now());
    function setSet(n) {
      if (ctrl.setNoteSet(n, now())) ctx.bus.set("lead/noteset", S.setId);
      refresh();
    }
    function stepOct(d) {
      if (ctrl.stepOctave(d, now())) ctx.bus.set("lead/octave", S.octave);
      refresh();
    }
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.set) setSet(Number(b.dataset.set));
      if (b.dataset.oct) stepOct(Number(b.dataset.oct));
      b.blur();
    });

    // Pointer on the ladder strip = a virtual right hand (hover = preview, press = play).
    const yOf = (e) => {
      const r = (doc.getElementById("overlay") || pad).getBoundingClientRect();
      return (e.clientY - r.top) / Math.max(1, r.height);
    };
    pad.addEventListener("pointerenter", (e) => { virt.inside = true; virt.y = yOf(e); virt.keyIdx = null; touchVirtual(); });
    pad.addEventListener("pointermove", (e) => { virt.y = yOf(e); virt.keyIdx = null; touchVirtual(); });
    pad.addEventListener("pointerleave", () => { virt.inside = false; });
    pad.addEventListener("pointerdown", (e) => {
      virt.y = yOf(e);
      virt.keyIdx = null;
      touchVirtual();
      // A click / tap on an octave arrow steps the octave at once (no 0.3 s hold: that is for the pinch only).
      const u = yToU(lastGeo, virt.y * lastGeo.H);
      const arrowDir = u > 1 + ARROW_ENTER ? 1 : u < -ARROW_ENTER ? -1 : 0;
      if (arrowDir) {
        stepOct(arrowDir);
        e.preventDefault();
        return;
      }
      virt.down = true;
      try { pad.setPointerCapture(e.pointerId); } catch {}
      if (ctx.audio.synth && ctx.audio.synth.ensureContext) ctx.audio.synth.ensureContext();
      e.preventDefault();
    });
    const up = () => { virt.down = false; };
    pad.addEventListener("pointerup", up);
    pad.addEventListener("pointercancel", up);

    // Keyboard: A-row / Q-row = ladder notes from the bottom, arrows = cursor, space = play,
    // 1-4 = note set, -/= = octave.
    function onKeyDown(e) {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.code;
      const ni = STEP_KEYS.indexOf(k);
      if (ni >= 0) {
        if (!e.repeat && ni < S.ladder.notes.length && !virt.keys.includes(ni)) virt.keys.push(ni);
      } else if (k === "Space") {
        if (e.target && e.target.tagName === "BUTTON") return; // space activates a focused button
        if (virt.keyIdx == null) virt.keyIdx = S.preview ?? Math.floor(S.ladder.notes.length / 2);
        virt.space = true;
      } else if (k === "ArrowUp" || k === "ArrowDown") {
        const base = virt.keyIdx ?? S.preview ?? Math.floor(S.ladder.notes.length / 2);
        virt.keyIdx = Math.max(0, Math.min(S.ladder.notes.length - 1, base + (k === "ArrowUp" ? 1 : -1)));
      } else if (/^Digit[1-4]$/.test(k)) {
        setSet(Number(k.slice(5)));
      } else if (k === "Minus" || k === "NumpadSubtract") {
        stepOct(-1);
      } else if (k === "Equal" || k === "NumpadAdd") {
        stepOct(1);
      } else {
        return;
      }
      touchVirtual();
      if (ctx.audio.synth && ctx.audio.synth.ensureContext) ctx.audio.synth.ensureContext();
      e.preventDefault();
    }
    function onKeyUp(e) {
      const ni = STEP_KEYS.indexOf(e.code);
      if (ni >= 0) virt.keys = virt.keys.filter((x) => x !== ni);
      if (e.code === "Space") virt.space = false;
    }
    win.addEventListener("keydown", onKeyDown);
    win.addEventListener("keyup", onKeyUp);

    return () => {
      off();
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("keyup", onKeyUp);
      root.remove();
      pad.remove();
      if (view.padEl === pad) view.padEl = null;
      Object.assign(virt, { inside: false, down: false, keys: [], space: false, keyIdx: null, touched: false, anchor: null });
    };
  },

  menuItems: [],
  /** Plays on top of the base mode (router: Lead layer). */
  layer: true,
  /** The expression edge shows the note ladder (drawn here), not a generic track. */
  rightTrack: null,
  /** Right-hand rows for the gesture guide. */
  guide: [
    ["✊", "Menu"],
    ["↕", "Note"],
    ["🤏", "Play"],
    ["1️⃣2️⃣3️⃣🤘", "Note set"], // 1/2/3 fingers from the index, rock sign = 4 (SET_SHAPES); open hand = nothing
    ["🔼", "Pinch arrow: octave"],
  ],

  /** Test/debug hook: controller state + what draw() renders (canvas px). Not part of the mode contract. */
  _debug(now = view.now) {
    const geo = lastGeo;
    const lines = currentLines(now).filter((l) => !l.old);
    const idx = S.pinchMode === "note" ? S.playIdx : S.preview;
    const note = idx != null ? S.ladder.notes[idx] : null;
    return {
      geo: { ...geo, sz: { ...geo.sz } },
      side: geo.side,
      held: view.held,
      setId: S.setId,
      octave: S.octave,
      keyName: S.keyName,
      chord: S.chord,
      present: S.present,
      hover: S.hover,
      pinchMode: S.pinchMode,
      arrowProgress: S.arrowProgress,
      setHoldTarget: S.setHoldTarget,
      setHoldProgress: S.setHoldProgress,
      preview: S.preview != null ? S.ladder.notes[S.preview].midi : null,
      playing: S.pinchMode === "note" ? S.playMidi : null,
      cursor: note ? { midi: note.midi, name: note.name, y: uToY(geo, lines.find((l) => l.midi === note.midi)?.u ?? note.u) } : null,
      lines: lines.map((l) => ({ midi: l.midi, isChord: l.isChord, y: uToY(geo, l.u), alpha: l.alpha })),
      usingVirtual: view.usingVirtual,
      changeAt: view.changeAt,
      changeKind: view.changeKind,
      sounding: voice ? voice.sounding : null,
      pad: voice ? voice.padFreqs : [],
      regions: view.regions.map((r) => ({ ...r, rect: { ...r.rect } })),
      // What the last draw() showed (camera-feedback tests): labels, current plate, confirm visuals.
      drawnAt: view.drawnAt,
      lostSince: S.lostSince,
      lostAlpha: view.lostAlpha ?? null, // hand-lost ring/plate opacity (null = hand present)
      setChangedAt: S.setChangedAt,
      octaveChangedAt: S.octaveChangedAt,
      labels: view.labels.map((l) => ({ ...l, rect: { ...l.rect } })),
      current: view.current ? { ...view.current, rect: { ...view.current.rect } } : null,
      setBadge: view.setBadge ? { ...view.setBadge, rect: { ...view.setBadge.rect } } : null,
      octaveToast: view.octaveToast ? { ...view.octaveToast, rect: { ...view.octaveToast.rect } } : null,
      // Edge feedback (lead-proximity): controller values + what draw() showed.
      proximity: S.proximity,
      proximityTo: S.proximityTo != null ? S.ladder.notes[S.proximityTo]?.midi ?? null : null,
      lean: S.lean,
      handU: S.u,
      marker: view.marker ? { ...view.marker } : null,
      sweet: view.sweet ? { ...view.sweet } : null,
      nearEdge: view.nearEdge ? { ...view.nearEdge } : null,
    };
  },
  /** Ladder y (canvas px) -> display-normalized y, for tests placing the hand on a note. */
  _yForMidi(midi) {
    const geo = lastGeo;
    const n = S.ladder.notes.find((x) => x.midi === midi);
    return n ? uToY(geo, n.u) / geo.H : null;
  },
  _controller: ctrl,
  /** Live Lead tunables (src/modes/lead-config.js) until the Tweaks panel binds them. */
  _config: leadConfig,
  _setConfig: setLeadConfig,
};

export default lead;
