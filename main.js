// Entry point: wires the layers together (see docs/architecture.md).
//   hand input (src/input) -> router (src/router.js) -> active mode (src/modes)
//   shared services (src/services) + signal bus (src/core/bus.js) reach modes through ctx.
import { setupCamera, setupHandLandmarker } from "./src/input/camera.js";

import { bus } from "./src/core/bus.js";
import { registry, registerMode } from "./src/core/registry.js";
import { createAppContext } from "./src/core/app-context.js";
import { makeView } from "./src/input/hand-input.js";
import { initAnalytics, trackClarityEvent } from "./src/services/analytics.js";
import { drawFrame } from "./src/ui/overlay.js";
import { mountIndicators } from "./src/ui/indicators.js";
import { mountControls } from "./src/ui/controls.js";
import { mountModeUI } from "./src/ui/mode-ui.js";
import { mountMobileUI } from "./src/ui/mobile/mobile-ui.js";
import { createRadialMenu, playTick } from "./src/menu/radial-menu.js";
import { soundMenuItem, registerInstrument, listInstruments } from "./src/instruments/index.js";
import chordsMode from "./src/modes/chords.js";
import arpMode from "./src/modes/arp.js";
import leadMode from "./src/modes/lead.js";
import { mountStatusChip } from "./src/output/status-chip.js"; // M3 output hook (see below)
import { tweaksRequested } from "./src/tweaks/flag.js";

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

// ---- Services + ctx + router (src/core/app-context.js; the labs use the same wiring) ----
// Container for the active mode's screen controls (empty for Chords). The router mounts the mode's
// rows here; the Controls panel (src/ui/controls-panel.js) adopts this node.
const modeControlsEl = document.createElement("div");
modeControlsEl.id = "modeControls";
stageEl.appendChild(modeControlsEl);

const { synth, audio, harmony, handInput, ctx, router } = createAppContext({
  bus,
  registry,
  canvasEl,
  controlsContainer: modeControlsEl,
  onFirstSound: () => trackClarityEvent("first_sound"),
});

// ---- UI ----
mountControls({ harmony, audio, synth, canvasEl });
// indicators.js renders `volume` (now the master) on the meter too; src/ui/readouts.js (mounted with the
// modes UI below, after it) re-renders the meter from the active mode's meter param (Chords: `volume`, Arp: gate).
mountIndicators(bus);

// ---- OUTPUT HOOK (milestone 3) ----
// Status chip only. The WebRTC output module is dynamic-imported when the user turns the
// output on, so with the output off it is never loaded and does no work.
const outputChip = mountStatusChip({ bus, ctx, parent: stageEl });
// ---- end OUTPUT HOOK ----

// ---- Modes ----
// Menu directions: Chords up, Arp right, Lead left; down = Sound (instrument sub-menu, below).
registerMode(chordsMode);
registerMode(arpMode);
registerMode(leadMode);
router.setMode("chords");
const modeUI = mountModeUI({ bus, ctx, registry, router, canvas: canvasEl, output: outputChip });
// Phones + touch tablets: one collapsible bar, sheets, minimal HUD (docs/mobile-ui.md). Mount LAST: it
// gathers the controls above into its tray. Inert (no DOM moves) on desktop.
const mobileUI = mountMobileUI({ bus });

// ---- Radial menu (right fist) ----
router.setMenu(
  createRadialMenu({
    // Lead is a layer: its arc turns it on over the current base; the base arc then has a hollow marker.
    // Down = Sound: a sub-ring of the registered instruments. It sets the base instrument (Chords / Arp), or the
    // Lead's while the Lead layer is on; the accent is the right-hand mode's color.
    items: () =>
      audio.ac // modes need the AudioContext
        ? [
            ...registry.menuItems(router.modeId, { layerId: router.layerId }),
            soundMenuItem({
              layerOn: !!router.layerId,
              color: router.rightMode?.color || "#e8a13d",
              current: () => audio.instrument(router.layerId ? "lead" : "base"),
            }),
          ]
        : [],
    currentId: () => router.rightModeId,
    onTick: () => { if (audio.ac) playTick(audio.ac, audio.out); },
  })
);

// ---- Tweaks panel (developer settings, src/tweaks/) ----
// Only with ?tweaks / ?tweaks=true: a lazy chunk (nothing loaded otherwise). Without it every tweakable value stays
// at its code default, even if tweaks were saved in this browser before.
if (tweaksRequested(location.search)) {
  import("./src/tweaks/index.js")
    .then(({ mountTweaks }) => mountTweaks({ synth }))
    .then((t) => { if (import.meta.env.DEV) window.__gsTest.tweaks = t; })
    .catch((err) => console.error("[tweaks]", err));
}

if (import.meta.env.DEV) {
  window.__gsTest.registry = registry;
  window.__gsTest.synth = synth;
  window.__gsTest.bus = bus;
  window.__gsTest.router = router;
  window.__gsTest.ctx = ctx;
  window.__gsTest.handInput = handInput;
  window.__gsTest.output = outputChip;
  window.__gsTest.mobile = mobileUI;
  window.__gsTest.instruments = { registerInstrument, listInstruments };
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
    // Show the camera at once; landmarks start when the model has loaded (first visit: ~8 MB download).
    const NO_HANDS = { landmarks: [], handedness: [] };
    handLandmarker = { detectForVideo: () => NO_HANDS };
    const status = document.createElement("div");
    status.id = "trackingStatus";
    status.textContent = "Loading hand tracking…";
    document.getElementById("stage").append(status);
    setupHandLandmarker()
      .then((real) => { handLandmarker = real; status.remove(); })
      .catch((err) => { status.textContent = "Hand tracking failed to load. Reload the page."; console.error(err); });
  }

  let lastVideoTime = -1;

  // Latest HandFrames; refreshed only when a new video frame arrives.
  let left = null;
  let right = null;
  let lastResults = { landmarks: [], handedness: [] };

  function loop() {
    // Schedule the next frame first: an exception in one drawing layer must never stop the
    // router (sound, left hand). It still surfaces as an uncaught error (and fails the tests).
    requestAnimationFrame(loop);
    const timestampNow = performance.now();

    // 1. New camera frame -> landmarks -> HandFrames
    if (videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;

      lastResults = handLandmarker.detectForVideo(videoEl, timestampNow);
      syncView();
      ({ left, right } = handInput.process(lastResults, timestampNow));
    }
    // Video + landmark dots are redrawn every animation frame: this clears the canvas, so the
    // translucent mode/menu drawings below never build up between camera frames.
    drawFrame(g, videoEl, lastResults, canvasEl.width, canvasEl.height);

    // 2. Router: left hand -> chord, right hand -> menu / active mode
    router.update(left, right, timestampNow);

    // 3. Mode (and menu) drawing on top of the video
    router.draw(g);
    modeUI.draw(g);
  }

  loop();
}

main().catch((err) => console.error(err));
