// Mobile UI system (docs/mobile-ui.md): compact, minimizable chrome for phones and tablets.
//
//   import { mountMobileUI } from "./src/ui/mobile/mobile-ui.js";
//   const mobile = mountMobileUI({ bus });   // once, AFTER the existing controls + the modes UI are mounted
//
// It never removes or re-implements a control. On a mobile layout it
//   - collects the existing top-left controls (key, tone, mode badge, guide, controls toggle, help) into ONE
//     collapsible bar (#gsBar). Collapsed, only a small status pill shows (mode dot, key, mode name);
//     one tap expands it, so every control is <= 2 taps away,
//   - auto-collapses the bar once hands are playing (never auto-expands),
//   - shows the Controls panel and Help as bottom sheets (side sheet in landscape) with a drag handle and a
//     44 px close button; the gesture guide becomes a compact strip under the pill,
//   - offers a remembered "Minimal HUD" toggle (chord + essentials only).
// On a desktop layout it puts every moved node back exactly where it was, so desktop is unchanged.
//
// Everything visual lives in mobile.css, scoped under body.gs-mobile.

import "./mobile.css";

/** Layout switch: phones (portrait or landscape) and touch tablets. Desktop (fine pointer, wide) is untouched. */
export const MOBILE_QUERY = "(max-width: 599px), (max-height: 499px), (pointer: coarse) and (max-width: 1366px)";
export const HUD_STORAGE_KEY = "gs.mobile.hud";
/** Set once the bar has been shown open on a first visit (so new players see what the pill holds). */
export const INTRO_STORAGE_KEY = "gs.mobile.seen";
/** Bar collapses this long after the last touch on it once hands are playing (ms). */
export const AUTO_COLLAPSE_MS = 2500;
/** A hand counts as gone after this long without a position (ms). */
const HAND_STALE_MS = 600;
const HAND_POLL_MS = 200;

const MODE_NAMES = { chords: "Chords", arp: "Arp", lead: "Lead" };

function safeGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function safeSet(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* private mode / blocked storage: the toggle still works for this session */
  }
}

/**
 * @param {{doc?:Document, win?:Window, bus?:object, storage?:Storage|null, force?:"mobile"|"desktop"|null,
 *          intro?:boolean, now?:()=>number}} [o]  intro (default true): open the tray once on a first visit
 * @returns {{isMobile:()=>boolean, expand():void, collapse():void, toggle():void, isOpen:()=>boolean,
 *            setPlaying(on:boolean):void, setMinimal(on:boolean):void, isMinimal:()=>boolean,
 *            openSheet(name:"controls"|"guide"|"help"):void, closeSheets():void, refresh():void, destroy():void}}
 */
