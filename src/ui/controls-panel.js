// Screen controls (docs/ui-integration.md D8): a `Controls` toggle next to "Open Guide" opens a panel in
// the gesture guide's slot (the two are mutually exclusive). Rows:
//   Mode (segmented; router.setMode) | the active mode's own rows (mode.controls(container, ctx)) |
//   Master vol | Output (on/off switch + room code + connection state + "New code", through the M3 status
//   chip's API when `output` is given; setOutputRow(render) replaces the row).
// Lead decision Q4 (docs/ui-integration.md): this row is THE output setting. The chip (top right) is
// hidden while the output is off and, once on, a press on it opens this panel (output.setPressHandler).
// The mode rows live in main.js's #modeControls (the router mounts/unmounts them on mode change); the
// panel adopts that node. Without it the panel calls mode.controls() itself.
//
// Screen controls vs gestures (spec "Gesture test page and screen controls"): a row shows a small hand
// mark while a gesture owns its value. If the player moves a screen control, the screen control wins
// until that hand moves again (S.overrides; published as `ui/override`).
//
// Lead layer: the Mode row lights the base AND Lead; choosing Lead turns the layer on (router.setMode), choosing a
// base turns it off. The router mounts the base's rows and Lead's rows in labelled groups; the base's rows (its
// held values: gate, tempo, …) stay usable and never show the hand mark (the right hand plays Lead).

import { MIN_BPM, MAX_BPM } from "../services/clock.js";

const MOVE = 0.05; // hand height change (0..1) that hands control back to the gesture
const HAND_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round" d="M5.2 8.6V3.4a.9.9 0 0 1 1.8 0v4.4M7 7.4V2.4a.9.9 0 0 1 ' +
  '1.8 0v5M8.8 7.6V3a.9.9 0 0 1 1.8 0v5.2M10.6 8.2V4.6a.9.9 0 0 1 1.8 0V10c0 2.6-1.8 4.4-4.3 4.4-1.7 0-2.8-.8-3.7-2.1L2.6 9.6a.95.95 0 0 1 1.5-1.1l1.1 1.3"/></svg>';

