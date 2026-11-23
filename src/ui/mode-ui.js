// Modes UI entry (docs/ui-integration.md). The ONE thing main.js calls:
//
//   const modeUI = mountModeUI({ bus, ctx, registry, router, canvas: canvasEl });   // once, after the router
//   modeUI.draw(g);                                                                // each frame, after router.draw(g)
//
// The canvas layers are drawn on their own canvas (#modeOverlay, right above #overlay, cleared and
// redrawn every animation frame), so their translucent plates don't build up between camera frames
// (#overlay is only cleared when a new video frame arrives). `g` is accepted for the hook signature.
//
// Everything here augments the existing UI (index.html + indicators.js + controls.js): it adds
// `body.gs-modes` + modes.css, new DOM nodes, and canvas layers drawn on top of the modes. State comes
// from bus signals, never from mode internals: pushed (subscribe) for `mode`, `beat` (event + playTime),
// `filter`, `volume` and the active right-track param; read once per frame (bus.get) for the rest, so
// their producers stay free: left|right/{pos,height,size,pinch,tilt}, menu (fallback:
// router.menu.snapshot()), held ({right?:bool, [param]: heldValue}), bpm, arp/rate, arp/double,
// lead/noteset. Missing signals degrade gracefully.
// Publishes: ui/override (state: names of screen controls currently winning over the hand);
//   ui/sides (state: {chord, expr} = screen edge of the chord hand / of the right-hand control), so a mode
//   that draws its own edge control (Lead's ladder) can put it on the expression side.
//
// Hooks for other layouts (e.g. a compact phone layout): every new DOM node has a stable id and hides
// with the `gs-collapsed` class; canvas layers hide with body classes `gs-hide-edge-tracks`,
// `gs-hide-hand-feedback`, `gs-hide-first-use` (or hide #modeOverlay altogether).

import "./modes.css";
import { MODE_COLORS, clearArea, rectsOverlap } from "./theme.js";
import { createEdgeTracks } from "./edge-tracks.js";
import { createSafeArea } from "./mobile/safe-area.js";
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
const SIDE_LOCK_MS = 600; // the chord hand must stay on the other side this long before the tracks swap

function newHand() {
  return { pos: null, height: null, size: null, pinch: false, tilt: null, seen: false, lastPos: null, goneAt: null };
}

/**
 * @param {{bus:object, ctx:object, registry:object, router?:object, canvas:HTMLCanvasElement,
 *          output?:object, doc?:Document}} o   output = the M3 status chip handle (Output row on/off + code)
 * @returns {{draw(g:CanvasRenderingContext2D):void, destroy():void, state:object,
 *            setOutputRow(render:(container:HTMLElement)=>(()=>void)|void):void, openControls():void}}
 */
