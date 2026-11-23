// Router: handles the gestures that are the same in every mode and forwards the
// right hand to the active mode.
//   - left hand  -> chord (via the harmony service). Master volume from left height lands in 1.3.
//   - right hand -> radial menu first (if one is plugged in), then the active mode.

import { classifyChord } from "./input/hand-input.js";

export function createRouter({ bus, registry, harmony, ctx, controlsContainer = null }) {
  let active = null;
  let menu = null;
  let cleanupControls = null;

  bus.declare("mode", { type: "state", owner: "router" });

  function setMode(id) {
    const next = registry.getMode(id);
    if (!next || next === active) return false;
    if (active && active.exit) active.exit(ctx);
    if (cleanupControls) { cleanupControls(); cleanupControls = null; }
    active = next;
    if (active.enter) active.enter(ctx);
    if (controlsContainer && active.controls) cleanupControls = active.controls(controlsContainer, ctx) || null;
    bus.set("mode", active.id);
    return true;
  }

  /**
   * Called every animation frame with the latest HandFrames (null when not visible).
   * Frames are refreshed only on new video frames; `now` advances every animation frame.
   */
  function update(left, right, now) {
    ctx.now = now;

    // ---- Left hand: chord ----
    harmony.updateLeft(
      left ? { chord: classifyChord(left.landmarks, "Left", left.fingers), isMajorMode: left.tilt >= 0 } : null,
      now
    );

    // ---- RADIAL MENU HOOK ----
    // When a menu is plugged in (router.setMenu), it sees the right hand first. While it
    // holds the right hand (fist-entry until countdown end) the active mode is NOT updated,
    // so the mode's right-hand values stay locked at their last value.
    if (menu) {
      const r = menu.update(right, now);
      if (r && r.confirmed) setMode(r.confirmed);
      if (menu.isHoldingRight()) return;
    }

    // ---- Right hand: active mode ----
    if (active) active.update(right, ctx);
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
  };
}
