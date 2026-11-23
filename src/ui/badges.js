// Mode badge (row 1, right of the key select) + Lead note-set badge (docs/ui-integration.md D7).
// Reads `mode` (via S) and `lead/noteset`. The badge takes the mode color as soon as `mode` changes,
// which the router does at the START of the countdown. Click/tap opens the controls panel.
// Lead layer: two parts, `● Arp + ● Lead` (each in its mode color, the base part quieter); the badge border is the
// right-hand mode's color. During a countdown it already shows what the selection will give.

import { MODE_COLORS, CONFIRM } from "./theme.js";
import { SET_SHAPES } from "../modes/lead-notes.js";

/** Lead note sets (lead/noteset 1..4; names as in src/modes/lead-notes.js NOTE_SETS). */
const SET_NAMES = ["Chord notes", "Five notes", "Full scale", "All notes"];
const FLASH_MS = CONFIRM.popMs; // the confirm pop (scale + white rim), same timing as the canvas confirm

export function createBadges({ S, bus, doc, registry = null }) {
  const key = doc.getElementById("keySelect");
  const badge = doc.createElement("button");
  badge.id = "modeBadge";
  badge.type = "button";
  badge.className = "gs-badge";
  badge.dataset.gsKind = "status";
  badge.title = "Mode (opens controls)";
  const noteSet = doc.createElement("div");
  noteSet.id = "noteSetBadge";
  noteSet.className = "gs-badge hidden";
  noteSet.dataset.gsKind = "status";
  noteSet.title = "Note set";
  key.after(badge, noteSet);

  let shown = null;
  let shownSet = null;
  let shownLeft = "";
  let flashTimer = 0;
  const clickHandlers = new Set();
  badge.addEventListener("click", () => clickHandlers.forEach((fn) => fn()));

  function update() {
    // During the countdown the badge already shows the target (spec: switches at countdown start): a layer target
    // goes on top of the current base, a base target replaces the base and ends the layer.
    let base = S.baseId ?? S.modeId;
    let lay = S.layerId ?? null;
    const target = S.menu.state === "countdown" && S.menu.targetId ? S.menu.targetId : null;
    if (target) {
      if (registry?.getMode?.(target)?.layer && base !== target) lay = target;
      else {
        base = target;
        lay = null;
      }
    }
    const id = `${base || ""}+${lay || ""}`;
    if (id !== shown) {
      shown = id;
      const nameOf = (m) => (m === S.baseId && S.baseName ? S.baseName : m === S.modeId ? S.name : m ? m[0].toUpperCase() + m.slice(1) : "");
      const colorOf = (m) => (m && MODE_COLORS[m]) || (m === S.baseId ? S.baseColor : S.color);
      const part = (m, cls) =>
        `<span class="gs-part ${cls}" style="--gs-mode:${colorOf(m)}"><span class="gs-dot"></span><span class="gs-name"></span></span>`;
      if (lay) {
        badge.innerHTML = `${part(base, "gs-part-base")}<span class="gs-plus" aria-hidden="true">+</span>${part(lay, "gs-part-layer")}`;
        const names = badge.querySelectorAll(".gs-name");
        names[0].textContent = nameOf(base);
        names[1].textContent = nameOf(lay);
      } else {
        badge.innerHTML = `<span class="gs-dot"></span><span class="gs-name"></span>`;
        badge.querySelector(".gs-name").textContent = nameOf(base);
      }
      const label = lay ? `${nameOf(base)} + ${nameOf(lay)}` : nameOf(base);
      badge.dataset.mode = base || "";
      if (lay) badge.dataset.layer = lay;
      else delete badge.dataset.layer;
      badge.classList.toggle("gs-two", !!lay);
      badge.style.setProperty("--gs-mode", colorOf(lay || base));
      badge.setAttribute("aria-label", `Mode: ${label}. Open controls`);
    }
    const set = S.modeId === "lead" ? bus.get("lead/noteset") : null; // S.modeId = the right-hand mode (layer)
    const on = typeof set === "number";
    if (set !== shownSet) {
      const changed = on && typeof shownSet === "number";
      shownSet = set;
      noteSet.classList.toggle("hidden", !on);
      if (on) {
        noteSet.innerHTML = SET_NAMES.map((_, i) => `<i class="${i + 1 === set ? "on" : ""}"></i>`).join("");
        const name = SET_NAMES[set - 1] || "";
        const shape = SET_SHAPES[set];
        noteSet.title = shape ? `Note set: ${name} (hand: ${shape.emoji} ${shape.label})` : `Note set: ${name}`;
        noteSet.setAttribute("aria-label", `Note set ${set} of 4: ${name}`);
        noteSet.dataset.set = String(set);
        // Short confirm flash on a change (spec: "a short flash confirms the change").
        if (changed) {
          noteSet.classList.remove("gs-flash");
          void noteSet.offsetWidth;
          noteSet.classList.add("gs-flash");
          clearTimeout(flashTimer);
          flashTimer = setTimeout(() => noteSet.classList.remove("gs-flash"), FLASH_MS);
        }
      }
    }
    if (on) {
      // Right after the mode badge. A CSS variable on the body (not inline position on the badge), so other
      // layouts (e.g. the compact phone layout) can place it with plain CSS.
      const left = `${badge.offsetLeft + badge.offsetWidth + 8}px`;
      if (left !== shownLeft) {
        shownLeft = left;
        doc.body.style.setProperty("--gs-noteset-left", left);
      }
    }
  }
  update();

  return {
    update,
    onClick: (fn) => (clickHandlers.add(fn), () => clickHandlers.delete(fn)),
    destroy() {
      clearTimeout(flashTimer);
      doc.body.style.removeProperty("--gs-noteset-left");
      badge.remove();
      noteSet.remove();
    },
  };
}
