// UI integration lab: the REAL existing UI (markup + CSS pulled from /index.html at runtime) with the
// proposed modes UI composited on top, over a synthetic camera scene. Static prototype, no tracking.
//
//   /labs/ui-lab.html?state=<name>[&swap][&bg=bright][&clean][&debug]
//     swap   chord hand on the screen RIGHT (see docs/ui-integration.md, open question Q1)
//     bright bright wall behind the player (legibility check)
//     clean  hide the lab's state switcher (used by tests/ui-lab.spec.js)
//     debug  outline the clear area and the regions the layout test checks
//
// The overlay drawing here is a reference implementation of docs/ui-integration.md using only
// src/ui/theme.js primitives. Workstreams should lift the relevant pieces into their own modules.

import {
  MODE_COLORS,
  COLORS,
  STROKE,
  FONT,
  LAYOUT,
  DIR_ANGLE,
  deg,
  easeOut,
  clearArea,
  withAlpha,
  edgeTrackX,
  drawLabel,
  drawPlate,
  drawPill,
  drawGuideLine,
  drawEdgeTrack,
  drawArc,
  drawArcSegment,
  drawRing,
  drawDots,
  drawTriangle,
} from "../src/ui/theme.js";
import { hand } from "../tests/helpers/hands.js";

export const STATES = [
  "chords-play",
  "menu-enter",
  "menu-approach",
  "menu-selected",
  "countdown",
  "arp-play",
  "arp-pinch",
  "arp-firstuse",
  "guide-open",
  "lead-preview",
  "lead-playing",
  "controls-panel-open",
  "hand-lost",
];

const params = new URLSearchParams(location.search);
let stateName = STATES.includes(params.get("state")) ? params.get("state") : "chords-play";
let swap = params.has("swap");
let bright = params.get("bg") === "bright";
if (params.has("clean")) document.body.classList.add("lab-clean");

/** Regions drawn on the canvas this frame: {name, kind, rect}. kind: edge|status|hand|transient. */
let regions = [];
const reg = (name, kind, rect) => (regions.push({ name, kind, rect }), rect);

// -------------------------------------------------------------------------------------------
// Mount the existing UI from index.html (so the lab can never drift from the real app)
// -------------------------------------------------------------------------------------------

async function mountExistingUI() {
  const html = await (await fetch("/index.html")).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const style = document.createElement("style");
  style.dataset.from = "index.html";
  style.textContent = doc.querySelector("style").textContent;
  document.head.insertBefore(style, document.head.querySelector('link[rel="stylesheet"]'));
  const stage = doc.getElementById("stage");
  stage.querySelectorAll("script").forEach((s) => s.remove());
  document.body.prepend(document.importNode(stage, true));
  document.getElementById("startOverlay").style.display = "none";
  document.getElementById("overlay").classList.remove("dimmed");
}

// Same content updateGestureGuide() renders for key A.
const GUIDE = [
  ["A", "1️⃣"],
  ["B", "2️⃣"],
  ["C#", "3️⃣"],
  ["D", "4️⃣"],
  ["E", "5️⃣"],
  ["F#", "🤘"],
  ["G#", "🤟"],
];

// Right-hand guide rows appended per mode (docs/ui-integration.md §5).
const GUIDE_MODE_ROWS = {
  chords: [["✊", "Menu"], ["👍", "Octave down"]],
  arp: [["✊", "Menu"], ["↕", "Gate"], ["👍", "Double time"], ["🤏", "Tempo"]],
  lead: [["✊", "Menu"], ["↕", "Note"], ["🤏", "Play"], ["☝️", "Note set"]],
};
const MODE_NAME = { chords: "Chords", arp: "Arp", lead: "Lead" };

function el(tag, attrs = {}, html = "") {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = html;
  return e;
}

function mountNewDom() {
  document.body.classList.add("gs-modes");
  const stage = document.getElementById("stage");
  const key = document.getElementById("keySelect");
  key.after(
    el("button", { id: "modeBadge", class: "gs-badge", "data-gs-kind": "status", title: "Mode (opens controls)" }),
    el("div", { id: "noteSetBadge", class: "gs-badge", "data-gs-kind": "status", title: "Note set" }),
  );
  document
    .getElementById("guideToggle")
    .after(el("button", { id: "controlsToggle", "data-gs-kind": "status", "aria-pressed": "false" }, "Controls"));
  document
    .getElementById("gestureGuide")
    .after(el("div", { id: "controlsPanel", class: "hidden", "data-gs-kind": "panel" }));
  stage.append(
    el("div", { id: "transport", class: "hidden", "data-gs-kind": "status" }),
    el("div", { id: "outputChip", "data-gs-kind": "status" }),
  );
}

// -------------------------------------------------------------------------------------------
// State descriptions
// -------------------------------------------------------------------------------------------

/** @typedef {{mode:string, chord:[string,string], roman:string, lines:number, meter:number,
 *  filter:number, left:object, right:object|null, ...}} LabState */

const BASE = {
  chords: { mode: "chords", chord: ["D(IV)", "Major 7th"], roman: "IV", lines: 3, meter: 0.75, filter: 0.5 },
  arp: { mode: "arp", chord: ["Bm(ii)", "Minor 7th"], roman: "ii", lines: 3, meter: 0.62, filter: 0.2, bpm: 110, beat: 1, step: 2 },
  lead: { mode: "lead", chord: ["A(I)", "Major"], roman: "I", lines: 1, meter: 0, filter: 0.35 },
};