export function mountModeUI({ bus, ctx, registry, router = null, canvas, output = null, doc = document }) {
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
    sideCandidate: null,
    sideSince: 0,
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
    /** Is the hand at canvas point p (palm) under an open panel? */
    palmCovered(p, hs) {
      const k = hs * 0.3;
      return this.covered({ x: p.x - k, y: p.y - k, w: 2 * k, h: 2 * k });
    },
    now: 0,
    /** name -> {value, hand:"left"|"right", ref:number|null} (screen control wins until the hand moves). */
    overrides: new Map(),
    lost(side) {
      const h = this.hands[side];
      return !h.pos && h.seen && h.goneAt != null && this.now - h.goneAt > LOST_GRACE_MS;
    },
    /** Position to draw at: live, or the last one during the lost grace (tracking dropouts don't blink). */
    drawPos(side) {
      const h = this.hands[side];
      if (h.pos) return h.pos;
      return h.lastPos && h.goneAt != null && this.now - h.goneAt <= LOST_GRACE_MS ? h.lastPos : null;
    },
  };

  const listeners = new Set(); // sub-module hooks: fn(kind: "set"|"event", name, value, playTime)

  function applyMode(id) {
    if (!id) return;
    const mode = registry?.getMode?.(id) || null;
    if (id !== S.modeId) S.overrides.clear(); // a screen value never carries into another mode
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
      if (v === h.pos || (v == null && h.pos == null)) return;
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

  // Master track sits on the edge where the chord ("Left") hand is displayed (D11). Decided from both
  // hands (chord hand left of the mode hand -> left edge) and only after it held for SIDE_LOCK_MS, so a
  // hand reaching across the middle doesn't swap the tracks. One hand only: first guess, never a swap.
  function updateChordSide() {
    const L = S.hands.left.pos;
    const R = S.hands.right.pos;
    const both = !!(L && R);
    let side = null;
    if (both) side = L.x < R.x ? "left" : "right";
    else if (!S.chordSideKnown && (L || R)) side = (L ? L.x : 1 - R.x) < 0.5 ? "left" : "right";
    if (!side) return;
    if (!S.chordSideKnown) {
      S.chordSide = side; // immediate until both hands have been seen together
      S.chordSideKnown = both;
      return;
    }
    const now = performance.now();
    if (side === S.chordSide) {
      S.sideCandidate = null;
      return;
    }
    if (S.sideCandidate !== side) {
      S.sideCandidate = side;
      S.sideSince = now;
    } else if (now - S.sideSince >= SIDE_LOCK_MS) {
      S.chordSide = side;
      S.sideCandidate = null;
    }
  }

  const HAND_SIGNALS = {
    "left/pos": ["left", "pos"], "right/pos": ["right", "pos"],
    "left/height": ["left", "height"], "right/height": ["right", "height"],
    "left/size": ["left", "size"], "right/size": ["right", "size"],
    "right/pinch": ["right", "pinch"], "right/tilt": ["right", "tilt"], "right/top": ["right", "top"],
  };

  // Subscribe only to what needs a push (mode changes, beat events); everything else is read with
  // bus.get() once per frame, so producers of hand values etc. stay free when nothing else listens.
  const unsubBus = bus.subscribe(
    {
      onSet(name, v) {
        if (name === "mode") applyMode(v);
        listeners.forEach((fn) => fn("set", name, v));
      },
      onEvent(name, data, playTime) {
        listeners.forEach((fn) => fn("event", name, data, playTime));
      },
    },
    ["mode", "beat"]
  );
  function pollHands() {
    for (const name in HAND_SIGNALS) setHand(...HAND_SIGNALS[name], bus.get(name) ?? null);
  }

  // Initial values (signals published before we subscribed).
  applyMode(bus.get("mode") || router?.modeId || "chords");
  pollHands();

  bus.declare("ui/override", { type: "state", owner: "ui" });
  bus.declare("ui/sides", { type: "state", owner: "ui" });
  let publishedSide = null;

  // Own canvas for the modes UI layers (see the header), right above the video canvas, under all DOM.
  const safeArea = createSafeArea(doc); // notch insets for the edge tracks (docs/mobile-ui.md §6)
  const layer = doc.createElement("canvas");
  layer.id = "modeOverlay";
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
  canvas.after(layer);
  const lg = layer.getContext("2d");

  const env = { S, bus, ctx, registry, router, doc, canvas, subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) };
  const badges = createBadges(env);
  const readouts = createReadouts(env);
  const guide = createGuide(env);
  const panel = createControlsPanel({ ...env, output });
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
    pollHands();
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
      // On phones the panel lives in the mobile bottom/side sheet: the sheet is what covers the canvas.
      const r = (el.closest("#gsControlsSheet") || el).getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      S.covers.push({ x: r.x - c.x, y: r.y - c.y, w: r.width, h: r.height });
    }
    body.classList.toggle("gs-right-held", S.rightHeld || S.rightReturn || S.lost("right"));
    if (S.chordSide !== publishedSide) {
      publishedSide = S.chordSide;
      bus.set("ui/sides", { chord: S.chordSide, expr: S.chordSide === "left" ? "right" : "left" });
    }
    for (const p of parts) p.update?.();
  }

  const regions = [];
  const reg = (name, kind, rect) => (rect && regions.push({ name, kind, rect }), rect);

  function draw() {
    tick();
    regions.length = 0;
    const W = layer.clientWidth || canvas.clientWidth || canvas.width;
    const H = layer.clientHeight || canvas.clientHeight || canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (layer.width !== bw || layer.height !== bh) {
      layer.width = bw;
      layer.height = bh;
    }
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.clearRect(0, 0, bw, bh);
    // Not drawn until the start overlay is dismissed (the video canvas is .dimmed until then).
    if (!canvas.classList.contains("dimmed")) {
      const G = {
        W, H, portrait: H > W, reg,
        hs: handSpan(W, H),
        toPx: (p) => ({ x: p.x * W, y: p.y * H }),
        safe: safeArea.get(),
      };
      lg.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Z-order (§5): edge tracks, hand feedback, first-use labels (all above the mode/menu canvas).
      const hide = body.classList;
      if (!hide.contains("gs-hide-edge-tracks")) tracks.draw(lg, G);
      if (!hide.contains("gs-hide-hand-feedback")) overlays.draw(lg, G);
      if (!hide.contains("gs-hide-first-use")) guide.draw(lg, G);
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

  // Hand span (wrist -> fingertips) in px. HandFrame.handSize (wrist -> middle MCP) is in display-height
  // units; it is used when hand input publishes it as `left|right/size`, else a typical arm's-length span.
  function handSpan(W, H) {
    const size = S.hands.right.size || S.hands.left.size;
    const span = typeof size === "number" && size > 0 ? size * H * 1.9 : H * 0.2;
    return Math.max(50, Math.min(span, W * 0.32, 280));
  }

  return {
    draw,
    state: S,
    openControls: () => panel.open(),
    setOutputRow: (render) => panel.setOutputRow(render),
    destroy() {
      unsubBus();
      for (const p of parts) p.destroy?.();
      safeArea.destroy();
      layer.remove();
      body.classList.remove("gs-modes", "gs-right-held", "gs-no-right-track");
      delete body.dataset.mode;
    },
  };
}

