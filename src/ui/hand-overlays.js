// Feedback at the right hand (docs/ui-integration.md §4 "At the hand"): the filter arc, all modes. It is THE
// filter visual (camera feedback: two filter visuals were one too many): the value shows as a small label above
// the arc ("Filter +40%"); the old top-right readout #distortionDisplay stays in the DOM (Eric's markup, still
// updated by indicators.js / readouts.js) but is hidden while the modes UI is mounted (modes.css, body.gs-modes).
// Sits above the right hand: centered on the palm horizontally, with the arc's lowest points a
// margin above the highest fingertip (`right/top`), so it never covers the fingers. -150° -> -30°;
// dot in the mode color at the filter value, moving the way the fingertips lean on screen (tilt is
// measured on the unmirrored camera image, so its sign is flipped for the mirrored display). Held (Arp pinch): arc dims, hollow dot. Hidden while the menu is open,
// when the right hand is not tracked, and while the hand itself is under an open panel (guide /
// controls; on phones the panels sit over the hands): feedback for a hidden hand reads as a glitch.
//
// Also exports small canvas helpers modes can use for their own at-hand feedback (Arp x2 pill, the
// big BPM plate during a pinch) so they share one look.

import { COLORS, FONT, STROKE, deg, drawArc, drawPill, drawPlate, drawLabel, withAlpha } from "./theme.js";
import { AXES } from "../core/axes.js";

// Sideways axes (src/core/axes.js: right x = Drive, left x = Space): a short horizontal tick scale under each palm,
// running from the band's inner end (towards the screen middle) to its outer end. Middle segment = the neutral dead
// zone; the outer half is the effect range (ticks at 1/4..4/4), filled from the middle to the dot in the axis color.
// States: neutral (dot hollow, scale quiet) | active (dot solid, fill, name next to the outer end) | held (menu or Arp
// pinch holds the right hand: 45 %, hollow dot) | off / hand lost / menu open (right) / hand under a panel: hidden.
/** Scale below the palm, in hand spans: just under the wrist (0.42 hs), well above the Arp x2 pill (0.9 hs). */
const AXIS_DROP = 0.48;
const AXIS_DEAD = 0.16; // drawn dead-zone width, fraction of the scale (= ZONE.DEAD_ZONE)

/** Gap between the highest fingertip and the arc's lowest points, in hand spans. */
const ARC_CLEARANCE = 0.12;

export function createHandOverlays({ S, bus }) {
  function drawAxis(g, G, a) {
    if (bus?.get?.(`${a.id}/on`) === false) return;
    const side = a.hand;
    const h = S.hands[side];
    const pos = S.drawPos(side);
    if (!pos || typeof h.x !== "number" || !h.zone) return;
    if (side === "right" && S.menu.state !== "closed") return;
    const p = G.toPx(pos);
    if (S.palmCovered(p, G.hs)) return;
    const phone = G.W < 600 || G.H < 500;
    const w = Math.max(40, Math.min(G.hs * (phone ? 0.6 : 0.72), phone ? 80 : 120));
    const dir = h.zone.outer >= h.zone.inner ? 1 : -1; // screen direction of "outward"
    const y = p.y + G.hs * AXIS_DROP;
    const x0 = p.x - (dir * w) / 2; // inner end
    const at = (u) => x0 + dir * u * w;
    const amount = Math.max(0, Math.min(1, Number(bus?.get?.(a.param)) || 0));
    const held = side === "right" && (S.rightHeld || S.rightReturn);
    const active = amount > 0.001;
    const color = side === "right" ? S.color : COLORS.ink;
    g.save();
    g.globalAlpha *= held ? 0.45 : 1;
    g.lineCap = "round";
    // halo + base line
    g.beginPath();
    g.moveTo(at(0), y);
    g.lineTo(at(1), y);
    g.strokeStyle = COLORS.halo;
    g.lineWidth = 5;
    g.stroke();
    g.strokeStyle = COLORS.faint;
    g.lineWidth = STROKE.thin;
    g.stroke();
    // dead zone (neutral) segment + effect-range ticks
    g.beginPath();
    g.moveTo(at(0.5 - AXIS_DEAD / 2), y);
    g.lineTo(at(0.5 + AXIS_DEAD / 2), y);
    g.strokeStyle = COLORS.quiet;
    g.lineWidth = 3;
    g.stroke();
    g.beginPath();
    for (const u of [0.5 + AXIS_DEAD / 2, 0.68, 0.79, 0.89, 1]) {
      const tx = at(u);
      g.moveTo(tx, y - 3);
      g.lineTo(tx, y + 3);
    }
    g.strokeStyle = COLORS.quiet;
    g.lineWidth = STROKE.hair;
    g.stroke();
    // fill from the dead zone to the amount, then the dot at the hand's position across the band
    const dotU = Math.max(0, Math.min(1, h.x));
    if (active) {
      g.beginPath();
      g.moveTo(at(0.5 + AXIS_DEAD / 2), y);
      g.lineTo(at(0.5 + AXIS_DEAD / 2 + amount * (0.5 - AXIS_DEAD / 2)), y);
      g.strokeStyle = withAlpha(color, 0.9);
      g.lineWidth = 3;
      g.stroke();
    }
    const dx = at(dotU);
    g.beginPath();
    g.arc(dx, y, 4.5, 0, Math.PI * 2);
    g.fillStyle = COLORS.halo;
    g.fill();
    g.beginPath();
    g.arc(dx, y, 3.5, 0, Math.PI * 2);
    if (active && !held) {
      g.fillStyle = color;
      g.fill();
    } else {
      g.strokeStyle = active ? color : COLORS.ink;
      g.lineWidth = STROKE.thin;
      g.stroke();
    }
    let box = { x: Math.min(at(0), at(1)) - 5, y: y - 6, w: w + 10, h: 12 };
    if (active && !phone) {
      const lx = at(1) + dir * 8;
      const r = drawLabel(g, a.label, lx, y, { size: 11, weight: 600, color, align: dir > 0 ? "left" : "right" });
      const x1 = Math.min(box.x, r.x);
      box = { x: x1, y: Math.min(box.y, r.y), w: Math.max(box.x + box.w, r.x + r.w) - x1, h: Math.max(box.h, r.h) };
    }
    g.restore();
    G.reg(`axis-${a.id}`, "hand", { ...box, dot: { x: dx, y }, value: amount, active, held });
  }

  /** Drive / Space tick scales (separate from the filter arc below). */
  function drawAxes(g, G) {
    for (const a of AXES) drawAxis(g, G, a);
  }

  function draw(g, G) {
    S.filterLabel = null; // rect of the value label this frame (first-use labels stack above it)
    drawAxes(g, G);
    const pos = S.drawPos("right");
    if (!pos || S.menu.state !== "closed") return;
    if (S.filter == null) return;
    const p = G.toPx(pos);
    const r = G.hs * 0.55;
    if (S.palmCovered(p, G.hs)) return;
    // Arc ends (at ±30° below horizontal from the center) sit ARC_CLEARANCE above the highest fingertip.
    const tipY = S.hands.right.top ? G.toPx(S.hands.right.top).y : p.y - G.hs * 0.8;
    const cy = Math.min(tipY, p.y) - G.hs * ARC_CLEARANCE + r * Math.sin(deg(30));
    const box = { x: p.x - r - 6, y: cy - r - 6, w: 2 * r + 12, h: r * 0.5 + 12 };
    const held = S.rightHeld || S.rightReturn;
    const dotAt = (1 - Math.max(-1, Math.min(1, S.filter))) / 2;
    drawArc(g, {
      cx: p.x, cy, r, a0: deg(-150), a1: deg(-30),
      color: "rgba(243, 239, 231, 0.72)", lineWidth: STROKE.thin, alpha: held ? 0.45 : 1,
      dotAt, dotColor: S.color, dotHollow: held, dotRadius: 5,
    });
    const dotA = deg(-150 + 120 * dotAt);
    const label = drawFilterValue(g, p.x, Math.max(FONT.small, cy - r - 16), S.filter, held, G.W);
    S.filterLabel = label.rect;
    G.reg("filter-arc", "hand", { ...box, dot: { x: p.x + r * Math.cos(dotA), y: cy + r * Math.sin(dotA) }, label });
  }
  return { draw };
}

