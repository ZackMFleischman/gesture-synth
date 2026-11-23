// Lead mode: the left hand holds a chord as a soft pad; the right hand plays one melody line on top.
//   right height  -> note (snapped, hysteresis)       pinch -> play (glide while moving, retrigger on re-pinch)
//   right fingers -> note set 1-4 (held 0.3 s)        tilt  -> shared filter
//   pinch held 0.3 s on an octave arrow (pinch must start on it) -> octave +/-1
//   thumb: no function (the pinch uses it)
// Screen controls (2.1): mouse on the ladder, keyboard, note-set + octave buttons.
//
// Publishes: lead/noteset, lead/octave (state); chord (state, the pad chord); filter (continuous);
// note/on + note/off with voice "lead" (and "pad" for the pad notes).

import {
  createLeadController,
  validCount,
  midiToFreq,
  noteName,
  NOTE_SETS,
  OCTAVE_MIN,
  OCTAVE_MAX,
} from "./lead-notes.js";
import { createLeadVoice } from "./lead-voice.js";
import { MODE_COLORS, COLORS, FONT as THEME_FONT, MOTION, withAlpha, easeOut } from "../ui/theme.js";

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
const LOOK = {
  edgeInset: 8, // ladder lines end this far from the right edge
  lineThin: 40, // scale-note line length
  lineChord: 56, // chord-note line length
  widthThin: 1.5,
  widthChord: 4,
  topPx: 196, // top note line (below the filter readout; up arrow reachable without the hand leaving the frame)
  bottomInset: 140, // bottom note line = H - this (palm must still reach the down arrow above the frame edge)
  arrowGap: 28, // arrow centre beyond the end lines
  arrowSize: 18,
  cursorR: 12,
  nameSize: 28,
  badge: { x: 200, y: 25 }, // top-left status row, right of the mode badge slot
  lineMoveMs: MOTION.base, // chord-note lines move to the new chord (150 ms)
  slideMs: MOTION.slow, // ladder slide on an octave change (200 ms)
  flashMs: MOTION.base, // confirm flash
  badgeLingerMs: 500, // at-hand badge after a confirmed set change
  dimDuringHold: 0.4,
};

const MENU_HELD_MS = 150;

const STEP_KEYS = ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote",
  "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight"];


/** Ladder geometry in canvas px. */
export function ladderGeometry(W, H) {
  const right = W - LOOK.edgeInset;
  const top = Math.min(LOOK.topPx, Math.round(H * 0.24));
  const bottom = Math.max(top + 120, H - LOOK.bottomInset);
  const cx = right - LOOK.lineChord / 2;
  return { W, H, right, top, bottom, cx, upY: top - LOOK.arrowGap, downY: bottom + LOOK.arrowGap };
}
const uToY = (geo, u) => geo.bottom - u * (geo.bottom - geo.top);
const yToU = (geo, y) => (geo.bottom - y) / (geo.bottom - geo.top);

// ---- Mode state (module singleton, like chords.js) ----
const ctrl = createLeadController();
const S = ctrl.state;
let voice = null;
let filterParam = null;
let masterApplied = null;
const DRONE_FADE_TAU = 0.08;
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
const view = {
  lastUpdateAt: -Infinity, // the router skips update() while the radial menu holds the right hand
  domBadge: false, // a DOM #noteSetBadge exists (src/ui/badges.js): skip the canvas status badge
  hand: null, // {x,y} canvas px of the right palm (null = none / screen control)
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
};

function ensureParams(ctx) {
  if (filterParam) return;
  filterParam = ctx.param("filter", {
    type: "continuous",
    min: -1,
    max: 1,
    onChange: (tilt) => ctx.audio.setFilter(tilt),
  });
}

/**
 * Hand-off from Chords without a gap: the Chords drone oscillators (wired straight into ctx.audio.out) are
 * re-routed through a local fade gain and faded out under the pad, then stopped. audio.js has no per-voice
 * gain for the drone yet (proposed change: a chord-voice gain node + synth.releaseChord(fadeS)).
 */
function handoffDrone(ctx) {
  const synth = ctx.audio.synth;
  const ac = ctx.audio.ac;
  if (!synth || !ac || !synth.oscillators || !synth.oscillators.length) return;
  const oscs = synth.oscillators;
  if (typeof synth._emitOff === "function") synth._emitOff(oscs);
  synth.oscillators = [];
  synth.currentKey = null; // Chords re-creates its drone when it becomes active again
  const t = ac.currentTime;
  const fade = ac.createGain();
  fade.gain.setValueAtTime(1, t);
  fade.gain.setTargetAtTime(0, t, DRONE_FADE_TAU);
  fade.connect(ctx.audio.out);
  for (const o of oscs) {
    try { o.disconnect(); } catch {}
    o.connect(fade);
    o.stop(t + DRONE_FADE_TAU * 8);
  }
  oscs[0].onended = () => { try { fade.disconnect(); } catch {} };
  masterApplied = null; // re-apply master (cancels Chords' exit ramp to 0)
}

