// Radial menu lab: the mouse drives a fake right-hand HandFrame.
//   mousedown = fist at the cursor, move = fist moves, mouseup = open hand.
// URL flags: ?manualClock (time only advances via __menuLab.step(ms)), ?noCamera (dark backdrop only).

import { createRadialMenu, playTick } from "../src/menu/radial-menu.js";

const params = new URLSearchParams(location.search);
const MANUAL = params.has("manualClock");

const ICONS = {
  // three stacked noteheads (a triad) on one stem
  chords:
    "M16 4v14M9 18a3 2.3 0 1 0 6 0a3 2.3 0 1 0-6 0M9 12.5a3 2.3 0 1 0 6 0a3 2.3 0 1 0-6 0M9 7a3 2.3 0 1 0 6 0a3 2.3 0 1 0-6 0",
  arp: "M4 18h4v-4h4v-4h4V6h4",
  lead: "M10 18V5l8 3M10 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0",
  sound: "M4 10v4h3l5 4V6L7 10H4M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11",
};
const MODES = [
  { id: "chords", type: "mode", label: "Chords", icon: ICONS.chords, color: "#e8a13d", direction: "up" },
  { id: "arp", type: "mode", label: "Arp", icon: ICONS.arp, color: "#4fb3ff", direction: "right" },
  { id: "lead", type: "mode", label: "Lead", icon: ICONS.lead, color: "#c08cff", direction: "left" },
];
// Sub-ring children, in fan order: next to the back sector (up-left), around the bottom, to up-right.
const INSTRUMENTS = [
  { id: "warm", label: "Warm", icon: "M3 15l4.5-6 4.5 6 4.5-6 4.5 6" },
  { id: "bright", label: "Bright", icon: "M3 16l6-8v8l6-8v8l6-8" },
  { id: "retro", label: "Retro", icon: "M3 16V8h4.5v8H12V8h4.5v8H21" },
  { id: "organ", label: "Organ", icon: "M5 20V10M9.5 20V6M14 20V4M18.5 20V8M3 20h18" },
  { id: "electric", label: "Electric", icon: "M13 3L6 13h5l-1 8 7-10h-5l1-8" },
  { id: "sax", label: "Sax", icon: "M9 3v11a4 4 0 0 0 8 0v-2M9 6.5h3M9 10h3" },
];
// Which instrument the Sound arc sets: the base mode's, or the lead's while Lead is on (Phase 2 semantics).
const sounds = { chords: "warm", arp: "warm", lead: "bright" };
const soundTarget = () => currentId;
const modeOf = (id) => MODES.find((m) => m.id === id);
const ITEMS_FN = () => [
  ...MODES,
  {
    id: "sound",
    type: "submenu",
    label: currentId === "lead" ? "Lead sound" : "Sound",
    icon: ICONS.sound,
    color: modeOf(currentId).color, // the mode color stays the accent; instruments are color-neutral
    direction: "down",
    setting: `sound/${currentId === "lead" ? "lead" : "base"}`,
    items: INSTRUMENTS,
    current: () => sounds[soundTarget()],
  },
];

const canvas = document.getElementById("canvas");
const g = canvas.getContext("2d");
const video = document.getElementById("video");
const badge = document.getElementById("badge");
const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const sizeEl = document.getElementById("size");
const sizeVal = document.getElementById("sizeVal");
const dropBtn = document.getElementById("drop");

let currentId = "chords";
let audio = null;
const events = [];
const pointer = { x: 0.5, y: 0.5, down: false, seen: false };
let handSize = Number(sizeEl.value);
let dropped = false;

const menu = createRadialMenu({
  items: ITEMS_FN,
  currentId: () => currentId,
  onTick: () => {
    log("tick");
    if (audio) playTick(audio);
  },
});

// ---- camera (Chrome fake camera in tests) or plain backdrop ---------------------------
if (!params.has("noCamera") && navigator.mediaDevices?.getUserMedia) {
  navigator.mediaDevices
    .getUserMedia({ video: { width: 1280, height: 720 } })
    .then((s) => (video.srcObject = s))
    .catch(() => {});
}

// ---- sizing --------------------------------------------------------------------------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize);
resize();
const toCanvas = (p) => ({ x: p.x * innerWidth, y: p.y * innerHeight });

// ---- input ---------------------------------------------------------------------------
function setPointer(e) {
  pointer.x = e.clientX / innerWidth;
  pointer.y = e.clientY / innerHeight;
  pointer.seen = true;
}
canvas.addEventListener("pointermove", setPointer);
canvas.addEventListener("pointerdown", (e) => {
  setPointer(e);
  pointer.down = true;
  canvas.setPointerCapture?.(e.pointerId);
  if (!audio) {
    try {
      audio = new AudioContext();
    } catch {}
  }
});
const up = (e) => {
  if (e) setPointer(e);
  pointer.down = false;
};
canvas.addEventListener("pointerup", up);
canvas.addEventListener("pointercancel", () => (pointer.down = false));

