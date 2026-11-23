// Gesture test page (dev tool, M0 0.3): live HandFrame values per hand, threshold sliders that
// live-edit hand-input.js, flicker counters, and record/replay of raw MediaPipe results.
//
// Sources: camera + MediaPipe (default), ?mockHands (window.__gsTest.results, for tests),
// ?replay=<url> (a recording, real time; &replayLoop to repeat).
// All classification comes from src/input/hand-input.js — this page only displays it.

import { createBus } from "../src/core/bus.js";
import {
  createHandInput, makeView, toDisplay, displayDistance, thumbOffset, FINGERS,
  getThresholds, setThresholds, DEFAULT_THRESHOLDS,
} from "../src/input/hand-input.js";
import { setupCamera, setupHandLandmarker } from "../src/input/camera.js";
import { createRecorder, downloadRecording, loadRecording, createReplaySource } from "../src/input/replay.js";
import { drawFrame } from "../src/ui/overlay.js";

const params = new URLSearchParams(location.search);
const MOCK = params.has("mockHands");
const REPLAY_URL = params.get("replay");
const SIDES = ["Left", "Right"];
const FLICKER_WINDOW_MS = 2000;
const EMPTY = { landmarks: [], handedness: [] };

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const g = canvas.getContext("2d");
const video = $("webcam");

window.__gsTest = window.__gsTest || {};
window.__gsTest.results = window.__gsTest.results || { landmarks: [], handedness: [] };

const handInput = createHandInput({ bus: createBus() });
const recorder = createRecorder({ onDone: (rec) => onRecordingDone(rec) });

// ---------------------------------------------------------------- hand panels (built once)

const THUMB_RANGE = 0.5; // thumb offset track spans -0.5..0.5 hand sizes
const PINCH_RANGE = 1.0; // pinch track spans 0..1 hand sizes

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(parent, label) {
  const r = el("div", "row");
  r.append(el("div", "k", label));
  const mid = el("div");
  const v = el("div", "v");
  r.append(mid, v);
  parent.append(r);
  return { mid, v };
}

function track(parent, { center = false } = {}) {
  const t = el("div", "track");
  const fill = el("div", "fill");
  const mark = el("div", "mark");
  t.append(fill);
  if (center) t.append(el("div", "center"));
  t.append(mark);
  parent.append(t);
  return { t, fill, mark };
}

const ui = {};
for (const side of SIDES) {
  const p = el("div", "panel");
  p.id = `hand-${side}`;
  const h = el("h2");
  h.append(el("span", "", side === "Left" ? "Left hand (chord)" : "Right hand (voicing)"));
  const seen = el("span", "seen dim", "not visible");
  h.append(seen);
  p.append(h);

  const fingers = row(p, "fingers");
  const dotsWrap = el("div", "dots");
  const dots = {};
  for (const [k, lbl] of [["thumb", "T"], ["index", "I"], ["middle", "M"], ["ring", "R"], ["pinky", "P"]]) {
    dots[k] = el("div", "dot", lbl);
    dotsWrap.append(dots[k]);
  }
  fingers.mid.append(dotsWrap);

  const pinch = row(p, "pinch");
  const pinchTrack = track(pinch.mid);
  const tickStart = el("div", "tick start");
  const tickEnd = el("div", "tick end");
  pinchTrack.t.append(tickStart, tickEnd);
  const pinchState = el("span", "state", "open");
  pinchState.dataset.testid = `${side}-pinch-state`;
  const pinchVal = el("span", "", "");
  pinch.v.append(pinchVal, " ", pinchState);

  const restore = row(p, "restore");
  restore.mid.className = "dim";
  restore.mid.textContent = "voicingBeforePinch";

  const fist = row(p, "fist");
  const fistTrack = track(fist.mid);
  const fistTick = el("div", "tick start");
  fistTrack.t.append(fistTick);
  const fistState = el("span", "state", "open");
  const fistVal = el("span", "");
  fist.v.append(fistVal, " ", fistState);

  const thumb = row(p, "thumb");
  const thumbTrack = track(thumb.mid, { center: true });
  const band = el("div", "band");
  thumbTrack.t.insertBefore(band, thumbTrack.mark);
  const thumbState = el("span", "state", "in");
  const thumbVal = el("span", "");
  thumb.v.append(thumbVal, " ", thumbState);

  const height = row(p, "height");
  const heightTrack = track(height.mid);
  const tilt = row(p, "tilt");
  const tiltTrack = track(tilt.mid, { center: true });
  const pos = row(p, "pos");
  const last = row(p, "last");
  last.mid.className = "last";
  last.mid.style.gridColumn = "2 / 4";
  last.v.remove();
  const flk = row(p, "flicker");
  flk.mid.className = "flk";
  flk.mid.style.gridColumn = "2 / 4";
  flk.v.remove();
  const flkEls = {};
  for (const k of ["pinch", "fist", "thumb"]) { flkEls[k] = el("span", "", ""); flk.mid.append(flkEls[k]); }

  $("hands").append(p);
  ui[side] = {
    seen, dots, fingersV: fingers.v, pinchTrack, tickStart, tickEnd, pinchState, pinchVal, restoreV: restore.v,
    fistTrack, fistTick, fistState, fistVal, thumbTrack, band, thumbState, thumbVal,
    heightTrack, heightV: height.v, tiltTrack, tiltV: tilt.v, posMid: pos.mid, posV: pos.v,
    lastEl: last.mid, flkEls,
  };
}

