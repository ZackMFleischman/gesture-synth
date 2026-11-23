// Radial menu: the ONE live-mutable config object (Tweaks panel `?tweaks=true` binds to it; ws/tweaks).
// menu-state.js and menu-draw.js read it EVERY frame (nothing is copied at import time), so a change takes effect on
// the next frame. Pure (no DOM).
//
//   import { menuConfig, setMenuConfig, resetMenuConfig } from "./menu-config.js";
//   setMenuConfig({ holdMs: 200 });   // unknown keys are ignored, values are type-checked
//
// Keys:
//   requireRelease  false = auto-select (crossing an arc's select radius chooses it; user feedback 2026-11-22).
//                   true  = the earlier flow: crossing only SELECTS, opening the hand confirms the selected arc,
//                           opening with nothing selected cancels.
//   holdMs          auto-select only: the fist must stay past the select radius this long before the arc is chosen
//                   (the arc's rim shows the hold filling; dropping back inside the radius restarts it). 0 = at once.
//   deadR, innerR, selectR, deselectR   radii in entry hand sizes (= MENU_GEOMETRY DEAD_R, INNER_R, SELECT_R, DESELECT_R)
//   cooldownMs      after a close, a fist that never opened re-opens the menu only this long after it (= REARM_MS)
//   countdownMs     after a mode is chosen: the chosen arc fades out over this long while the right hand stays held
//                   (= COUNTDOWN_MS); the new mode gets the right hand at its end.

export const MENU_CONFIG_DEFAULTS = Object.freeze({
  requireRelease: false,
  holdMs: 0,
  deadR: 0.22,
  innerR: 0.3,
  selectR: 0.6,
  deselectR: 0.44,
  cooldownMs: 2000,
  countdownMs: 400,
});

/** Live config: read it, don't copy it. Mutate through setMenuConfig (or directly, same effect). */
export const menuConfig = { ...MENU_CONFIG_DEFAULTS };

/** Merge known keys (type-checked: booleans stay booleans, numbers must be finite and >= 0). Returns menuConfig. */
export function setMenuConfig(partial = {}) {
  for (const [k, v] of Object.entries(partial || {})) {
    if (!(k in MENU_CONFIG_DEFAULTS)) continue;
    const def = MENU_CONFIG_DEFAULTS[k];
    if (typeof def === "boolean") menuConfig[k] = !!v;
    else if (Number.isFinite(Number(v)) && Number(v) >= 0) menuConfig[k] = Number(v);
  }
  return menuConfig;
}

export function resetMenuConfig() {
  return Object.assign(menuConfig, MENU_CONFIG_DEFAULTS);
}
