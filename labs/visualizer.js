// Demo remote visualizer for the Gesture Synth output (milestone 3).
// Open /labs/visualizer.html on the dev server (any machine that can reach the signaling server),
// type the room code shown on the synth's output chip. ?room=XXXX-XX auto-connects;
// ?signal=ws://host:5417 picks the signaling server.
//
// window.__viz exposes everything received (used by tests/output*.spec.js).
//
// Notes pair by id: a /gs/note/on is drawn from its play time until the /gs/note/off with the same id
// (also scheduled at its play time); a /gs/note/cancel (sent before the note would have played) removes the
// pending on/off of that id. /gs/menu events drive the ring (open, arc under the fist, progress, close);
// /gs/mode shows the active mode in its color.

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
  beatsShown: [], //  {beat, local, expected}
  beatgridLog: [], // every beat grid received, {..., recvLocal}
  channelOf: {}, //   address -> "reliable" | "fast" (last seen)
  status: null,
  menu: null, //      last /gs/menu event value while open (null when closed)
  menuEvents: [], //  {phase, arc, selected, confirmed, progress, recvLocal}
  modeLog: [], //     {mode, recvLocal} on each change of /gs/mode
  pinchEvents: [], // {v, recvLocal}
  cancels: [], //     {id, removed, recvLocal}
  active: new Map(), // note id -> {note, voice, on: shownLocal}
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
      viz.beatgridLog.push(viz.beatgrid);
      if (viz.beatgridLog.length > 200) viz.beatgridLog.shift();
      return;
  }
  const type = typeOfAddress(m.a);
  if (type === "event") {
    const recvLocal = performance.now();
    const playLocal = typeof m.t === "number" ? client.toLocal(m.t) : recvLocal;
    const ev = { a: m.a, v: m.v, t: m.t, at: m.at, recvLocal, playLocal, ch };
    viz.events.push(ev);
    if (viz.events.length > 500) viz.events.shift();
    logEvent(ev);
    if (m.a === "/gs/note/cancel") return cancelNote(ev);
    if (m.a === "/gs/menu") return onMenu(ev);
    if (m.a === "/gs/pinch") return onPinch(ev);
    scheduled.push(ev);
  } else {
    viz.stateUpdates++;
    (type === "continuous" ? viz.cont : viz.state)[m.a] = m.v;
    renderState();
  }
}

// A scheduled note that will not play: drop its pending on/off (and switch it off if already shown).
function cancelNote(ev) {
  const id = ev.v && ev.v.id;
  if (id == null) return;
  let removed = 0;
  for (let i = scheduled.length - 1; i >= 0; i--) {
    const s = scheduled[i];
    if ((s.a === "/gs/note/on" || s.a === "/gs/note/off") && s.v && s.v.id === id) {
      scheduled.splice(i, 1);
      removed++;
    }
  }
  if (viz.active.delete(id)) removed++;
  viz.cancels.push({ id, removed, recvLocal: ev.recvLocal });
  if (viz.cancels.length > 200) viz.cancels.shift();
}

function onMenu(ev) {
  const v = ev.v || {};
  viz.menuEvents.push({ ...v, recvLocal: ev.recvLocal });
  if (viz.menuEvents.length > 300) viz.menuEvents.shift();
  viz.menu = v.phase === "close" ? null : v;
  menuClosedAt = v.phase === "close" ? ev.recvLocal : null;
  lastMenuClose = v.phase === "close" ? v : null;
  renderMenuInfo();
}

function onPinch(ev) {
  viz.pinchEvents.push({ v: ev.v, recvLocal: ev.recvLocal });
  if (viz.pinchEvents.length > 200) viz.pinchEvents.shift();
  const on = ev.v === 1;
  $("pinch").classList.toggle("on", on);
  $("pinch").textContent = on ? "on" : "off";
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
    stateUpdates: 0, hello: null, beatgrid: null, events: [], notesShown: [], beatsShown: [], beatgridLog: [], channelOf: {},
    menu: null, menuEvents: [], modeLog: [], pinchEvents: [], cancels: [], active: new Map() });
  scheduled.length = 0;
  lastBeatAt = null;
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

const MODE_COLORS = { chords: "#e8a13d", arp: "#4fb3ff", lead: "#c08cff" };
// Fixed menu directions (docs/architecture.md: chords=up, arp=right, lead=left, down=free).
const MENU_DIRS = { chords: "up", arp: "right", lead: "left" };
const DIR_ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
let shownMode = null;
let menuClosedAt = null;
let lastMenuClose = null;

