// Mobile UI lab: the REAL existing UI (index.html markup + CSS, mounted by ui-lab.js) + the planned modes chrome
// (ui-lab.css / ui-lab.js states) with the mobile system from src/ui/mobile/ applied on top.
//
//   /labs/mobile-lab.html?m=<state>[&layout=mobile|desktop][&clean][&debug][&swap][&bg=bright]
//     m        one of STATES below (default playing-collapsed); landscape = just use a landscape viewport
//     layout   force the mobile system on/off (default: its media query decides)
//     clean    hide the lab's state switcher (tests)
//
// The lab wires stand-ins for the click handlers controls.js / the modes UI own in the app (guide toggle,
// help, controls toggle, mode badge), so the mobile chrome can be exercised end to end.

import { mountMobileUI } from "../src/ui/mobile/mobile-ui.js";

/** Mobile state -> ui-lab state + what the mobile system should do. */
export const STATES = {
  "playing-collapsed": { lab: "chords-play", playing: true },
  expanded: { lab: "chords-play", playing: false, expand: true },
  "controls-sheet": { lab: "controls-panel-open", playing: false },
  "guide-sheet": { lab: "guide-open", playing: true },
  help: { lab: "chords-play", playing: false, help: true },
  "minimal-hud": { lab: "arp-play", playing: true, minimal: true },
  "mode-chords": { lab: "chords-play", playing: true },
  "mode-arp": { lab: "arp-play", playing: true },
  "mode-lead": { lab: "lead-preview", playing: true },
  menu: { lab: "menu-selected", playing: true },
};

const params = new URLSearchParams(location.search);
const name = STATES[params.get("m")] ? params.get("m") : "playing-collapsed";
const def = STATES[name];
if (params.has("clean")) document.body.classList.add("mlab-clean");

// ui-lab.js reads its state from the URL when it loads.
const q = new URLSearchParams(location.search);
q.set("state", def.lab);
q.set("clean", "");
history.replaceState(null, "", `?${q.toString().replace(/=(&|$)/g, "$1")}`);
await import("./ui-lab.js");

// ---- Stand-ins for the app's handlers (controls.js + modes UI) ----
const $ = (id) => document.getElementById(id);
const guide = $("gestureGuide");
const panel = $("controlsPanel");
const setGuide = (open) => {
  guide.classList.toggle("hidden", !open);
  $("guideToggle").textContent = open ? "Close Guide" : "Open Guide";
  if (open) setPanel(false);
};
const setPanel = (open) => {
  panel.classList.toggle("hidden", !open);
  $("controlsToggle").setAttribute("aria-pressed", String(open));
  if (open) setGuide(false);
};
$("guideToggle").addEventListener("click", () => setGuide(guide.classList.contains("hidden")));
$("controlsToggle").addEventListener("click", () => setPanel(panel.classList.contains("hidden")));
$("modeBadge").addEventListener("click", () => setPanel(true));
$("helpButton").addEventListener("click", () => $("helpModal").classList.remove("hidden"));
$("closeHelp").addEventListener("click", (e) => (e.stopPropagation(), $("helpModal").classList.add("hidden")));
$("helpModal").addEventListener("click", (e) => e.target === $("helpModal") && $("helpModal").classList.add("hidden"));

// ---- Mobile system ----
// In-memory storage: lab states must not leak into each other (the app uses localStorage).
const mem = new Map();
const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
const force = ["mobile", "desktop"].includes(params.get("layout")) ? params.get("layout") : null;
const mobile = mountMobileUI({ storage, force, intro: false });
mobile.setPlaying(def.playing);
if (def.minimal) mobile.setMinimal(true);
if (def.expand) mobile.expand();
if (def.help) mobile.openSheet("help");

// ---- Lab switcher ----
const bar = $("mobileLabBar");
for (const s of Object.keys(STATES)) {
  const a = document.createElement("a");
  const p = new URLSearchParams(params);
  p.set("m", s);
  p.delete("state");
  p.delete("clean");
  a.href = `?${p.toString().replace(/=(&|$)/g, "$1")}`;
  a.textContent = s;
  if (s === name) a.className = "on";
  bar.append(a);
}

window.__mobileLab = { ready: true, state: name, mobile };