export function createControlsPanel({ S, bus, ctx, registry, router, doc, output = null }) {
  const guideToggle = doc.getElementById("guideToggle");
  const guideEl = doc.getElementById("gestureGuide");

  const toggle = doc.createElement("button");
  toggle.id = "controlsToggle";
  toggle.type = "button";
  toggle.dataset.gsKind = "status";
  toggle.setAttribute("aria-pressed", "false");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "controlsPanel");
  toggle.textContent = "Controls";
  guideToggle.after(toggle);

  const panel = doc.createElement("div");
  panel.id = "controlsPanel";
  panel.className = "hidden";
  panel.dataset.gsKind = "panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Screen controls");
  panel.innerHTML = `
    <span class="gs-k">Mode</span><span class="gs-v"><div class="gs-seg" data-control="mode" role="group" aria-label="Mode"></div></span>
    <div class="gs-sep"></div>
    <div class="gs-mode-host"></div>
    <div class="gs-sep"></div>
    <span class="gs-k">Master vol</span><span class="gs-v gs-master-row"><input class="gs-range master" type="range" min="0" max="1" step="0.01" aria-label="Master volume" data-control="master"></span>
    <span class="gs-k">Output</span><span class="gs-v" data-hook="output"></span>`;
  (guideEl || toggle).after(panel);

  const seg = panel.querySelector('[data-control="mode"]');
  const host = panel.querySelector(".gs-mode-host");
  const master = panel.querySelector('[data-control="master"]');
  const outputEl = panel.querySelector('[data-hook="output"]');

  // ---- Mode rows: adopt the router's container, else mount them ourselves ----
  const routerHost = doc.getElementById("modeControls");
  if (routerHost) host.append(routerHost);
  let ownCleanup = null;
  let ownFor = null;
  function syncOwnControls() {
    if (routerHost || ownFor === S.modeId) return;
    ownCleanup?.();
    ownCleanup = null;
    ownFor = S.modeId;
    if (S.mode?.controls) ownCleanup = S.mode.controls(host, ctx) || null;
  }

  // ---- Mode segmented control ----
  let segFor = "";
  function buildSeg() {
    const modes = registry?.getModes?.() || [];
    const key = modes.map((m) => m.id).join(",");
    if (key === segFor) return;
    segFor = key;
    seg.innerHTML = "";
    for (const m of modes) {
      const b = doc.createElement("button");
      b.type = "button";
      b.dataset.value = m.id;
      b.textContent = m.name || m.id;
      if (m.color) b.style.setProperty("--gs-mode", m.color); // base + Lead can both be lit: each in its color
      b.addEventListener("click", () => router?.setMode?.(m.id));
      seg.append(b);
    }
  }

  // ---- Output row (milestone 3): on/off + room code via the status chip's API ----
  let outputCleanup = null;
  let outputRefresh = null;
  function defaultOutputRow(c) {
    c.innerHTML =
      '<button type="button" class="gs-switch" aria-pressed="false" aria-label="Visualizer output" data-control="output"></button>' +
      '<span class="gs-code" data-hook="output-code" aria-label="Room code" hidden></span>' +
      '<span class="gs-note" data-hook="output-status">Off</span>' +
      '<button type="button" class="gs-btn gs-mini" data-control="output-new-code" title="New room code (drops connected visualizers)" hidden>New</button>';
    const sw = c.querySelector(".gs-switch");
    const code = c.querySelector('[data-hook="output-code"]');
    const note = c.querySelector('[data-hook="output-status"]');
    const fresh = c.querySelector('[data-control="output-new-code"]');
    if (!output) {
      sw.disabled = true;
      note.textContent = "Off · not available";
      return null;
    }
    sw.addEventListener("click", () => output.setOutput(output.status?.state === "off"));
    fresh.addEventListener("click", () => output.newRoom?.());
    outputRefresh = () => {
      const st = output.status || { state: "off" };
      const on = st.state !== "off";
      const live = st.state === "connected" || st.state === "relayed";
      const delay = live && typeof st.rttMs === "number" ? ` · ${Math.max(1, Math.round(st.rttMs / 2))} ms` : "";
      const text =
        !on ? "Off" :
        live ? `${st.state === "connected" ? "Direct" : "Relayed"}${delay}` :
        st.room ? "Waiting for a visualizer" : "Connecting…";
      const codeText = on && st.room ? st.room : "";
      if (sw.getAttribute("aria-pressed") !== String(on)) sw.setAttribute("aria-pressed", String(on));
      if (note.textContent !== text) note.textContent = text;
      if (code.textContent !== codeText) code.textContent = codeText;
      if (code.hidden !== !codeText) code.hidden = !codeText;
      if (fresh.hidden !== !on) fresh.hidden = !on;
      c.dataset.state = st.state === "connecting" ? "waiting" : st.state;
    };
    outputRefresh();
    const offStatus = output.onStatus?.(() => outputRefresh?.()) || null;
    return () => {
      offStatus?.();
      outputRefresh = null;
    };
  }
  function setOutputRow(render) {
    outputCleanup?.();
    outputRefresh = null;
    outputEl.innerHTML = "";
    outputCleanup = (render || defaultOutputRow)(outputEl) || null;
  }
  setOutputRow(null);

  // ---- Master volume (ctx.masterVolume; ctx.setMasterVolume from the router, milestone 1.3) ----
  function setMaster(v) {
    if (typeof ctx.setMasterVolume === "function") ctx.setMasterVolume(v);
    else ctx.masterVolume = v;
  }

  // ---- Tap tempo (added next to the mode's tempo +/− buttons) ----
  const taps = [];
  function setBpm(bpm) {
    const b = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
    const base = S.base ?? S.mode; // tempo belongs to the base (Arp), also under the Lead layer
    if (typeof base?.set === "function") base.set({ bpm: b });
    else if (ctx.clock) ctx.clock.bpm = b;
  }
  function onTap() {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(t);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) setBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
  }
  function ensureTap() {
    const up = host.querySelector('[data-control="bpm-up"]');
    if (!up || host.querySelector('[data-control="bpm-tap"]')) return;
    const tap = doc.createElement("button");
    tap.type = "button";
    tap.className = "arp-btn";
    tap.dataset.control = "bpm-tap";
    tap.setAttribute("aria-label", "Tap tempo");
    tap.textContent = "Tap";
    tap.addEventListener("click", onTap);
    up.after(tap);
  }

  // ---- Hand marks: which rows a gesture owns right now ----
  const OWNED = [
    // Arp rows: not owned while the Lead layer has the right hand (their values are held).
    { sel: '[data-control="gate"]', owned: () => !S.layerId && !!S.hands.right.pos && !S.rightHeld && !S.rightReturn && !S.overrides.has("arp/gate") },
    { sel: '[data-control="double"]', owned: () => !S.layerId && !!S.hands.right.pos && !S.rightHeld },
    { sel: '[data-control="bpm"]', owned: () => !S.layerId && !!S.hands.right.pos && !!S.hands.right.pinch },
    { sel: '[data-control="master"]', owned: () => !!S.hands.left.pos && !S.overrides.has("master") },
    // Lead: finger count = note set, pinch on an arrow = octave.
    { sel: '[data-control="noteset"]', owned: () => !!S.hands.right.pos && !S.rightHeld },
    { sel: '[data-control="octave"]', owned: () => !!S.hands.right.pos && !S.rightHeld },
  ];
  function rowOf(el) {
    return el.closest(".arp-controls > .arp-row, .lead-controls > .lead-row, .gs-v") || el.parentElement;
  }
  function ensureMarks() {
    for (const o of OWNED) {
      const el = panel.querySelector(o.sel);
      if (!el) continue;
      const row = rowOf(el);
      if (!row.querySelector(":scope > .gs-hand")) {
        const mark = doc.createElement("span");
        mark.className = "gs-hand";
        mark.title = "Set by your hand";
        mark.innerHTML = HAND_SVG;
        row.append(mark);
      }
    }
  }
  const hostObserver = new MutationObserver(() => {
    ensureTap();
    ensureMarks();
  });
  hostObserver.observe(host, { childList: true, subtree: true });

  // ---- Screen control wins until the hand moves again ----
  const OVERRIDABLE = {
    gate: {
      name: "arp/gate",
      hand: "right",
      read: () => bus.get("arp/gate"),
      apply: (v) => (S.base ?? S.mode)?.set?.({ gate: v }),
    },
    master: { name: "master", hand: "left", read: () => ctx.masterVolume, apply: setMaster },
  };
  let publishedOverrides = "";
  function publishOverrides() {
    const keys = [...S.overrides.keys()];
    const k = keys.join(",");
    if (k === publishedOverrides) return;
    publishedOverrides = k;
    bus.set("ui/override", keys);
  }
  panel.addEventListener("input", (e) => {
    const def = OVERRIDABLE[e.target?.dataset?.control];
    if (!def) return;
    const value = Number(e.target.value);
    const h = S.hands[def.hand];
    S.overrides.set(def.name, { value, hand: def.hand, ref: h.pos ? h.height : null, read: def.read, apply: def.apply });
    def.apply(value);
    publishOverrides();
  });
  function enforceOverrides() {
    for (const [name, o] of S.overrides) {
      const h = S.hands[o.hand];
      if (h.pos && typeof h.height === "number") {
        if (o.ref == null) o.ref = h.height;
        else if (Math.abs(h.height - o.ref) > MOVE) {
          S.overrides.delete(name);
          continue;
        }
      }
      // Fallback until modes skip hand writes for names in `ui/override`: put the screen value back.
      const cur = o.read();
      if (typeof cur !== "number" || Math.abs(cur - o.value) > 1e-6) o.apply(o.value);
    }
    publishOverrides();
  }

  // ---- Open / close (mutually exclusive with the gesture guide) ----
  const isOpen = () => !panel.classList.contains("hidden");
  const guideOpen = () => !!guideEl && !guideEl.classList.contains("hidden");
  function open({ focus = true } = {}) {
    if (guideOpen()) guideToggle.click(); // closes it through controls.js (keeps its label in sync)
    panel.classList.remove("hidden");
    doc.body.classList.add("gs-panel-open");
    toggle.setAttribute("aria-pressed", "true");
    toggle.setAttribute("aria-expanded", "true");
    update();
    if (focus) (seg.querySelector("button.on") || panel.querySelector("button, input"))?.focus({ preventScroll: true });
  }
  function close({ restoreFocus = false } = {}) {
    const hadFocus = panel.contains(doc.activeElement);
    panel.classList.add("hidden");
    doc.body.classList.remove("gs-panel-open");
    toggle.setAttribute("aria-pressed", "false");
    toggle.setAttribute("aria-expanded", "false");
    if (restoreFocus || hadFocus) toggle.focus({ preventScroll: true });
  }
  toggle.addEventListener("click", () => (isOpen() ? close() : open()));
  // Q4: a press on the output chip opens this panel (its Output row is the output setting).
  output?.setPressHandler?.(() => open({ focus: false }));
  // controls.js toggles the guide first (it subscribed earlier); then we close the panel if the guide opened.
  guideToggle.setAttribute("aria-expanded", String(guideOpen()));
  guideToggle.setAttribute("aria-controls", "gestureGuide");
  const onGuide = () => {
    guideToggle.setAttribute("aria-expanded", String(guideOpen()));
    if (guideOpen()) close();
  };
  guideToggle.addEventListener("click", onGuide);
  const helpModal = doc.getElementById("helpModal");
  const onKey = (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    if (helpModal && !helpModal.classList.contains("hidden")) return; // the modal is on top
    close({ restoreFocus: true });
  };
  doc.addEventListener("keydown", onKey);

  let lastMarks = "";
  function update() {
    syncOwnControls();
    enforceOverrides();
    if (!isOpen()) return;
    buildSeg();
    for (const b of seg.children) {
      const on = b.dataset.value === (S.baseId ?? S.modeId) || b.dataset.value === S.layerId;
      if (b.classList.contains("on") !== on) {
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      }
    }
    if (doc.activeElement !== master) {
      const mv = typeof ctx.masterVolume === "number" ? ctx.masterVolume : 1;
      if (Number(master.value) !== mv) master.value = String(mv);
    }
    let marks = "";
    for (const o of OWNED) {
      const el = panel.querySelector(o.sel);
      if (!el) continue;
      const on = o.owned();
      marks += on ? "1" : "0";
      rowOf(el).classList.toggle("gs-owned", on);
    }
    lastMarks = marks;
    outputRefresh?.();
  }
  ensureTap();
  ensureMarks();

  return {
    update,
    open,
    close,
    isOpen,
    setOutputRow,
    get marks() {
      return lastMarks;
    },
    destroy() {
      hostObserver.disconnect();
      guideToggle.removeEventListener("click", onGuide);
      doc.removeEventListener("keydown", onKey);
      ownCleanup?.();
      outputCleanup?.();
      output?.setPressHandler?.(null);
      if (routerHost) doc.getElementById("stage")?.append(routerHost);
      toggle.remove();
      panel.remove();
    },
  };
}
