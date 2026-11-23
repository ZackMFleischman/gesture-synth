// Edge tracks (docs/ui-integration.md §4): full-height tracks in the 20px gutters, one per hand.
//  - Master-volume track: neutral ink, on the edge where the chord hand is displayed (D11).
//  - Right track: the active mode's right-height control (mode.rightTrack, default Chords=volume,
//    Arp=gate), in the mode color. Held (menu / countdown / pinch): dim + hollow marker at the held
//    value, no guide. Return (engine still holds the value, `held` signal): hollow + solid markers.
//    A screen control that wins over the hand (ui/override) also shows as hollow (value) + solid (hand).
//  - Hand lost: that hand's markers dashed in the warning color, a "Hand lost" plate at the edge and a
//    ghost ring where the hand was last seen.
// Markers are level with the hand's palm (no numbers).

import {
  COLORS, LAYOUT, STROKE, edgeTrackX, drawEdgeTrack, drawPlate, drawRing, FONT,
} from "./theme.js";

const MEET_PX = 6; // return state ends when the hand marker is this close to the held marker

export function createEdgeTracks({ S }) {
  let wasHeld = false;
  let heldY = null; // hollow marker y while held (menu / pinch)
  let lastRightY = null;
  let lastMode = null;

  function trackBounds(G) {
    return { top: LAYOUT.trackTop, bottom: G.H - LAYOUT.trackBottom };
  }
  const valueToY = (G, v) => {
    const { top, bottom } = trackBounds(G);
    return bottom - Math.max(0, Math.min(1, v)) * (bottom - top);
  };

  /** Stronger dotted guide than theme.drawGuideLine (bright-video legibility). */
  function guide(g, x0, y0, x1, y1, { lost = false } = {}) {
    g.save();
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.lineCap = "round";
    g.lineWidth = 5;
    g.strokeStyle = "rgba(0, 0, 0, 0.42)";
    g.stroke();
    g.lineCap = "butt";
    g.setLineDash(lost ? [4, 4] : [3, 5]);
    g.lineWidth = 2;
    g.strokeStyle = lost ? COLORS.warn : "rgba(243, 239, 231, 0.85)";
    g.stroke();
    g.restore();
  }

  /** Dark strip behind a track so its outline reads on bright walls / windows. */
  function backing(g, x, top, bottom) {
    drawPlate(g, x - 7, top - 3, 14, bottom - top + 6, { radius: 7, fill: "rgba(0, 0, 0, 0.32)" });
  }

  function lostLabel(g, G, side, y) {
    const inward = side === "left" ? 1 : -1;
    const edgeX = edgeTrackX(side, G.W) + inward * (LAYOUT.gutter - 2);
    const lines = G.W < 520 ? ["Hand", "lost"] : ["Hand lost"];
    const size = 12;
    g.save();
    g.font = `700 ${size}px ${FONT.family}`;
    const tw = Math.max(...lines.map((l) => g.measureText(l).width));
    const lh = size * 1.2;
    const w = tw + 10;
    const h = lines.length * lh + 6;
    const cy = Math.max(150 + h / 2, Math.min(G.H - 90 - h / 2, y));
    const x = side === "left" ? edgeX : edgeX - w;
    const r = drawPlate(g, x, cy - h / 2, w, h, {
      radius: 6, fill: "rgba(20, 20, 20, 0.85)", stroke: COLORS.warn, lineWidth: 1, dash: [3, 2],
    });
    g.fillStyle = COLORS.warn;
    g.textBaseline = "middle";
    g.textAlign = "left";
    lines.forEach((l, i) => g.fillText(l, x + 5, cy - ((lines.length - 1) * lh) / 2 + i * lh));
    g.restore();
    return r;
  }

  function ghost(g, G, side, pos) {
    const p = G.toPx(pos);
    return drawRing(g, {
      cx: p.x, cy: p.y, r: G.hs * 0.45, color: COLORS.warn, lineWidth: STROKE.thin, dash: [4, 5], alpha: 0.75,
    });
  }

  /** One hand's track. o: {side, color, hand, lostNow, markerY, heldY, dim, guideTo, name} */
  function track(g, G, o) {
    const x = edgeTrackX(o.side, G.W);
    // What was drawn (read by tests through window.__gsTest.ui.tracks).
    S.tracks[o.name] = { side: o.side, markerY: o.markerY ?? null, heldY: o.heldY ?? null, dim: !!o.dim, lost: !!o.lostNow };
    const { top, bottom } = trackBounds(G);
    backing(g, x, top, bottom);
    if (o.guideTo && o.markerY != null) {
      const dir = o.guideTo.x > x ? 1 : -1;
      guide(g, x + dir * (LAYOUT.markerLength / 2 + 4), o.markerY, o.guideTo.x, o.guideTo.y);
    }
    const rect = drawEdgeTrack(g, {
      x, top, bottom, color: o.color, markerY: o.markerY, heldY: o.heldY, dim: o.dim, lost: o.lostNow,
      fillY: o.fillY, guideTo: null,
    });
    G.reg(o.name, "edge", rect);
    if (o.lostNow && o.hand.lastPos) {
      G.reg(`${o.name}-lost-label`, "edge", lostLabel(g, G, o.side, o.markerY ?? G.H / 2));
      G.reg(`${o.name}-ghost`, "hand", ghost(g, G, o.side, o.hand.lastPos));
    }
    return rect;
  }

  function handEdgePoint(G, pos, side) {
    const p = G.toPx(pos);
    const inward = side === "left" ? 1 : -1;
    return { x: p.x - inward * G.hs * 0.42, y: p.y };
  }

  function draw(g, G) {
    S.tracks = {};
    const chordSide = S.chordSide;
    const exprSide = chordSide === "left" ? "right" : "left";

    // ---- Master volume (chord hand) ----
    const L = S.hands.left;
    const lLost = S.lost("left");
    const ov = S.overrides.get("master");
    const lY = L.pos ? L.pos.y * G.H : L.lastPos && L.seen ? L.lastPos.y * G.H : null;
    track(g, G, {
      name: "master-track",
      side: chordSide,
      color: COLORS.ink,
      hand: L,
      lostNow: lLost,
      markerY: lY,
      heldY: ov && L.pos ? valueToY(G, ov.value) : null,
      guideTo: L.pos ? handEdgePoint(G, L.pos, chordSide) : null,
    });

    // ---- Right track (mode's right-height control) ----
    if (S.modeId !== lastMode) {
      lastMode = S.modeId;
      heldY = null;
    }
    const R = S.hands.right;
    const liveY = R.pos ? R.pos.y * G.H : null;
    if (S.rightHeld && !wasHeld) heldY = S.heldValue != null ? valueToY(G, S.heldValue) : lastRightY ?? liveY;
    if (!S.rightHeld) heldY = null;
    wasHeld = S.rightHeld;
    if (liveY != null && !S.rightHeld) lastRightY = liveY;
    if (!S.rightTrack) return; // e.g. Lead: the mode draws its note ladder instead

    const rLost = S.lost("right");
    const rov = S.overrides.get(S.rightTrack.param);
    let hollow = null;
    if (S.rightReturn && S.heldValue != null) hollow = valueToY(G, S.heldValue);
    else if (rov) hollow = valueToY(G, rov.value);
    if (hollow != null && liveY != null && Math.abs(hollow - liveY) < MEET_PX) hollow = null;

    if (rLost) {
      track(g, G, { name: "right-track", side: exprSide, color: S.color, hand: R, lostNow: true, markerY: lastRightY, fillY: lastRightY });
    } else if (S.rightHeld) {
      track(g, G, { name: "right-track", side: exprSide, color: S.color, hand: R, markerY: null, heldY, fillY: heldY, dim: true });
    } else {
      track(g, G, {
        name: "right-track",
        side: exprSide,
        color: S.color,
        hand: R,
        markerY: liveY,
        heldY: hollow,
        guideTo: R.pos ? handEdgePoint(G, R.pos, exprSide) : null,
      });
    }
  }

  return { draw };
}

