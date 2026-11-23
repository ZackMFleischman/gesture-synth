// Tweaks panel (DOM). Only loaded with `?tweaks` (see src/tweaks/index.js). Augments the page: a small button in the
// bottom-right corner (#tweaksToggle) opens a scrollable panel (#tweaksPanel): one collapsible section per group,
// each row = label + ⓘ (hover/focus tooltip with the tweak's `info`) + control + current value; per-group Reset,
// global Reset all, Copy JSON, Paste JSON. Desktop: a card above the button; phones (≤ 599 px wide or ≤ 499 px
// high): a bottom sheet. Closes with ✕, Escape or the button.
import "./panel.css";

const UI_KEY = "gs.tweaks.ui.v1"; // per-viewer convenience: which groups are collapsed

const ICON_SLIDERS =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>';

function readUi(storage) {
  try {
    const d = JSON.parse(storage?.getItem(UI_KEY) || "{}");
    return d && typeof d === "object" && Array.isArray(d.collapsed) ? d : { collapsed: [] };
  } catch {
    return { collapsed: [] };
  }
}
function writeUi(storage, ui) {
  try {
    storage?.setItem(UI_KEY, JSON.stringify(ui));
  } catch {
    /* blocked storage: per-page only */
  }
}

const slug = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, "-");

/** Text for a value next to its control. */
export function formatTweakValue(def, v) {
  if (def.type === "toggle") return v ? "on" : "off";
  if (def.type === "select") {
    const o = (def.options || []).find((x) => (x && typeof x === "object" ? x.value : x) === v);
    return String(o && typeof o === "object" ? (o.label ?? o.value) : v);
  }
  const decimals = def.step > 0 ? Math.min(4, (String(def.step).split(".")[1] || "").length) : 2;
  const n = Number(v).toFixed(decimals);
  return def.unit ? `${n} ${def.unit}` : n;
}

/**
 * @param {{tweaks: ReturnType<import("./tweaks.js").createTweaks>, doc?: Document, parent?: Element,
 *          storage?: Storage|null}} opts
 */