const pct = (v) => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(2)}%`;

// ---------------------------------------------------------------- per-hand state tracking

const hist = {};
for (const side of SIDES) {
  hist[side] = { prev: null, changes: { pinch: [], fist: [], thumb: [] }, last: null };
}
const logLines = [];

function logEvent(side, name, t) {
  const h = hist[side];
  // several changes in one frame read as one event: "pinch start + thumb out"
  h.last = h.last && h.last.t === t ? { name: `${h.last.name} + ${name}`, t } : { name, t };
  logLines.unshift(`${(t / 1000).toFixed(2).padStart(8)}s  ${side.padEnd(5)}  ${name}`);
  if (logLines.length > 40) logLines.length = 40;
  $("log").textContent = logLines.join("\n");
}

function trackEvents(side, f, t) {
  const h = hist[side];
  const prev = h.prev;
  if (!f) {
    if (prev) logEvent(side, "hand lost", t);
    h.prev = null;
    return;
  }
  if (!prev) logEvent(side, "hand found", t);
  else {
    const pairs = [["pinch", f.pinch, prev.pinch, "pinch start", "pinch end"],
      ["fist", f.fist, prev.fist, "fist on", "fist off"],
      ["thumb", f.fingers.thumb, prev.thumb, "thumb out", "thumb in"]];
    for (const [k, now, was, on, off] of pairs) {
      if (now !== was) { h.changes[k].push(t); logEvent(side, now ? on : off, t); }
    }
    if (f.voicingCount !== prev.voicingCount && !f.pinch) logEvent(side, `voicing ${prev.voicingCount}→${f.voicingCount}`, t);
  }
  h.prev = { pinch: f.pinch, fist: f.fist, thumb: f.fingers.thumb, voicingCount: f.voicingCount };
}

function fistRatio(f, view) {
  let m = 0;
  for (const name of ["index", "middle", "ring", "pinky"]) {
    m = Math.max(m, displayDistance(f.landmarks[FINGERS[name].tip], f.landmarks[0], view));
  }
  return f.handSize > 0 ? m / f.handSize : 0;
}

function renderHand(side, f, now) {
  const u = ui[side];
  const thr = getThresholds();
  const h = hist[side];

  // flicker counters (rolling window)
  for (const k of ["pinch", "fist", "thumb"]) {
    const arr = h.changes[k];
    while (arr.length && arr[0] < now - FLICKER_WINDOW_MS) arr.shift();
    const rate = arr.length / (FLICKER_WINDOW_MS / 1000);
    u.flkEls[k].textContent = `${k} ${rate.toFixed(1)}/s`;
    u.flkEls[k].className = rate > 1 ? "hot" : "";
  }
  u.lastEl.textContent = h.last ? `Last event: ${h.last.name} (${((now - h.last.t) / 1000).toFixed(1)} s ago)` : "Last event: —";

  // ticks follow the live thresholds even without a hand
  u.tickStart.style.left = pct(thr.PINCH_START / PINCH_RANGE);
  u.tickEnd.style.left = pct(thr.PINCH_END / PINCH_RANGE);
  u.fistTick.style.left = pct(thr.FIST_TIP_RATIO / 2.5);
  u.band.style.left = pct(0.5 - thr.THUMB_BAND / (2 * THUMB_RANGE));
  u.band.style.width = pct(thr.THUMB_BAND / THUMB_RANGE);

  u.seen.textContent = f ? "visible" : "not visible";
  if (!f) {
    for (const d of Object.values(u.dots)) d.classList.remove("on");
    u.fingersV.textContent = "—";
    for (const tr of [u.pinchTrack, u.fistTrack, u.thumbTrack, u.heightTrack, u.tiltTrack]) {
      tr.mark.style.display = "none"; tr.fill.style.width = "0";
    }
    u.pinchState.textContent = "—"; u.pinchState.className = "state"; u.pinchVal.textContent = "";
    u.fistState.textContent = "—"; u.fistState.className = "state"; u.fistVal.textContent = "";
    u.thumbState.textContent = "—"; u.thumbState.className = "state"; u.thumbVal.textContent = "";
    u.restoreV.textContent = "—"; u.heightV.textContent = "—"; u.tiltV.textContent = "—";
    u.posMid.textContent = "—"; u.posV.textContent = "";
    return;
  }
  for (const tr of [u.pinchTrack, u.fistTrack, u.thumbTrack, u.heightTrack, u.tiltTrack]) tr.mark.style.display = "";

  for (const [k, d] of Object.entries(u.dots)) d.classList.toggle("on", !!f.fingers[k]);
  u.fingersV.textContent = `count ${f.fingerCount} · voi ${f.voicingCount}`;

  const pd = Math.min(f.pinchDistance, 9.99);
  u.pinchTrack.mark.style.left = pct(pd / PINCH_RANGE);
  u.pinchTrack.fill.style.width = pct(pd / PINCH_RANGE);
  u.pinchTrack.fill.style.background = f.pinch ? "var(--pinch)" : "#2f6f9c";
  u.pinchVal.textContent = pd.toFixed(2);
  u.pinchState.textContent = f.pinch ? "PINCH" : f.fingers.middle ? "open" : "no-mid";
  u.pinchState.className = f.pinch ? "state pinch" : "state";

  u.restoreV.textContent = f.voicingBeforePinch === null ? "—" : `voi ${f.voicingBeforePinch}`;

  const fr = fistRatio(f, handInput.view);
  u.fistTrack.mark.style.left = pct(fr / 2.5);
  u.fistTrack.fill.style.width = pct(fr / 2.5);
  u.fistVal.textContent = fr.toFixed(2);
  u.fistState.textContent = f.fist ? "FIST" : "open";
  u.fistState.className = f.fist ? "state fist" : "state";

  const to = thumbOffset(f.landmarks, side, f.handSize, handInput.view);
  u.thumbTrack.mark.style.left = pct(0.5 + to / (2 * THUMB_RANGE));
  u.thumbVal.textContent = (to >= 0 ? "+" : "") + to.toFixed(2);
  u.thumbState.textContent = f.fingers.thumb ? "OUT" : "in";
  u.thumbState.className = f.fingers.thumb ? "state thumb" : "state";

  u.heightTrack.mark.style.left = pct(f.height);
  u.heightTrack.fill.style.width = pct(f.height);
  u.heightV.textContent = f.height.toFixed(2);

  const tl = (f.tilt + 1) / 2;
  u.tiltTrack.mark.style.left = pct(tl);
  u.tiltTrack.fill.style.left = pct(Math.min(tl, 0.5));
  u.tiltTrack.fill.style.width = pct(Math.abs(tl - 0.5));
  u.tiltV.textContent = (f.tilt >= 0 ? "+" : "") + f.tilt.toFixed(2);

  u.posMid.textContent = `pos x ${f.pos.x.toFixed(3)}  y ${f.pos.y.toFixed(3)}`;
  u.posV.textContent = `size ${f.handSize.toFixed(3)}`;
}

// ---------------------------------------------------------------- thresholds panel

const SLIDERS = [
  ["PINCH_START", 0.05, 0.8, 0.01],
  ["PINCH_END", 0.05, 1.0, 0.01],
  ["FIST_TIP_RATIO", 0.8, 2.5, 0.05],
  ["THUMB_BAND", 0, 0.3, 0.01],
];
const sliderEls = {};
for (const [key, min, max, step] of SLIDERS) {
  const r = el("div", "thr");
  const lbl = el("label", "", key);
  const input = el("input");
  Object.assign(input, { type: "range", min, max, step, id: `thr-${key}` });
  const val = el("span", "v");
  lbl.htmlFor = input.id;
  input.addEventListener("input", () => { setThresholds({ [key]: Number(input.value) }); syncSliders(); });
  r.append(lbl, input, val);
  $("thresholds").append(r);
  sliderEls[key] = { input, val };
}

function copyText() {
  const t = getThresholds();
  return `PINCH_START = ${t.PINCH_START.toFixed(2)}; PINCH_END = ${t.PINCH_END.toFixed(2)}; ` +
    `FIST_TIP_RATIO = ${t.FIST_TIP_RATIO.toFixed(2)}; THUMB_BAND = ${t.THUMB_BAND.toFixed(2)};`;
}

function syncSliders() {
  const t = getThresholds();
  for (const [key, { input, val }] of Object.entries(sliderEls)) {
    input.value = t[key];
    val.textContent = t[key].toFixed(2);
  }
  $("copyOut").value = copyText();
}
syncSliders();

$("copyBtn").addEventListener("click", async () => {
  $("copyOut").select();
  try { await navigator.clipboard.writeText(copyText()); $("copyBtn").textContent = "Copied"; }
  catch { document.execCommand?.("copy"); $("copyBtn").textContent = "Copied (select)"; }
  setTimeout(() => ($("copyBtn").textContent = "Copy values"), 1200);
});
$("resetBtn").addEventListener("click", () => { setThresholds(DEFAULT_THRESHOLDS); syncSliders(); });

// ---------------------------------------------------------------- record

function onRecordingDone(rec) {
  $("recBtn").classList.remove("active");
  $("recBtn").textContent = "● Record";
  $("recStatus").textContent = `saved ${rec.frames.length} frames (${(rec.durationMs / 1000).toFixed(1)} s)`;
  window.__gsTest.lastRecording = rec;
  downloadRecording(rec);
}

$("recBtn").addEventListener("click", () => {
  if (recorder.recording) { recorder.stop(); return; }
  const secs = Math.max(1, Math.min(120, Number($("recSecs").value) || 10));
  recorder.start(secs * 1000, performance.now(), { width: handInput.view.srcW, height: handInput.view.srcH });
  $("recBtn").classList.add("active");
  $("recBtn").textContent = "■ Stop";
});

// ---------------------------------------------------------------- canvas

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

function drawHands(frames) {
  const W = canvas.width, H = canvas.height;
  const view = handInput.view;
  for (const f of frames) {
    const pts = f.landmarks.map((p) => { const d = toDisplay(p, view); return { x: d.x * W, y: d.y * H }; });
    const color = f.pinch ? "#4fb3ff" : f.fist ? "#ff6b6b" : f.handedness === "Left" ? "#e8a13d" : "#4fd18b";
    g.strokeStyle = color; g.lineWidth = 2;
    g.beginPath();
    for (const [a, b] of BONES) { g.moveTo(pts[a].x, pts[a].y); g.lineTo(pts[b].x, pts[b].y); }
    g.stroke();
    g.fillStyle = color;
    for (const p of pts) { g.beginPath(); g.arc(p.x, p.y, 3, 0, Math.PI * 2); g.fill(); }
    // thumb-index line when near the pinch band
    if (f.pinchDistance < getThresholds().PINCH_END * 1.5) {
      g.strokeStyle = f.pinch ? "#4fb3ff" : "#f0b341"; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(pts[4].x, pts[4].y); g.lineTo(pts[8].x, pts[8].y); g.stroke(); g.setLineDash([]);
    }
    g.font = "bold 13px ui-monospace, monospace";
    g.fillText(`${f.handedness}${f.pinch ? " PINCH" : f.fist ? " FIST" : ""}`, pts[0].x + 8, pts[0].y + 16);
  }
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
}

// ---------------------------------------------------------------- main loop

async function main() {
  let source = "camera";
  let detector;
  let cameraOk = false;
  try { await setupCamera(video); cameraOk = true; } catch (e) { console.warn("camera unavailable:", e); }

  if (REPLAY_URL) {
    const rec = await loadRecording(REPLAY_URL);
    detector = createReplaySource(rec, { loop: params.has("replayLoop") });
    window.__gsTest.replay = detector;
    source = `replay ${REPLAY_URL} (${rec.frames.length} frames)`;
  } else if (MOCK) {
    detector = { detectForVideo: () => window.__gsTest.results };
    source = "mockHands";
  } else {
    if (!cameraOk) throw new Error("no camera");
    source = "camera + MediaPipe (loading model…)";
    $("source").textContent = `source: ${source}`;
    detector = await setupHandLandmarker();
    source = "camera + MediaPipe";
  }
  $("source").textContent = `source: ${source}`;
  const synthetic = !!(REPLAY_URL || MOCK); // process every animation frame, camera optional

  let lastVideoTime = -1;
  let fpsCount = 0, fpsT0 = performance.now();
  let latest = { frames: [], left: null, right: null };

  function loop() {
    const now = performance.now();
    resizeCanvas();
    const newFrame = synthetic || (cameraOk && video.currentTime !== lastVideoTime);
    if (newFrame) {
      lastVideoTime = video.currentTime;
      const results = detector.detectForVideo(video, now) || EMPTY;
      const rec = REPLAY_URL ? detector.recording.video : null;
      const srcW = video.videoWidth || rec?.width || 640;
      const srcH = video.videoHeight || rec?.height || 480;
      const v = handInput.view;
      if (v.srcW !== srcW || v.srcH !== srcH || v.dstW !== canvas.width || v.dstH !== canvas.height) {
        handInput.setView(makeView(srcW, srcH, canvas.width, canvas.height));
      }
      if (cameraOk && video.videoWidth) drawFrame(g, video, EMPTY, canvas.width, canvas.height);
      else { g.fillStyle = "#000"; g.fillRect(0, 0, canvas.width, canvas.height); }

      latest = handInput.process(results, now);
      recorder.add(results, now);
      for (const side of SIDES) trackEvents(side, side === "Left" ? latest.left : latest.right, now);
      drawHands(latest.frames);
      fpsCount++;
    }
    if (now - fpsT0 > 1000) {
      $("fps").textContent = `${Math.round((fpsCount * 1000) / (now - fpsT0))} fps`;
      fpsCount = 0; fpsT0 = now;
    }
    if (recorder.recording) {
      $("recStatus").textContent = `recording… ${(recorder.progress(now) * 100).toFixed(0)}%`;
    }
    renderHand("Left", latest.left, now);
    renderHand("Right", latest.right, now);
    window.__gsTest.lab = { left: latest.left, right: latest.right };
    requestAnimationFrame(loop);
  }
  loop();
}

window.__gsTest.handInput = handInput;
window.__gsTest.setThresholds = (t) => { const r = setThresholds(t); syncSliders(); return r; };
window.__gsTest.getThresholds = getThresholds;

main().catch((err) => {
  console.error(err);
  $("source").textContent = `error: ${err.message}`;
});
