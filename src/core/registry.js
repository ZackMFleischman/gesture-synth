// Mode registry (contract: docs/architecture.md "Mode plugin").
// A mode registers itself; the radial menu reads menuItems() and shows it automatically.

import { bus as sharedBus } from "./bus.js";

export function createRegistry({ bus = sharedBus } = {}) {
  const modes = [];

  function registerMode(mode) {
    if (!mode || !mode.id) throw new Error("registerMode: mode needs an id");
    if (modes.some((m) => m.id === mode.id)) throw new Error(`registerMode: duplicate id "${mode.id}"`);
    for (const s of mode.signals || []) bus.declare(s.name, { type: s.type, owner: mode.id });
    modes.push(mode);
    return mode;
  }

  const getModes = () => modes.slice();
  const getMode = (id) => modes.find((m) => m.id === id) || null;

  /**
   * MenuItem[] for the radial menu: one item per registered mode + the active mode's (and layer's) extras.
   * A mode with `layer: true` (Lead) is a "layer" item: it plays on top of the base mode (docs/architecture.md
   * "Lead layer"). While a layer is on, the base's item carries `secondary: true` (it still runs underneath:
   * hollow marker; choosing it is a change = the layer turns off) and a `confirmHint`.
   */
  function menuItems(activeId, { layerId = null } = {}) {
    const layer = layerId ? getMode(layerId) : null;
    const items = modes.map((m) => {
      const it = {
        id: m.id,
        type: m.layer ? "layer" : "mode",
        label: m.name,
        icon: m.icon,
        color: m.color,
        direction: m.direction,
      };
      if (layer && !m.layer && m.id === activeId) {
        it.secondary = true;
        it.confirmHint = `Open hand: ${layer.name} off`;
      }
      return it;
    });
    const active = activeId ? getMode(activeId) : null;
    if (active && Array.isArray(active.menuItems)) items.push(...active.menuItems);
    if (layer && Array.isArray(layer.menuItems)) items.push(...layer.menuItems);
    return items;
  }

  return { registerMode, getModes, getMode, menuItems };
}

/** The app-wide registry. */
export const registry = createRegistry();
export const registerMode = registry.registerMode;
export const getModes = registry.getModes;
