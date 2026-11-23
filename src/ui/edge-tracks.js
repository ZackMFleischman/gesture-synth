// Edge tracks (docs/ui-integration.md §4): full-height tracks in the 20px gutters, one per hand.
//  - Master-volume track: neutral ink, on the edge where the chord hand is displayed (D11).
//  - Right track: the active mode's right-height control (mode.rightTrack, default Chords=volume,
//    Arp=gate), in the mode color. Held (menu / countdown / pinch): dim + hollow marker at the held
//    value, no guide. Return (engine still holds the value, `held` signal): hollow + solid markers.
//    A screen control that wins over the hand (ui/override) also shows as hollow (value) + solid (hand).
//  - Hand lost: that hand's markers dashed in the warning color, a "Hand lost" plate at the edge and a
//    ghost ring where the hand was last seen. Ring and plate fade out after MOTION.lostHold + lostFade.
// Markers are level with the hand's palm (no numbers).

import {
  COLORS, LAYOUT, MOTION, STROKE, edgeTrackX, drawEdgeTrack, drawLabel, drawPlate, drawRing, FONT,
} from "./theme.js";

/** Opacity of the "hand lost" ring + plate, `ms` after the hand counted as lost: 1, then fades to 0. */
export function lostAlpha(ms) {
  if (ms <= MOTION.lostHold) return 1;
  return Math.max(0, 1 - (ms - MOTION.lostHold) / MOTION.lostFade);
}

const MEET_PX = 6; // return state ends when the hand marker is this close to the held marker

/** Track center x, moved in by the safe-area inset on that side (landscape notch; G.safe from mode-ui). */
export function trackX(side, G) {
  const inset = side === "left" ? G.safe?.left || 0 : G.safe?.right || 0;
  return edgeTrackX(side, G.W) + (side === "left" ? inset : -inset);
}

