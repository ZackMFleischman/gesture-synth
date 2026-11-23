// Radial menu: canvas renderer. Reads a menu-state snapshot, keeps only cosmetic animation state.
// All colors / sizes live in MENU_THEME so integration can swap them for shared UI tokens.

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
  plateAlpha: 0.45, // dark plate under every arc so accent hues stay true over video
  outlineAlpha: 0.72,
  approachFill: 0.55,
  selectedFill: 0.72,
  dimAlpha: 0.35, // other arcs when one is selected
  labelDim: 0.5, // other labels' text when one is selected
  labelPx: 14,
  iconPx: 17,
  labelGap: 14, // ring outer edge (or rim) -> label pill
  labelQuiet: 0.66,
  hintPx: 12,
  markerR: 3, // current-mode dot, sits on the arc's outer edge
  entryR: 2.5,
  fistR: 6,
  countdownR: 0.33, // x handSize
  countdownW: 3,
  growFrom: 0.55, // ring scale at the start of the grow animation
  tauMs: 40, // easing time constant for highlight changes (~120 ms to settle)
  fillTauMs: 25,
  edgePad: 18,
  // sub-menus
  subMarkPx: 5, // chevron on the outer edge of an arc that opens a sub-ring
  breadcrumbK: 0.3, // parent ring scale once it has shrunk to the breadcrumb
  breadcrumbAlpha: 0.85,
  backPx: 11, // "Back" caption next to the breadcrumb
  settingDoneMs: 420, // value pill lingers (fading) after a setting confirm
});

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const rgba = (rgb, a) => `rgba(${rgb},${a})`;
const DEG = Math.PI / 180;
const vec = (deg) => [Math.cos(deg * DEG), Math.sin(deg * DEG)];

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
function drawIcon(g, icon, x, y, size, color, alpha = 1) {
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
    g.lineWidth = 3.4;
    g.strokeStyle = `rgba(0,0,0,${0.35 * alpha})`;
    g.stroke(p);
    g.lineWidth = 2.1;
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
  const anim = new Map(); // `${level}:${id}` -> { fill, sel, hov, dim, vis, lab, push }
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
    const isSettingConfirm = snap.confirmKind === "setting";

    // ---- Which visual phase are we in? -------------------------------------------------
    let ringAlpha = 1;
    let mode = phase; // "open" | "confirm" | "fade" | "done" | null
    if (phase === "idle") {
      const since = now - snap.closedAt;
      const doneMs = isSettingConfirm ? TH.settingDoneMs : 160;
      if (!snap.center || !(since >= 0)) mode = null;
      else if (snap.closeReason === "done") mode = since < doneMs ? "done" : null;
      else if (since < T.CANCEL_FADE_MS) mode = "fade";
      else mode = null;
      if (!mode) {
        anim.clear();
        return;
      }
    }
    // Grow animation of the active ring (main ring at open / after "back", sub-ring at sub-open).
    const growU = phase === "open" ? easeOut((now - Math.max(snap.openedAt, snap.levelAt ?? 0)) / T.GROW_MS) : 1;
    let ringScale = 1;
    if (mode === "fade") {
      const u = (now - snap.closedAt) / T.CANCEL_FADE_MS;
      ringAlpha = 1 - u;
      ringScale = 1 - 0.06 * u;
    } else if (phase === "open") {
      ringAlpha = growU * (snap.tracking ? 1 : 0.7);
      ringScale = TH.growFrom + (1 - TH.growFrom) * growU;
    }

    const s = snap.handSize * view.scale; // px per hand size
    const Rf = G.SELECT_R * s; // full-size outer radius
    const R = Rf * ringScale;
    const ri = G.INNER_R * s * ringScale;
    const labelStart0 = TH.rimGap + TH.rimW + TH.labelGap; // labels clear the selected rim
    const b = view.bounds;
    const items = snap.items;
    const level = snap.level || 0;
    const miniR = Rf * TH.breadcrumbK;

    g.save();
    g.lineCap = "round";
    g.lineJoin = "round";

    // ---- Countdown / done: drawn at the hand ---------------------------------------------
    if (mode === "confirm" || mode === "done") {
      const item = snap.confirmedItem || items.find((i) => i.id === snap.confirmedId);
      const t = now - snap.confirmedAt;
      const ctr = clampedCenter();
      if (mode === "confirm" && t < T.FLASH_MS + 120) {
        if (level === 1 && snap.parent) drawBreadcrumb(ctr, 1, Math.max(0, 1 - t / T.FLASH_MS));
        drawRing(ctr, t);
      }
      if (isSettingConfirm) drawSettingDone(item, t);
      else drawCountdown(item, t);
      g.restore();
      return;
    }

    const ctr = clampedCenter();
    if (level === 1 && snap.parent) drawBreadcrumb(ctr, growU, 1);
    drawRing(ctr, null);
    g.restore();

    // ---- Geometry helpers ------------------------------------------------------------------
    function labelBox(it) {
      g.font = labelFont(true);
      const icon = it.icon ? TH.iconPx + 6 : 0;
      const w = g.measureText(it.label).width + icon + 22;
      const h = TH.labelPx + 12;
      return { w, h, icon };
    }

    /** Distance from a box center to its edge along the unit vector (vx, vy). */
    function boxExtent(w, h, vx, vy) {
      const ax = Math.abs(vx) > 1e-6 ? w / 2 / Math.abs(vx) : Infinity;
      const ay = Math.abs(vy) > 1e-6 ? h / 2 / Math.abs(vy) : Infinity;
      return Math.min(ax, ay);
    }

    /** Label pill center offset (from the ring center) for an item. */
    function labelOffset(it, radius, push = 0) {
      const { w, h } = labelBox(it);
      const [vx, vy] = vec(it.angle);
      const d = radius + labelStart0 + push + boxExtent(w, h, vx, vy);
      return { x: vx * d, y: vy * d, w, h };
    }

    /** Breadcrumb (shrunk parent ring) position, relative to the sub-ring center, at full size. */
    function breadcrumbOffset() {
      const [vx, vy] = vec(snap.back.angle);
      const d = Rf + TH.labelGap + miniR;
      return { x: vx * d, y: vy * d };
    }

    function clampedCenter() {
      const real = view.toCanvas(snap.center);
      const rim = Rf + TH.rimGap + TH.rimW;
      // extents from the center: left / right / up / down
      const ext = { l: rim, r: rim, u: rim, d: rim };
      for (const it of items) {
        const o = labelOffset(it, Rf);
        ext.l = Math.max(ext.l, -(o.x - o.w / 2));
        ext.r = Math.max(ext.r, o.x + o.w / 2);
        ext.u = Math.max(ext.u, -(o.y - o.h / 2));
        ext.d = Math.max(ext.d, o.y + o.h / 2);
      }
      if (level === 1 && snap.back) {
        const o = breadcrumbOffset();
        const m = miniR + 6;
        ext.l = Math.max(ext.l, -(o.x - m));
        ext.r = Math.max(ext.r, o.x + m + 48); // "Back" caption beside it
        ext.u = Math.max(ext.u, -(o.y - m));
        ext.d = Math.max(ext.d, o.y + m);
      }
      ext.d += 40; // hint under the ring
      const p = TH.edgePad;
      const fit = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
      return {
        x: fit(real.x, b.x0 + ext.l + p, b.x1 - ext.r - p),
        y: fit(real.y, b.y0 + ext.u + p, b.y1 - ext.d - p),
      };
    }

    // ---- Ring (open / fading / flashing) --------------------------------------------------
    function drawRing(ctr, confirmT) {
      const { x: cx, y: cy } = ctr;
      const offPx = { x: snap.offset.x * view.scale, y: snap.offset.y * view.scale };
      const fist = { x: cx + offPx.x, y: cy + offPx.y };
      const distPx = Math.hypot(offPx.x, offPx.y);
      const flashing = confirmT !== null;
      // After the flash the confirmed arc fades out while the countdown ring takes over.
      const postFlash = flashing ? clamp01((confirmT - T.FLASH_MS) / 120) : 0;
      const flash = flashing ? Math.sin(Math.PI * clamp01(confirmT / T.FLASH_MS)) : 0;
      const key = (id) => `${level}:${id}`;

      for (const it of items) {
        let a = anim.get(key(it.id));
        if (!a) anim.set(key(it.id), (a = { fill: 0, sel: 0, hov: 0, dim: 0, vis: 1, lab: TH.labelQuiet, push: 0 }));
        const isSel = it.id === snap.selectedId;
        const isHov = it.id === snap.hoverId;
        const fillT = isSel ? 1 : isHov ? clamp01((distPx / ringScale - G.INNER_R * s) / ((G.SELECT_R - G.INNER_R) * s)) : 0;
        const dimT = snap.selectedId && !isSel ? 1 : 0;
        const labT = isSel ? 1 : isHov ? TH.labelQuiet + (1 - TH.labelQuiet) * snap.progress : TH.labelQuiet;
        if (mode === "open" || flashing) {
          a.fill = step(a.fill, fillT, dt, TH.fillTauMs);
          a.sel = step(a.sel, isSel ? 1 : 0, dt, TH.tauMs);
          a.hov = step(a.hov, isHov || isSel ? 1 : 0, dt, TH.tauMs);
          a.dim = step(a.dim, dimT, dt, TH.tauMs);
          a.vis = flashing ? (isSel ? 1 : Math.min(a.vis, clamp01(1 - confirmT / 60))) : 1;
          a.lab = step(a.lab, labT, dt, TH.tauMs);
          // keep the label ahead of the fist so the fist never covers it
          const [ux, uy] = vec(it.angle);
          const along = offPx.x * ux + offPx.y * uy;
          const pushT = isHov || isSel ? Math.max(0, along + TH.fistR + 6 - (G.SELECT_R * s + labelStart0)) : 0;
          a.push = step(a.push, pushT, dt, TH.fillTauMs);
        }
      }

      // back sector (sub-ring only): neutral, no label (the breadcrumb beyond it is the label)
      if (level === 1 && snap.back && !flashing) drawBackArc(cx, cy, distPx);

      const ordered = [...items].sort((p, q) => (anim.get(key(p.id)).sel || 0) - (anim.get(key(q.id)).sel || 0));
      for (const it of ordered) {
        const a = anim.get(key(it.id));
        const col = hexToRgb(it.color);
        const span = (it.span - TH.arcGapDeg) * DEG;
        const mid = it.angle * DEG;
        const a0 = mid - span / 2;
        const a1 = mid + span / 2;
        const dimF = 1 - (1 - TH.dimAlpha) * a.dim;
        const base = ringAlpha * a.vis * (1 - postFlash);
        const alpha = base * dimF;
        if (base <= 0.002) continue;
        const isCur = it.id === snap.currentId;

        // plate
        sectorPath(g, cx, cy, ri, R, a0, a1, TH.cornerPx);
        g.fillStyle = rgba(TH.plate, TH.plateAlpha * alpha);
        g.fill();

        // approach / selected fill
        if (a.fill > 0.004) {
          const rf = ri + (R - ri) * a.fill;
          sectorPath(g, cx, cy, ri, rf, a0, a1, TH.cornerPx);
          const selFill = isCur ? TH.approachFill : TH.selectedFill; // "no change" stays quieter
          const fa = TH.approachFill + (selFill - TH.approachFill) * a.sel + 0.3 * flash;
          g.fillStyle = rgba(col, Math.min(0.95, fa) * alpha);
          g.fill();
        }

        // outline: dark halo, then thin line (neutral -> item color)
        sectorPath(g, cx, cy, ri, R, a0, a1, TH.cornerPx);
        const w = TH.outlineW + (TH.hoverW - TH.outlineW) * a.hov + (TH.selectedW - TH.hoverW) * a.sel;
        g.lineWidth = w + 2;
        g.strokeStyle = rgba(TH.shadow, 0.28 * alpha * (1 - 0.7 * a.sel));
        g.stroke();
        g.lineWidth = w;
        // selected: the rim carries the accent, so the arc's own outline steps back
        g.strokeStyle = a.hov > 0.5 ? rgba(col, alpha * (1 - 0.75 * a.sel)) : rgba(TH.ink, TH.outlineAlpha * alpha);
        g.stroke();

        // selected rim with a soft glow
        if (a.sel > 0.01) {
          const rr = R + TH.rimGap + TH.rimW / 2;
          g.save();
          const rimCol = isCur ? TH.ink : col; // selecting the current item = neutral rim, no glow
          g.shadowColor = rgba(rimCol, (isCur ? 0 : 0.7) * a.sel * alpha);
          g.shadowBlur = 10 + 10 * flash;
          g.beginPath();
          g.arc(cx, cy, rr, a0 + 2 / rr, a1 - 2 / rr);
          g.lineWidth = TH.rimW;
          g.strokeStyle = rgba(flash > 0.3 ? TH.ink : rimCol, (isCur ? 0.8 : 1) * a.sel * alpha);
          g.stroke();
          g.restore();
        }

        const [vx, vy] = vec(it.angle);
        // current-item marker: small dot on the arc's outer edge; an item still running under the current one
        // (`secondary`, e.g. the base mode under the Lead layer) gets a hollow ring instead
        if (isCur) {
          g.beginPath();
          g.arc(cx + vx * R, cy + vy * R, TH.markerR, 0, Math.PI * 2);
          g.lineWidth = 2;
          g.strokeStyle = rgba(TH.shadow, 0.55 * base);
          g.stroke();
          g.fillStyle = rgba(TH.ink, base * (1 - 0.4 * a.dim));
          g.fill();
        } else if (it.secondary) {
          g.beginPath();
          g.arc(cx + vx * R, cy + vy * R, TH.markerR + 0.5, 0, Math.PI * 2);
          g.lineWidth = 3.5;
          g.strokeStyle = rgba(TH.shadow, 0.5 * base);
          g.stroke();
          g.lineWidth = 1.5;
          g.strokeStyle = rgba(TH.ink, base * (1 - 0.4 * a.dim));
          g.stroke();
        }

        // sub-menu mark: outward chevron on the outer edge; it slides out while the fist passes through
        if (it.type === "submenu") {
          const pend = it.id === snap.selectedId ? snap.subPending || 0 : 0;
          const ca = base * (0.75 + 0.25 * Math.max(a.hov, pend));
          drawChevron(cx, cy, it.angle, R + TH.rimGap + TH.rimW + 5 + 6 * pend, ca, a.sel > 0.5 ? col : TH.ink);
        }

        // label outside the ring, in the direction of movement
        drawLabel(it, cx, cy, a, base, col);
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

      // hint under the ring (not while fading out)
      if (mode !== "open") return;
      const sel = items.find((i) => i.id === snap.selectedId);
      let hint = "Move to choose";
      if (level === 1 && snap.back) hint = `Move to choose · ${backWord(snap.back.angle)} = back`;
      if (!snap.tracking) hint = "Hand lost";
      else if (sel && sel.type === "submenu") hint = "Keep going to open";
      else if (sel) {
        if (sel.id === snap.currentId) hint = level === 1 ? "Already set" : "Already active";
        else hint = sel.confirmHint || (sel.type === "setting" ? "Open hand to set" : "Open hand to confirm");
      } else if (snap.hoverBack) hint = "Back";
      let low = Rf + 24;
      for (const it of items) {
        const o = labelOffset(it, Rf);
        low = Math.max(low, o.y + o.h / 2 + 24);
      }
      const hy = cy + low;
      g.font = `${sel ? 600 : 500} ${TH.hintPx}px ${TH.font}`;
      const hw = g.measureText(hint).width + 20;
      const hh = TH.hintPx + 10;
      roundRect(g, cx - hw / 2, hy - hh / 2, hw, hh, hh / 2);
      g.fillStyle = rgba(TH.plate, 0.5 * ringAlpha);
      g.fill();
      if (!snap.tracking) {
        g.lineWidth = 1;
        g.setLineDash([3, 3]);
        g.strokeStyle = TH.warn;
        g.stroke();
        g.setLineDash([]);
      }
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = !snap.tracking ? TH.warn : rgba(TH.ink, (sel ? 0.95 : 0.72) * ringAlpha);
      g.fillText(hint, cx, hy + 0.5);
    }

    function backWord(angle) {
      const a = ((angle % 360) + 360) % 360;
      if (a > 225 && a < 315) return "up";
      if (a > 45 && a < 135) return "down";
      return a >= 135 && a <= 225 ? "left" : "right";
    }

    /** The back sector: short neutral dashed arc, fills (ink) as the fist heads back toward the parent. */
    function drawBackArc(cx, cy, distPx) {
      const bk = snap.back;
      const span = (bk.span - TH.arcGapDeg) * DEG;
      const a0 = bk.angle * DEG - span / 2;
      const a1 = bk.angle * DEG + span / 2;
      const r1 = ri + (R - ri) * 0.55; // shorter than the item arcs: it is a way out, not a choice
      sectorPath(g, cx, cy, ri, r1, a0, a1, TH.cornerPx);
      g.fillStyle = rgba(TH.plate, TH.plateAlpha * 0.8 * ringAlpha);
      g.fill();
      if (snap.hoverBack) {
        const u = clamp01((distPx / ringScale - G.INNER_R * s) / ((G.BACK_R - G.INNER_R) * s));
        if (u > 0.01) {
          sectorPath(g, cx, cy, ri, ri + (r1 - ri) * u, a0, a1, TH.cornerPx);
          g.fillStyle = rgba(TH.ink, 0.35 * ringAlpha);
          g.fill();
        }
      }
      sectorPath(g, cx, cy, ri, r1, a0, a1, TH.cornerPx);
      g.save();
      g.setLineDash([3, 3]);
      g.lineWidth = 1.25;
      g.strokeStyle = rgba(TH.ink, (snap.hoverBack ? 0.85 : 0.5) * ringAlpha);
      g.stroke();
      g.restore();
    }

    /** Parent ring shrunk to a breadcrumb beyond the back sector. u: 0 = full size in place -> 1 = breadcrumb. */
    function drawBreadcrumb(ctr, u, alphaMul) {
      const par = snap.parent;
      if (!par || !snap.back) return;
      // start: where the parent ring sits relative to the sub-ring (fixed offset in canvas px)
      const pc = view.toCanvas(par.center);
      const sc = view.toCanvas(snap.center);
      const start = { x: ctr.x + (pc.x - sc.x), y: ctr.y + (pc.y - sc.y) };
      const bo = breadcrumbOffset();
      const end = { x: ctr.x + bo.x, y: ctr.y + bo.y };
      const k = 1 + (TH.breadcrumbK - 1) * u;
      const x = start.x + (end.x - start.x) * u;
      const y = start.y + (end.y - start.y) * u;
      const r1 = Rf * k;
      const r0 = G.INNER_R * s * k;
      const alpha = alphaMul * (1 - (1 - TH.breadcrumbAlpha) * u) * (snap.tracking ? 1 : 0.7);
      const gap = TH.arcGapDeg * (1 + u) * DEG;
      for (const it of par.items) {
        const span = it.span * DEG - gap;
        const a0 = it.angle * DEG - span / 2;
        const a1 = it.angle * DEG + span / 2;
        const isHost = it.id === par.hostId;
        sectorPath(g, x, y, r0, r1, a0, a1, Math.max(1, TH.cornerPx * k));
        g.fillStyle = isHost ? rgba(hexToRgb(it.color), 0.8 * alpha) : rgba(TH.plate, TH.plateAlpha * alpha);
        g.fill();
        g.lineWidth = 1;
        g.strokeStyle = isHost ? rgba(hexToRgb(it.color), alpha) : rgba(TH.ink, 0.45 * alpha);
        g.stroke();
      }
      if (u > 0.6) {
        const ta = alpha * clamp01((u - 0.6) / 0.4) * (snap.hoverBack ? 1 : 0.72);
        g.font = `${snap.hoverBack ? 650 : 500} ${TH.backPx}px ${TH.font}`;
        g.textBaseline = "middle";
        g.textAlign = "left";
        const tx = x + r1 + 7;
        const txt = "Back";
        const tw = g.measureText(txt).width;
        roundRect(g, tx - 5, y - 9, tw + 10, 18, 9);
        g.fillStyle = rgba(TH.plate, 0.5 * ta);
        g.fill();
        g.fillStyle = rgba(TH.ink, ta);
        g.fillText(txt, tx, y + 0.5);
      }
    }

    function drawChevron(cx, cy, angleDeg, dist, alpha, col) {
      const [vx, vy] = vec(angleDeg);
      const m = TH.subMarkPx;
      const rgb = col.startsWith("#") ? hexToRgb(col) : col;
      g.save();
      g.translate(cx + vx * dist, cy + vy * dist);
      g.rotate(angleDeg * DEG);
      g.beginPath();
      g.moveTo(-m * 0.5, -m);
      g.lineTo(m * 0.5, 0);
      g.lineTo(-m * 0.5, m);
      g.lineWidth = 3.5;
      g.strokeStyle = rgba(TH.shadow, 0.4 * alpha);
      g.stroke();
      g.lineWidth = 1.75;
      g.strokeStyle = rgba(rgb, alpha);
      g.stroke();
      g.restore();
    }

    /** Icon + label pill, centered at (x, y). */
    function drawPill(it, x, y, { textA, plateA, strokeCol, bold }) {
      const { w, h, icon } = labelBox(it);
      roundRect(g, x - w / 2, y - h / 2, w, h, h / 2);
      g.fillStyle = rgba(TH.plate, plateA);
      g.fill();
      if (strokeCol) {
        g.lineWidth = 1.25;
        g.strokeStyle = strokeCol;
        g.stroke();
      }
      const left = x - w / 2 + 11;
      if (icon) drawIcon(g, it.icon, left + TH.iconPx / 2, y, TH.iconPx, rgba(TH.ink, textA), textA);
      g.font = labelFont(bold);
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillStyle = rgba(TH.ink, textA);
      g.fillText(it.label, left + icon, y + 0.5);
    }

    function drawLabel(it, cx, cy, a, alpha, col) {
      const o = labelOffset(it, R, a.push);
      const isCur = it.id === snap.currentId;
      drawPill(it, cx + o.x, cy + o.y, {
        textA: a.lab * alpha * (1 - (1 - TH.labelDim) * a.dim),
        plateA: (0.5 + 0.15 * a.hov) * alpha,
        strokeCol: a.sel > 0.01 ? rgba(isCur ? TH.ink : col, a.sel * alpha * (isCur ? 0.6 : 1)) : null,
        bold: a.hov > 0.5 && a.lab > TH.labelQuiet + 0.05,
      });
    }

    function handAnchor(extraBelow) {
      const rc = TH.countdownR * s;
      const hp = view.toCanvas(snap.handPos || snap.center);
      const m = rc * 1.3 + 8;
      return {
        rc,
        x: Math.max(b.x0 + m, Math.min(b.x1 - m, hp.x)),
        y: Math.max(b.y0 + m, Math.min(b.y1 - m - extraBelow, hp.y)),
      };
    }

    /** Setting confirm: no countdown (the right hand's controls don't change), just the picked value at the hand. */
    function drawSettingDone(item, t) {
      if (!item) return;
      const col = hexToRgb(item.color);
      const { h } = labelBox(item);
      const { x, y } = handAnchor(h + 12);
      let alpha;
      let rise = 0;
      if (mode === "done") {
        const d = clamp01((now - snap.closedAt) / TH.settingDoneMs);
        alpha = 1 - d * d;
        rise = 4 * easeOut(d);
      } else alpha = clamp01((t - 40) / 80);
      if (alpha <= 0.002) return;
      drawPill(item, x, y + TH.fistR + 12 + h / 2 - rise, {
        textA: alpha,
        plateA: 0.6 * alpha,
        strokeCol: rgba(col, alpha),
        bold: true,
      });
    }

    function drawCountdown(item, t) {
      if (!item) return;
      const col = hexToRgb(item.color);
      const { rc, x: hx, y: hy } = handAnchor(TH.labelPx + 22);
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
        r = rc * (1 + 0.3 * (1 - easeOut(u)));
      }
      // single quiet track on a soft dark band, so it reads over any video
      g.beginPath();
      g.arc(hx, hy, r, 0, Math.PI * 2);
      g.lineWidth = TH.countdownW + 3;
      g.strokeStyle = rgba(TH.plate, 0.5 * alpha);
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
      // mode name under the ring, on the same pill as the arc labels
      const { h } = labelBox(item);
      drawPill(item, hx, hy + rc * 1.3 + 10 + h / 2, {
        textA: alpha,
        plateA: 0.6 * alpha,
        strokeCol: rgba(col, alpha),
        bold: true,
      });
    }
  };
}
