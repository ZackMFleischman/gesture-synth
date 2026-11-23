// Entry point: wires the layers together (see docs/architecture.md).
//   hand input (src/input) -> router (src/router.js) -> active mode (src/modes)
//   shared services (src/services) + signal bus (src/core/bus.js) reach modes through ctx.
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

import { bus, createParam } from "./src/core/bus.js";
import { registry, registerMode } from "./src/core/registry.js";
import { createHandInput, makeView } from "./src/input/hand-input.js";
import { createRouter } from "./src/router.js";
import { SynthEngine, createAudioFacade } from "./src/services/audio.js";
import { createHarmony } from "./src/services/harmony.js";
import { initAnalytics, trackClarityEvent } from "./src/services/analytics.js";
import { drawFrame } from "./src/ui/overlay.js";
import { mountIndicators } from "./src/ui/indicators.js";
import { mountControls } from "./src/ui/controls.js";
import chordsMode from "./src/modes/chords.js";

initAnalytics();

// ---- DOM references ----
const stageEl = document.getElementById("stage");
const videoEl = document.getElementById("webcam");
const canvasEl = document.getElementById("overlay");
const g = canvasEl.getContext("2d");

// ---- Dev-only test hook ----
// With ?mockHands in the URL (dev server only), MediaPipe is skipped and hand
// results are read from window.__gsTest.results so automated tests can drive gestures.
const MOCK_HANDS =
  import.meta.env.DEV && new URLSearchParams(location.search).has("mockHands");
if (import.meta.env.DEV) {
  window.__gsTest = { results: { landmarks: [], handedness: [] } };
}

// ---- Services ----
const synth = new SynthEngine({ bus, onFirstSound: () => trackClarityEvent("first_sound") });
const audio = createAudioFacade(synth);
const harmony = createHarmony();
const handInput = createHandInput({ bus });

const ctx = {
  audio,
  clock: null, // milestone 1.1 (src/services/clock.js)
  harmony,
  bus,
  param: (name, opts) => createParam(bus, name, { owner: router?.modeId ?? undefined, ...opts }),
  toCanvas: (p) => ({ x: p.x * canvasEl.width, y: p.y * canvasEl.height }),
  now: 0,
  masterVolume: 1, // milestone 1.3: from left height
};

// Container for the active mode's screen controls (empty for Chords).
const modeControlsEl = document.createElement("div");
modeControlsEl.id = "modeControls";
stageEl.appendChild(modeControlsEl);

const router = createRouter({ bus, registry, harmony, ctx, controlsContainer: modeControlsEl });

// ---- UI ----
mountControls({ harmony, audio, synth, canvasEl });
mountIndicators(bus);

// ---- Modes ----
registerMode(chordsMode);
router.setMode("chords");

if (import.meta.env.DEV) {
  window.__gsTest.synth = synth;
  window.__gsTest.bus = bus;
  window.__gsTest.router = router;
  window.__gsTest.ctx = ctx;
}

// ---- Camera setup ----
async function setupCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: false,
  });
  videoEl.srcObject = stream;
  return new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });
}

// ---- MediaPipe setup ----
async function setupHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
  });
}

// ---- Main loop ----
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
  await setupCamera();
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  const handLandmarker = MOCK_HANDS
    ? { detectForVideo: () => window.__gsTest.results }
    : await setupHandLandmarker();

  let lastVideoTime = -1;

  // Latest HandFrames; refreshed only when a new video frame arrives.
  let left = null;
  let right = null;

  function loop() {
    const timestampNow = performance.now();

    // 1. New camera frame -> landmarks -> HandFrames (+ draw video and landmark dots)
    if (videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;

      const results = handLandmarker.detectForVideo(videoEl, timestampNow);
      drawFrame(g, videoEl, results, canvasEl.width, canvasEl.height);

      syncView();
      ({ left, right } = handInput.process(results, timestampNow));
    }

    // 2. Router: left hand -> chord, right hand -> menu / active mode
    router.update(left, right, timestampNow);

    // 3. Mode (and menu) drawing on top of the video
    router.draw(g);

    requestAnimationFrame(loop);
  }

  loop();
}

main().catch((err) => console.error(err));