/** The filter value as text ("Filter +40%"): what the old top-right readout said, now at the arc. */
export function filterText(f) {
  const pct = Math.round(Math.max(-1, Math.min(1, f)) * 100);
  return `Filter ${pct > 0 ? "+" : ""}${pct}%`;
}

/** Small value label above the arc's apex (halo, legible over video). Returns {text, rect}. */
function drawFilterValue(g, x, y, f, held, W = Infinity) {
  const text = filterText(f);
  // Kept on screen when the hand is at the very edge (the arc may leave the frame; its value never does).
  g.save();
  g.font = `600 ${FONT.small}px ${FONT.family}`;
  const half = g.measureText(text).width / 2 + 4;
  g.restore();
  x = Math.max(half, Math.min(W - half, x));
  const rect = drawLabel(g, text, x, y, { size: FONT.small, weight: 600, color: COLORS.ink, align: "center", alpha: held ? 0.45 : 0.9 });
  return { text, rect };
}

/** x2 pill under the right palm (Arp): outline until double time is active, then filled. */
export function drawX2Pill(g, { x, y, hs, color, filled }) {
  return drawPill(g, "x2", x, y + hs * 0.9, { color, filled, size: 12 });
}

/**
 * The one large number in change (BPM during a pinch) with its delta INSIDE the same plate.
 * align "left" = the plate starts at x, "right" = ends at x.
 */
export function drawBpmPlate(g, { x, y, bpm, delta = 0, align = "left" }) {
  g.save();
  g.font = `700 ${FONT.big}px ${FONT.family}`;
  const bw = g.measureText(String(bpm)).width;
  g.font = `600 12px ${FONT.family}`;
  const sub = `BPM ${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)}`;
  const sw = g.measureText(sub).width;
  const w = Math.max(bw, sw) + 18;
  const h = FONT.big * 1.15 + 22;
  const left = align === "left" ? x : x - w;
  const rect = drawPlate(g, left, y - h / 2, w, h, { radius: 8, fill: "rgba(20, 20, 20, 0.78)" });
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${FONT.big}px ${FONT.family}`;
  g.fillStyle = COLORS.ink;
  g.fillText(String(bpm), left + w / 2, y - 8);
  g.font = `600 12px ${FONT.family}`;
  g.fillStyle = COLORS.quiet;
  g.fillText(sub, left + w / 2, y + h / 2 - 11);
  g.restore();
  return rect;
}
