// Radial menu: canvas renderer. Reads a menu-state snapshot, keeps only cosmetic animation state.
// All colors / sizes live in MENU_THEME so integration can swap them for shared UI tokens.

import { DIRECTIONS } from "./menu-state.js";

export const MENU_THEME = Object.freeze({
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  ink: "255,255,255", // structure (rgb triple, alpha applied per use)
  plate: "10,12,18", // dark plates behind arcs / labels for readability over video
  shadow: "0,0,0",
  warn: "#f5b041", // amber: hand lost only
  arcGapDeg: 8, // gap between neighbouring arcs (arc span = 90 - gap)
  cornerPx: 4,
  outlineW: 1.25,
  hoverW: 1.5,
  selectedW: 2,
  rimW: 3,
  rimGap: 4,
  plateAlpha: 0.34,
  outlineAlpha: 0.72,
  approachFill: 0.38,
  selectedFill: 0.5,
  dimAlpha: 0.35,
  labelPx: 14,
  labelGap: 20, // ring outer edge -> label plate
  labelQuiet: 0.62,
  hintPx: 12,
  markerR: 3,
  markerGap: 10, // ring outer edge -> current-mode dot center
  entryR: 2.5,
  fistR: 6,
  countdownR: 0.42, // x handSize
  countdownW: 3,
  growFrom: 0.55, // ring scale at the start of the grow animation
  tauMs: 40, // easing time constant for highlight changes (~120 ms to settle)
  fillTauMs: 25,
  edgePad: 10,
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const rgba = (rgb, a) => `rgba(${rgb},${a})`;
const DEG = Math.PI / 180;
const DIR_VEC = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "255,255,255";
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/** Derive pixel scale/bounds from ctx.toCanvas (falls back to the canvas size). */
export function viewFromCtx(g, ctx) {
  const m = g.getTransform ? g.getTransform() : { a: 1, d: 1 };
  const cw = g.canvas.width / (m.a || 1);
  const ch = g.canvas.height / (m.d || 1);
  const toCanvas = ctx?.toCanvas ?? ((p) => ({ x: p.x * cw, y: p.y * ch }));
  const o = toCanvas({ x: 0, y: 0 });
  const e = toCanvas({ x: 1, y: 1 });
  const sx = Math.abs(e.x - o.x) || cw;
  const sy = Math.abs(e.y - o.y) || ch;
  return {
    toCanvas,
    scale: sx, // px per width unit
    aspect: sx / sy,
    bounds: {
      x0: Math.max(0, Math.min(o.x, e.x)),
      y0: Math.max(0, Math.min(o.y, e.y)),
      x1: Math.min(cw, Math.max(o.x, e.x)),
      y1: Math.min(ch, Math.max(o.y, e.y)),
    },
  };
}

/** Annular sector with softly rounded corners. Angles in radians. */
function sectorPath(g, cx, cy, r0, r1, a0, a1, corner) {
  const cr = Math.max(0, Math.min(corner, (r1 - r0) / 2 - 0.01, (r1 * (a1 - a0)) / 4));
  const P = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  g.beginPath();
  if (cr <= 0.5) {
    g.arc(cx, cy, r1, a0, a1);
    g.arc(cx, cy, r0, a1, a0, true);
    g.closePath();
    return;
  }
  const d1 = cr / r1;
  const d0 = cr / Math.max(r0, cr * 2);
  g.moveTo(...P(r0 + cr, a0));
  g.arcTo(...P(r1, a0), ...P(r1, a0 + d1), cr);
  g.arc(cx, cy, r1, a0 + d1, a1 - d1);
  g.arcTo(...P(r1, a1), ...P(r1 - cr, a1), cr);
  g.arcTo(...P(r0, a1), ...P(r0, a1 - d0), cr);
  g.arc(cx, cy, r0, a1 - d0, a0 + d0, true);
  g.arcTo(...P(r0, a0), ...P(r0 + cr, a0), cr);
  g.closePath();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

const pathCache = new Map();
function drawIcon(g, icon, x, y, size, color) {
  if (!icon) return;
  const isPath = /^\s*[Mm]\s*[-\d.]/.test(icon) && typeof Path2D !== "undefined";
  g.save();
  if (isPath) {
    let p = pathCache.get(icon);
    if (!p) pathCache.set(icon, (p = new Path2D(icon)));
    g.translate(x - size / 2, y - size / 2);
    g.scale(size / 24, size / 24);
    g.lineCap = "round";
    g.lineJoin = "round";
    g.lineWidth = 2.6;
    g.strokeStyle = "rgba(0,0,0,0.45)";
    g.stroke(p);
    g.lineWidth = 1.8;
    g.strokeStyle = color;
    g.stroke(p);
  } else {
    g.font = `${Math.round(size * 0.9)}px ${MENU_THEME.font}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(icon, x, y + 1);
  }
  g.restore();
}

/**
 * Creates a renderer with its own cosmetic animation state.
 * draw(g, snapshot, view) — snapshot from menu-state, view from viewFromCtx().
 */
export function createMenuRenderer(themeOverrides = {}) {
  const TH = { ...MENU_THEME, ...themeOverrides };
  const anim = new Map(); // id -> { fill, sel, hov, dim, vis }
  let last = null;

  function step(cur, target, dt, tau) {
    return cur + (target - cur) * (1 - Math.exp(-dt / tau));
  }

  function labelFont(bold) {
    return `${bold ? 650 : 500} ${TH.labelPx}px ${TH.font}`;
  }

  return function draw(g, snap, view) {
    const { phase, now, timing: T, geometry: G } = snap;
    const dt = last === null ? 16 : Math.max(0, Math.min(100, now - last));
    last = now;

    // ---- Which visual phase are we in? -------------------------------------------------
    let ringAlpha = 1;
    let ringScale = 1;
    let mode = phase; // "open" | "confirm" | "fade" | "done" | null
    if (phase === "idle") {
      const since = now - snap.closedAt;
      if (!snap.center || !(since >= 0)) mode = null;
      else if (snap.closeReason === "done") mode = since < 160 ? "done" : null;
      else if (since < T.CANCEL_FADE_MS) mode = "fade";
      else mode = null;
      if (!mode) {
        anim.clear();
        return;
      }
      if (mode === "fade") {
        const u = since / T.CANCEL_FADE_MS;
        ringAlpha = 1 - u;
        ringScale = 1 - 0.06 * u;
      }
    } else if (phase === "open") {
      const u = easeOut((now - snap.openedAt) / T.GROW_MS);
      ringAlpha = u;
      ringScale = TH.growFrom + (1 - TH.growFrom) * u;
    }

    const s = snap.handSize * view.scale; // px per hand size
    const R = G.SELECT_R * s * ringScale;
    const ri = G.INNER_R * s * ringScale;
    const b = view.bounds;
    const items = snap.items;

    g.save();
    g.lineCap = "round";
    g.lineJoin = "round";

    // ---- Countdown / done: drawn at the hand ---------------------------------------------
    if (mode === "confirm" || mode === "done") {
      const item = items.find((i) => i.id === snap.confirmedId);
      const t = now - snap.confirmedAt;
      if (mode === "confirm" && t < T.FLASH_MS + 120) drawRing(t);
      drawCountdown(item, t);
      g.restore();
      return;
    }

    drawRing(null);
    g.restore();

    // ---- Ring (open / fading / flashing) --------------------------------------------------
    function drawRing(confirmT) {
      const ctr = clampedCenter();
      const { x: cx, y: cy } = ctr;
      const offPx = { x: snap.offset.x * view.scale, y: snap.offset.y * view.scale };
      const fist = { x: cx + offPx.x, y: cy + offPx.y };
      const distPx = Math.hypot(offPx.x, offPx.y);
      const span = (90 - TH.arcGapDeg) * DEG;
      const flashing = confirmT !== null;
      // After the flash the confirmed arc fades out while the countdown ring takes over.
      const postFlash = flashing ? clamp01((confirmT - T.FLASH_MS) / 120) : 0;
      const flash = flashing ? Math.sin(Math.PI * clamp01(confirmT / T.FLASH_MS)) : 0;

      for (const it of items) {
        let a = anim.get(it.id);
        if (!a) anim.set(it.id, (a = { fill: 0, sel: 0, hov: 0, dim: 0, vis: 1, lab: TH.labelQuiet }));
        const isSel = it.id === snap.selectedId;
        const isHov = it.id === snap.hoverId;
        const fillT = isSel ? 1 : isHov ? clamp01((distPx / ringScale - G.INNER_R * s) / ((G.SELECT_R - G.INNER_R) * s)) : 0;
        const dimT = snap.selectedId && !isSel ? 1 : 0;
        const visT = flashing && !isSel ? 0 : 1;
        const labT = isSel ? 1 : isHov ? TH.labelQuiet + (1 - TH.labelQuiet) * snap.progress : TH.labelQuiet;
        if (mode === "open" || flashing) {
          a.fill = step(a.fill, fillT, dt, TH.fillTauMs);
          a.sel = step(a.sel, isSel ? 1 : 0, dt, TH.tauMs);
          a.hov = step(a.hov, isHov || isSel ? 1 : 0, dt, TH.tauMs);
          a.dim = step(a.dim, dimT, dt, TH.tauMs);
          a.vis = flashing ? step(a.vis, visT, dt, 35) : 1;
          a.lab = step(a.lab, labT, dt, TH.tauMs);
        }
      }

      const ordered = [...items].sort((p, q) => (anim.get(p.id).sel || 0) - (anim.get(q.id).sel || 0));
      for (const it of ordered) {
        const a = anim.get(it.id);
        const col = hexToRgb(it.color);
        const mid = DIRECTIONS[it.direction] * DEG;
        const a0 = mid - span / 2;
        const a1 = mid + span / 2;
        const dimF = 1 - (1 - TH.dimAlpha) * a.dim;
        const alpha = ringAlpha * a.vis * dimF * (1 - postFlash);
        if (alpha <= 0.002) continue;

        // plate
        sectorPath(g, cx, cy, ri, R, a0, a1, TH.cornerPx);
        g.fillStyle = rgba(TH.plate, TH.plateAlpha * alpha);
        g.fill();

        // approach / selected fill
        if (a.fill > 0.004) {
          const rf = ri + (R - ri) * a.fill;
          sectorPath(g, cx, cy, ri, rf, a0, a1, TH.cornerPx);
          const fa = TH.approachFill + (TH.selectedFill - TH.approachFill) * a.sel + 0.4 * flash;
          g.fillStyle = rgba(col, Math.min(0.95, fa) * alpha);
          g.fill();
        }

        // outline: dark halo, then thin line (neutral -> item color)
        sectorPath(g, cx, cy, ri, R, a0, a1, TH.cornerPx);
        const w = TH.outlineW + (TH.hoverW - TH.outlineW) * a.hov + (TH.selectedW - TH.hoverW) * a.sel;
        g.lineWidth = w + 2;
        g.strokeStyle = rgba(TH.shadow, 0.28 * alpha);
        g.stroke();
        g.lineWidth = w;
        g.strokeStyle = a.hov > 0.5 ? rgba(col, alpha) : rgba(TH.ink, TH.outlineAlpha * alpha);
        g.stroke();

        // selected rim with a soft glow
        if (a.sel > 0.01) {
          const rr = R + TH.rimGap + TH.rimW / 2;
          g.save();
          g.shadowColor = rgba(col, 0.7 * a.sel * alpha);
          g.shadowBlur = 10 + 10 * flash;
          g.beginPath();
          g.arc(cx, cy, rr, a0 + 2 / rr, a1 - 2 / rr);
          g.lineWidth = TH.rimW;
          g.strokeStyle = rgba(flash > 0.3 ? TH.ink : col, a.sel * alpha);
          g.stroke();
          g.restore();
        }

        // icon in the band
        const iconSize = Math.max(14, Math.min(26, (R - ri) * 0.5));
        const rm = (ri + R) / 2;
        const [vx, vy] = DIR_VEC[it.direction];
        const iconCol = rgba(TH.ink, (0.78 + 0.22 * a.hov) * alpha);
        drawIcon(g, it.icon, cx + vx * rm, cy + vy * rm, iconSize, iconCol);

        // current-mode marker: small dot just outside the arc
        if (it.id === snap.currentId) {
          const rd = R + TH.markerGap;
          g.beginPath();
          g.arc(cx + vx * rd, cy + vy * rd, TH.markerR, 0, Math.PI * 2);
          g.fillStyle = rgba(TH.ink, 0.95 * alpha);
          g.strokeStyle = rgba(TH.shadow, 0.5 * alpha);
          g.lineWidth = 2;
          g.stroke();
          g.fill();
        }

        // label outside the ring, in the direction of movement
        drawLabel(it, cx, cy, a, alpha, col);
      }

      if (flashing) return;

      // dashed tracking line + entry point + fist
      const hov = items.find((i) => i.id === (snap.selectedId || snap.hoverId));
      const lineCol = hov ? hexToRgb(hov.color) : TH.ink;
      if (distPx > 4) {
        g.save();
        g.setLineDash([4, 4]);
        g.lineWidth = 3;
        g.strokeStyle = rgba(TH.shadow, 0.3 * ringAlpha);
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(fist.x, fist.y);
        g.stroke();
        g.lineWidth = 1.25;
        g.strokeStyle = rgba(lineCol, (hov ? 0.95 : 0.6) * ringAlpha);
        g.stroke();
        g.restore();
      }
      g.beginPath();
      g.arc(cx, cy, TH.entryR, 0, Math.PI * 2);
      g.fillStyle = rgba(TH.ink, 0.75 * ringAlpha);
      g.fill();

      if (snap.tracking) {
        g.beginPath();
        g.arc(fist.x, fist.y, TH.fistR, 0, Math.PI * 2);
        g.fillStyle = rgba(TH.ink, ringAlpha);
        g.lineWidth = 2.5;
        g.strokeStyle = rgba(TH.shadow, 0.45 * ringAlpha);
        g.stroke();
        g.fill();
      } else {
        g.save();
        g.setLineDash([3, 3]);
        g.beginPath();
        g.arc(fist.x, fist.y, TH.fistR + 2, 0, Math.PI * 2);
        g.lineWidth = 2;
        g.strokeStyle = TH.warn;
        g.globalAlpha = ringAlpha;
        g.stroke();
        g.restore();
      }

      // hint under the ring
      const sel = items.find((i) => i.id === snap.selectedId);
      let hint = "Move to choose";
      if (!snap.tracking) hint = "Hand lost";
      else if (sel) hint = sel.id === snap.currentId ? "Already active" : "Open hand to confirm";
      const hasDown = items.some((i) => i.direction === "down");
      const hy = cy + R + (hasDown ? TH.labelGap + TH.labelPx + 30 : 22);
      g.font = `${sel ? 600 : 500} ${TH.hintPx}px ${TH.font}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineWidth = 3;
      g.strokeStyle = rgba(TH.shadow, 0.55 * ringAlpha);
      g.strokeText(hint, cx, hy);
      g.fillStyle = !snap.tracking ? TH.warn : rgba(TH.ink, (sel ? 0.95 : 0.7) * ringAlpha);
      g.fillText(hint, cx, hy);
    }

    function labelBox(it) {
      g.font = labelFont(true);
      const w = g.measureText(it.label).width + 18;
      const h = TH.labelPx + 10;
      return { w, h };
    }

    function drawLabel(it, cx, cy, a, alpha, col) {
      const { w, h } = labelBox(it);
      const [vx, vy] = DIR_VEC[it.direction];
      const start = R + TH.labelGap;
      const lx = cx + vx * (start + w / 2);
      const ly = cy + vy * (start + h / 2);
      const la = a.lab * alpha * (1 - (1 - 0.6) * a.dim);
      roundRect(g, lx - w / 2, ly - h / 2, w, h, h / 2);
      g.fillStyle = rgba(TH.plate, (0.42 + 0.2 * a.hov) * alpha);
      g.fill();
      if (a.sel > 0.01) {
        g.lineWidth = 1.25;
        g.strokeStyle = rgba(col, a.sel * alpha);
        g.stroke();
      }
      g.font = labelFont(a.hov > 0.5 && a.lab > TH.labelQuiet + 0.05);
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = rgba(TH.ink, la);
      g.fillText(it.label, lx, ly + 0.5);
    }

    function clampedCenter() {
      const real = view.toCanvas(snap.center);
      const Rf = G.SELECT_R * s; // clamp against the full-size ring so it doesn't drift while growing
      const ext = { up: Rf + TH.rimGap + TH.rimW, down: Rf + 30, left: Rf + 8, right: Rf + 8 };
      for (const it of items) {
        const { w, h } = labelBox(it);
        const e = Rf + TH.labelGap + (it.direction === "up" || it.direction === "down" ? h : w);
        ext[it.direction] = Math.max(ext[it.direction], e + (it.direction === "down" ? 30 : 0));
      }
      const p = TH.edgePad;
      const fit = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
      return {
        x: fit(real.x, b.x0 + ext.left + p, b.x1 - ext.right - p),
        y: fit(real.y, b.y0 + ext.up + p, b.y1 - ext.down - p),
      };
    }

    function drawCountdown(item, t) {
      if (!item) return;
      const col = hexToRgb(item.color);
      const rc = TH.countdownR * s;
      const hp = view.toCanvas(snap.handPos || snap.center);
      const m = rc + 8;
      const hx = Math.max(b.x0 + m, Math.min(b.x1 - m, hp.x));
      const hy = Math.max(b.y0 + m, Math.min(b.y1 - m - 30, hp.y));
      let u, alpha, r;
      if (mode === "done") {
        const d = clamp01((now - snap.closedAt) / 160);
        u = 1;
        alpha = 1 - d;
        r = rc * (1 + 0.15 * easeOut(d));
      } else {
        const tc = t - T.FLASH_MS;
        if (tc < -60) return; // countdown fades in at the tail of the flash
        u = clamp01(tc / T.COUNTDOWN_MS);
        alpha = clamp01((tc + 60) / 100);
        r = rc * (1 + 0.6 * (1 - easeOut(u)));
      }
      // track
      g.beginPath();
      g.arc(hx, hy, r, 0, Math.PI * 2);
      g.lineWidth = TH.countdownW + 2;
      g.strokeStyle = rgba(TH.shadow, 0.3 * alpha);
      g.stroke();
      g.lineWidth = TH.countdownW;
      g.strokeStyle = rgba(TH.ink, 0.22 * alpha);
      g.stroke();
      // closing arc
      if (u > 0.001) {
        g.save();
        g.shadowColor = rgba(col, 0.6 * alpha);
        g.shadowBlur = mode === "done" ? 18 : 8;
        g.beginPath();
        g.arc(hx, hy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * u);
        g.lineWidth = TH.countdownW;
        g.strokeStyle = rgba(col, alpha);
        g.stroke();
        g.restore();
      }
      // hand: hollow circle
      g.beginPath();
      g.arc(hx, hy, TH.fistR, 0, Math.PI * 2);
      g.lineWidth = 3.5;
      g.strokeStyle = rgba(TH.shadow, 0.4 * alpha);
      g.stroke();
      g.lineWidth = 2;
      g.strokeStyle = rgba(TH.ink, 0.95 * alpha);
      g.stroke();
      // mode name under the ring
      g.font = `650 ${TH.labelPx}px ${TH.font}`;
      g.textAlign = "center";
      g.textBaseline = "top";
      const ty = hy + rc * 1.6 + 8;
      g.lineWidth = 3;
      g.strokeStyle = rgba(TH.shadow, 0.55 * alpha);
      g.strokeText(item.label, hx, ty);
      g.fillStyle = rgba(TH.ink, alpha);
      g.fillText(item.label, hx, ty);
    }
  };
}