export function mountMobileUI(o = {}) {
  const doc = o.doc || document;
  const win = o.win || doc.defaultView || window;
  const storage = o.storage === undefined ? safeStorage(win) : o.storage;
  const now = o.now || (() => performance.now());
  const body = doc.body;
  const $ = (id) => doc.getElementById(id);
  if (body.__gsMobile) return body.__gsMobile; // idempotent

  // ---------------------------------------------------------------- DOM scaffolding (inert on desktop)
  const h = (tag, attrs = {}, html = "") => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (html) e.innerHTML = html;
    return e;
  };
  const bar = h("div", { id: "gsBar", "data-gs-mobile": "bar" });
  const head = h("div", { class: "gs-tray-head" });
  const pill = h("button", { id: "gsPill", type: "button", "aria-expanded": "false", "aria-controls": "gsBar", title: "Show controls" },
    `<span class="gs-dot"></span><span class="gs-pill-key"></span><span class="gs-pill-mode"></span><span class="gs-pill-min" title="Minimal HUD is on"></span><span class="gs-caret" aria-hidden="true"></span>`);
  const extra = h("div", { class: "gs-tray-extra" });
  const hudBtn = h("button", { id: "gsHudToggle", type: "button", "aria-pressed": "false", title: "Minimal HUD: hide everything but the chord" },
    `<span class="gs-hud-icon" aria-hidden="true"></span><span class="gs-hud-label">Minimal</span>`);
  const rows = h("div", { class: "gs-tray-rows" });
  const row1 = h("div", { class: "gs-tray-row", "data-row": "sound" });
  const row2 = h("div", { class: "gs-tray-row", "data-row": "views" });
  extra.append(hudBtn);
  head.append(pill, extra);
  rows.append(row1, row2);
  bar.append(head, rows);

  const guideClose = h("button", { id: "gsGuideClose", type: "button", class: "gs-close", "aria-label": "Close guide", "data-gs-mobile": "close" }, "✕");
  const sheet = h("div", { id: "gsControlsSheet", class: "gs-sheet hidden", role: "dialog", "aria-label": "Controls" });
  const sheetHead = h("div", { class: "gs-sheet-head" },
    `<span class="gs-sheet-handle" aria-hidden="true"></span><span class="gs-sheet-title">Controls</span>`);
  const sheetClose = h("button", { type: "button", class: "gs-close", "aria-label": "Close controls" }, "✕");
  const sheetBody = h("div", { class: "gs-sheet-body" });
  sheetHead.append(sheetClose);
  sheet.append(sheetHead, sheetBody);
  const helpHandle = h("div", { class: "gs-help-handle", "aria-hidden": "true" });

  const stage = $("stage") || body;
  stage.append(bar, sheet);

  // ---------------------------------------------------------------- moving existing nodes in and back out
  /** [element id, target container] in display order. Missing ids (e.g. no modes UI yet) are skipped. */
  const MOVES = [
    ["noteSetBadge", head, pill],
    ["helpButton", extra, null],
    ["keySelect", row1, null],
    ["toneSelect", row1, null],
    ["modeBadge", row2, null],
    ["controlsToggle", row2, null],
    ["guideToggle", row2, null],
  ];
  /** id -> placeholder comment left where the node lived. */
  const homes = new Map();
  let mobile = false;

  function moveIn() {
    for (const [id, target, after] of MOVES) {
      const e = $(id);
      if (!e || homes.has(id)) continue;
      const mark = doc.createComment(`gs-mobile:${id}`);
      e.before(mark);
      homes.set(id, mark);
      if (after) after.after(e);
      else if (target === extra) extra.insertBefore(e, hudBtn);
      else target.append(e);
    }
    const guide = $("gestureGuide");
    if (guide && !guideClose.isConnected) guide.after(guideClose);
    const panel = $("controlsPanel");
    if (panel && !homes.has("controlsPanel")) {
      const mark = doc.createComment("gs-mobile:controlsPanel");
      panel.before(mark);
      homes.set("controlsPanel", mark);
      sheetBody.append(panel);
    }
    const help = doc.querySelector("#helpModal .help-content");
    if (help && !helpHandle.isConnected) help.prepend(helpHandle);
  }

  function moveOut() {
    for (const [id, mark] of homes) {
      const e = $(id);
      if (e && mark.isConnected) mark.replaceWith(e);
      else mark.remove();
    }
    homes.clear();
    guideClose.remove();
    helpHandle.remove();
  }

  // ---------------------------------------------------------------- state
  let open = false;
  let playing = false;
  let minimal = safeGet(storage, HUD_STORAGE_KEY) === "minimal";
  let lastTouch = -Infinity;
  let collapseTimer = 0;

  function setOpen(v) {
    open = !!v && mobile;
    bar.classList.toggle("open", open);
    body.classList.toggle("gs-bar-open", open);
    pill.setAttribute("aria-expanded", String(open));
    pill.title = open ? "Hide controls" : "Show controls";
    if (open) lastTouch = now();
    schedule();
  }

  function schedule() {
    clearTimeout(collapseTimer);
    if (!open || !playing) return;
    const wait = Math.max(0, lastTouch + AUTO_COLLAPSE_MS - now());
    collapseTimer = setTimeout(() => {
      if (open && playing && now() - lastTouch >= AUTO_COLLAPSE_MS - 5) setOpen(false);
      else schedule();
    }, wait);
  }

  function setMinimal(v) {
    minimal = !!v;
    body.classList.toggle("gs-hud-min", minimal && mobile);
    hudBtn.setAttribute("aria-pressed", String(minimal));
    hudBtn.title = minimal ? "Minimal HUD is on: tap for the full HUD" : "Minimal HUD: hide everything but the chord";
    safeSet(storage, HUD_STORAGE_KEY, minimal ? "minimal" : "full");
  }

  function setPlaying(v) {
    playing = !!v;
    body.classList.toggle("gs-playing", playing && mobile);
    schedule();
  }

  /** Pill text follows the key select and the active mode. */
  function refresh() {
    const key = $("keySelect");
    const note = key?.selectedOptions?.[0]?.dataset.note || key?.value || "";
    pill.querySelector(".gs-pill-key").textContent = note;
    const id = body.dataset.mode;
    const badge = $("modeBadge");
    const name = MODE_NAMES[id] || (badge ? badge.textContent.trim() : "");
    pill.querySelector(".gs-pill-mode").textContent = name;
    pill.classList.toggle("no-mode", !name);
    syncSheets();
  }

  /** Mirrors the panels' own open state (owned by controls.js / the modes UI) onto the mobile chrome. */
  function syncSheets() {
    const panel = $("controlsPanel");
    const panelOpen = !!panel && !panel.classList.contains("hidden");
    sheet.classList.toggle("hidden", !(mobile && panelOpen));
    const guide = $("gestureGuide");
    const guideOpen = !!guide && !guide.classList.contains("hidden");
    const helpOpen = !!$("helpModal") && !$("helpModal").classList.contains("hidden");
    body.classList.toggle("gs-sheet-open", mobile && (panelOpen || helpOpen));
    body.classList.toggle("gs-controls-open", mobile && panelOpen);
    body.classList.toggle("gs-guide-open", mobile && guideOpen);
    // A panel taking over collapses the bar (closing it returns to collapsed, not expanded).
    if (mobile && open && (panelOpen || guideOpen || helpOpen)) setOpen(false);
  }

  // ---------------------------------------------------------------- open/close through the existing controls
  const click = (id) => $(id)?.click();
  function closeControls() {
    const panel = $("controlsPanel");
    if (!panel || panel.classList.contains("hidden")) return;
    if ($("controlsToggle")) click("controlsToggle");
    else panel.classList.add("hidden");
  }
  function closeGuide() {
    const guide = $("gestureGuide");
    if (guide && !guide.classList.contains("hidden")) click("guideToggle");
  }
  function closeHelp() {
    const m = $("helpModal");
    if (m && !m.classList.contains("hidden")) click("closeHelp");
  }
  function openSheet(name) {
    if (name === "controls") {
      const panel = $("controlsPanel");
      if (panel?.classList.contains("hidden")) $("controlsToggle") ? click("controlsToggle") : panel.classList.remove("hidden");
    } else if (name === "guide") {
      if ($("gestureGuide")?.classList.contains("hidden")) click("guideToggle");
    } else if (name === "help") click("helpButton");
    syncSheets();
  }
  function closeSheets() {
    closeControls();
    closeGuide();
    closeHelp();
    syncSheets();
  }

  // ---------------------------------------------------------------- events
  const off = [];
  const on = (t, ev, fn, opt) => (t.addEventListener(ev, fn, opt), off.push(() => t.removeEventListener(ev, fn, opt)));

  on(pill, "click", () => setOpen(!open));
  on(hudBtn, "click", () => setMinimal(!minimal));
  on(guideClose, "click", closeGuide);
  on(sheetClose, "click", closeControls);
  on(bar, "pointerdown", () => ((lastTouch = now()), schedule()));
  on(bar, "change", () => ((lastTouch = now()), refresh()));
  // Tap anywhere outside the expanded bar collapses it.
  on(doc, "pointerdown", (e) => {
    // The start overlay tap ("click to enable audio") must not fold the first-visit tray it reveals.
    if (open && !bar.contains(e.target) && !e.target.closest?.("#startOverlay")) setOpen(false);
  }, true);
  on(doc, "keydown", (e) => {
    if (e.key !== "Escape" || !mobile) return;
    if (open) setOpen(false);
    else closeSheets();
  });

  attachDrag(sheetHead, sheet, () => (isLandscape() ? "x" : "y"), closeControls);
  attachDrag(helpHandle, () => doc.querySelector("#helpModal .help-content"), () => "y", closeHelp);

  const mo = new win.MutationObserver(() => refresh());
  const watch = () => {
    mo.disconnect();
    mo.observe(body, { attributes: true, attributeFilter: ["data-mode"] });
    for (const id of ["controlsPanel", "gestureGuide", "helpModal"]) {
      const e = $(id);
      if (e) mo.observe(e, { attributes: true, attributeFilter: ["class"] });
    }
    const badge = $("modeBadge");
    if (badge) mo.observe(badge, { childList: true, characterData: true, subtree: true });
  };

  // Hands playing (optional bus): a hand position seen in the last HAND_STALE_MS. Polled with bus.get (not
  // subscribed), so the hand-position producers stay free (bus.wants() stays false; see output.spec).
  let lastHand = -Infinity;
  let pollTimer = 0;
  if (o.bus?.get) {
    pollTimer = setInterval(() => {
      if (!mobile) return;
      if (o.bus.get("left/pos") || o.bus.get("right/pos")) lastHand = now();
      const on = now() - lastHand < HAND_STALE_MS;
      if (on !== playing) setPlaying(on);
    }, HAND_POLL_MS);
  }

  // ---------------------------------------------------------------- layout switch
  const mq = win.matchMedia ? win.matchMedia(MOBILE_QUERY) : { matches: false, addEventListener() {}, removeEventListener() {} };
  const landscapeMq = win.matchMedia ? win.matchMedia("(max-height: 499px) and (orientation: landscape)") : { matches: false };
  const isLandscape = () => landscapeMq.matches;

  function apply() {
    const want = o.force ? o.force === "mobile" : mq.matches;
    if (want === mobile && (mobile ? homes.size : true)) {
      refresh();
      return;
    }
    mobile = want;
    body.classList.toggle("gs-mobile", mobile);
    if (mobile) moveIn();
    else {
      setOpen(false);
      moveOut();
    }
    setMinimal(minimal);
    setPlaying(playing);
    watch();
    refresh();
  }
  const onMq = () => apply();
  mq.addEventListener?.("change", onMq);
  off.push(() => mq.removeEventListener?.("change", onMq));

  apply();
  // First visit: show the tray open once (it folds away by itself when the hands start playing).
  if (o.intro !== false && mobile && safeGet(storage, INTRO_STORAGE_KEY) !== "1") {
    safeSet(storage, INTRO_STORAGE_KEY, "1");
    setOpen(true);
  }

  const api = {
    isMobile: () => mobile,
    isOpen: () => open,
    expand: () => setOpen(true),
    collapse: () => setOpen(false),
    toggle: () => setOpen(!open),
    setPlaying,
    setMinimal,
    isMinimal: () => minimal,
    openSheet,
    closeSheets,
    /** Re-scan for nodes added after mount (e.g. the modes UI mounted later) and re-sync. */
    refresh: () => {
      if (mobile) moveIn();
      watch();
      refresh();
    },
    destroy() {
      clearTimeout(collapseTimer);
      clearInterval(pollTimer);
      mo.disconnect();
      off.forEach((f) => f());
      moveOut();
      bar.remove();
      sheet.remove();
      for (const c of ["gs-mobile", "gs-bar-open", "gs-playing", "gs-hud-min", "gs-sheet-open", "gs-controls-open", "gs-guide-open"]) body.classList.remove(c);
      delete body.__gsMobile;
    },
  };
  body.__gsMobile = api;
  return api;
}

