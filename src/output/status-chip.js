// Output status chip (spec "Connection status (Milestone 3)", mock §6) + its settings popover.
//
//   Off        outline pill, empty dot,        "Output off"
//   Waiting    dashed outline, empty dot,      "Code K7QF-2M"
//   Connected  green tint + green dot,         "Direct, 24 ms"
//   Relayed    amber tint + amber dot,         "Relayed, 85 ms"
//
// The delay shown is the one-way estimate (RTT / 2) and changes at most once per second.
// A press opens the settings: output on/off + room code.
//
// This module is tiny and does no per-frame work. The WebRTC output (./webrtc-output.js) is
// loaded with a dynamic import() ONLY when the user turns the output on.
//
// TODO(ui-integration): placement is provisional — just below the volume meter + "Filter: x%"
// readout at the top right. docs/ui-integration.md (UI pass) finalizes where the chip lives
// (the mock puts it at the very top right, next to the chord).

import { defaultSignalUrl, ROOM_CODE_RE } from "./protocol.js";

const DELAY_UPDATE_MS = 1000;
const STYLE_ID = "gs-output-chip-style";

const CSS = `
#outputChip {
  position: absolute; top: 130px; right: 12px; z-index: 6;
  display: inline-flex; align-items: center; gap: 7px;
  height: 26px; padding: 0 11px 0 9px; border-radius: 13px;
  font: 12px/1 monospace; letter-spacing: 0.02em; white-space: nowrap;
  color: rgba(235,235,235,0.92); background: rgba(16,16,16,0.72);
  border: 1.5px solid rgba(235,235,235,0.55); cursor: pointer;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  transition: background-color 150ms, border-color 150ms;
}
#outputChip:focus-visible { outline: 2px solid rgba(235,235,235,0.8); outline-offset: 2px; }
#outputChip .dot { width: 9px; height: 9px; border-radius: 50%; box-sizing: border-box;
  border: 1.5px solid currentColor; background: transparent; flex: none; }
#outputChip[data-state="off"] { color: rgba(235,235,235,0.7); }
#outputChip[data-state="waiting"] { border-style: dashed; }
#outputChip[data-state="connected"] { border-color: #3ecf6e; background: rgba(36,110,62,0.45); }
#outputChip[data-state="connected"] .dot { background: #3ecf6e; border-color: #3ecf6e; }
#outputChip[data-state="relayed"] { border-color: #e8a13d; background: rgba(130,86,20,0.45); }
#outputChip[data-state="relayed"] .dot { background: #e8a13d; border-color: #e8a13d; }

#outputPopover {
  position: absolute; top: 162px; right: 12px; z-index: 7; width: 230px; box-sizing: border-box;
  padding: 12px 14px; border-radius: 8px; font: 12px/1.4 monospace;
  color: rgba(235,235,235,0.92); background: rgba(18,18,18,0.94); border: 1px solid rgba(235,235,235,0.25);
  box-shadow: 0 6px 24px rgba(0,0,0,0.5);
}
#outputPopover.hidden { display: none; }
#outputPopover h4 { margin: 0 0 8px; font-size: 12px; font-weight: bold; letter-spacing: 0.04em; }
#outputPopover label.row { display: flex; align-items: center; justify-content: space-between; cursor: pointer; }
#outputPopover .code { margin: 10px 0 2px; font-size: 22px; letter-spacing: 0.08em; font-weight: bold; }
#outputPopover .muted { color: rgba(235,235,235,0.55); font-size: 11px; }
#outputPopover #outputServer { word-break: break-all; }
#outputPopover button { margin-top: 8px; font: 11px monospace; color: inherit; background: #262626;
  border: 1px solid rgba(235,235,235,0.3); border-radius: 4px; padding: 3px 8px; cursor: pointer; }
#outputPopover button:disabled { opacity: 0.4; cursor: default; }
`;

/**
 * @param {{
 *   bus: any, ctx: any, parent: HTMLElement,
 *   load?: () => Promise<typeof import("./webrtc-output.js")>,
 *   signalUrl?: string, forceRelay?: boolean, now?: () => number,
 * }} opts
 */