export function mountTweaksPanel({ tweaks, doc = document, parent = doc.body, storage }) {
  const win = doc.defaultView;
  if (storage === undefined) {
    try {
      storage = win.localStorage;
    } catch {
      storage = null;
    }
  }
  const ui = readUi(storage);
  const el = (tag, props = {}, kids = []) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k in n && typeof v !== "string") n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) if (c) n.append(c);
    return n;
  };

  // ---- Toggle button ----
  const toggle = el("button", {
    id: "tweaksToggle",
    type: "button",
    class: "gs-tweaks-toggle",
    title: "Tweaks (developer settings)",
    "aria-label": "Tweaks",
    "aria-expanded": "false",
    "aria-controls": "tweaksPanel",
    "data-gs-kind": "status",
    html: ICON_SLIDERS + '<span class="gs-tw-toggle-label">Tweaks</span>',
  });

  // ---- Panel ----
  const panel = el("section", {
    id: "tweaksPanel",
    class: "gs-tweaks-panel",
    role: "dialog",
    "aria-label": "Tweaks",
    "data-gs-kind": "panel",
  });
  panel.hidden = true;
  const closeBtn = el("button", { type: "button", class: "gs-tw-close", "aria-label": "Close tweaks", text: "✕" });
  const head = el("header", { class: "gs-tw-head" }, [
    el("h2", { text: "Tweaks" }),
    el("span", { class: "gs-tw-sub", text: "saved in this browser" }),
    closeBtn,
  ]);
  const resetAllBtn = el("button", { type: "button", class: "gs-tw-btn", "data-action": "reset-all", text: "Reset all" });
  const copyBtn = el("button", { type: "button", class: "gs-tw-btn", "data-action": "copy", text: "Copy JSON" });
  const pasteBtn = el("button", { type: "button", class: "gs-tw-btn", "data-action": "paste", text: "Paste JSON", "aria-expanded": "false" });
  const actions = el("div", { class: "gs-tw-actions" }, [resetAllBtn, copyBtn, pasteBtn]);
  const status = el("div", { class: "gs-tw-status", role: "status", "aria-live": "polite" });
  const jsonBox = el("textarea", { class: "gs-tw-json", spellcheck: "false", "aria-label": "Tweaks JSON", rows: "6" });
  const applyBtn = el("button", { type: "button", class: "gs-tw-btn", "data-action": "apply-json", text: "Apply" });
  const cancelJsonBtn = el("button", { type: "button", class: "gs-tw-btn gs-tw-quiet", "data-action": "close-json", text: "Close" });
  const jsonWrap = el("div", { class: "gs-tw-jsonwrap" }, [jsonBox, el("div", { class: "gs-tw-actions" }, [applyBtn, cancelJsonBtn])]);
  jsonWrap.hidden = true;
  const body = el("div", { class: "gs-tw-body" });
  const tip = el("div", { class: "gs-tw-tooltip", role: "tooltip", id: "tweaksTooltip" });
  tip.hidden = true;
  panel.append(head, actions, status, jsonWrap, body);

  // ---- Rows ----
  const rows = new Map(); // key -> {def, input, out, row}
  const groupEls = new Map(); // group -> {section, rowsEl, btn}
  function setGroupCollapsed(group, collapsed, save = true) {
    const g = groupEls.get(group);
    if (!g) return;
    g.rowsEl.hidden = collapsed;
    g.btn.setAttribute("aria-expanded", String(!collapsed));
    g.section.classList.toggle("collapsed", collapsed);
    if (save) {
      ui.collapsed = [...groupEls.keys()].filter((k) => groupEls.get(k).rowsEl.hidden);
      writeUi(storage, ui);
    }
  }

  function showTip(anchor, text) {
    tip.textContent = text;
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const w = Math.min(280, vw - 16);
    tip.style.maxWidth = `${w}px`;
    const tr = tip.getBoundingClientRect();
    let left = Math.min(vw - 8 - tr.width, Math.max(8, r.left + r.width / 2 - tr.width / 2));
    let top = r.top - tr.height - 8;
    if (top < 8) top = Math.min(vh - tr.height - 8, r.bottom + 8);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
  const hideTip = () => (tip.hidden = true);

  function makeControl(def, id) {
    const v = tweaks.getTweak(def.key);
    let input;
    if (def.type === "toggle") {
      input = el("input", { type: "checkbox", id, role: "switch", class: "gs-tw-switch" });
      input.checked = !!v;
      input.addEventListener("change", () => tweaks.setTweak(def.key, input.checked));
    } else if (def.type === "select") {
      input = el("select", { id, class: "gs-tw-select" });
      for (const o of def.options || []) {
        const val = o && typeof o === "object" ? o.value : o;
        const opt = el("option", { text: String(o && typeof o === "object" ? (o.label ?? o.value) : o) });
        opt.value = String(val);
        opt._val = val;
        input.append(opt);
      }
      input.addEventListener("change", () => tweaks.setTweak(def.key, input.selectedOptions[0]?._val));
    } else {
      input = el("input", { type: def.type === "slider" ? "range" : "number", id, class: def.type === "slider" ? "gs-tw-range" : "gs-tw-number" });
      if (Number.isFinite(def.min)) input.min = String(def.min);
      if (Number.isFinite(def.max)) input.max = String(def.max);
      input.step = def.step > 0 ? String(def.step) : "any";
      const commit = () => {
        const n = parseFloat(input.value);
        if (Number.isFinite(n)) tweaks.setTweak(def.key, n);
        else sync(def.key);
      };
      input.addEventListener(def.type === "slider" ? "input" : "change", commit);
    }
    return input;
  }

  function sync(key) {
    const r = rows.get(key);
    if (!r) return;
    const v = tweaks.getTweak(key);
    const { def, input, out, row } = r;
    if (def.type === "toggle") input.checked = !!v;
    else if (def.type === "select") {
      const i = [...input.options].findIndex((o) => o._val === v);
      if (i >= 0) input.selectedIndex = i;
    } else if (doc.activeElement !== input || def.type === "slider") input.value = String(v);
    out.textContent = formatTweakValue(def, v);
    row.classList.toggle("changed", !tweaks.isDefault(key));
    row.title = tweaks.isDefault(key) ? "" : `default: ${formatTweakValue(def, def.default)}`;
  }

  function build() {
    body.textContent = "";
    rows.clear();
    groupEls.clear();
    for (const group of tweaks.groups()) {
      const gid = `tw-g-${slug(group)}`;
      const btn = el("button", { type: "button", class: "gs-tw-group-toggle", "aria-expanded": "true", "aria-controls": gid }, [
        el("span", { class: "gs-tw-caret", "aria-hidden": "true", text: "▾" }),
        el("span", { text: group }),
      ]);
      const reset = el("button", { type: "button", class: "gs-tw-btn gs-tw-quiet", "data-action": "reset-group", text: "Reset", "aria-label": `Reset ${group}` });
      const rowsEl = el("div", { class: "gs-tw-rows", id: gid });
      const section = el("section", { class: "gs-tw-group", "data-group": group }, [el("h3", { class: "gs-tw-group-head" }, [btn, reset]), rowsEl]);
      btn.addEventListener("click", () => setGroupCollapsed(group, !rowsEl.hidden));
      reset.addEventListener("click", () => {
        tweaks.resetTweaks(group);
        say(`${group}: defaults restored`);
      });
      groupEls.set(group, { section, rowsEl, btn });
      for (const def of tweaks.list().filter((d) => d.group === group)) {
        const id = `tw-${slug(def.key)}`;
        const input = makeControl(def, id);
        const out = el("output", { class: "gs-tw-value", for: id });
        const label = el("label", { for: id, class: "gs-tw-label", text: def.label });
        let info = null;
        if (def.info) {
          const descId = `${id}-info`;
          info = el("button", { type: "button", class: "gs-tw-info", "aria-label": `About ${def.label}`, "aria-describedby": descId, text: "i" });
          const desc = el("span", { id: descId, class: "gs-tw-sr", text: def.info });
          info.addEventListener("mouseenter", () => showTip(info, def.info));
          info.addEventListener("mouseleave", () => doc.activeElement !== info && hideTip());
          info.addEventListener("focus", () => showTip(info, def.info));
          info.addEventListener("blur", hideTip);
          info.addEventListener("click", () => showTip(info, def.info)); // touch: tap shows, tapping elsewhere (blur) hides
          input.setAttribute("aria-describedby", descId);
          rowsEl.append(desc);
        }
        const row = el("div", { class: `gs-tw-row gs-tw-${def.type}`, "data-key": def.key }, [
          el("div", { class: "gs-tw-labelwrap" }, [label, info]),
          el("div", { class: "gs-tw-control" }, [input, out]),
        ]);
        rowsEl.append(row);
        rows.set(def.key, { def, input, out, row });
        sync(def.key);
      }
      body.append(section);
      setGroupCollapsed(group, ui.collapsed.includes(group), false);
    }
  }

  // ---- Status line ----
  let sayTimer = 0;
  function say(text, kind = "ok") {
    status.textContent = text;
    status.dataset.kind = kind;
    win.clearTimeout(sayTimer);
    sayTimer = win.setTimeout(() => (status.textContent = ""), 4000);
  }

  // ---- JSON box (copy fallback + paste) ----
  function openJson(mode) {
    jsonWrap.hidden = false;
    jsonWrap.dataset.mode = mode;
    applyBtn.hidden = mode !== "paste";
    pasteBtn.setAttribute("aria-expanded", String(mode === "paste"));
    if (mode === "copy") {
      jsonBox.value = tweaks.exportTweaks();
      jsonBox.readOnly = true;
      jsonBox.focus();
      jsonBox.select();
    } else {
      jsonBox.readOnly = false;
      jsonBox.value = "";
      jsonBox.placeholder = '{"version":1,"values":{…}}';
      jsonBox.focus();
    }
  }
  function closeJson() {
    jsonWrap.hidden = true;
    pasteBtn.setAttribute("aria-expanded", "false");
  }

  async function copy() {
    const text = tweaks.exportTweaks();
    try {
      // Called straight from the click handler (user activation) so the clipboard API is allowed.
      if (!win.navigator.clipboard?.writeText) throw new Error("no clipboard API");
      await win.navigator.clipboard.writeText(text);
      say("Copied all tweaks as JSON");
    } catch {
      openJson("copy"); // fallback: the text selected in a box, ready for Ctrl/Cmd+C
      let ok = false;
      try {
        ok = doc.execCommand?.("copy");
      } catch {
        ok = false;
      }
      say(ok ? "Copied all tweaks as JSON" : "Clipboard blocked: press Ctrl/Cmd+C to copy the selected JSON", ok ? "ok" : "warn");
    }
  }

  function applyJson() {
    try {
      const r = tweaks.importTweaks(jsonBox.value);
      say(`Applied ${r.applied.length} tweak${r.applied.length === 1 ? "" : "s"}${r.ignored.length ? `, ignored ${r.ignored.join(", ")}` : ""}`, r.ignored.length ? "warn" : "ok");
      closeJson();
    } catch (err) {
      say(`Not valid tweaks JSON: ${err.message}`, "warn");
    }
  }

  // ---- Open / close ----
  let lastFocus = null;
  function setOpen(open, { restoreFocus = true } = {}) {
    if (open === !panel.hidden) return;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("on", open);
    doc.body.classList.toggle("gs-tweaks-open", open);
    hideTip();
    if (open) {
      lastFocus = doc.activeElement;
      for (const k of rows.keys()) sync(k);
      closeBtn.focus({ preventScroll: true });
    } else if (restoreFocus) {
      (lastFocus && lastFocus !== doc.body && doc.contains(lastFocus) ? lastFocus : toggle).focus?.({ preventScroll: true });
    }
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  closeBtn.addEventListener("click", () => setOpen(false));
  resetAllBtn.addEventListener("click", () => {
    tweaks.resetTweaks();
    say("All tweaks back to their defaults");
  });
  copyBtn.addEventListener("click", copy);
  pasteBtn.addEventListener("click", () => (jsonWrap.hidden || jsonWrap.dataset.mode !== "paste" ? openJson("paste") : closeJson()));
  applyBtn.addEventListener("click", applyJson);
  cancelJsonBtn.addEventListener("click", closeJson);
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation(); // the app's own Escape handlers (mobile sheets, controls panel) stay out of it
    if (!tip.hidden) hideTip();
    else setOpen(false);
  });
  const onDocKey = (e) => {
    if (e.key === "Escape" && !panel.hidden && !panel.contains(e.target)) setOpen(false, { restoreFocus: false });
  };
  doc.addEventListener("keydown", onDocKey);
  body.addEventListener("scroll", hideTip, { passive: true });

  const offAny = tweaks.onAnyTweak((key) => sync(key));

  build();
  parent.append(toggle, panel, tip);

  return {
    toggle,
    panel,
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => !panel.hidden,
    rebuild: build,
    destroy() {
      offAny();
      doc.removeEventListener("keydown", onDocKey);
      toggle.remove();
      panel.remove();
      tip.remove();
      doc.body.classList.remove("gs-tweaks-open");
    },
  };
}