/** Master volume = ctx.masterVolume (1 until milestone 1.3 provides it). */
function applyMaster(ctx) {
  const ac = ctx.audio.ac;
  const master = ctx.audio.master;
  if (!ac || !master) return;
  handoffDrone(ctx);
  const target = Math.max(0, Math.min(1, ctx.masterVolume ?? 1));
  if (masterApplied !== null && Math.abs(target - masterApplied) < 0.002) return;
  const t = ac.currentTime;
  const g = master.gain;
  if (typeof g.cancelAndHoldAtTime === "function") g.cancelAndHoldAtTime(t);
  else { const v = g.value; g.cancelScheduledValues(t); g.setValueAtTime(v, t); }
  g.setTargetAtTime(target, t, 0.05);
  masterApplied = target;
}

function updatePad(ctx) {
  const chord = ctx.harmony.chord;
  const live = !!ctx.audio.ac;
  if (chord === padChord && padApplied === live) return;
  padChord = chord;
  padApplied = live;
  if (!live) return;
  voice.setPad(chord ? ctx.harmony.notes(chord.roman, chord.isMajor, 1) : null);
}

function handleEvents(evs, ctx) {
  for (const ev of evs) {
    switch (ev.type) {
      case "noteOn": voice.noteOn(midiToFreq(ev.midi), { midi: ev.midi }); break;
      case "glide": voice.glideTo(midiToFreq(ev.midi), { midi: ev.midi }); break;
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
function drawArrow(g, cx, cy, dir, { lit, grey, progress, flash = 0 }) {
  const big = (lit || progress > 0) && !grey ? 1.25 : 1;
  const s = LOOK.arrowSize * big;
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
  ],

  enter(ctx) {
    view.domBadge = typeof document !== "undefined" && !!document.getElementById("noteSetBadge");
    ensureParams(ctx);
    if (!voice) voice = createLeadVoice(ctx.audio, { bus: ctx.bus });
    masterApplied = null;
    padChord = undefined;
    padApplied = false;
    ctx.bus.set("lead/noteset", S.setId);
    ctx.bus.set("lead/octave", S.octave);
    ctx.bus.set("voicing", 0); // the quality display has no meaning here
  },

  exit() {
    ctrl.release();
    if (voice) voice.stop();
    padChord = undefined;
    padApplied = false;
  },

  update(right, ctx) {
    const now = ctx.now;
    view.now = now;
    view.lastUpdateAt = now;
    if (!voice) lead.enter(ctx);
    applyMaster(ctx);
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
      view.hand = null;
    } else if (right) {
      const p = ctx.toCanvas(right.pos);
      view.hand = p;
      view.handSize = right.handSize * geo.H;
      input = { present: true, u: yToU(geo, p.y), pinch: right.pinch, count: validCount(right), noteIdx: null };
      if (filterParam) filterParam.value = right.tilt;
    } else {
      input = null;
    }

    handleEvents(ctrl.step(input, now), ctx);
    // Keyboard notes drive the cursor; once released the cursor stays there for the arrow keys.
    if (useVirtual && input.noteIdx != null) virt.keyIdx = input.noteIdx;
    captureLadderChange(now);
    if (S.preview != null) view.lastPreviewMidi = S.ladder.notes[S.preview].midi;

    ctx.bus.set("chord", ctx.harmony.chord);
  },

  draw(g, ctx) {
    const now = ctx ? ctx.now : view.now;
    const W = g.canvas.width;
    const H = g.canvas.height;
    const geo = (lastGeo = ladderGeometry(W, H));
    captureLadderChange(now);
    const lines = currentLines(now);
    const span = geo.bottom - geo.top;
    // Held: the radial menu has the right hand (update() not called). Ladder dims, nothing sounds.
    const menuHeld = now - view.lastUpdateAt > MENU_HELD_MS;
    if (menuHeld && S.pinchMode !== "none") {
      ctrl.release();
      if (voice) voice.noteOff();
    }
    const holding = !menuHeld && S.setHoldTarget != null && S.setHoldProgress > 0;
    const lostNow = !S.present && S.lostSince != null;
    const ladderAlpha = holding || lostNow || menuHeld ? LOOK.dimDuringHold : 1;

    g.save();
    // ---- Soft dark backing so the ladder reads over bright video ----
    {
      const x0 = geo.right - LOOK.lineChord - 8;
      const grad = g.createLinearGradient(x0, 0, W, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.35, "rgba(0,0,0,0.22)");
      grad.addColorStop(1, "rgba(0,0,0,0.3)");
      roundRect(g, x0, geo.top - 16, W - x0, span + 32, 10);
      g.fillStyle = grad;
      g.fill();
    }

    // ---- Ladder lines (clipped to the ladder band during slides) ----
    g.save();
    g.beginPath();
    g.rect(geo.right - LOOK.lineChord - 10, geo.top - 14, LOOK.lineChord + 20, span + 28);
    g.clip();
    g.lineCap = "round";
    // thin first, chord lines on top
    for (const pass of [false, true]) {
      for (const l of lines) {
        if (l.isChord !== pass) continue;
        const y = uToY(geo, l.u);
        const len = l.isChord ? LOOK.lineChord : LOOK.lineThin;
        g.globalAlpha = ladderAlpha * l.alpha;
        g.beginPath();
        g.moveTo(geo.right - len, y);
        g.lineTo(geo.right, y);
        strokeHalo(g, l.isChord ? LEAD_COLOR : "rgba(243, 239, 231, 0.6)", l.isChord ? LOOK.widthChord : LOOK.widthThin);
      }
    }
    g.restore();
    g.globalAlpha = 1;

    // ---- Octave arrows + marks ----
    const hoverUp = S.hover === "up" && S.present;
    const hoverDown = S.hover === "down" && S.present;
    const octFlash = Math.max(0, 1 - (now - S.octaveChangedAt) / LOOK.flashMs);
    const upFlash = S.octaveDir > 0 ? octFlash : 0;
    const downFlash = S.octaveDir < 0 ? octFlash : 0;
    const upGrey = S.octave >= OCTAVE_MAX;
    const downGrey = S.octave <= OCTAVE_MIN;
    drawArrow(g, geo.cx, geo.upY, "up", {
      lit: hoverUp && !upGrey,
      grey: upGrey,
      progress: S.pinchMode === "arrow" && S.arrowDir > 0 ? S.arrowProgress : 0,
      flash: upFlash,
    });
    drawArrow(g, geo.cx, geo.downY, "down", {
      lit: hoverDown && !downGrey,
      grey: downGrey,
      progress: S.pinchMode === "arrow" && S.arrowDir < 0 ? S.arrowProgress : 0,
      flash: downFlash,
    });
    // Arrow label: the value in change (only while the cursor is on an arrow).
    if (hoverUp || hoverDown) {
      const up = hoverUp;
      const grey = up ? upGrey : downGrey;
      const label = grey ? (up ? "Top octave" : "Bottom octave") : up ? "Octave up" : "Octave down";
      plateLabel(g, label, geo.cx - LOOK.arrowSize * 1.35 - 30, up ? geo.upY : geo.downY, {
        size: 14, weight: 700, align: "right", color: grey ? "rgba(200,200,200,0.9)" : C.ink,
        stroke: grey ? null : withAlpha(LEAD_COLOR, 0.8),
      });
    }
    // Octave marks: 4 dots in a column left of the ladder's top end (lowest octave at the bottom), one lit.
    {
      const n = OCTAVE_MAX - OCTAVE_MIN + 1;
      const step = 11;
      const mx = geo.cx - LOOK.arrowSize * 1.35 - 10; // inner side of the up arrow
      const yTop = geo.upY - ((n - 1) * step) / 2;
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
    }

    // ---- Cursor + note name ----
    const lost = !S.present;
    let idx = S.pinchMode === "note" ? S.playIdx : S.preview;
    let cursorMidi = idx != null ? S.ladder.notes[idx]?.midi : null;
    if (cursorMidi == null && lost) cursorMidi = view.lastPreviewMidi;
    let cl = cursorMidi != null ? lines.find((l) => l.midi === cursorMidi && !l.old) : null;
    if (!cl && cursorMidi != null) {
      // The ladder is being rebuilt (chord/set change): never let the cursor blink out.
      const n = S.ladder.notes.find((x) => x.midi === cursorMidi);
      cl = { midi: cursorMidi, u: n ? n.u : (cursorMidi - S.ladder.low) / 24 };
    }
    const onArrow = !lost && S.hover && S.pinchMode !== "note";
    if (cl || onArrow) {
      const cy = onArrow ? (S.hover === "up" ? geo.upY : geo.downY) : uToY(geo, cl.u);
      const cx = geo.cx;
      const playing = S.pinchMode === "note" && !lost;
      const nameRight = geo.right - LOOK.lineChord - 12;
      // Dotted guide from the hand to the cursor (stops at the name plate).
      if (view.hand && !lost && !menuHeld && !onArrow && view.hand.x < nameRight - 90) {
        g.save();
        g.beginPath();
        g.moveTo(view.hand.x, view.hand.y);
        g.lineTo(onArrow ? geo.cx - LOOK.arrowSize - 40 : nameRight - 80, cy);
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
        const r = LOOK.cursorR;
        g.save();
        if (lost) {
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
        g.restore();
        if (!lost) {
          const name = S.ladder.notes[idx]?.name ?? "";
          plateLabel(g, name, nameRight, cy, {
            size: W < 600 ? 22 : LOOK.nameSize,
            weight: 700,
            align: "right",
            color: playing ? "#111" : C.ink,
            fill: playing ? LEAD_COLOR : C.plate,
            padX: 10,
            padY: 4,
          });
        }
      }
      if (lost) plateLabel(g, "Hand lost", nameRight, cy, { size: 13, weight: 700, color: C.warn, align: "right", stroke: withAlpha(C.warn, 0.7) });
    }

    // ---- Note-set badge (status, top left row; canvas fallback until the DOM #noteSetBadge exists) ----
    const setFlash = Math.max(0, 1 - (now - S.setChangedAt) / LOOK.flashMs);
    if (!view.domBadge) {
      const bx = LOOK.badge.x;
      const by = LOOK.badge.y;
      const label = NOTE_SETS[S.setId].name;
      g.font = `600 12px ${FONT}`;
      const tw = g.measureText(label).width;
      const segW = 4 * 7 + 3 * 3;
      const w = 10 + segW + 8 + tw + 12;
      roundRect(g, bx, by - 14, w, 28, 14);
      g.fillStyle = C.plate;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = withAlpha(LEAD_COLOR, 0.8);
      g.stroke();
      drawSetSegments(g, bx + 10, by + 9, { active: S.setId, flash: setFlash, scale: 7 / 6, hScale: 1.05 });
      g.fillStyle = C.ink;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillText(label, bx + 10 + segW + 8, by + 1);
    }

    // ---- At-hand note-set badge (hand only): approach fill, selected rim + flash, then fade ----
    const since = now - S.setChangedAt;
    if (view.hand && !lost && !menuHeld && (holding || since < LOOK.badgeLingerMs)) {
      const alpha = holding ? 1 : 1 - easeOut(Math.max(0, since - LOOK.flashMs) / (LOOK.badgeLingerMs - LOOK.flashMs));
      const target = holding ? S.setHoldTarget : null;
      const label = NOTE_SETS[holding ? S.setHoldTarget : S.setId].name;
      const sc = 2.2;
      const segW = (4 * 6 + 3 * 3) * sc;
      g.save();
      g.globalAlpha = alpha;
      g.font = `700 15px ${FONT}`;
      const tw = g.measureText(label).width;
      const bw = Math.max(segW, tw) + 28;
      const bh = 92;
      // Beside the hand on the inner side, so the fingers doing the count stay visible.
      const hs = Math.max(50, view.handSize || 90);
      const ax = Math.max(bw / 2 + 8, view.hand.x - hs * 0.6 - bw / 2);
      const ay = Math.min(H - bh / 2 - 8, Math.max(bh / 2 + 8, view.hand.y - hs * 0.2));
      const confirmed = !holding;
      roundRect(g, ax - bw / 2, ay - bh / 2, bw, bh, 12);
      g.fillStyle = C.plate;
      g.fill();
      g.lineWidth = confirmed ? 3 : 1.5;
      g.strokeStyle = setFlash > 0 ? "#fff" : confirmed ? LEAD_COLOR : withAlpha(LEAD_COLOR, 0.55);
      g.stroke();
      drawSetSegments(g, ax - segW / 2, ay + 8, { active: S.setId, scale: sc, target, progress: S.setHoldProgress, flash: setFlash });
      g.fillStyle = confirmed ? LEAD_COLOR : C.ink;
      g.font = `${confirmed ? 800 : 600} 15px ${FONT}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(label, ax, ay + 24);
      // Hold progress along the bottom edge (grows with the hold time).
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
    }
    g.restore();
  },

  controls(container, ctx) {
    const doc = container.ownerDocument || document;
    const win = doc.defaultView || window;
    const root = doc.createElement("div");
    root.className = "lead-controls";
    root.innerHTML = `
      <style>
        .lead-controls { position:absolute; right:150px; bottom:14px; z-index:5; display:flex; gap:10px; align-items:center;
          font:12px monospace; color:#f3efe7; background:rgba(20,20,20,0.78); border:1px solid rgba(192,140,255,0.45);
          border-radius:8px; padding:6px 10px; user-select:none; }
        .lead-controls .grp { display:flex; gap:3px; align-items:center; }
        .lead-controls .lbl { color:rgba(243,239,231,0.6); margin-right:4px; }
        .lead-controls button { font:12px monospace; color:#f3efe7; background:#1a1a1a; border:1px solid #444;
          border-radius:4px; padding:3px 7px; cursor:pointer; min-width:26px; }
        .lead-controls button[aria-pressed="true"] { background:${LEAD_COLOR}; color:#111; border-color:${LEAD_COLOR}; }
        .lead-controls button:disabled { opacity:0.35; cursor:default; }
        .lead-controls .oct { min-width:28px; text-align:center; }
        @media (max-width: 700px) { .lead-controls { right:auto; left:12px; bottom:auto; top:128px; gap:6px; padding:5px 6px; }
          .lead-controls .lbl { display:none; } .lead-controls button { padding:3px 5px; min-width:22px; } }
        .lead-pad { position:absolute; top:0; right:0; bottom:0; width:170px; z-index:3; cursor:crosshair; touch-action:none; }
      </style>
      <div class="grp" role="group" aria-label="Note set"><span class="lbl">Notes</span>
        ${[1, 2, 3, 4].map((n) => `<button data-set="${n}" title="${NOTE_SETS[n].name} (key ${n})">${n}</button>`).join("")}
      </div>
      <div class="grp" role="group" aria-label="Octave"><span class="lbl">Octave</span>
        <button data-oct="-1" title="Octave down (-)">−</button><span class="oct"></span><button data-oct="1" title="Octave up (=)">+</button>
      </div>`;
    const pad = doc.createElement("div");
    pad.className = "lead-pad";
    pad.title = "Lead: hover to preview, press to play";
    container.appendChild(root);
    container.appendChild(pad);

    const setBtns = [...root.querySelectorAll("[data-set]")];
    const octLbl = root.querySelector(".oct");
    const [octDown, octUp] = root.querySelectorAll("[data-oct]");
    function refresh() {
      for (const b of setBtns) b.setAttribute("aria-pressed", String(Number(b.dataset.set) === S.setId));
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
      const r = (ctx.canvas || doc.getElementById("overlay") || pad).getBoundingClientRect();
      return (e.clientY - r.top) / Math.max(1, r.height);
    };
    pad.addEventListener("pointerenter", (e) => { virt.inside = true; virt.y = yOf(e); virt.keyIdx = null; touchVirtual(); });
    pad.addEventListener("pointermove", (e) => { virt.y = yOf(e); virt.keyIdx = null; touchVirtual(); });
    pad.addEventListener("pointerleave", () => { virt.inside = false; });
    pad.addEventListener("pointerdown", (e) => {
      virt.y = yOf(e);
      virt.down = true;
      virt.keyIdx = null;
      touchVirtual();
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
      Object.assign(virt, { inside: false, down: false, keys: [], space: false, keyIdx: null, touched: false, anchor: null });
    };
  },

  menuItems: [],
  /** The right edge shows the note ladder (drawn here), not a generic track. */
  rightTrack: null,
  /** Right-hand rows for the gesture guide. */
  guide: [
    ["🤏", "Pinch: play"],
    ["↕️", "Height: note"],
    ["☝️✌️", "Fingers: notes"],
    ["🔼", "Arrow: octave"],
    ["↔️", "Tilt: filter"],
  ],

  /** Test/debug hook: controller state + what draw() renders (canvas px). Not part of the mode contract. */
  _debug(now = view.now) {
    const geo = lastGeo;
    const lines = currentLines(now).filter((l) => !l.old);
    const idx = S.pinchMode === "note" ? S.playIdx : S.preview;
    const note = idx != null ? S.ladder.notes[idx] : null;
    return {
      geo,
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
    };
  },
  /** Ladder y (canvas px) -> display-normalized y, for tests placing the hand on a note. */
  _yForMidi(midi) {
    const geo = lastGeo;
    const n = S.ladder.notes.find((x) => x.midi === midi);
    return n ? uToY(geo, n.u) / geo.H : null;
  },
  _controller: ctrl,
};

export default lead;
