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

  /** MenuItem[] for the radial menu: one "mode" item per registered mode + the active mode's extras. */
  function menuItems(activeId) {
    const items = modes.map((m) => ({
      id: m.id,
      type: "mode",
      label: m.name,
      icon: m.icon,
      color: m.color,
      direction: m.direction,
    }));
    const active = activeId ? getMode(activeId) : null;
    if (active && Array.isArray(active.menuItems)) items.push(...active.menuItems);
    return items;
  }

  return { registerMode, getModes, getMode, menuItems };
}

/** The app-wide registry. */
export const registry = createRegistry();
export const registerMode = registry.registerMode;
export const getModes = registry.getModes;
