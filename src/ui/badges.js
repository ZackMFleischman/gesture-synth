// Mode badge (row 1, right of the key select) + Lead note-set badge (docs/ui-integration.md D7).
// Reads `mode` (via S) and `lead/noteset`. The badge takes the mode color as soon as `mode` changes,
// which the router does at the START of the countdown. Click/tap opens the controls panel.

import { MODE_COLORS } from "./theme.js";

const NOTE_SETS = 4;

export function createBadges({ S, bus, doc }) {
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
  const clickHandlers = new Set();
  badge.addEventListener("click", () => clickHandlers.forEach((fn) => fn()));

  function update() {
    // During the countdown the badge already shows the target mode (spec: switches at countdown start).
    const id = S.menu.state === "countdown" && S.menu.targetId ? S.menu.targetId : S.modeId;
    if (id !== shown) {
      shown = id;
      const name = id === S.modeId ? S.name : id ? id[0].toUpperCase() + id.slice(1) : "";
      badge.innerHTML = `<span class="gs-dot"></span><span class="gs-name"></span>`;
      badge.querySelector(".gs-name").textContent = name;
      badge.dataset.mode = id || "";
      badge.style.setProperty("--gs-mode", (id && MODE_COLORS[id]) || S.color);
      badge.setAttribute("aria-label", `Mode: ${name}. Open controls`);
    }
    const set = S.modeId === "lead" ? bus.get("lead/noteset") : null;
    const on = typeof set === "number";
    if (set !== shownSet) {
      shownSet = set;
      noteSet.classList.toggle("hidden", !on);
      if (on) noteSet.innerHTML = Array.from({ length: NOTE_SETS }, (_, i) => `<i class="${i === set ? "on" : ""}"></i>`).join("");
    }
    if (on) {
      const left = `${badge.offsetLeft + badge.offsetWidth + 8}px`;
      if (noteSet.style.left !== left) noteSet.style.left = left;
    }
  }
  update();

  return {
    update,
    onClick: (fn) => (clickHandlers.add(fn), () => clickHandlers.delete(fn)),
    destroy() {
      badge.remove();
      noteSet.remove();
    },
  };
}
