// Demo remote visualizer for the Gesture Synth output (milestone 3).
// Open /labs/visualizer.html on the dev server (any machine that can reach the signaling server),
// type the room code shown on the synth's output chip. ?room=XXXX-XX auto-connects;
// ?signal=ws://host:5417 picks the signaling server.
//
// window.__viz exposes everything received (used by tests/output.spec.js).

import { createViewerClient } from "../src/output/viewer-client.js";
import { SYS, defaultSignalUrl, normalizeRoomCode } from "../src/output/protocol.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const signalUrl = defaultSignalUrl(location, import.meta.env || {});

// ---------------------------------------------------------------- received data
const viz = {
  manifest: [],
  state: {}, //       address -> value (state signals)
  cont: {}, //        address -> value (continuous signals, latest)
  frames: 0,
  frameSeq: 0,
  framesMissed: 0,
  snapshots: 0,
  stateUpdates: 0,
  hello: null,
  beatgrid: null,
  events: [], //      {a, v, t, at, recvLocal, playLocal, ch}
  notesShown: [], //  {note, voice, playLocal, shownLocal}
  beatsShown: [], //  {beat, local}
  channelOf: {}, //   address -> "reliable" | "fast" (last seen)
  status: null,
};
window.__viz = viz;

const client = createViewerClient({ signalUrl, onMessage, onStatus });
viz.client = client;

function onMessage(m, ch) {
  viz.channelOf[m.a] = ch;
  switch (m.a) {
    case SYS.hello:
      viz.hello = m.v;
      return;
    case SYS.manifest:
      viz.manifest = m.v;
      renderManifest();
      return;
    case SYS.state:
      viz.snapshots++;
      Object.assign(viz.state, m.v.state);
      Object.assign(viz.cont, m.v.continuous);
      renderState();
      return;
    case SYS.frame:
      viz.frames++;
      if (viz.frameSeq && m.n > viz.frameSeq + 1) viz.framesMissed += m.n - viz.frameSeq - 1;
      viz.maxFrameKeys = Math.max(viz.maxFrameKeys || 0, Object.keys(m.v).length);
      if (m.n > viz.frameSeq) {
        viz.frameSeq = m.n;
        Object.assign(viz.cont, m.v);
      }
      return;
    case SYS.beatgrid:
      viz.beatgrid = { ...m.v, recvLocal: performance.now() };
      return;
  }
  const type = typeOfAddress(m.a);
  if (type === "event") {
    const recvLocal = performance.now();
    const playLocal = typeof m.t === "number" ? client.toLocal(m.t) : recvLocal;
    const ev = { a: m.a, v: m.v, t: m.t, at: m.at, recvLocal, playLocal, ch };
    viz.events.push(ev);
    if (viz.events.length > 500) viz.events.shift();
    scheduled.push(ev);
    logEvent(ev);
  } else {
    viz.stateUpdates++;
    (type === "continuous" ? viz.cont : viz.state)[m.a] = m.v;
    renderState();
  }
}

function typeOfAddress(a) {
  const s = viz.manifest.find((x) => x.address === a);
  return s ? s.type : "event";
}

function onStatus(s) {
  const prev = viz.status ? viz.status.state : null;
  viz.status = s;
  if (s.state !== prev) {
    // wall-clock stamps (Date.now) so tests can compare with the synth page
    if (s.state === "waiting") viz.joinedAt = Date.now();
    if (s.state === "direct" || s.state === "relay") viz.readyAt = Date.now();
  }
  const el = $("conn");
  el.dataset.state = s.state === "relay" ? "relay" : s.state;
  $("connText").textContent =
    s.state === "direct" ? "Direct" :
    s.state === "relay" ? "Relayed" :
    s.state === "waiting" ? `Waiting for synth (${s.room})` :
    s.state === "error" ? `${s.error} (${s.room}) — retrying` :
    s.state === "idle" ? "Not connected" : "Connecting…";
  $("stats").textContent = s.synced
    ? `RTT ${s.rttMs.toFixed(1)} ms · offset ${s.offsetMs.toFixed(1)} ms · ${s.samples} pings · rx ${s.counts.reliable} reliable / ${s.counts.fast} fast`
    : "";
  $("connect").textContent = s.state === "idle" ? "Connect" : "Disconnect";
}

