// Entry point: wires the layers together (see docs/architecture.md).
//   hand input (src/input) -> router (src/router.js) -> active mode (src/modes)
//   shared services (src/services) + signal bus (src/core/bus.js) reach modes through ctx.
import { setupCamera, setupHandLandmarker } from "./src/input/camera.js";

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
import { createClock } from "./src/services/clock.js";
import { createRadialMenu, playTick } from "./src/menu/radial-menu.js";
import chordsMode from "./src/modes/chords.js";
import arpMode from "./src/modes/arp.js";

initAnalytics();

// ---- DOM references ----
const stageEl = document.getElementById("stage");
const videoEl = document.getElementById("webcam");
const canvasEl = document.getElementById("overlay");
const g = canvasEl.getContext("2d");

// ---- Dev-only test hook ----
// With ?mockHands in the URL (dev server only), MediaPipe is skipped and hand
// results are read from window.__gsTest.results so automated tests can drive gestures.
// With ?replay=<url-to-recording.json> (dev only), a recorded session (labs/gesture-test.html
// "Record") is fed through the same pipeline in real time instead (&replayLoop to repeat).
const MOCK_HANDS =
  import.meta.env.DEV && new URLSearchParams(location.search).has("mockHands");
const REPLAY_URL = import.meta.env.DEV ? new URLSearchParams(location.search).get("replay") : null;
if (import.meta.env.DEV) {
  window.__gsTest = { results: { landmarks: [], handedness: [] } };
}

// ---- Services ----
const synth = new SynthEngine({ bus, onFirstSound: () => trackClarityEvent("first_sound") });
const audio = createAudioFacade(synth);
const harmony = createHarmony();
const handInput = createHandInput({ bus });

// One shared tempo clock for every mode, created with the AudioContext (first user gesture).
// Arp's enter() starts it; leaving Arp leaves it running.
let clock = null;
const getClock = () => {
  if (!clock && synth.ctx) clock = createClock(synth.ctx, { bus });
  return clock;
};

const ctx = {
  audio,
  get clock() { return getClock(); },
  harmony,
  bus,
  param: (name, opts) => createParam(bus, name, { owner: router?.modeId ?? undefined, ...opts }),
  toCanvas: (p) => ({ x: p.x * canvasEl.width, y: p.y * canvasEl.height }),
  now: 0,
  masterVolume: 0, // router: left height -> master volume (1.3)
  rightLocked: null, // router: the right HandFrame locked when the menu opened
};

// Container for the active mode's screen controls (empty for Chords).
const modeControlsEl = document.createElement("div");
modeControlsEl.id = "modeControls";
stageEl.appendChild(modeControlsEl);

const router = createRouter({ bus, registry, harmony, ctx, controlsContainer: modeControlsEl });

// ---- UI ----
mountControls({ harmony, audio, synth, canvasEl });
mountIndicators(meterBus(bus));

// ---- Modes ----
// Menu directions: Chords up, Arp right (Lead left lands in milestone 2; down stays free).
registerMode(chordsMode);
registerMode(arpMode);
router.setMode("chords");

// ---- Radial menu (right fist) ----
router.setMenu(
  createRadialMenu({
    items: () => (audio.ac ? registry.menuItems(router.modeId) : []), // modes need the AudioContext
    currentId: () => router.modeId,
    onTick: () => { if (audio.ac) playTick(audio.ac, audio.out); },
  })
);

if (import.meta.env.DEV) {
  window.__gsTest.registry = registry;
  window.__gsTest.synth = synth;
  window.__gsTest.bus = bus;
  window.__gsTest.router = router;
  window.__gsTest.ctx = ctx;
  window.__gsTest.handInput = handInput;
}

/**
 * Bus view for the existing indicators (src/ui/indicators.js, untouched): its 8-bar meter reads
 * `volume`, which is now the master volume. Per docs/ui-integration.md D5 the meter shows what the
 * right height controls in the active mode (mode.rightTrack.param: Chords = chords/volume,
 * Arp = arp/gate), so this view serves that param under the name `volume`.
 * TODO(ui): drop once src/ui/readouts.js drives the meter from mode.rightTrack directly.
 */
function meterBus(b) {
  const meterParam = () => registry.getMode(b.get("mode"))?.rightTrack?.param ?? null;
  return {
    get: (name) => (name === "volume" ? (meterParam() ? b.get(meterParam()) ?? 0 : 0) : b.get(name)),
    subscribe(consumer, filter) {
      const wanted = (n) => (Array.isArray(filter) ? filter.includes(n) : true);
      return b.subscribe(
        {
          onSet(name, v) {
            if (name === "mode") {
              const p = meterParam();
              consumer.onSet?.("volume", p ? b.get(p) ?? 0 : 0);
            } else if (name === meterParam()) consumer.onSet?.("volume", v ?? 0);
            else if (name !== "volume" && wanted(name)) consumer.onSet?.(name, v);
          },
        },
        (n) => n === "mode" || n === "volume" || n.endsWith("/volume") || n.endsWith("/gate") || wanted(n)
      );
    },
  };
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
  await setupCamera(videoEl);
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  let handLandmarker;
  if (import.meta.env.DEV && REPLAY_URL) {
    const { loadRecording, createReplaySource } = await import("./src/input/replay.js");
    const loop = new URLSearchParams(location.search).has("replayLoop");
    handLandmarker = createReplaySource(await loadRecording(REPLAY_URL), { loop });
    window.__gsTest.replay = handLandmarker;
  } else if (MOCK_HANDS) {
    handLandmarker = { detectForVideo: () => window.__gsTest.results };
  } else {
    handLandmarker = await setupHandLandmarker();
  }

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
