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

import { COLORS, FONT, STROKE, deg, drawArc, drawLabel, drawPill, drawPlate } from "./theme.js";

/** Gap between the highest fingertip and the arc's lowest points, in hand spans. */
const ARC_CLEARANCE = 0.12;

export function createHandOverlays({ S }) {
  function draw(g, G) {
    S.filterLabel = null; // rect of the value label this frame (first-use labels stack above it)
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
    const label = drawFilterValue(g, p.x, Math.max(FONT.small, cy - r - 16), S.filter, held);
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
function drawFilterValue(g, x, y, f, held) {
  const text = filterText(f);
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
