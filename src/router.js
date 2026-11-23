// Router: handles the gestures that are the same in every mode and forwards the
// right hand to the active mode.
//   - left hand  -> chord (via the harmony service) + master volume (left height, every mode, menu open too)
//   - right hand -> radial menu first (if one is plugged in), then the active mode
//   - both hands sideways -> the reach axes (src/core/axes.js: right x = Drive, left x = Space, every mode)
//
// Right-hand rules (spec "Decided changes to hand roles", "Mode selection flow"):
//   - A right fist is the menu gesture, never a mode input: while the right hand is a fist the mode
//     keeps seeing the last open-hand frame (so the 100 ms before the menu opens changes nothing).
//   - While the menu holds the right hand (fist entry .. countdown end) mode.update() is NOT called;
//     mode.hold(ctx) is called instead, so the left hand stays live with the locked right values.
//   - On confirm the mode switches at once (badge + `mode` signal at countdown start; old.exit(),
//     new.enter() with ctx.rightLocked = the locked right frame). The new mode gets the right hand
//     only after the countdown, and its height/tilt crossfade from the locked values to the live
//     hand over RESUME_MS (also after a cancel), so nothing jumps.
//
// Lead layer (docs/architecture.md "Lead layer"): a mode with `layer: true` (Lead) plays ON TOP of the base mode
// (Chords / Arp) instead of replacing it. While the layer is on, the base keeps running through `hold(ctx)` every
// frame (left hand live: chord + master; its right-hand values held), and the right hand drives the layer.
// Choosing a base mode (menu or Controls) turns the layer off; choosing the base that was underneath gives the right
// hand back to it with the Return crossfade from the values it held. `mode` stays the base id; `layer` = "lead"|null.
//
// Menu settings (setting items in a sub-ring, e.g. the Sound menu): the menu reports {key, value} when the hand opens
// on one; the router applies it through ctx.settings[key](value) (src/core/app-context.js). No mode change, no countdown.
//
// Publishes: mode (state), layer (state), volume (master volume, continuous), menu (state), right/held (state).

import { classifyChord } from "./input/hand-input.js";

/** Left-height master volume tuning (pure; see createMasterVolume). */
export const MASTER_VOLUME = { // mutable: Tweaks may change LOW / HIGH at runtime (createMasterVolume reads them live)
  DEAD_ZONE: 0.04, // height units: movements smaller than this (backlash) never change the volume
  TAU_MS: 140, // one-pole smoothing time constant (right height uses ~30-50 ms in the audio graph)
  LOW: 0.1, // height at/below which the master is 0 (low left hand = rest)
  // Height at/above which the master is 1. 0.55 (was 0.7): a mid-frame left hand (0.5) gives 0.89, so typical play
  // keeps about today's loudness after the gain re-staging that keeps voices out of the limiter (src/services/audio.js).
  HIGH: 0.55,
  INITIAL: 1, // before a left hand was ever seen (e.g. a right-hand-only Lead melody); the first left frame sets it directly
};

/** Crossfade from locked right-hand values to the live hand after the menu releases it. */
export const RESUME_MS = 200;

/**
 * Left height -> master volume with a dead zone (backlash) and smoothing. Pure, Node-testable.
 * update(height|null, nowMs) -> volume 0..1. A null height (hand not visible) holds the volume.
 */
export function createMasterVolume(opts = {}) {
  // Read live (not copied): the Tweaks panel may change MASTER_VOLUME fields while playing; `opts` still override.
  const o = new Proxy(opts, { get: (t, k) => (k in t ? t[k] : MASTER_VOLUME[k]) });
  let anchor = null; // dead-zoned height
  let value = o.INITIAL;
  let lastT = null;
  const map = (h) => Math.max(0, Math.min(1, (h - o.LOW) / Math.max(1e-6, o.HIGH - o.LOW)));
  return {
    update(height, now) {
      if (height == null || !Number.isFinite(height)) {
        lastT = null;
        return value;
      }
      if (anchor === null) {
        anchor = height;
        value = map(anchor);
        lastT = now;
        return value;
      }
      if (height > anchor + o.DEAD_ZONE) anchor = height - o.DEAD_ZONE;
      else if (height < anchor - o.DEAD_ZONE) anchor = height + o.DEAD_ZONE;
      const target = map(anchor);
      const dt = lastT === null ? 0 : Math.max(0, now - lastT);
      lastT = now;
      value += (target - value) * (1 - Math.exp(-dt / o.TAU_MS));
      if (Math.abs(target - value) < 1e-4) value = target;
      return value;
    },
    get value() { return value; },
    get anchor() { return anchor; },
    /** Jump the smoothed value (e.g. to a screen-control value), so the hand takes over smoothly from there. */
    setValue(v) { value = Math.max(0, Math.min(1, v)); },
  };
}

