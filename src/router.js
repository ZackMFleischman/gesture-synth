// Router: handles the gestures that are the same in every mode and forwards the
// right hand to the active mode.
//   - left hand  -> chord (via the harmony service) + master volume (left height, every mode, menu open too)
//   - right hand -> radial menu first (if one is plugged in), then the active mode
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
// Publishes: mode (state), volume (master volume, continuous), menu (state), right/held (state).

import { classifyChord } from "./input/hand-input.js";

/** Left-height master volume tuning (pure; see createMasterVolume). */
export const MASTER_VOLUME = Object.freeze({
  DEAD_ZONE: 0.04, // height units: movements smaller than this (backlash) never change the volume
  TAU_MS: 140, // one-pole smoothing time constant (right height uses ~30-50 ms in the audio graph)
  LOW: 0.1, // height at/below which the master is 0 (low left hand = rest)
  // Height at/above which the master is 1. 0.55 (was 0.7): a mid-frame left hand (0.5) gives 0.89, so typical play
  // keeps about today's loudness after the gain re-staging that keeps voices out of the limiter (src/services/audio.js).
  HIGH: 0.55,
  INITIAL: 1, // before a left hand was ever seen (e.g. a right-hand-only Lead melody); the first left frame sets it directly
});

/** Crossfade from locked right-hand values to the live hand after the menu releases it. */
export const RESUME_MS = 200;

/**
 * Left height -> master volume with a dead zone (backlash) and smoothing. Pure, Node-testable.
 * update(height|null, nowMs) -> volume 0..1. A null height (hand not visible) holds the volume.
 */
export function createMasterVolume(opts = {}) {
  const o = { ...MASTER_VOLUME, ...opts };
  let anchor = null; // dead-zoned height
  let value = o.INITIAL;
  let lastT = null;
  const map = (h) => Math.max(0, Math.min(1, (h - o.LOW) / (o.HIGH - o.LOW)));
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
export function createRouter({ bus, registry, harmony, ctx, controlsContainer = null, aspect = () => 1 }) {
  let active = null;
  let menu = null;
  let cleanupControls = null;
  const master = createMasterVolume();
  let lastMaster = -1;
  let lastOpenRight = null; // last non-fist right frame (null after the right hand was lost)
  let resumePending = false;
  let resumeStart = null;
  let lastMenuKey = "";
  let masterOverride = null; // screen control value (Controls panel) while `ui/override` lists "master"
  let heldPhase = null; // null | "held" | "return" (what the `held` signal currently says)
  let heldFor = null; // mode id the `held` object was built for

  bus.declare("mode", { type: "state", owner: "router" });
  bus.declare("volume", { type: "continuous", owner: "router" });
  bus.declare("menu", { type: "state", owner: "router" });
  bus.declare("right/held", { type: "state", owner: "router" });
  bus.declare("held", { type: "state", owner: "router" });
  bus.set("right/held", false);
  bus.set("menu", null);
  bus.set("held", null);
  ctx.rightLocked = null;

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
  function publishHeld(phase) {
    const id = active ? active.id : null;
    if (phase === heldPhase && id === heldFor) return;
    heldPhase = phase;
    heldFor = id;
    if (!phase) { bus.set("held", null); return; }
    const p = active?.rightTrack?.param;
    const h = phase === "held" ? { right: true } : {};
    if (p) h[p] = bus.get(p) ?? null;
    bus.set("held", h);
  }

  function setMode(id) {
    const next = registry.getMode(id);
    if (!next || next === active) return false;
    if (active && active.exit) active.exit(ctx);
    if (cleanupControls) { cleanupControls(); cleanupControls = null; }
    active = next;
    bus.set("mode", active.id); // badge switches at the start of the countdown
    if (active.enter) active.enter(ctx);
    if (controlsContainer && active.controls) cleanupControls = active.controls(controlsContainer, ctx) || null;
    return true;
  }

  // `menu` signal: { state, hoverId, selectedId, progress } while open/countdown, else null.
  // Rebuilt only when something visible changes (progress in 1% steps), so consumers get few updates.
  function publishMenu(r) {
    if (!r || r.state === "closed") {
      if (lastMenuKey !== "") { lastMenuKey = ""; bus.set("menu", null); }
      return;
    }
    const p = Math.round(r.progress * 100) / 100;
    const key = `${r.state}|${r.hoverId}|${r.selectedId}|${p}`;
    if (key === lastMenuKey) return;
    lastMenuKey = key;
    bus.set("menu", {
      state: r.state,
      hoverId: r.hoverId,
      selectedId: r.selectedId,
      confirmedId: r.state === "countdown" ? r.selectedId : null,
      progress: p,
    });
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
      if (r.finished || r.cancelled) {
        resumePending = true;
        resumeStart = null;
      }
      publishMenu(r);
      held = menu.isHoldingRight();
    }
    bus.set("right/held", held);
    if (!active) return;

    if (held) {
      // Values stay locked; the left hand (chord changes, master volume) stays live.
      publishHeld("held");
      if (active.hold) active.hold(ctx);
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
    publishHeld(resumePending || resumeStart !== null ? "return" : null);
    active.update(frame, ctx);
  }

  function draw(g) {
    if (active && active.draw) active.draw(g, ctx);
    if (menu && menu.draw) menu.draw(g, ctx);
  }

  return {
    update,
    draw,
    setMode,
    /** Plug in the radial menu: createRadialMenu({ items: () => registry.menuItems(router.modeId), currentId: () => router.modeId }). */
    setMenu(m) { menu = m || null; },
    get menu() { return menu; },
    get mode() { return active; },
    get modeId() { return active ? active.id : null; },
    get masterVolume() { return master.value; },
    /** true while the menu holds the right hand (mode values locked). */
    get rightHeld() { return !!(menu && menu.isHoldingRight()); },
  };
}