export function createEdgeTracks({ S, bus }) {
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
    const edgeX = trackX(side, G) + inward * (LAYOUT.gutter - 2);
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
  /** Hollow-marker y for a value, in the hand's own frame when the hand is visible (so hollow and solid
   *  meet where the engine hands control back: height ~ wrist y over 90% of the frame), else on the track. */
  function hollowY(G, value, liveY, handHeight) {
    if (liveY != null && typeof handHeight === "number") return liveY + (handHeight - value) * 0.9 * G.H;
    return valueToY(G, value);
  }

  function track(g, G, o) {
    const x = trackX(o.side, G);
    // What was drawn (read by tests through window.__gsTest.ui.tracks).
    S.tracks[o.name] = { side: o.side, markerY: o.markerY ?? null, heldY: o.heldY ?? null, dim: !!o.dim, lost: !!o.lostNow };
    const { top, bottom } = trackBounds(G);
    backing(g, x, top, bottom);
    if (o.guideTo && o.markerY != null) {
      const dir = o.guideTo.x > x ? 1 : -1;
      const x0 = x + dir * (LAYOUT.markerLength / 2 + 4);
      const seg = { x: Math.min(x0, o.guideTo.x), y: Math.min(o.markerY, o.guideTo.y) - 3, w: Math.abs(o.guideTo.x - x0), h: Math.abs(o.guideTo.y - o.markerY) + 6 };
      if (!S.covered(seg)) guide(g, x0, o.markerY, o.guideTo.x, o.guideTo.y); // not under an open panel
    }
    const rect = drawEdgeTrack(g, {
      x, top, bottom, color: o.color, markerY: o.markerY, heldY: o.heldY, dim: o.dim, lost: o.lostNow,
      fillY: o.fillY, guideTo: null,
    });
    G.reg(o.name, "edge", rect);
    const a = o.lostNow && o.hand.lastPos && o.hand.goneAt != null ? lostAlpha(S.now - o.hand.goneAt - S.lostGraceMs) : 0;
    if (a > 0) {
      g.save();
      g.globalAlpha *= a;
      G.reg(`${o.name}-lost-label`, "edge", lostLabel(g, G, o.side, o.markerY ?? G.H / 2));
      G.reg(`${o.name}-ghost`, "hand", ghost(g, G, o.side, o.hand.lastPos));
      g.restore();
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
    const exprSide = S.chordSide === "left" ? "right" : "left";
    // A mode without a right track (Lead) draws its own control on the expression edge (`ui/sides`), so
    // the master track always stays on the chord hand's edge.
    const chordSide = S.chordSide;
    const ownSide = true;

    // ---- Master volume (chord hand) ----
    const L = S.hands.left;
    const lLost = S.lost("left");
    const ov = S.overrides.get("master");
    const lPos = S.drawPos("left");
    const lY = lPos ? lPos.y * G.H : L.lastPos && L.seen ? L.lastPos.y * G.H : null;
    track(g, G, {
      name: "master-track",
      side: chordSide,
      color: COLORS.ink,
      hand: L,
      lostNow: lLost,
      markerY: lY,
      heldY: ov && lPos ? hollowY(G, ov.value, lY, L.height) : null,
      guideTo: lPos && ownSide ? handEdgePoint(G, lPos, chordSide) : null,
    });

    // ---- Right track (mode's right-height control) ----
    const R = S.hands.right;
    const rPos = S.drawPos("right");
    const liveY = rPos ? rPos.y * G.H : null;
    if (S.modeId !== lastMode) {
      lastMode = S.modeId;
      // The router switches mode at the START of the countdown, while the menu still holds the hand:
      // keep showing a held marker, now at the new mode's value.
      const v = S.rightTrack ? bus.get(S.rightTrack.param) : null;
      heldY = S.rightHeld ? (typeof v === "number" ? valueToY(G, v) : heldY) : null;
    }
    if (S.rightHeld && !wasHeld) {
      // Arp pinch (menu closed): the hollow marker stays where the solid one was (hand level at the pinch
      // start), so nothing jumps; the menu shows the held value on the track.
      const pinchHold = S.menu.state === "closed" && lastRightY != null;
      heldY = pinchHold ? lastRightY : S.heldValue != null ? valueToY(G, S.heldValue) : lastRightY ?? liveY;
    }
    if (!S.rightHeld) heldY = null;
    wasHeld = S.rightHeld;
    if (liveY != null && !S.rightHeld) lastRightY = liveY;
    if (!S.rightTrack) return; // e.g. Lead: the mode draws its note ladder instead

    const rLost = S.lost("right");
    const rov = S.overrides.get(S.rightTrack.param);
    let hollow = null;
    if (S.rightReturn && S.heldValue != null) hollow = hollowY(G, S.heldValue, liveY, R.height);
    else if (rov) hollow = hollowY(G, rov.value, liveY, R.height);
    if (hollow != null && liveY != null && Math.abs(hollow - liveY) < MEET_PX) hollow = null;

    if (rLost) {
      track(g, G, { name: "right-track", side: exprSide, color: S.color, hand: R, lostNow: true, markerY: lastRightY, fillY: lastRightY });
    } else if (S.rightHeld) {
      track(g, G, { name: "right-track", side: exprSide, color: S.color, hand: R, markerY: null, heldY, fillY: heldY, dim: true });
      // Pinch (menu closed): say what is held next to the hollow marker ("Gate held", mock §3).
      if (S.menu.state === "closed" && heldY != null && S.rightTrack.label) {
        const inward = exprSide === "left" ? 1 : -1;
        const x = edgeTrackX(exprSide, G.W) + inward * (LAYOUT.markerLength / 2 + 10);
        const y = Math.max(LAYOUT.trackTop + 10, Math.min(G.H - LAYOUT.trackBottom - 10, heldY));
        const r = drawLabel(g, `${S.rightTrack.label} held`, x, y, {
          size: 12, weight: 600, color: COLORS.ink, align: inward > 0 ? "left" : "right", plate: true,
        });
        S.tracks["right-track"].heldLabel = `${S.rightTrack.label} held`;
        G.reg("right-held-label", "hand", r);
      }
    } else {
      track(g, G, {
        name: "right-track",
        side: exprSide,
        color: S.color,
        hand: R,
        markerY: liveY,
        heldY: hollow,
        // No guide while the big BPM shows next to the hand (Arp pinch + ~1 s): it would cross the number.
        guideTo: rPos && !bus.get("arp/tempo") ? handEdgePoint(G, rPos, exprSide) : null,
      });
    }
  }

  return { draw };
}

