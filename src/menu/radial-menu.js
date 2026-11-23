// Generic radial menu (fist menu). Knows nothing about specific modes: items come from items().
// Auto-select: crossing an arc's select radius confirms it (no open-hand confirm, no sound); see menu-state.js.
// Contract: docs/architecture.md "Radial menu". Spec: docs/spec/requirements.md "Mode selection flow".
//
//   const menu = createRadialMenu({ items, currentId });
//   each frame:  const r = menu.update(rightHandFrameOrNull, now);   // before modes update
//                if (!menu.isHoldingRight()) activeMode.update(right, ctx);
//                ...; menu.draw(g, ctx);                             // after modes draw (on top)

import {
  createMenuState,
  MENU_TIMING,
  MENU_GEOMETRY,
  DIRECTIONS,
  BACK_ID,
  registerMenuItemType,
  pickDirection,
  pickSlot,
  fanLayout,
} from "./menu-state.js";
import { createMenuRenderer, viewFromCtx, MENU_THEME } from "./menu-draw.js";
import { menuConfig, setMenuConfig, resetMenuConfig, MENU_CONFIG_DEFAULTS } from "./menu-config.js";

export { MENU_TIMING, MENU_GEOMETRY, MENU_THEME, DIRECTIONS, BACK_ID, registerMenuItemType, pickDirection, pickSlot, fanLayout };
// Live config (read every frame by the state machine + renderer): Tweaks panel / labs.
export { menuConfig, setMenuConfig, resetMenuConfig, MENU_CONFIG_DEFAULTS };

/**
 * @param {{
 *   items: () => Array<MenuItem>,  // main ring, one item per direction
 *     MenuItem   = {id, type?: "mode"|"submenu", label, icon?, color, direction: "up"|"right"|"down"|"left"}
 *     submenu    = MenuItem + { items: SettingItem[] | () => SettingItem[],   // the sub-ring (resolved when it opens)
 *                               current?: () => string,  // id of the current child ("current" dot, "Already set")
 *                               setting?: string }       // key reported in result.setting.key (default: the submenu id)
 *     SettingItem = {id, type?: "setting", label, icon?, color? (default: the submenu's color), value? (default: id)}
 *     The sub-ring opens when the fist stays past the submenu arc's outer edge for SUB_OPEN_MS; its children are
 *     spread as a fan (list order: next to the back sector, counter-clockwise on screen); the back sector
 *     (BACK_SPAN_DEG) points toward the parent; reaching BACK_R inside it goes back one level. Max 2 levels.
 *   currentId: () => string,
 *   aspect?: number|(() => number),// canvas width/height; default: learned from draw(g, ctx)
 *   timing?: object, geometry?: object, theme?: object,  // overrides (see exported constants)
 * }} opts
 */
export function createRadialMenu(opts) {
  const state = createMenuState(opts);
  const render = createMenuRenderer(opts.theme);
  const learnAspect = opts.aspect === undefined;

  return {
    /** @returns {{state:"closed"|"open"|"countdown"|"flash", level:0|1, path:string[],
     *   hoverId:string|null, progress:number, selectedId:string|null,   // ids within the active ring
     *   confirmed?:string,                                   // fist crossed a mode item: flash + countdown follow ("countdown")
     *   setting?:{key, submenu, id, value},                  // fist crossed a setting item: flash only ("flash"), then finished
     *   entered?:string, back?:true,                         // sub-ring opened (submenu id) / went back one level
     *   cancelled?:true, reason?:"empty"|"same-item"|"submenu"|"tracking-lost",
     *   opened?:true, finished?:string}} */
    update: (right, now) => state.update(right, now),

    /** Draws ring / countdown at the hand. ctx.toCanvas maps display-normalized -> canvas px. */
    draw(g, ctx) {
      const view = viewFromCtx(g, ctx);
      if (learnAspect) state.setAspect(view.aspect);
      render(g, state.snapshot(), view);
    },

    /** true from fist-entry until the countdown ends (router locks right-hand values meanwhile). */
    isHoldingRight: () => state.isHoldingRight(),

    /** Read-only state for debugging / tests / other visuals (e.g. dimming right-hand controls). */
    snapshot: () => state.snapshot(),

    reset: () => state.reset(),
  };
}
