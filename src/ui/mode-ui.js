// Modes UI entry (docs/ui-integration.md). The ONE thing main.js calls:
//
//   const modeUI = mountModeUI({ bus, ctx, registry, router, canvas: canvasEl });   // once, after the router
//   modeUI.draw(g);                                                                // each frame, after router.draw(g)
//
// Everything here augments the existing UI (index.html + indicators.js + controls.js): it adds
// `body.gs-modes` + modes.css, new DOM nodes, and canvas layers drawn on top of the modes. State comes
// from bus signals (subscribe), never from mode internals. Missing signals degrade gracefully:
//   mode, menu (fallback: router.menu.snapshot()), volume, left|right/{pos,height,pinch,size},
//   filter (fallback: right/tilt), arp/gate, arp/double, arp/rate, bpm, beat (event + playTime),
//   chord, voicing, held (optional {right?:bool, [param]: heldValue}), lead/noteset.
// Publishes: ui/override (state: names of screen controls currently winning over the hand).

import "./modes.css";
import { MODE_COLORS, clearArea, rectsOverlap } from "./theme.js";
import { createEdgeTracks } from "./edge-tracks.js";
import { createHandOverlays } from "./hand-overlays.js";
import { createBadges } from "./badges.js";
import { createReadouts } from "./readouts.js";
import { createControlsPanel } from "./controls-panel.js";
import { createTransport } from "./transport.js";
import { createGuide } from "./guide.js";

/** What the right edge track / 8-bar meter show when a mode does not say (`mode.rightTrack`). */
export const DEFAULT_RIGHT_TRACK = {
  chords: { param: "volume", label: "Volume" },
  arp: { param: "arp/gate", label: "Gate" },
};

const LOST_GRACE_MS = 250; // a hand must be gone this long before it shows as lost

function newHand() {
  return { pos: null, height: null, size: null, pinch: false, tilt: null, seen: false, lastPos: null, goneAt: null };
}

/**
 * @param {{bus:object, ctx:object, registry:object, router?:object, canvas:HTMLCanvasElement, doc?:Document}} o
 * @returns {{draw(g:CanvasRenderingContext2D):void, destroy():void, state:object,
 *            setOutputRow(render:(container:HTMLElement)=>(()=>void)|void):void, openControls():void}}
 */
