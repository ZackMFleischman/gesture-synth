// Radial menu lab: the mouse drives a fake right-hand HandFrame.
//   mousedown = fist at the cursor, move = fist moves, mouseup = open hand.
// URL flags: ?manualClock (time only advances via __menuLab.step(ms)), ?noCamera (dark backdrop only).

import { createRadialMenu, playTick } from "../src/menu/radial-menu.js";

const params = new URLSearchParams(location.search);
const MANUAL = params.has("manualClock");

const ICONS = {
  chords: "M5 7h14M5 12h14M5 17h14",
  arp: "M4 18h4v-4h4v-4h4V6h4",
  lead: "M10 18V5l8 3M10 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0",
};
const ITEMS = [
  { id: "chords", type: "mode", label: "Chords", icon: ICONS.chords, color: "#f2b14c", direction: "up" },
  { id: "arp", type: "mode", label: "Arp", icon: ICONS.arp, color: "#4fb3ff", direction: "right" },
  { id: "lead", type: "mode", label: "Lead", icon: ICONS.lead, color: "#5fd08a", direction: "left" },
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
  items: () => ITEMS,
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
  const it = ITEMS.find((i) => i.id === id);
  badge.textContent = it.label;
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
  if (r.cancelled) log(`cancelled (${r.reason})`);
  if (r.finished) log("countdown done");
  last = r;
  statusEl.textContent = `${r.state}${r.hoverId ? ` · ${r.hoverId} ${(r.progress * 100).toFixed(0)}%` : ""}${r.selectedId ? ` · selected ${r.selectedId}` : ""}`;
  statusEl.dataset.state = r.state;

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