function stateDef(name) {
  switch (name) {
    case "chords-play":
      return { ...BASE.chords, left: { fingers: 4 }, right: { fingers: 3 } };
    case "menu-enter":
      return { ...BASE.chords, left: { fingers: 4 }, right: { fist: true }, menu: { phase: "enter", d: 0 }, held: true };
    case "menu-approach":
      return { ...BASE.chords, left: { fingers: 4 }, right: { fist: true }, menu: { phase: "approach", d: 0.62, a: deg(-8) }, held: true };
    case "menu-selected":
      return { ...BASE.chords, left: { fingers: 4 }, right: { fist: true }, menu: { phase: "selected", d: 1.12, a: deg(-6) }, held: true };
    case "countdown":
      return { ...BASE.arp, chord: BASE.chords.chord, roman: "IV", left: { fingers: 4 }, right: { fingers: 4, open: true }, countdown: 0.62, held: true, noTransportPulse: true };
    case "arp-play":
      return { ...BASE.arp, left: { fingers: 2, minor: true }, right: { fingers: 3, thumb: true }, x2: true, chip: "direct" };
    case "arp-pinch":
      return { ...BASE.arp, bpm: 116, left: { fingers: 2, minor: true }, right: { pinch: true }, pinch: { ticks: 6 }, held: true };
    case "arp-firstuse":
      return { ...BASE.arp, left: { fingers: 2, minor: true }, right: { fingers: 3 }, firstUse: true };
    case "guide-open":
      return { ...BASE.arp, left: { fingers: 2, minor: true }, right: { fingers: 3 }, firstUse: true, guide: true };
    case "lead-preview":
      return { ...BASE.lead, left: { fingers: 1 }, right: { fingers: 3 }, lead: { playing: false } };
    case "lead-playing":
      return { ...BASE.lead, left: { fingers: 1 }, right: { pinch: true }, lead: { playing: true } };
    case "controls-panel-open":
      return { ...BASE.arp, left: { fingers: 2, minor: true }, right: { fingers: 3 }, panel: true };
    case "hand-lost":
      return { ...BASE.arp, left: { fingers: 2, minor: true }, right: null, lost: true };
  }
}

// -------------------------------------------------------------------------------------------
// Geometry
// -------------------------------------------------------------------------------------------

function geometry(s) {
  const W = innerWidth;
  const H = innerHeight;
  const portrait = H > W;
  const hs = portrait ? W * 0.24 : H * 0.14; // hand span (wrist -> fingertips), px
  const chordSide = swap ? "right" : "left";
  const exprSide = swap ? "left" : "right";
  const fromSide = (f, side) => (side === "left" ? W * f : W * (1 - f));
  const L = { x: fromSide(portrait ? 0.24 : 0.25, chordSide), y: H * (portrait ? 0.6 : 0.57) };
  let R = { x: fromSide(portrait ? 0.25 : 0.25, exprSide), y: H * (portrait ? 0.5 : 0.47) };
  if (s.pinch) R = { ...R, y: R.y - s.pinch.ticks * 6 };
  if (s.mode === "lead") R = { ...R, y: H * 0.43 };
  return { W, H, portrait, hs, chordSide, exprSide, L, R, inward: (side) => (side === "left" ? 1 : -1) };
}

// -------------------------------------------------------------------------------------------
// Synthetic camera scene (stands in for the mirrored video)
// -------------------------------------------------------------------------------------------

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Display-space landmarks for a hand shape centered on palm P. */
function handLandmarks(shape, P, hs, side) {
  const fingers = ["index", "middle", "ring", "pinky"].slice(0, shape.fist ? 0 : shape.pinch ? 4 : shape.fingers ?? 0);
  const h = hand({ handedness: "Left", fingers: shape.pinch ? ["middle", "ring", "pinky"] : fingers, thumb: !!shape.thumb, volume: 0.5 });
  const lm = h.landmarks.map((p) => ({ ...p }));
  if (shape.pinch) {
    // Curl index towards the thumb, thumb tip meets index tip.
    lm[7] = { x: lm[5].x - 0.045, y: lm[5].y - 0.075 };
    lm[8] = { x: lm[5].x - 0.075, y: lm[5].y - 0.055 };
    lm[6] = { x: lm[5].x - 0.01, y: lm[5].y - 0.06 };
    lm[3] = { x: lm[2].x - 0.02, y: lm[2].y - 0.06 };
    lm[4] = { x: lm[8].x - 0.004, y: lm[8].y + 0.012 };
  }
  const pc = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + lm[i].x / 5, y: a.y + lm[i].y / 5 }), { x: 0, y: 0 });
  const S = hs / 0.27;
  const flip = side === "left" ? -1 : 1; // thumb points towards the screen center
  return lm.map((p) => ({ x: P.x + flip * (p.x - pc.x) * S, y: P.y + (p.y - pc.y) * S }));
}

