// Lead lab: Lead mode full-screen against the real app context (same services + router as main.js).
//   ?mockHands  skip MediaPipe; frames read window.__gsTest.results (tests/helpers/hands.js builds them)
//   otherwise   real MediaPipe on the camera (or the fake camera in Playwright)
// Screen controls: Pad chord buttons stand in for the left hand; the mode's own controls (ladder strip,
// keyboard, note set, octave) come from lead.controls().
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

import { bus } from "../src/core/bus.js";
import { registry, registerMode } from "../src/core/registry.js";
import { createAppContext } from "../src/core/app-context.js";
import { makeView } from "../src/input/hand-input.js";
import { drawFrame } from "../src/ui/overlay.js";
import lead from "../src/modes/lead.js";

const stageEl = document.getElementById("stage");
const videoEl = document.getElementById("webcam");
const canvasEl = document.getElementById("overlay");
const g = canvasEl.getContext("2d");
const MOCK_HANDS = new URLSearchParams(location.search).has("mockHands");
window.__gsTest = { results: { landmarks: [], handedness: [] } };

const { synth, audio, harmony, handInput, ctx, router } = createAppContext({
  bus,
  registry,
  canvasEl,
  controlsContainer: document.getElementById("modeControls"),
});

// ---- Screen chord (stands in for the left hand when no left chord is seen) ----
let screenChord = null; // { chord: roman, isMajorMode }
let screenDegree = 0;
let screenMinor = false;
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII"];
const realUpdateLeft = harmony.updateLeft;
harmony.updateLeft = (raw, now) => realUpdateLeft(raw && raw.chord ? raw : screenChord, now);
const padButtons = [...document.querySelectorAll("#row3 [data-deg]")];
const minorBtn = document.getElementById("minorToggle");
function applyScreenChord() {
  screenChord = screenDegree
    ? { chord: screenMinor ? ROMAN[screenDegree].toLowerCase() : ROMAN[screenDegree], isMajorMode: !screenMinor }
    : null;
  for (const b of padButtons) b.setAttribute("aria-pressed", String(Number(b.dataset.deg) === screenDegree));
  minorBtn.setAttribute("aria-pressed", String(screenMinor));
}
padButtons.forEach((b) => b.addEventListener("click", () => { screenDegree = Number(b.dataset.deg); applyScreenChord(); b.blur(); }));
minorBtn.addEventListener("click", () => { screenMinor = !screenMinor; applyScreenChord(); minorBtn.blur(); });
applyScreenChord();

// ---- Key / tone ----
const keySelectEl = document.getElementById("keySelect");
const toneSelectEl = document.getElementById("toneSelect");
const readKey = () => harmony.setKey(Number(keySelectEl.value), keySelectEl.selectedOptions[0].dataset.note);
readKey();
keySelectEl.addEventListener("change", () => { readKey(); keySelectEl.blur(); });
synth.waveform = toneSelectEl.value;
toneSelectEl.addEventListener("change", () => { audio.setWaveform(toneSelectEl.value); toneSelectEl.blur(); });

// ---- Chord display (reads the bus like the app's indicators) ----
const chordEl = document.getElementById("chordDisplay");
bus.subscribe({ onSet: (n, c) => (chordEl.textContent = c ? `${c.name}(${c.roman})` : "--") }, "chord");

// ---- Start ----
const startEl = document.getElementById("startOverlay");
startEl.addEventListener("click", () => {
  synth.ensureContext();
  startEl.style.display = "none";
});

registerMode(lead);
router.setMode("lead");

Object.assign(window.__gsTest, { synth, bus, router, ctx, handInput, harmony, lead, registry,
  setScreenChord(deg, minor = false) { screenDegree = deg; screenMinor = minor; applyScreenChord(); } });

// ---- Camera + loop (as main.js) ----
async function setupCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  videoEl.srcObject = stream;
  return new Promise((resolve) => {
    videoEl.onloadedmetadata = () => { videoEl.play(); resolve(); };
  });
}

async function setupHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
  });
}

function resizeCanvas() {
  canvasEl.width = window.innerWidth;
  canvasEl.height = window.innerHeight;
}

function syncView() {
  const v = handInput.view;
  const srcW = videoEl.videoWidth || 1;
  const srcH = videoEl.videoHeight || 1;
  if (v.srcW !== srcW || v.srcH !== srcH || v.dstW !== canvasEl.width || v.dstH !== canvasEl.height) {
    handInput.setView(makeView(srcW, srcH, canvasEl.width, canvasEl.height));
  }
}

async function main() {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  await setupCamera().catch((e) => console.warn("no camera:", e.message));
  const landmarker = MOCK_HANDS ? { detectForVideo: () => window.__gsTest.results } : await setupHandLandmarker();
  let lastVideoTime = -1;
  let left = null;
  let right = null;
  function loop() {
    const now = performance.now();
    if (videoEl.currentTime !== lastVideoTime || !videoEl.videoWidth) {
      lastVideoTime = videoEl.currentTime;
      const results = landmarker.detectForVideo(videoEl, now);
      if (videoEl.videoWidth) drawFrame(g, videoEl, results, canvasEl.width, canvasEl.height);
      else g.clearRect(0, 0, canvasEl.width, canvasEl.height);
      syncView();
      ({ left, right } = handInput.process(results, now));
    }
    router.update(left, right, now);
    router.draw(g);
    requestAnimationFrame(loop);
  }
  loop();
}

main().catch((err) => console.error(err));