sizeEl.addEventListener("input", () => {
  handSize = Number(sizeEl.value);
  sizeVal.textContent = handSize.toFixed(3).replace(/0$/, "");
});
dropBtn.addEventListener("click", () => {
  dropped = !dropped;
  dropBtn.setAttribute("aria-pressed", String(dropped));
  dropBtn.textContent = dropped ? "Restore tracking" : "Drop tracking";
  log(dropped ? "tracking dropped" : "tracking restored");
});

function fakeRight(now) {
  if (dropped || !pointer.seen) return null;
  const fist = pointer.down;
  const thumb = fist ? Math.random() < 0.5 : true; // thumb flickers in a fist: must not matter
  const fingers = { thumb, index: !fist, middle: !fist, ring: !fist, pinky: !fist };
  return {
    handedness: "Right",
    landmarks: [],
    fingers,
    fingerCount: Object.values(fingers).filter(Boolean).length,
    voicingCount: fist ? 0 : 4,
    fist,
    pinch: false,
    pinchDistance: 1,
    height: 1 - pointer.y,
    tilt: 0,
    pos: { x: pointer.x, y: pointer.y },
    handSize,
    t: now,
  };
}

// ---- UI ------------------------------------------------------------------------------
function setBadge(id) {
  const it = MODES.find((i) => i.id === id);
  const inst = INSTRUMENTS.find((i) => i.id === sounds[soundTarget()]);
  badge.textContent = `${it.label} · ${inst ? inst.label : "?"}`;
  badge.dataset.sound = sounds[soundTarget()];
  badge.style.background = hexA(it.color, 0.15);
  badge.style.borderColor = it.color;
  badge.dataset.mode = id;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function log(msg) {
  const t = (performance.now() / 1000).toFixed(2);
  events.push(msg);
  const row = document.createElement("div");
  row.innerHTML = `<b>${msg}</b> <span>${t}s</span>`;
  logEl.insertBefore(row, logEl.children[1] || null);
  while (logEl.children.length > 9) logEl.lastChild.remove();
}
setBadge(currentId);

// ---- frame ---------------------------------------------------------------------------
let last = { state: "closed" };
function frame(now) {
  const right = fakeRight(now);
  const r = menu.update(right, now);
  if (r.opened) log("opened");
  if (r.confirmed) {
    currentId = r.confirmed;
    setBadge(currentId); // badge switches at the start of the countdown
    log(`confirmed: ${r.confirmed}`);
  }
  if (r.entered) log(`submenu: ${r.entered}`);
  if (r.back) log("back");
  if (r.setting) {
    sounds[soundTarget()] = r.setting.value;
    setBadge(currentId);
    log(`set ${r.setting.key}: ${r.setting.value}`);
  }
  if (r.cancelled) log(`cancelled (${r.reason})`);
  if (r.finished) log(last.state === "flash" ? "setting done" : "countdown done");
  last = r;
  statusEl.textContent = `${r.state}${r.level ? ` · ${r.path.join("/")}` : ""}${r.hoverId ? ` · ${r.hoverId} ${(r.progress * 100).toFixed(0)}%` : ""}${r.selectedId ? ` · selected ${r.selectedId}` : ""}`;
  statusEl.dataset.state = r.state;
  statusEl.dataset.level = String(r.level ?? 0);

  g.clearRect(0, 0, innerWidth, innerHeight);
  if (right && !menu.isHoldingRight()) drawHand(right);
  menu.draw(g, { toCanvas, now: () => now });
}

function drawHand(h) {
  const p = toCanvas(h.pos);
  const r = h.handSize * innerWidth * (h.fist ? 0.22 : 0.32);
  g.save();
  g.beginPath();
  g.arc(p.x, p.y, r, 0, Math.PI * 2);
  g.lineWidth = 1.5;
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.setLineDash(h.fist ? [] : [3, 4]);
  g.stroke();
  if (h.fist) {
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.fill();
  }
  g.restore();
}

let manualNow = 1000;
function loop(t) {
  if (!MANUAL) frame(t);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---- test hooks ----------------------------------------------------------------------
window.__menuLab = {
  menu,
  events,
  get last() {
    return last;
  },
  get currentId() {
    return currentId;
  },
  sounds,
  /** manual clock: advance `ms` in 16 ms frames */
  step(ms = 16) {
    const end = manualNow + ms;
    while (manualNow < end) {
      manualNow = Math.min(end, manualNow + 16);
      frame(manualNow);
    }
    return last;
  },
};