function drawScene(g, G, s, hands) {
  const { W, H, portrait } = G;
  // Room.
  const wall = g.createLinearGradient(0, 0, 0, H);
  if (bright) {
    wall.addColorStop(0, "#e9e6df");
    wall.addColorStop(1, "#c9c3b8");
  } else {
    wall.addColorStop(0, "#3a3631");
    wall.addColorStop(1, "#1f1d1b");
  }
  g.fillStyle = wall;
  g.fillRect(0, 0, W, H);
  // Bright window top-right + lamp glow left (legibility stress for the edges).
  const win = { x: W * (portrait ? 0.62 : 0.7), y: H * 0.04, w: W * (portrait ? 0.5 : 0.34), h: H * 0.46 };
  const wg = g.createLinearGradient(win.x, win.y, win.x + win.w, win.y + win.h);
  wg.addColorStop(0, "#f4f7fa");
  wg.addColorStop(1, "#b9c7d3");
  g.fillStyle = wg;
  g.fillRect(win.x, win.y, win.w, win.h);
  g.fillStyle = bright ? "#a9a196" : "#2a2622";
  g.fillRect(win.x + win.w * 0.48, win.y, 6, win.h);
  g.fillRect(win.x, win.y + win.h * 0.5, win.w, 6);
  const lamp = g.createRadialGradient(W * 0.08, H * 0.3, 0, W * 0.08, H * 0.3, H * 0.45);
  lamp.addColorStop(0, "rgba(255,214,160,0.55)");
  lamp.addColorStop(1, "rgba(255,214,160,0)");
  g.fillStyle = lamp;
  g.fillRect(0, 0, W, H);
  // Shelf with books, left (busy texture under the master track).
  const rnd = mulberry32(7);
  const shelfY = H * 0.72;
  g.fillStyle = bright ? "#8a7b68" : "#4a3e32";
  g.fillRect(0, shelfY, W * 0.2, 8);
  for (let x = 4; x < W * 0.19; x += 9 + rnd() * 6) {
    const bh = 30 + rnd() * 40;
    g.fillStyle = `hsl(${rnd() * 360}, 35%, ${bright ? 55 : 32}%)`;
    g.fillRect(x, shelfY - bh, 7 + rnd() * 5, bh);
  }

  // Player.
  const cx = W / 2;
  const headR = portrait ? W * 0.13 : H * 0.1;
  const headY = portrait ? H * 0.3 : H * 0.3;
  const shoulderY = headY + headR * 1.9;
  const shoulderHalf = headR * 2.1;
  const shirt = bright ? "#3b4d63" : "#2c3a4c";
  // Arms (behind torso edge).
  const sleeve = (from, to) => {
    g.lineCap = "round";
    g.strokeStyle = shirt;
    g.lineWidth = headR * 0.85;
    const elbow = { x: (from.x + to.x) / 2 + (to.x < cx ? -1 : 1) * headR * 0.6, y: Math.max(from.y, to.y) + headR * 1.3 };
    g.beginPath();
    g.moveTo(from.x, from.y);
    g.quadraticCurveTo(elbow.x, elbow.y, to.x, to.y + headR * 0.3);
    g.stroke();
  };
  for (const hnd of hands) {
    const sh = { x: hnd.wrist.x < cx ? cx - shoulderHalf * 0.8 : cx + shoulderHalf * 0.8, y: shoulderY + headR * 0.3 };
    sleeve(sh, hnd.wrist);
  }
  // Torso.
  g.fillStyle = shirt;
  g.beginPath();
  g.moveTo(cx - shoulderHalf, shoulderY + headR * 0.5);
  g.quadraticCurveTo(cx - shoulderHalf, shoulderY, cx - shoulderHalf * 0.6, shoulderY - headR * 0.05);
  g.lineTo(cx + shoulderHalf * 0.6, shoulderY - headR * 0.05);
  g.quadraticCurveTo(cx + shoulderHalf, shoulderY, cx + shoulderHalf, shoulderY + headR * 0.5);
  g.lineTo(cx + shoulderHalf * 1.05, H);
  g.lineTo(cx - shoulderHalf * 1.05, H);
  g.closePath();
  g.fill();
  // Neck + head + hair.
  const skin = "#c8977a";
  g.fillStyle = "#b5876c";
  g.fillRect(cx - headR * 0.35, headY + headR * 0.6, headR * 0.7, headR * 1.0);
  g.fillStyle = skin;
  g.beginPath();
  g.ellipse(cx, headY, headR * 0.82, headR, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#2a1f1a";
  g.beginPath();
  g.ellipse(cx, headY - headR * 0.45, headR * 0.88, headR * 0.62, 0, Math.PI, Math.PI * 2);
  g.fill();

  // Hands: skin silhouette, then the app's existing landmark dots (#ffffff80, r=4).
  for (const hnd of hands) {
    const lm = hnd.lm;
    if (!lm.length) continue;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = skin;
    g.fillStyle = skin;
    g.beginPath();
    [0, 1, 5, 9, 13, 17].forEach((i, k) => (k ? g.lineTo(lm[i].x, lm[i].y) : g.moveTo(lm[i].x, lm[i].y)));
    g.closePath();
    g.lineWidth = G.hs * 0.12;
    g.fill();
    g.stroke();
    for (const chain of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
      g.beginPath();
      g.moveTo(lm[chain[0]].x, lm[chain[0]].y);
      for (const i of chain.slice(1)) g.lineTo(lm[i].x, lm[i].y);
      g.lineWidth = G.hs * 0.1;
      g.stroke();
    }
  }
  g.fillStyle = "#ffffff80";
  for (const hnd of hands)
    for (const p of hnd.lm) {
      g.beginPath();
      g.arc(p.x, p.y, 4, 0, Math.PI * 2);
      g.fill();
    }
}

// Static copy of main.js drawEnergy() (existing wave behind the chord display), seeded jitter.
const SCALE_COLORS = { I: "232, 161, 61", II: "210, 50, 120", III: "180, 40, 150", IV: "240, 210, 40", V: "245, 120, 30", VI: "230, 40, 40", VII: "100, 200, 250" };
function drawEnergyStatic(g, W, H, volume01, lineCount, tilt, roman) {
  const rnd = mulberry32(3);
  const centerY = H - 56;
  const maxThickness = 1 + volume01 * 8;
  const chaos = (tilt + 1) / 2;
  const amp = chaos * 25;
  const freq = 0.05 + chaos * 0.15;
  const isMajor = roman === roman.toUpperCase();
  const [r, gg, b] = SCALE_COLORS[roman.toUpperCase()].split(",").map(Number);
  const alpha = isMajor ? 1 : 0.7;
  const time = 1.7;
  g.save();
  g.shadowBlur = 10 + volume01 * 20;
  g.shadowColor = `rgba(${r},${gg},${b},${0.5 * alpha})`;
  for (let l = 0; l < lineCount; l++) {
    g.beginPath();
    const y0 = centerY + (l - (lineCount - 1) / 2) * 12;
    for (let x = 0; x <= W; x += 10) {
      const y = y0 + Math.sin(x * 0.005 + time + l * 0.5) * 20 + (rnd() - 0.5) * amp * Math.sin(x * freq + time);
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = `rgba(${r},${gg},${b},${alpha})`;
    g.lineWidth = Math.max(1, maxThickness - l * 0.5);
    g.lineCap = "round";
    g.stroke();
  }
  g.restore();
}

// -------------------------------------------------------------------------------------------
// New overlays (reference implementation of docs/ui-integration.md)
// -------------------------------------------------------------------------------------------

const trackTop = () => LAYOUT.trackTop;
const trackBottom = (G) => G.H - LAYOUT.trackBottom;

/** Point on the hand's outer side where edge guides end. */
const handEdgePoint = (G, P, side) => ({ x: P.x - G.inward(side) * G.hs * 0.42, y: P.y });

function drawMasterTrack(g, G) {
  const x = edgeTrackX(G.chordSide, G.W);
  reg("master-track", "edge", drawEdgeTrack(g, {
    x, top: trackTop(), bottom: trackBottom(G), markerY: G.L.y, color: COLORS.ink, guideTo: handEdgePoint(G, G.L, G.chordSide),
  }));
}

function drawExpressionTrack(g, G, s, color) {
  const x = edgeTrackX(G.exprSide, G.W);
  const base = { x, top: trackTop(), bottom: trackBottom(G), color };
  const restY = G.H * (G.portrait ? 0.5 : 0.47); // where the hand was when values locked
  if (s.lost) {
    reg("expr-track", "edge", drawEdgeTrack(g, { ...base, markerY: restY, heldY: null, fillY: restY, lost: true }));
    const r = drawLabel(g, "Hand lost", x + G.inward(G.exprSide) * (LAYOUT.gutter - 2), restY, {
      size: 10, color: COLORS.warn, align: G.exprSide === "right" ? "right" : "left", plate: true, weight: 700, padX: 4,
    });
    reg("hand-lost-label", "edge", r);
    return;
  }
  if (s.menu || s.countdown != null) {
    // Held: dim track, hollow marker at the locked value, no live marker.
    reg("expr-track", "edge", drawEdgeTrack(g, { ...base, heldY: restY, dim: true }));
    return;
  }
  if (s.pinch) {
    const startY = restY;
    reg("expr-track", "edge", drawEdgeTrack(g, { ...base, heldY: startY, dim: true }));
    return;
  }
  reg("expr-track", "edge", drawEdgeTrack(g, { ...base, markerY: G.R.y, guideTo: handEdgePoint(G, G.R, G.exprSide) }));
}

function drawFilterArc(g, G, s, color, { held = false } = {}) {
  const r = G.hs * 0.95;
  const P = G.R;
  const rect = drawArc(g, {
    cx: P.x, cy: P.y, r, a0: deg(-150), a1: deg(-30), color: COLORS.quiet, lineWidth: STROKE.thin,
    alpha: held ? 0.45 : 1, dotAt: (s.filter + 1) / 2, dotColor: color, dotHollow: held,
  });
  reg("filter-arc", "hand", { x: P.x - r, y: P.y - r, w: 2 * r, h: r * 0.6 });
  return rect;
}

// Mode icons (each mode plugin owns its icon; these are placeholders drawn with primitives).
function drawModeIcon(g, id, x, y, color, alpha = 1) {
  g.save();
  g.globalAlpha *= alpha;
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 1.6;
  g.lineCap = "round";
  if (id === "chords") {
    for (let i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(x - 5, y + i * 4);
      g.lineTo(x + 5, y + i * 4);
      g.stroke();
    }
  } else if (id === "arp") {
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(x - 5 + i * 5, y + 4 - i * 4, 1.8, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    g.beginPath();
    g.ellipse(x - 2, y + 4, 3, 2.3, -0.4, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(x + 1, y + 3.5);
    g.lineTo(x + 1, y - 6);
    g.lineTo(x + 5, y - 3.5);
    g.stroke();
  }
  g.restore();
}

const MENU_ITEMS = [
  { id: "chords", label: "Chords", dir: "up" },
  { id: "arp", label: "Arp", dir: "right" },
  { id: "lead", label: "Lead", dir: "left" },
];

function menuGeometry(G, entry) {
  const r1 = G.hs * 0.95;
  const r0 = r1 * 0.5;
  // Draw the ring where it fits (spec: fist near the frame edge). Movement stays relative to entry.
  const labelW = 64;
  const mx = LAYOUT.gutter + r1 + labelW;
  const cx = Math.min(G.W - mx, Math.max(mx, entry.x));
  const cy = Math.min(G.H - r1 - 40, Math.max(150 + r1, entry.y));
  return { cx, cy, r0, r1, select: r1 * 0.92 };
}

function drawMenu(g, G, s) {
  const { phase } = s.menu;
  const M = menuGeometry(G, G.R);
  const grow = phase === "enter" ? easeOut(0.72) : 1;
  const r0 = M.r0 * grow;
  const r1 = M.r1 * grow;
  const d = s.menu.d * M.r1;
  const a = s.menu.a ?? 0;
  const fist = { x: M.cx + Math.cos(a) * d, y: M.cy + Math.sin(a) * d };
  const hoverId = phase === "enter" ? null : "arp";
  const selected = phase === "selected";
  const current = s.mode;

  for (const it of MENU_ITEMS) {
    const ang = DIR_ANGLE[it.dir];
    const a0 = ang - deg(41);
    const a1 = ang + deg(41);
    const color = MODE_COLORS[it.id];
    const isHover = it.id === hoverId;
    const dimmed = selected && !isHover;
    if (isHover && selected) {
      drawArcSegment(g, { cx: M.cx, cy: M.cy, r0, r1, a0, a1, stroke: color, lineWidth: STROKE.mid, fill: color, fillAlpha: 0.45 });
      drawArc(g, { cx: M.cx, cy: M.cy, r: r1 + 5, a0: a0 + deg(2), a1: a1 - deg(2), color, lineWidth: STROKE.rim });
    } else if (isHover) {
      drawArcSegment(g, { cx: M.cx, cy: M.cy, r0, r1, a0, a1, stroke: color, lineWidth: STROKE.thin, fill: color, fillAlpha: 0.4, fillTo: Math.max(r0, Math.min(r1, d)) });
    } else {
      drawArcSegment(g, { cx: M.cx, cy: M.cy, r0, r1, a0, a1, stroke: COLORS.quiet, lineWidth: STROKE.thin, alpha: dimmed ? 0.35 : 1 });
    }
    // Current-mode marker: small dot just outside its arc.
    if (it.id === current) {
      const px = M.cx + Math.cos(ang) * (r1 + 6);
      const py = M.cy + Math.sin(ang) * (r1 + 6);
      g.save();
      g.globalAlpha = dimmed ? 0.4 : 1;
      g.beginPath();
      g.arc(px, py, 3, 0, Math.PI * 2);
      g.fillStyle = COLORS.ink;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = COLORS.halo;
      g.stroke();
      g.restore();
    }
    // Label outside the ring in the direction of movement; icon leads the name.
    const labelAlpha = phase === "enter" ? 0.6 : dimmed ? 0.4 : 1;
    const bold = isHover;
    const lc = isHover ? color : COLORS.ink;
    const off = r1 + 20;
    let lx = M.cx + Math.cos(ang) * off;
    let ly = M.cy + Math.sin(ang) * off;
    const size = bold ? 15 : 13;
    g.save();
    g.font = `${bold ? 700 : 400} ${size}px ${FONT.family}`;
    const tw = g.measureText(it.label).width;
    g.restore();
    const iconGap = 16;
    let tx;
    if (it.dir === "up") {
      ly -= 2;
      tx = lx - (tw + iconGap) / 2 + iconGap;
    } else {
      // Side labels sit above the arc's outer end, out of the fist's horizontal path.
      ly = M.cy - r1 * 0.72 - 10;
      lx = M.cx + Math.cos(ang) * (r1 * 0.72 + 8);
      tx = it.dir === "right" ? lx + iconGap : lx - tw;
    }
    const ix = tx - 11;
    drawModeIcon(g, it.id, ix, ly, lc, labelAlpha);
    drawLabel(g, it.label, tx, ly, { size, weight: bold ? 700 : 400, color: lc, alpha: labelAlpha });
  }
  // Tracked point: entry mark, dashed line to the fist, solid fist dot.
  if (d > 4) drawGuideLine(g, M.cx, M.cy, fist.x, fist.y, { color: COLORS.ink, dash: [4, 4], alpha: 0.85 });
  drawRing(g, { cx: M.cx, cy: M.cy, r: 2.5, color: COLORS.quiet, lineWidth: 1.5 });
  g.save();
  g.beginPath();
  g.arc(fist.x, fist.y, 6, 0, Math.PI * 2);
  g.fillStyle = COLORS.ink;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = COLORS.halo;
  g.stroke();
  g.restore();
  if (selected) drawLabel(g, "Open hand", M.cx, M.cy + r1 + 18, { size: 12, color: COLORS.ink, align: "center", plate: true });
  reg("menu", "hand", { x: M.cx - r1 - 90, y: M.cy - r1 - 34, w: 2 * r1 + 180, h: 2 * r1 + 60 });
  return fist;
}

function drawCountdown(g, G, s) {
  const color = MODE_COLORS[s.mode];
  const p = s.countdown;
  const r = G.hs * (0.95 - 0.3 * easeOut(p));
  drawRing(g, { cx: G.R.x, cy: G.R.y - G.hs * 0.05, r, color, lineWidth: STROKE.rim, progress: p, track: true });
  drawLabel(g, MODE_NAME[s.mode], G.R.x, G.R.y + r + 16, { size: 15, weight: 700, color, align: "center" });
  reg("countdown", "hand", { x: G.R.x - r, y: G.R.y - r, w: 2 * r, h: 2 * r + 24 });
}

function drawX2(g, G, filled) {
  const r = drawPill(g, "x2", G.R.x, G.R.y + G.hs * 0.9, { color: MODE_COLORS.arp, filled, size: 12 });
  reg("x2", "hand", r);
}

function drawTempoScale(g, G, s) {
  const color = MODE_COLORS.arp;
  const tickStep = 6; // 1 tick = 1 BPM
  const span = 10; // ticks shown each side of the start tick
  // Scale + big number go on the outer side (towards the right-hand edge) when there is room,
  // else on the inner side. Order from the hand outwards: scale, then number.
  let out = -G.inward(G.exprSide);
  const roomOut = out > 0 ? G.W - LAYOUT.gutter - G.R.x : G.R.x - LAYOUT.gutter;
  if (roomOut < G.hs * 0.55 + 150) out = -out;
  const startY = G.R.y + s.pinch.ticks * tickStep;
  const sx = G.R.x + out * G.hs * 0.55;
  const top = startY - span * tickStep;
  drawPlate(g, Math.min(sx, sx + out * 16) - 4, top - 6, 24, span * 2 * tickStep + 12, { radius: 6, fill: "rgba(20,20,20,0.45)" });
  g.save();
  g.lineCap = "round";
  for (let i = -span; i <= span; i++) {
    const y = startY - i * tickStep;
    const isStart = i === 0;
    const isCur = i === s.pinch.ticks;
    const len = isStart || isCur ? 14 : i % 5 === 0 ? 9 : 5;
    g.beginPath();
    g.moveTo(sx, y);
    g.lineTo(sx + out * len, y);
    g.lineWidth = isCur ? 2.5 : isStart ? 1.5 : 1;
    g.strokeStyle = isCur ? color : isStart ? COLORS.ink : withAlpha(COLORS.ink, 0.55 - Math.abs(i) * 0.03);
    g.stroke();
  }
  g.restore();
  reg("tempo-scale", "hand", { x: Math.min(sx, sx + out * 16) - 4, y: top - 6, w: 24, h: span * 2 * tickStep + 12 });

  // Big BPM number (the one large number on screen) with the delta, beyond the scale.
  const align = out > 0 ? "left" : "right";
  const bx = sx + out * 30;
  const by = G.R.y - 4;
  const r1 = drawLabel(g, String(s.bpm), bx, by, { size: FONT.big, weight: 700, color: COLORS.ink, align, plate: true, radius: 8, padX: 8 });
  const sub = `BPM  +${s.pinch.ticks}`;
  drawLabel(g, sub, align === "left" ? r1.x + 8 : r1.x + r1.w - 8, r1.y + r1.h + 11, { size: 12, color: COLORS.ink, align });
  reg("bpm-big", "hand", r1);
}

// Lead: note ladder on the expression edge.
const SCALE_A = ["A", "B", "C#", "D", "E", "F#", "G#"];
function drawLeadLadder(g, G, s) {
  const color = MODE_COLORS.lead;
  const side = G.exprSide;
  const ex = (d) => (side === "right" ? G.W - d : d); // distance from the edge -> x
  const top = 176;
  const bottom = G.H - 100; // down arrow clears the help button when the ladder is on the left (swap)
  const n = 15; // full scale, 2 octaves: A3..A5
  const notes = Array.from({ length: n }, (_, i) => ({ name: SCALE_A[i % 7] + (3 + Math.floor((i + 0) / 7) + (i % 7 >= 2 ? 1 : 0) - (i >= 7 && i % 7 < 2 ? 0 : 0)), chord: [0, 2, 4].includes(i % 7) }));
  // Octave numbering: C# starts the next octave in A major (A3 B3 C#4 ...).
  notes.forEach((nt, i) => (nt.name = SCALE_A[i % 7] + (3 + Math.floor((i + 5) / 7))));
  const yOf = (i) => bottom - (i * (bottom - top)) / (n - 1);
  let cur = 0;
  for (let i = 0; i < n; i++) if (Math.abs(yOf(i) - G.R.y) < Math.abs(yOf(cur) - G.R.y)) cur = i;
  const edge = 8;
  for (let i = 0; i < n; i++) {
    const y = yOf(i);
    const nt = notes[i];
    const len = nt.chord ? 54 : 40;
    g.save();
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(ex(edge), y);
    g.lineTo(ex(edge + len), y);
    g.lineWidth = nt.chord ? 2.5 + 2 * STROKE.halo : 1 + 2 * STROKE.halo;
    g.strokeStyle = COLORS.halo;
    g.stroke();
    g.lineWidth = nt.chord ? 2.5 : 1;
    g.strokeStyle = nt.chord ? color : withAlpha(COLORS.ink, 0.55);
    g.stroke();
    g.restore();
  }
  const ax = ex(edge + 27);
  drawTriangle(g, { cx: ax, cy: top - 24, size: 13, dir: "up", color: COLORS.ink });
  drawTriangle(g, { cx: ax, cy: bottom + 24, size: 13, dir: "down", color: COLORS.ink });
  // Octave marks: 4, current lit, inner side of the up arrow.
  drawDots(g, { x: ex(edge + 27 + 22), y: top - 24 - 12, count: 4, active: 2, r: 2.5, gap: 3, vertical: true, color, align: "left" });
  reg("lead-ladder", "edge", { x: Math.min(ex(edge), ex(edge + 60)), y: top - 34, w: 60, h: bottom - top + 68 });

  // Cursor on the nearest line: hollow = preview, filled + glow = playing.
  const cy = yOf(cur);
  const cx = ex(edge + 27);
  drawRing(g, { cx, cy, r: 9, color, lineWidth: STROKE.mid, fill: s.lead.playing ? color : null, glow: s.lead.playing });
  // The only note name on screen: next to the cursor, inner side. Dotted guide from the hand to it.
  const nameX = ex(edge + 27 + 18);
  const nr = drawLabel(g, notes[cur].name, nameX, cy, {
    size: 28, weight: 700, color: s.lead.playing ? color : COLORS.ink, align: side === "right" ? "right" : "left", plate: true, radius: 8,
  });
  const dir = side === "right" ? 1 : -1;
  const handX = G.R.x + dir * G.hs * 0.42;
  const nameEdge = side === "right" ? nr.x - 4 : nr.x + nr.w + 4;
  if ((nameEdge - handX) * dir > 8) drawGuideLine(g, handX, G.R.y, nameEdge, cy, { color: COLORS.quiet });
  reg("lead-cursor", "hand", nr);
}

function drawFirstUse(g, G, s) {
  const o = { size: 12, plate: true, color: COLORS.ink };
  const inw = G.inward(G.exprSide);
  const tx = edgeTrackX(G.exprSide, G.W) + inw * (LAYOUT.gutter - 2);
  reg("fu-gate", "transient", drawLabel(g, "Gate", tx, G.R.y - 18, { ...o, align: inw > 0 ? "left" : "right" }));
  reg("fu-filter", "transient", drawLabel(g, "Filter", G.R.x, G.R.y - G.hs * 0.95 - 16, { ...o, align: "center" }));
  reg("fu-thumb", "transient", drawLabel(g, "Thumb: x2", G.R.x + inw * G.hs * 0.62, G.R.y + G.hs * 0.18, { ...o, align: inw > 0 ? "left" : "right" }));
  reg("fu-pinch", "transient", drawLabel(g, "Pinch: tempo", G.R.x, G.R.y + G.hs * 0.74, { ...o, align: "center" }));
}

// -------------------------------------------------------------------------------------------
// DOM side of a state
// -------------------------------------------------------------------------------------------

function applyDom(s) {
  const body = document.body;
  body.dataset.mode = s.mode;
  body.classList.toggle("gs-right-held", !!(s.held || s.lost));
  document.getElementById("chordDisplay").textContent = s.chord[0];
  document.getElementById("qualityDisplay").textContent = s.chord[1];
  const lit = Math.round(s.meter * 8);
  // Same rule as main.js updateVolumeMeter(): bars fill from the bottom.
  document.querySelectorAll(".vol-bar").forEach((b) => b.classList.toggle("lit", Number(b.dataset.index) >= 8 - lit));
  const pct = Math.round(s.filter * 100);
  document.getElementById("distortionDisplay").textContent = `Filter: ${pct > 0 ? "+" : ""}${pct}%`;

  const badge = document.getElementById("modeBadge");
  badge.innerHTML = `<span class="gs-dot"></span>${MODE_NAME[s.mode]}`;
  const ns = document.getElementById("noteSetBadge");
  ns.style.display = s.mode === "lead" ? "" : "none";
  if (s.mode === "lead") {
    ns.innerHTML = [0, 1, 2, 3].map((i) => `<i class="${i === 2 ? "on" : ""}"></i>`).join("");
    ns.title = "Note set: Full scale";
    ns.style.left = `${badge.getBoundingClientRect().right + 8}px`;
  }

  // Gesture guide (existing rows + appended mode rows).
  const guide = document.getElementById("gestureGuide");
  guide.innerHTML =
    GUIDE.map(([n, e]) => `<div class="gesture-guide-row"><span class="gesture-guide-note">${n}</span><span class="gesture-guide-gesture">${e}</span></div>`).join("") +
    `<div class="gs-guide-sep"></div><div class="gs-guide-head">${MODE_NAME[s.mode]}</div>` +
    GUIDE_MODE_ROWS[s.mode].map(([e, l]) => `<div class="gesture-guide-row gs-guide-mode"><span class="gesture-guide-gesture">${e}</span><span class="gs-guide-label">${l}</span></div>`).join("");
  guide.classList.toggle("hidden", !s.guide);
  document.getElementById("guideToggle").textContent = s.guide ? "Close Guide" : "Open Guide";

  // Controls panel.
  const panel = document.getElementById("controlsPanel");
  panel.classList.toggle("hidden", !s.panel);
  document.getElementById("controlsToggle").setAttribute("aria-pressed", String(!!s.panel));
  document.getElementById("controlsToggle").textContent = "Controls";
  const seg = (opts, on) => `<div class="gs-seg">${opts.map((o) => `<button class="${o === on ? "on" : ""}">${o}</button>`).join("")}</div>`;
  const hand = `<span class="gs-hand" title="Set by your hand">✋</span>`;
  panel.innerHTML = `
    <span class="gs-k">Mode</span><span class="gs-v">${seg(["Chords", "Arp", "Lead"], MODE_NAME[s.mode])}</span>
    <div class="gs-sep"></div>
    <span class="gs-k">Tempo</span><span class="gs-v"><button class="gs-btn">−</button><span class="gs-num">${s.bpm ?? 110}</span><button class="gs-btn">+</button><button class="gs-btn">Tap</button>${hand}</span>
    <span class="gs-k">Rate</span><span class="gs-v">${seg(["1/4", "1/8", "1/16"], "1/8")}</span>
    <span class="gs-k">Pattern</span><span class="gs-v">${seg(["Up", "Down", "Up-down", "Random"], "Up")}</span>
    <span class="gs-k">Gate</span><span class="gs-v"><input class="gs-range" type="range" value="62">${hand}</span>
    <span class="gs-k">Double time</span><span class="gs-v"><span class="gs-switch ${s.x2 ? "on" : ""}"></span>${hand}</span>
    <div class="gs-sep"></div>
    <span class="gs-k">Master vol</span><span class="gs-v"><input class="gs-range master" type="range" value="55">${hand}</span>`;

  // Transport (clocked modes only).
  const tr = document.getElementById("transport");
  tr.classList.toggle("hidden", s.mode !== "arp");
  if (s.mode === "arp") {
    tr.innerHTML =
      `<span class="gs-bpm"><b>${s.bpm}</b><span>BPM</span></span>` +
      `<span class="gs-beats">${[0, 1, 2, 3].map((i) => `<i class="${i === s.beat ? "on" : ""}"></i>`).join("")}</span>` +
      `<span class="gs-div"></span>` +
      `<span class="gs-steps">${Array.from({ length: 8 }, (_, i) => `<i class="${i === s.step ? "on" : ""}"></i>`).join("")}</span>`;
  }

  // Output chip (milestone 3; visible once output is turned on).
  const chip = document.getElementById("outputChip");
  chip.style.display = s.chip ? "" : "none";
  chip.className = s.chip || "";
  chip.innerHTML = `<span class="gs-dot"></span><span class="gs-text">${s.chip === "direct" ? "Direct, 24 ms" : "Output off"}</span>`;
}

// -------------------------------------------------------------------------------------------
// Render
// -------------------------------------------------------------------------------------------

function render() {
  regions = [];
  const s = stateDef(stateName);
  applyDom(s);
  const G = geometry(s);
  const canvas = document.getElementById("overlay");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = G.W * dpr;
  canvas.height = G.H * dpr;
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Video layer (scene + existing landmark dots).
  const hands = [];
  const L = handLandmarks({ fingers: s.left.fingers }, G.L, G.hs, G.chordSide);
  hands.push({ lm: L, wrist: L[0] });
  let fistPos = null;
  if (s.menu) {
    // The real hand moved from the entry point; the ring may be drawn shifted to fit (see menuGeometry).
    const d = s.menu.d * menuGeometry(G, G.R).r1;
    const a = s.menu.a ?? 0;
    fistPos = { x: G.R.x + Math.cos(a) * d, y: G.R.y + Math.sin(a) * d };
  }
  if (s.right) {
    const P = fistPos || G.R;
    const R = handLandmarks(s.right, P, G.hs, G.exprSide);
    hands.push({ lm: R, wrist: R[0] });
  } else {
    // Right hand out of frame: arm drops below the frame.
    const x = G.exprSide === "right" ? G.W * 0.78 : G.W * 0.22;
    hands.push({ lm: [], wrist: { x, y: G.H + 60 } });
  }
  drawScene(g, G, s, hands);

  // Existing wave (unchanged; lives behind the chord display).
  drawEnergyStatic(g, G.W, G.H, s.mode === "chords" ? s.meter : 0.5, s.lines, s.filter, s.roman);

  // New overlays, back to front (docs/ui-integration.md §4 z-order).
  const color = MODE_COLORS[s.mode];
  drawMasterTrack(g, G);
  if (s.mode === "lead") drawLeadLadder(g, G, s);
  else drawExpressionTrack(g, G, s, color);

  if (s.right && !s.menu && s.countdown == null) {
    drawFilterArc(g, G, s, color, { held: !!s.pinch });
    if (s.mode === "arp" && s.x2) drawX2(g, G, true);
    if (s.pinch && s.mode === "arp") drawTempoScale(g, G, s);
  }
  if (s.menu) drawMenu(g, G, s);
  if (s.countdown != null) drawCountdown(g, G, s);
  if (s.firstUse) drawFirstUse(g, G, s);

  if (params.has("debug")) {
    // Clear area + region boxes (what tests/ui-lab.spec.js checks).
    const c = clearArea(G.W, G.H);
    drawPlate(g, c.x, c.y, c.w, c.h, { fill: null, stroke: "rgba(255,255,255,0.6)", dash: [6, 6], radius: 4 });
    drawLabel(g, "clear area", c.x + 8, c.y + 12, { size: 11, color: COLORS.quiet });
    for (const r of regions) {
      const col = { edge: "#5ad17a", status: "#5ad17a", hand: "#4fb3ff", transient: "#c08cff" }[r.kind];
      drawPlate(g, r.rect.x, r.rect.y, r.rect.w, r.rect.h, { fill: null, stroke: col, lineWidth: 1, radius: 0 });
    }
  }

  window.__uiLab = {
    ready: true,
    state: stateName,
    regions,
    clearArea: clearArea(G.W, G.H),
    chordSide: G.chordSide,
  };
}

// -------------------------------------------------------------------------------------------
// Lab chrome
// -------------------------------------------------------------------------------------------

function buildBar() {
  const bar = document.getElementById("labBar");
  const sync = () => {
    const p = new URLSearchParams(location.search);
    p.set("state", stateName);
    swap ? p.set("swap", "") : p.delete("swap");
    bright ? p.set("bg", "bright") : p.delete("bg");
    history.replaceState(null, "", `?${p.toString().replace(/=(&|$)/g, "$1")}`);
    bar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.s === stateName || (b.dataset.t === "swap" && swap) || (b.dataset.t === "bright" && bright)));
  };
  for (const name of STATES) {
    const b = el("button", { "data-s": name }, name);
    b.onclick = () => ((stateName = name), sync(), render());
    bar.append(b);
  }
  const t1 = el("button", { "data-t": "swap" }, "swap sides");
  t1.onclick = () => ((swap = !swap), sync(), render());
  const t2 = el("button", { "data-t": "bright" }, "bright bg");
  t2.onclick = () => ((bright = !bright), sync(), render());
  bar.append(t1, t2);
  sync();
}

await mountExistingUI();
mountNewDom();
buildBar();
render();
window.addEventListener("resize", render);