export function mountModeUI({ bus, ctx, registry, router = null, canvas, doc = document }) {
  const body = doc.body;
  body.classList.add("gs-modes");

  /** Shared, read-only for the sub-modules (they get it as `S`). */
  const S = {
    modeId: null,
    name: "",
    mode: null,
    color: MODE_COLORS.chords,
    rightTrack: DEFAULT_RIGHT_TRACK.chords,
    menu: { state: "closed", targetId: null },
    hands: { left: newHand(), right: newHand() },
    chordSide: "left",
    chordSideKnown: false,
    rightHeld: false,
    rightReturn: false,
    heldValue: null,
    filter: null,
    tracks: {},
    panelOpen: false,
    guideOpen: false,
    /** Rects (CSS px) of user-opened panels (guide, controls): hand feedback under them is not drawn. */
    covers: [],
    covered(r) {
      return this.covers.some((c) => rectsOverlap(r, c));
    },
    now: 0,
    /** name -> {value, hand:"left"|"right", ref:number|null} (screen control wins until the hand moves). */
    overrides: new Map(),
    lost(side) {
      const h = this.hands[side];
      return !h.pos && h.seen && h.goneAt != null && this.now - h.goneAt > LOST_GRACE_MS;
    },
  };

  const listeners = new Set(); // sub-module onSignal(name, v) hooks
  const onSignal = (name, v) => listeners.forEach((fn) => fn(name, v));

  function applyMode(id) {
    if (!id) return;
    const mode = registry?.getMode?.(id) || null;
    S.modeId = id;
    S.mode = mode;
    S.name = mode?.name || id[0].toUpperCase() + id.slice(1);
    S.color = MODE_COLORS[id] || mode?.color || MODE_COLORS.chords;
    S.rightTrack = mode && "rightTrack" in mode ? mode.rightTrack : DEFAULT_RIGHT_TRACK[id] || null;
    body.dataset.mode = id;
    if (MODE_COLORS[id]) body.style.removeProperty("--gs-mode");
    else body.style.setProperty("--gs-mode", S.color);
    body.classList.toggle("gs-no-right-track", !S.rightTrack);
  }

  function setHand(side, field, v) {
    const h = S.hands[side];
    if (field === "pos") {
      if (v) {
        h.pos = v;
        h.lastPos = v;
        h.seen = true;
        h.goneAt = null;
      } else if (h.pos) {
        h.pos = null;
        h.goneAt = performance.now();
      }
      updateChordSide();
    } else h[field] = v;
  }

  // Master track sits on the edge where the chord ("Left") hand is displayed (D11), with hysteresis.
  function updateChordSide() {
    const L = S.hands.left.pos;
    const R = S.hands.right.pos;
    const x = L ? L.x : R ? 1 - R.x : null;
    if (x == null) return;
    if (!S.chordSideKnown) {
      S.chordSide = x < 0.5 ? "left" : "right";
      S.chordSideKnown = true;
    } else if (S.chordSide === "left" && x > 0.6) S.chordSide = "right";
    else if (S.chordSide === "right" && x < 0.4) S.chordSide = "left";
  }

  const HAND_SIGNALS = {
    "left/pos": ["left", "pos"], "right/pos": ["right", "pos"],
    "left/height": ["left", "height"], "right/height": ["right", "height"],
    "left/size": ["left", "size"], "right/size": ["right", "size"],
    "right/pinch": ["right", "pinch"], "right/tilt": ["right", "tilt"],
  };

  const unsubBus = bus.subscribe(
    {
      onSet(name, v) {
        if (name === "mode") applyMode(v);
        else if (HAND_SIGNALS[name]) setHand(...HAND_SIGNALS[name], v);
        onSignal(name, v);
      },
      onEvent(name, data, playTime) {
        listeners.forEach((fn) => fn(name, data, playTime));
      },
    },
    (name) => name !== "note/on" && name !== "note/off" && name !== "note/cancel"
  );

  // Initial values (signals published before we subscribed).
  applyMode(bus.get("mode") || router?.modeId || "chords");
  for (const [name, [side, field]] of Object.entries(HAND_SIGNALS)) {
    const v = bus.get(name);
    if (v != null) setHand(side, field, v);
  }

  bus.declare("ui/override", { type: "state", owner: "ui" });

  const env = { S, bus, ctx, registry, router, doc, canvas, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
  const badges = createBadges(env);
  const readouts = createReadouts(env);
  const guide = createGuide(env);
  const panel = createControlsPanel({ ...env, guide });
  badges.onClick(() => panel.open());
  const transport = createTransport(env);
  const tracks = createEdgeTracks(env);
  const overlays = createHandOverlays(env);
  const parts = [badges, readouts, guide, panel, transport, tracks, overlays];

  function readMenu() {
    const m = bus.get("menu");
    if (m && typeof m === "object" && typeof m.state === "string") {
      return { state: m.state, targetId: m.confirmed ?? m.confirmedId ?? m.selectedId ?? null };
    }
    const snap = router?.menu?.snapshot?.();
    if (snap && snap.phase) {
      const state = snap.phase === "idle" ? "closed" : snap.phase === "open" ? "open" : "countdown";
      return { state, targetId: snap.confirmedId ?? snap.selectedId ?? null };
    }
    return { state: "closed", targetId: null };
  }

  function heldBySignal() {
    const h = bus.get("held");
    if (!h || typeof h !== "object") return null;
    const p = S.rightTrack?.param;
    if (h.right === true) return { value: p && typeof h[p] === "number" ? h[p] : null };
    if (p && h[p] != null && h[p] !== false) return { value: typeof h[p] === "number" ? h[p] : null };
    return null;
  }

  // One frame of non-drawing work (also runs while the start overlay dims the canvas).
  function tick() {
    S.now = performance.now();
    S.menu = readMenu();
    const sig = heldBySignal();
    S.heldValue = sig?.value ?? null;
    // Held = the hand does not drive the right-hand control right now (menu / countdown / Arp pinch).
    // Return = the engine still holds its value after that (`held` signal) until the hand gets there.
    S.rightHeld = S.menu.state !== "closed" || (S.modeId === "arp" && !!S.hands.right.pinch && !!S.hands.right.pos);
    S.rightReturn = !!sig && !S.rightHeld;
    S.guideOpen = guide.isOpen();
    S.panelOpen = panel.isOpen();
    S.covers.length = 0;
    for (const el of [S.guideOpen && doc.getElementById("gestureGuide"), S.panelOpen && doc.getElementById("controlsPanel")]) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      S.covers.push({ x: r.x - c.x, y: r.y - c.y, w: r.width, h: r.height });
    }
    body.classList.toggle("gs-right-held", S.rightHeld || S.rightReturn || S.lost("right"));
    for (const p of parts) p.update?.();
  }

  const regions = [];
  const reg = (name, kind, rect) => (rect && regions.push({ name, kind, rect }), rect);

  function draw(g) {
    tick();
    regions.length = 0;
    const W = canvas.clientWidth || canvas.width;
    const H = canvas.clientHeight || canvas.height;
    if (!canvas.classList.contains("dimmed")) {
      // Canvas may be backed at a different resolution than CSS px: draw in CSS px.
      const sx = canvas.width / W;
      const sy = canvas.height / H;
      const portrait = H > W;
      const G = {
        W, H, portrait, reg,
        hs: handSpan(W, H, portrait),
        toPx: (p) => ({ x: p.x * W, y: p.y * H }),
      };
      g.save();
      g.setTransform(sx, 0, 0, sy, 0, 0);
      // Z-order (§5): edge tracks, hand feedback, first-use labels. The menu/mode draw is underneath.
      tracks.draw(g, G);
      overlays.draw(g, G);
      guide.draw(g, G);
      g.restore();
    }
    if (import.meta.env?.DEV && window.__gsTest) {
      window.__gsTest.ui = {
        regions: regions.slice(),
        clearArea: clearArea(W, H),
        chordSide: S.chordSide,
        rightHeld: S.rightHeld,
        menu: S.menu,
        firstUse: guide.firstUseVisible(),
        overrides: [...S.overrides.keys()],
        tracks: S.tracks,
        panel,
      };
    }
  }

  // Hand span (wrist -> fingertips) in px. Uses the published hand size when there is one.
  function handSpan(W, H, portrait) {
    const size = S.hands.right.size || S.hands.left.size;
    if (typeof size === "number" && size > 0) return Math.max(50, Math.min(260, size * W * 1.9));
    return portrait ? W * 0.24 : H * 0.14;
  }

  return {
    draw,
    state: S,
    openControls: () => panel.open(),
    setOutputRow: (render) => panel.setOutputRow(render),
    destroy() {
      unsubBus();
      for (const p of parts) p.destroy?.();
      body.classList.remove("gs-modes", "gs-right-held", "gs-no-right-track");
      delete body.dataset.mode;
    },
  };
}

