// Feedback at the right hand (docs/ui-integration.md §4 "At the hand"): the filter arc, all modes.
// Centered on the right palm, r = 0.95 hand spans, -150° -> -30° (above the hand); dot in the mode
// color at the filter value. Held (Arp pinch): arc dims, hollow dot. Hidden while the menu is open,
// when the right hand is not tracked, and where an open panel (guide / controls) would cover it: on
// phones the panels sit over the hands, and a half-covered arc reads as a glitch.
//
// Also exports small canvas helpers modes can use for their own at-hand feedback (Arp x2 pill, the
// big BPM plate during a pinch) so they share one look.

import { COLORS, FONT, STROKE, deg, drawArc, drawPill, drawPlate } from "./theme.js";

export function createHandOverlays({ S }) {
  function draw(g, G) {
    const R = S.hands.right;
    if (!R.pos || S.menu.state !== "closed") return;
    if (S.filter == null) return;
    const p = G.toPx(R.pos);
    const r = G.hs * 0.95;
    const box = { x: p.x - r - 6, y: p.y - r - 6, w: 2 * r + 12, h: r * 0.6 + 12 };
    if (S.covered(box)) return;
    const held = S.rightHeld || S.rightReturn;
    drawArc(g, {
      cx: p.x, cy: p.y, r, a0: deg(-150), a1: deg(-30),
      color: "rgba(243, 239, 231, 0.72)", lineWidth: STROKE.thin, alpha: held ? 0.45 : 1,
      dotAt: (Math.max(-1, Math.min(1, S.filter)) + 1) / 2, dotColor: S.color, dotHollow: held, dotRadius: 5,
    });
    G.reg("filter-arc", "hand", box);
  }
  return { draw };
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