function renderMode() {
  const mode = viz.state["/gs/mode"] ?? null;
  if (mode !== shownMode) {
    shownMode = mode;
    if (mode != null) viz.modeLog.push({ mode, recvLocal: performance.now() });
    const el = $("modeName");
    el.textContent = mode ? mode[0].toUpperCase() + mode.slice(1) : "—";
    el.dataset.mode = mode || "";
    el.style.setProperty("--mode", MODE_COLORS[mode] || "var(--ink)");
  }
  const parts = [];
  const st = viz.state;
  if (st["/gs/voicing"]) parts.push(`voicing ${st["/gs/voicing"]}`);
  if (mode === "arp" && st["/gs/bpm"]) parts.push(`${st["/gs/bpm"]} BPM`);
  if (mode === "lead") {
    if (st["/gs/noteset"] != null) parts.push(`note set ${st["/gs/noteset"]}`);
    if (st["/gs/octave"] != null) parts.push(`octave ${st["/gs/octave"]}`);
  }
  const sub = parts.join(" · ");
  if ($("modeSub").textContent !== sub) $("modeSub").textContent = sub;
}

function renderMenuInfo() {
  const m = viz.menu;
  const el = $("menuInfo");
  if (m) el.textContent = m.state === "countdown" ? `→ ${m.confirmed} (get ready)` : `open · arc ${m.arc ?? "—"} · ${Math.round((m.progress || 0) * 100)}%`;
  else if (lastMenuClose) el.textContent = lastMenuClose.confirmed ? `closed · switched to ${lastMenuClose.confirmed}` : "closed · cancelled";
  else el.textContent = "menu closed";
}

const mg = $("menu").getContext("2d");
function drawMenu(now) {
  const c = mg.canvas;
  const W = c.width, cx = W / 2, cy = W / 2, R = W * 0.42, r = W * 0.2;
  mg.clearRect(0, 0, W, W);
  const m = viz.menu;
  const fade = !m && menuClosedAt != null ? Math.max(0, 1 - (now - menuClosedAt) / 600) : 0;
  const alpha = m ? 1 : 0.25 + 0.75 * fade;
  for (const [dir, ang] of Object.entries(DIR_ANGLE)) {
    const id = Object.keys(MENU_DIRS).find((k) => MENU_DIRS[k] === dir) || null;
    const color = MODE_COLORS[id] || "#3a3d42";
    const a0 = ang - Math.PI / 4 + 0.06, a1 = ang + Math.PI / 4 - 0.06;
    const hover = m && m.arc === id;
    const selected = (m && (m.selected === id || m.confirmed === id)) || (!m && fade > 0 && lastMenuClose?.confirmed === id);
    const current = viz.state["/gs/mode"] === id;
    mg.globalAlpha = alpha * (hover || selected ? 1 : 0.45);
    // arc band
    mg.beginPath();
    mg.arc(cx, cy, R, a0, a1);
    mg.arc(cx, cy, r, a1, a0, true);
    mg.closePath();
    mg.fillStyle = selected ? color : "#202328";
    mg.fill();
    mg.lineWidth = current ? 5 : 2;
    mg.strokeStyle = color;
    mg.stroke();
    // progress fill of the hovered arc (from the inner edge outwards)
    if (m && hover && !selected && m.progress > 0) {
      const rr = r + (R - r) * Math.min(1, m.progress);
      mg.beginPath();
      mg.arc(cx, cy, rr, a0, a1);
      mg.arc(cx, cy, r, a1, a0, true);
      mg.closePath();
      mg.globalAlpha = alpha * 0.8;
      mg.fillStyle = color;
      mg.fill();
    }
    if (id) {
      mg.globalAlpha = alpha;
      mg.fillStyle = selected ? "#111" : "#e6e6e6";
      mg.font = "bold 22px monospace";
      mg.textAlign = "center";
      mg.textBaseline = "middle";
      const lr = (R + r) / 2;
      mg.fillText(id, cx + Math.cos(ang) * lr, cy + Math.sin(ang) * lr);
    }
  }
  mg.globalAlpha = 1;
  // center: open / closed marker
  mg.beginPath();
  mg.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  mg.fillStyle = m ? (m.state === "countdown" ? MODE_COLORS[m.confirmed] || "#e6e6e6" : "#e6e6e6") : "#2a2d32";
  mg.fill();
}