const isOverridden = (bus, name) => {
  const o = bus.get("ui/override");
  return Array.isArray(o) && o.includes(name);
};

const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (k) => k * k * (3 - 2 * k);

/**
 * @param {{ bus, registry, harmony, ctx, controlsContainer?: HTMLElement|null,
 *           aspect?: () => number }} opts  aspect = canvas width / height (menu geometry units)
 */
export function createRouter({ bus, registry, harmony, ctx, controlsContainer = null, aspect = () => 1, axes = null }) {
  let active = null;
  let menu = null;
  let cleanupControls = null;
  const master = createMasterVolume();
  let lastMaster = -1;
  let lastOpenRight = null; // last non-fist right frame (null after the right hand was lost)
  let resumePending = false;
  let resumeStart = null;
  let lastMenuKey = "";
  let lastSetting = null;
  let masterOverride = null; // screen control value (Controls panel) while `ui/override` lists "master"
  let heldPhase = null; // null | "held" | "return" (what the `held` signal currently says)
  let heldFor = null; // mode id the `held` object was built for
  let layer = null; // Lead layer on top of `active` (a mode with `layer: true`), or null
  let lastBaseFrame = null; // the last right frame the base mode got (its held values = this frame's)
  let baseLocked = null; // that frame when the layer turned on (Return crossfade start when the base gets the hand back)

  bus.declare("mode", { type: "state", owner: "router" });
  bus.declare("layer", { type: "state", owner: "router" });
  bus.declare("volume", { type: "continuous", owner: "router" });
  bus.declare("menu", { type: "state", owner: "router" });
  bus.declare("right/held", { type: "state", owner: "router" });
  bus.declare("held", { type: "state", owner: "router" });
  bus.set("right/held", false);
  bus.set("menu", null);
  bus.set("held", null);
  bus.set("layer", null);
  ctx.rightLocked = null;
  ctx.layerBase = null; // id of the base mode while a layer plays on top of it (Lead skips its pad then)

  /** Controls panel master slider: the screen value wins until the left hand moves (`ui/override`). */
  ctx.setMasterVolume = (v) => {
    masterOverride = Math.max(0, Math.min(1, Number(v) || 0));
    master.setValue(masterOverride);
    applyMaster(masterOverride);
  };

  function applyMaster(mv) {
    if (mv === lastMaster) return;
    lastMaster = mv;
    ctx.masterVolume = mv;
    ctx.audio?.setMasterVolume?.(mv);
    bus.set("volume", mv);
  }

  // `held` (state): while the menu holds the right hand {right: true, [rightTrack.param]: heldValue};
  // during the crossfade back to the hand {[param]: heldValue}; otherwise null. Built on transitions only.
  // A mode can hold right-hand values itself (Arp pinch) through the optional `mode.heldState()` ->
  // null | { phase: "held"|"return", values: {[param]: heldValue} }; the menu wins over it.
  function publishHeld(phase, values = null, src = "menu") {
    const rm = layer || active;
    const id = rm ? `${active.id}+${layer ? layer.id : ""}` : null;
    const key = phase ? `${src}|${phase}` : null;
    if (key === heldPhase && id === heldFor) return;
    heldPhase = key;
    heldFor = id;
    if (!phase) { bus.set("held", null); return; }
    const h = phase === "held" ? { right: true } : {};
    if (values) Object.assign(h, values);
    else {
      const p = rm?.rightTrack?.param;
      if (p) h[p] = bus.get(p) ?? null;
    }
    bus.set("held", h);
  }

  /** (Re)mounts the screen controls: the base's rows, plus the layer's rows in labelled groups while it is on. */
  function mountControls() {
    if (cleanupControls) { cleanupControls(); cleanupControls = null; }
    if (!controlsContainer || !active) return;
    if (!layer) {
      if (active.controls) cleanupControls = active.controls(controlsContainer, ctx) || null;
      return;
    }
    const doc = controlsContainer.ownerDocument;
    const group = (m, kind, note) => {
      const el = doc.createElement("div");
      el.className = "gs-ctl-group";
      el.dataset.group = kind;
      el.dataset.mode = m.id;
      el.style.setProperty("--gs-group", m.color);
      const head = doc.createElement("div");
      head.className = "gs-ctl-head";
      head.innerHTML = `<span class="gs-dot"></span><span class="gs-ctl-name"></span><span class="gs-ctl-note"></span>`;
      head.querySelector(".gs-ctl-name").textContent = m.name;
      head.querySelector(".gs-ctl-note").textContent = note;
      el.append(head);
      controlsContainer.append(el);
      return el;
    };
    const baseEl = group(active, "base", "right hand held");
    const layerEl = group(layer, "layer", "right hand");
    const cb = active.controls ? active.controls(baseEl, ctx) || null : null;
    const cl = layer.controls ? layer.controls(layerEl, ctx) || null : null;
    cleanupControls = () => {
      cb?.();
      cl?.();
      baseEl.remove();
      layerEl.remove();
    };
  }

  /** Lead layer off (its exit runs; the base keeps playing). */
  function clearLayer() {
    if (!layer) return;
    const l = layer;
    layer = null;
    if (l.exit) l.exit(ctx);
    ctx.layerBase = null;
    ctx.audio?.setLayerMix?.(false);
    bus.set("layer", null);
  }

  /** Lead layer on over the current base: the base's right-hand values stay held, the right hand plays the layer. */
  function setLayer(next) {
    if (!active || next === layer) return false;
    clearLayer();
    baseLocked = lastBaseFrame;
    layer = next;
    ctx.layerBase = active.id;
    ctx.audio?.setLayerMix?.(true);
    bus.set("layer", layer.id);
    if (layer.enter) layer.enter(ctx);
    mountControls();
    return true;
  }

  /**
   * Selects a mode (menu confirm, Controls panel): a base mode replaces the base and turns a layer off; a layer
   * mode turns the layer on over the current base. Returns true if something changed.
   */
  function setMode(id) {
    const next = registry.getMode(id);
    if (!next) return false;
    // A layer needs a base under it; without one (labs/lead-lab.html) it runs alone like a base mode.
    if (next.layer && active && !active.layer) return setLayer(next);
    if (next === active) {
      if (!layer) return false;
      // The base that was underneath gets the right hand back: crossfade from the values it held.
      clearLayer();
      ctx.rightLocked = baseLocked;
      resumePending = true;
      resumeStart = null;
      mountControls();
      return true;
    }
    clearLayer();
    if (active && active.exit) active.exit(ctx);
    if (cleanupControls) { cleanupControls(); cleanupControls = null; }
    active = next;
    lastBaseFrame = null;
    bus.set("mode", active.id); // badge switches at the start of the countdown
    if (active.enter) active.enter(ctx);
    mountControls();
    return true;
  }

  // `menu` signal: { state, level, path, hoverId, selectedId, progress } while open/countdown/flash, else null.
  // state "flash" = a setting was picked (`setting: {key, value}`); level 1 = inside a sub-ring (path = [submenu id]).
  // Rebuilt only when something visible changes (progress in 1% steps), so consumers get few updates.
  function publishMenu(r) {
    if (!r || r.state === "closed") {
      if (lastMenuKey !== "") { lastMenuKey = ""; bus.set("menu", null); }
      return;
    }
    const p = Math.round(r.progress * 100) / 100;
    const level = r.level || 0;
    const key = `${r.state}|${level}|${r.hoverId}|${r.selectedId}|${p}`;
    if (key === lastMenuKey) return;
    lastMenuKey = key;
    const m = {
      state: r.state,
      level,
      path: r.path || [],
      hoverId: r.hoverId,
      selectedId: r.selectedId,
      confirmedId: r.state === "countdown" ? r.selectedId : null,
      progress: p,
    };
    if (r.setting) lastSetting = { key: r.setting.key, value: r.setting.value };
    if (r.state === "flash") m.setting = lastSetting;
    bus.set("menu", m);
  }

  /**
   * Called every animation frame with the latest HandFrames (null when not visible).
   * Frames are refreshed only on new video frames; `now` advances every animation frame.
   */
  function update(left, right, now) {
    ctx.now = now;

    // ---- Left hand: master volume (every mode, also while the menu is open) ----
    // (A screen-control override wins until the hand moves: the panel drops "master" from ui/override.)
    if (masterOverride !== null && !isOverridden(bus, "master")) masterOverride = null;
    const mv = master.update(left ? left.height : null, now);
    if (masterOverride !== null) master.setValue(masterOverride); // hand takes over smoothly from here
    applyMaster(masterOverride !== null ? masterOverride : mv);

    // ---- Left hand: chord ----
    harmony.updateLeft(
      left ? { chord: classifyChord(left.landmarks, "Left", left.fingers), isMajorMode: left.tilt >= 0 } : null,
      now
    );

    // ---- Right hand: a fist never reaches the mode ----
    if (!right) lastOpenRight = null;
    else if (!right.fist) lastOpenRight = right;

    // ---- RADIAL MENU HOOK ----
    let held = false;
    if (menu) {
      // HandFrame.handSize is in display-HEIGHT units; the menu measures in canvas-WIDTH units.
      const a = aspect();
      const menuHand = right && a !== 1 ? { ...right, handSize: right.handSize / a } : right;
      const r = menu.update(menuHand, now);
      if (r.opened) ctx.rightLocked = lastOpenRight;
      if (r.confirmed) setMode(r.confirmed);
      if (r.setting) {
        const apply = ctx.settings?.[r.setting.key];
        if (apply) apply(r.setting.value);
      }
      if (r.finished || r.cancelled) {
        resumePending = true;
        resumeStart = null;
      }
      publishMenu(r);
      held = menu.isHoldingRight();
    }
    bus.set("right/held", held);
    // ---- Sideways axes (every mode; right-hand axes hold while the menu holds the right hand, and under the Lead
    // layer: Drive is a base value there, like the base's other right-hand values; Space (left) stays live) ----
    axes?.update(left, right ? (right.fist ? lastOpenRight : right) : null, { now, rightHeld: held || !!layer });
    if (!active) return;

    if (held) {
      // Values stay locked; the left hand (chord changes, master volume) stays live.
      publishHeld("held");
      if (active.hold) active.hold(ctx);
      if (layer && layer.hold) layer.hold(ctx);
      return;
    }

    // ---- Right hand: active mode (crossfading from the locked values after a menu release) ----
    let frame = right ? (right.fist ? lastOpenRight : right) : null;
    if (frame && resumePending) {
      resumePending = false;
      resumeStart = now;
    }
    const locked = ctx.rightLocked;
    if (frame && resumeStart !== null && locked) {
      const k = (now - resumeStart) / RESUME_MS;
      if (k >= 1) resumeStart = null;
      else {
        const e = smooth(Math.max(0, k));
        frame = { ...frame, height: lerp(locked.height, frame.height, e), tilt: lerp(locked.tilt, frame.tilt, e) };
      }
    }
    if (layer) {
      // Lead layer: the base keeps playing with its right-hand values held; the right hand plays the layer.
      if (active.hold) active.hold(ctx);
      layer.update(frame, ctx);
    } else {
      active.update(frame, ctx);
      lastBaseFrame = frame;
    }
    if (resumePending || resumeStart !== null) publishHeld("return");
    else {
      const rm = layer || active;
      const mh = rm.heldState ? rm.heldState() : null;
      if (mh) publishHeld(mh.phase, mh.values, "mode");
      else publishHeld(null);
    }
  }

  function draw(g) {
    if (active && active.draw) active.draw(g, ctx);
    if (layer && layer.draw) layer.draw(g, ctx);
    if (menu && menu.draw) menu.draw(g, ctx);
  }

  return {
    update,
    draw,
    setMode,
    /** Same as setMode (a layer id toggles the layer on; a base id sets the base and turns the layer off). */
    select: setMode,
    /**
     * Plug in the radial menu: createRadialMenu({ items: () => registry.menuItems(router.modeId, { layerId: router.layerId }),
     * currentId: () => router.rightModeId }).
     */
    setMenu(m) { menu = m || null; },
    get menu() { return menu; },
    /** The base mode (Chords / Arp): bus `mode`. */
    get mode() { return active; },
    get modeId() { return active ? active.id : null; },
    /** The layer playing on top of the base (Lead) or null: bus `layer`. */
    get layer() { return layer; },
    get layerId() { return layer ? layer.id : null; },
    /** The mode the right hand drives (the layer if on, else the base). */
    get rightMode() { return layer || active; },
    get rightModeId() { return (layer || active)?.id ?? null; },
    get masterVolume() { return master.value; },
    /** Reach axes (src/core/axes.js) or null. */
    get axes() { return axes; },
    /** true while the menu holds the right hand (mode values locked). */
    get rightHeld() { return !!(menu && menu.isHoldingRight()); },
  };
}