// ---------------------------------------------------------------- UI
const roomEl = $("room");
roomEl.value = params.get("room") || "";
$("connect").addEventListener("click", () => {
  if (client.status.state === "idle") connect();
  else client.disconnect();
});
roomEl.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
function connect() {
  const code = normalizeRoomCode(roomEl.value);
  if (!code) return;
  roomEl.value = code;
  resetData();
  client.connect(code);
}
function resetData() {
  Object.assign(viz, { manifest: [], state: {}, cont: {}, frames: 0, frameSeq: 0, framesMissed: 0, snapshots: 0,
    stateUpdates: 0, hello: null, beatgrid: null, events: [], notesShown: [], beatsShown: [], channelOf: {} });
  scheduled.length = 0;
  renderManifest();
  renderState();
  $("events").textContent = "";
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const keysEl = $("keys");
const keyEls = NOTE_NAMES.map((n) => {
  const d = document.createElement("div");
  d.textContent = n;
  keysEl.appendChild(d);
  return d;
});
const beatsEl = $("beats");
let beatEls = [];
function ensureBeatDots(n) {
  if (beatEls.length === n) return;
  beatsEl.textContent = "";
  beatEls = Array.from({ length: n }, () => {
    const d = document.createElement("div");
    d.className = "b";
    beatsEl.appendChild(d);
    return d;
  });
}
ensureBeatDots(4);

const METERS = [
  ["volume", "/gs/volume", 0, 1],
  ["filter", "/gs/filter", -1, 1],
  ["gate", "/gs/gate", 0, 1],
  ["left height", "/gs/left/height", 0, 1],
  ["right height", "/gs/right/height", 0, 1],
  ["left tilt", "/gs/left/tilt", -1, 1],
  ["right tilt", "/gs/right/tilt", -1, 1],
];
const meterEls = METERS.map(([label, , min]) => {
  const l = document.createElement("div");
  l.textContent = label;
  const bar = document.createElement("div");
  bar.className = `bar${min < 0 ? " center" : ""}`;
  const fill = document.createElement("i");
  bar.appendChild(fill);
  const val = document.createElement("div");
  val.className = "muted";
  $("meters").append(l, bar, val);
  return { fill, val };
});

function renderManifest() {
  $("manifestCount").textContent = viz.manifest.length ? `(${viz.manifest.length})` : "";
  $("manifest").innerHTML = viz.manifest
    .map((s) => `<tr><td>${esc(s.address)}</td><td>${esc(s.type)}</td><td>${esc(s.owner || "")}</td></tr>`)
    .join("");
}

function fmt(v) {
  if (v == null) return "—";
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (Array.isArray(v)) return `[${v.map(fmt).join(", ")}]`;
  if (typeof v === "object") {
    if ("name" in v && "degree" in v) return `${v.name} · degree ${v.degree} ${v.major ? "maj" : "min"} · root ${v.root}`;
    return JSON.stringify(v);
  }
  return String(v);
}

function renderState() {
  const keys = ["/gs/mode", "/gs/chord", "/gs/voicing", "/gs/bpm", "/gs/noteset", "/gs/octave"];
  const rest = Object.keys(viz.state).filter((k) => !keys.includes(k)).sort();
  $("state").innerHTML = [...keys, ...rest]
    .map((k) => `<tr><td>${esc(k.replace("/gs/", ""))}</td><td>${esc(fmt(viz.state[k]))}</td></tr>`)
    .join("");
}

function logEvent(ev) {
  const lead = ev.playLocal - ev.recvLocal;
  const div = document.createElement("div");
  div.textContent = `${ev.a.replace("/gs/", "")} ${fmt(ev.v)}  ${lead >= 0 ? `+${lead.toFixed(0)} ms early` : `${lead.toFixed(0)} ms late`} · ${ev.ch}`;
  const box = $("events");
  box.prepend(div);
  while (box.childNodes.length > 40) box.lastChild.remove();
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// ---------------------------------------------------------------- render loop
const scheduled = []; // events waiting for their play time
const activeNotes = new Map(); // pitch class -> count
const g = $("hands").getContext("2d");
const smooth = {}; // address -> smoothed value (live input arrives with network delay; smooth it)
let lastBeatAt = null;

function frame() {
  const now = performance.now();

  // Events at their scheduled play time (synced clock).
  for (let i = 0; i < scheduled.length; ) {
    const ev = scheduled[i];
    if (ev.playLocal <= now) {
      scheduled.splice(i, 1);
      fire(ev, now);
    } else i++;
  }

  // Beat grid -> own beat clock (no network delay).
  const bg = viz.beatgrid;
  if (bg && bg.bpm > 0 && bg.running !== false) {
    const period = 60000 / bg.bpm;
    const ref = client.toLocal(bg.beatTime);
    const n = Math.floor((now - ref) / period);
    const bpb = bg.beatsPerBar || 4;
    ensureBeatDots(bpb);
    const expected = ref + n * period;
    // Compare beat TIMES, not indices: every grid resync moves `ref` to a new beat.
    if (lastBeatAt == null) {
      lastBeatAt = expected; // grid just arrived mid-beat: wait for the next beat onset
    } else if (Math.abs(expected - lastBeatAt) > period / 2) {
      lastBeatAt = expected;
      const idx = (((bg.beat + n) % bpb) + bpb) % bpb;
      beatEls.forEach((d, i) => d.classList.toggle("on", i === idx));
      viz.beatsShown.push({ beat: idx, local: now, expected });
      if (viz.beatsShown.length > 200) viz.beatsShown.shift();
    }
    $("beatInfo").textContent = `${bg.bpm} BPM · beat grid synced`;
  }

  // Meters (smoothed).
  METERS.forEach(([, addr, min, max], i) => {
    const v = viz.cont[addr];
    const { fill, val } = meterEls[i];
    if (typeof v !== "number") { fill.style.width = "0"; val.textContent = "—"; return; }
    const s = (smooth[addr] = smooth[addr] == null ? v : smooth[addr] + (v - smooth[addr]) * 0.5);
    if (min < 0) {
      const c = 50, w = (Math.abs(s) / (max - min)) * 100;
      fill.style.left = `${s >= 0 ? c : c - w}%`;
      fill.style.width = `${w}%`;
    } else {
      fill.style.left = "0";
      fill.style.width = `${((s - min) / (max - min)) * 100}%`;
    }
    val.textContent = v.toFixed(2);
  });

  drawHands();
  $("frameInfo").textContent = viz.frames ? `· ${viz.frames} frames (${viz.framesMissed} dropped)` : "";
  requestAnimationFrame(frame);
}

function fire(ev, now) {
  const isOn = ev.a === "/gs/note/on";
  const isOff = ev.a === "/gs/note/off";
  if ((isOn || isOff) && ev.v && typeof ev.v.note === "number") {
    const pc = ((ev.v.note % 12) + 12) % 12;
    const c = (activeNotes.get(pc) || 0) + (isOn ? 1 : -1);
    activeNotes.set(pc, Math.max(0, c));
    keyEls[pc].classList.toggle("on", c > 0);
    if (isOn) {
      viz.notesShown.push({ note: ev.v.note, voice: ev.v.voice, playLocal: ev.playLocal, shownLocal: now, recvLocal: ev.recvLocal });
      if (viz.notesShown.length > 500) viz.notesShown.shift();
      if (ev.v.voice !== "chords") {
        // one-shot voices: brief flash even without a note/off
        setTimeout(() => { if (!activeNotes.get(pc)) keyEls[pc].classList.remove("on"); }, 120);
      }
    }
  }
  if (ev.a === "/gs/beat") viz.beatsShown.push({ beat: ev.v, local: now, event: true });
}

function drawHands() {
  const c = g.canvas;
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = "#1d2024";
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo((c.width * i) / 4, 0); g.lineTo((c.width * i) / 4, c.height); g.stroke();
    g.beginPath(); g.moveTo(0, (c.height * i) / 4); g.lineTo(c.width, (c.height * i) / 4); g.stroke();
  }
  for (const [side, color] of [["left", "#4fb3ff"], ["right", "#ff6fae"]]) {
    const p = viz.cont[`/gs/${side}/pos`];
    if (!Array.isArray(p)) continue;
    const key = `/gs/${side}/pos`;
    const s = (smooth[key] = smooth[key] ? [smooth[key][0] + (p[0] - smooth[key][0]) * 0.5, smooth[key][1] + (p[1] - smooth[key][1]) * 0.5] : p);
    const x = s[0] * c.width, y = s[1] * c.height;
    g.fillStyle = color;
    g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#e6e6e6";
    g.font = "13px monospace";
    g.fillText(side, x + 20, y + 4);
  }
  const mode = viz.state["/gs/mode"];
  const chord = viz.state["/gs/chord"];
  g.fillStyle = "#e6e6e6";
  g.font = "bold 28px monospace";
  if (chord && chord.name) g.fillText(chord.name, 16, 40);
  g.font = "13px monospace";
  g.fillStyle = "#8a8f98";
  if (mode) g.fillText(`mode: ${mode}${viz.state["/gs/voicing"] ? ` · voicing ${viz.state["/gs/voicing"]}` : ""}`, 16, 62);
}

renderState();
requestAnimationFrame(frame);
if (roomEl.value) connect();