function renderState() {
  renderMode();
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
const g = $("hands").getContext("2d");
const smooth = {}; // address -> smoothed value (live input arrives with network delay; smooth it)
let lastBeatAt = null;

let beatInfoHtml = "";
const BEAT_CATCH_UP_MS = 60; // a beat onset this recent is still shown when its grid arrives
let prevFrameAt = -Infinity; // previous render frame: an event shown now was due after it (tests check this)
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
  if (bg && bg.running === false && lastBeatAt != null) {
    lastBeatAt = null; // clock stopped: dots off; a restart waits for its first beat onset
    beatEls.forEach((d) => d.classList.remove("on"));
    $("beatInfo").textContent = beatInfoHtml = `${bg.bpm} BPM · clock stopped`;
  }
  if (bg && bg.bpm > 0 && bg.running !== false) {
    const period = 60000 / bg.bpm;
    const ref = client.toLocal(bg.beatTime);
    const n = Math.floor((now - ref) / period);
    const bpb = bg.beatsPerBar || 4;
    ensureBeatDots(bpb);
    const expected = ref + n * period;
    // Compare beat TIMES, not indices: every grid resync moves `ref` to a new beat.
    // A grid that arrives just after its reference beat (e.g. the clock's first beat, ~60 ms after start, on a
    // loaded machine) still shows that beat; one that arrives mid-beat waits for the next onset.
    const catchUp = lastBeatAt == null && n >= 0 && now - expected < BEAT_CATCH_UP_MS;
    if (lastBeatAt == null && !catchUp) {
      lastBeatAt = expected; // grid just arrived mid-beat: wait for the next beat onset
    } else if (catchUp || Math.abs(expected - lastBeatAt) > period / 2) {
      lastBeatAt = expected;
      const idx = (((bg.beat + n) % bpb) + bpb) % bpb;
      beatEls.forEach((d, i) => d.classList.toggle("on", i === idx));
      viz.beatsShown.push({ beat: idx, local: now, expected, prevFrame: prevFrameAt });
      if (viz.beatsShown.length > 200) viz.beatsShown.shift();
    }
    const rate = bg.rate ? ` · 1/${Math.round(1 / bg.rate)}` : "";
    const info = `${bg.bpm} BPM${rate}${bg.double ? ' <span class="x2">x2</span>' : ""} · beat grid synced`;
    if (info !== beatInfoHtml) $("beatInfo").innerHTML = beatInfoHtml = info; // DOM writes only on change
  }
  renderKeys(now);
  drawMenu(now);

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
  prevFrameAt = now;
  $("frameInfo").textContent = viz.frames ? `· ${viz.frames} frames (${viz.framesMissed} dropped)` : "";
  requestAnimationFrame(frame);
}

function fire(ev, now) {
  const isOn = ev.a === "/gs/note/on";
  const isOff = ev.a === "/gs/note/off";
  if ((isOn || isOff) && ev.v && typeof ev.v.note === "number") {
    const id = ev.v.id;
    if (id != null) {
      // Paired by id (the synth's globally unique note id).
      if (isOn) viz.active.set(id, { note: ev.v.note, voice: ev.v.voice, on: now });
      else viz.active.delete(id);
    } else {
      // Legacy sender without ids: count per pitch class.
      const pc = ((ev.v.note % 12) + 12) % 12;
      legacyCount[pc] = Math.max(0, legacyCount[pc] + (isOn ? 1 : -1));
    }
    if (isOn) {
      const pc = ((ev.v.note % 12) + 12) % 12;
      lastOnAt[pc] = now;
      viz.notesShown.push({ note: ev.v.note, voice: ev.v.voice, id, playLocal: ev.playLocal, shownLocal: now, recvLocal: ev.recvLocal, prevFrame: prevFrameAt });
      if (viz.notesShown.length > 500) viz.notesShown.shift();
    }
  }
  if (ev.a === "/gs/beat") viz.beatsShown.push({ beat: ev.v, local: now, event: true });
}

const legacyCount = new Array(12).fill(0);
const lastOnAt = new Array(12).fill(-Infinity);
const MIN_LIT_MS = 70; // very short arp notes still light their key for a few frames
function renderKeys(now) {
  const lit = legacyCount.map((c) => c > 0);
  for (const n of viz.active.values()) lit[((n.note % 12) + 12) % 12] = true;
  for (let pc = 0; pc < 12; pc++) {
    const on = lit[pc] || now - lastOnAt[pc] < MIN_LIT_MS;
    if (keyEls[pc].classList.contains("on") !== on) keyEls[pc].classList.toggle("on", on);
  }
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