function safeStorage(win) {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

/**
 * Drag a sheet by its handle area to close it (down in portrait, right in landscape). Releasing past
 * 72 px (or a fast flick) closes; otherwise it springs back.
 * @param {HTMLElement} handle @param {HTMLElement|(()=>HTMLElement)} target @param {()=>"x"|"y"} axis
 */
function attachDrag(handle, target, axis, onClose) {
  let start = null;
  const el = () => (typeof target === "function" ? target() : target);
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const t = el();
    if (!t) return;
    start = { x: e.clientX, y: e.clientY, t: e.timeStamp, a: axis() };
    t.classList.add("gs-dragging");
    handle.setPointerCapture?.(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    const d = Math.max(0, start.a === "y" ? e.clientY - start.y : e.clientX - start.x);
    el().style.transform = start.a === "y" ? `translateY(${d}px)` : `translateX(${d}px)`;
  });
  const end = (e) => {
    if (!start) return;
    const t = el();
    const d = Math.max(0, start.a === "y" ? e.clientY - start.y : e.clientX - start.x);
    const v = d / Math.max(1, e.timeStamp - start.t);
    start = null;
    t.classList.remove("gs-dragging");
    t.style.transform = "";
    if (d > 72 || (d > 24 && v > 0.6)) onClose();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