export function mountStatusChip({
  bus,
  ctx,
  parent,
  load = () => import("./webrtc-output.js"),
  signalUrl = defaultSignalUrl(location, import.meta.env || {}),
  forceRelay = new URLSearchParams(location.search).has("outputRelay"),
  now = () => performance.now(),
}) {
  const doc = parent.ownerDocument;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  const chip = doc.createElement("button");
  chip.id = "outputChip";
  chip.type = "button";
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");
  chip.innerHTML = `<span class="dot"></span><span class="label"></span>`;
  const labelEl = chip.querySelector(".label");

  const pop = doc.createElement("div");
  pop.id = "outputPopover";
  pop.className = "hidden";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Output settings");
  pop.innerHTML = `
    <h4>Visualizer output</h4>
    <label class="row">Output <input type="checkbox" id="outputToggle"></label>
    <div class="code" id="outputRoomCode">----</div>
    <div class="muted" id="outputStatusText">Off</div>
    <button type="button" id="outputNewCode" disabled>New code</button>
    <div class="muted" style="margin-top:8px">Type the code in the visualizer.<br>Server: <span id="outputServer"></span></div>`;
  const toggleEl = pop.querySelector("#outputToggle");
  const codeEl = pop.querySelector("#outputRoomCode");
  const statusTextEl = pop.querySelector("#outputStatusText");
  const newCodeEl = pop.querySelector("#outputNewCode");
  pop.querySelector("#outputServer").textContent = signalUrl;

  parent.appendChild(chip);
  parent.appendChild(pop);

  let output = null;
  let loading = null;
  let status = { state: "off", room: null, rttMs: null };
  let shownDelay = null;
  let delayShownAt = -Infinity;
  let lastState = null;
  let stateChangedAt = Date.now();

  function delayText() {
    const rtt = status.rttMs;
    if (rtt == null) return null;
    const t = now();
    if (shownDelay == null || lastState !== status.state || t - delayShownAt >= DELAY_UPDATE_MS) {
      shownDelay = Math.max(1, Math.round(rtt / 2));
      delayShownAt = t;
    }
    return `${shownDelay} ms`;
  }

  function render() {
    const s = status.state;
    const visual = s === "connecting" ? "waiting" : s;
    if (s !== lastState) { shownDelay = null; }
    let text;
    if (s === "off") text = "Output off";
    else if (s === "connecting" || s === "waiting") text = status.room ? `Code ${status.room}` : "Waiting…";
    else {
      const d = delayText();
      text = `${s === "connected" ? "Direct" : "Relayed"}${d ? `, ${d}` : ""}`;
    }
    lastState = s;
    if (chip.dataset.state !== visual) stateChangedAt = Date.now();
    chip.dataset.state = visual;
    if (labelEl.textContent !== text) labelEl.textContent = text;
    chip.title = `Visualizer output: ${s}`;

    toggleEl.checked = s !== "off";
    codeEl.textContent = status.room && ROOM_CODE_RE.test(status.room) ? status.room : "----";
    newCodeEl.disabled = s === "off";
    statusTextEl.textContent =
      s === "off" ? "Off" :
      s === "connecting" ? (status.signaling === false ? "Connecting to server…" : "Waiting…") :
      s === "waiting" ? (status.signaling ? "Waiting for a visualizer" : "Server unreachable, retrying…") :
      `${s === "connected" ? "Direct" : "Relayed"} · ${status.peers} visualizer${status.peers === 1 ? "" : "s"}`;
  }

  // Re-render once a second while connected so the delay number can move (throttled above).
  let tick = null;
  function onStatus(s) {
    status = s;
    render();
    const live = s.state === "connected" || s.state === "relayed";
    if (live && !tick) tick = setInterval(render, DELAY_UPDATE_MS);
    if (!live && tick) { clearInterval(tick); tick = null; }
  }

  async function setOutput(on) {
    if (on) {
      if (output || loading) return loading;
      status = { state: "connecting", room: null, rttMs: null, signaling: false };
      render();
      loading = load().then(({ createWebRtcOutput }) => {
        loading = null;
        if (!toggleWanted) return null;
        output = createWebRtcOutput({
          bus,
          signalUrl,
          forceRelay,
          getAudioContext: () => (ctx && ctx.audio ? ctx.audio.ac : null) || null,
          getClock: () => (ctx ? ctx.clock : null),
          onStatus,
        });
        output.start();
        return output;
      });
      return loading;
    }
    if (output) { output.stop(); output = null; }
    onStatus({ state: "off", room: null, rttMs: null });
  }

  let toggleWanted = false;
  toggleEl.addEventListener("change", () => {
    toggleWanted = toggleEl.checked;
    setOutput(toggleWanted);
  });
  newCodeEl.addEventListener("click", () => output && output.newRoom());

  function openPopover(open) {
    pop.classList.toggle("hidden", !open);
    chip.setAttribute("aria-expanded", String(open));
  }
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover(pop.classList.contains("hidden"));
  });
  pop.addEventListener("click", (e) => e.stopPropagation());
  doc.addEventListener("click", () => openPopover(false));
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") openPopover(false); });

  render();

  return {
    el: chip,
    popover: pop,
    /** Turn the output on/off (same as the toggle in the popover). */
    setOutput(on) {
      toggleWanted = !!on;
      return setOutput(toggleWanted);
    },
    get output() { return output; },
    get status() { return status; },
    get state() { return chip.dataset.state; },
    /** Date.now() when the chip's visual state last changed (tests measure "< 1 s"). */
    get stateChangedAt() { return stateChangedAt; },
  };
}
