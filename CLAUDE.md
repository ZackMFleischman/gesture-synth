# Gesture Synth — dev notes

Vanilla JS + Vite (ES modules, no framework). Markup/CSS in `index.html`; contracts in `docs/architecture.md`.
Hand tracking: MediaPipe HandLandmarker (wasm + model loaded from CDN at runtime). Sound: Web Audio.

## Code layout (four layers)
- `main.js` — thin entry: builds services + `ctx`, registers modes, runs the camera/render loop.
- `src/input/hand-input.js` — landmarks -> `HandFrame` (fingers, counts, fist, pinch w/ hysteresis, height,
  tilt, display-space pos, handSize). ALL gesture classification lives here; thresholds are exported
  live bindings (`FIST_TIP_RATIO`, `PINCH_START`, `PINCH_END`, `THUMB_BAND`, `PINCH_LOOKBACK_MS`; change via
  `setThresholds()`, defaults in `DEFAULT_THRESHOLDS`). Pinch is decided before the finger count; while
  pinching use `voicingBeforePinch`, not `voicingCount`. Pure (no DOM) — unit-testable in Node.
  `camera.js` = camera + MediaPipe setup; `replay.js` = record/replay of raw results (DEV).
- `src/router.js` — left hand -> chord (via harmony); right hand -> radial menu hook (`router.setMenu`) ->
  active mode. Publishes `mode`.
- `src/modes/*.js` — mode plugins (`chords.js` = the original right-hand behavior + energy wave; `lead.js` +
  `lead-notes.js` (pure: note sets, snapping, octave/set state machine) + `lead-voice.js` (mono lead + pad)).
- `src/services/` — `audio.js` (SynthEngine + `ctx.audio` facade, emits `note/on|off`), `harmony.js`
  (key, chord tones, voicings, names, chord stabilizer), `analytics.js` (Clarity, prod-only).
- `src/core/` — `bus.js` (signal bus + `createParam`), `registry.js` (`registerMode`, menu items).
- `src/ui/mobile/` — phone/touch-tablet layout (docs/mobile-ui.md): `mobile-ui.js` (`mountMobileUI`, mounted last in
  main.js: one collapsible bar, Controls/Help sheets, guide strip, minimal HUD; inert on desktop), `mobile.css`
  (all under `body.gs-mobile`), `layout-metrics.js` (pure coverage/clear-area math), `safe-area.js` (notch insets for canvas).
  Lab: `/labs/mobile-lab.html?m=<state>`. `__gsTest.mobile` in DEV.
- `src/ui/` — `overlay.js` (video + landmark dots), `indicators.js` (chord/quality/meter/filter — read
  from the bus), `controls.js` (key/tone selects, guide, help, start overlay).

## Setup
Node lives at `~/.local/node/bin` on this machine (not on the default PATH):
`export PATH=$HOME/.local/node/bin:$PATH`, then `npm ci`.

- `npm run dev` — dev server (http://localhost:5173). `.claude/launch.json` has a `gesture-synth` preview config.
- **Tests: read `docs/testing.md` before writing any.** Four layers chosen by file name: `*.unit.spec.js` (Node,
  pure src/), `*.int.spec.js` (a lab page), `*.e2e.spec.js` / `mN-*.spec.js` (the real app), `*.build.spec.js`
  (vite build + preview). Playwright with headless system Chrome + fake webcam; own port per worktree (`PW_PORT`).
  - **Merge gate: `PW_PORT=52xx npm run verify`** (unit -> integration -> e2e -> build, prints per-layer times). ~2 min.
  - `npm test` (unit+int+e2e), `npm run test:unit` (~2 s, no server), `test:int`, `test:e2e`, `test:build`,
    `test:pages` (every page incl. auto-discovered labs), `test:visual` (pixel baselines; `-- --update-snapshots`
    after an intended UI change), `test:ui`, `test:audio`, `test:smoke` (real MediaPipe, needs network).
- `npm run signal` — visualizer output signaling/relay server (ws://localhost:5417; `SIGNAL_PORT`). Turn the output
  on in **Controls → Output** (switch + room code; the status chip at the top right appears only while it is on and
  opens Controls when pressed), open `/labs/visualizer.html`, type the code. `?signal=ws://…` overrides the
  server, `?outputRelay` forces the WebSocket relay. Output code: `src/output/` (webrtc-output.js is lazy-loaded).
  Wire mapping (bus name -> `/gs/...`, `menu` sent as an event, `pinch` derived from `right/pinch` while the bus has
  no `pinch` event) is the `ADDRESS_TABLE` in `src/output/protocol.js`; the beat grid is re-sent on every
  `clock.onTransport` change (start/stop/bpm/rate/x2), on every scheduled beat (drift correction) and every 2 s.
  Tests start the server on `PW_SIGNAL_PORT` (default PW_PORT + 200).

## How to verify changes yourself
- **Gestures without a camera:** open `/?mockHands` (dev server only). MediaPipe is skipped and
  each frame reads `window.__gsTest.results` (`{landmarks, handedness}`, same shape as
  `detectForVideo`). `tests/helpers/hands.js` builds these: `leftHand(degree, {minor})`,
  `rightHand(quality, {volume, tilt, thumb})`, `fist({...})`, `pinch({distance, ...})`; every builder
  also takes `pos` (display space), `view` and `scale`. `window.__gsTest` also exposes `synth`, `bus`,
  `router`, `ctx`, `handInput` (DEV only — never in the build).
- **Lead lab:** `/labs/lead-lab.html` (`?mockHands` for tests) runs Lead full-screen on the real ctx
  (`src/core/app-context.js`); mouse on the ladder strip, A-row/Q-row keys, 1-4 sets, -/= octave, Pad chord buttons.
  `window.__gsTest.lead._debug()` = controller state + drawn ladder; `__gsTest.freeze(true)` holds the frame.
- **Gesture test page:** `/labs/gesture-test.html` (dev server; also `?mockHands`, `?replay=`). Live HandFrame
  values per hand, threshold sliders (live-edit `setThresholds()` in hand-input.js), flicker counters, and a
  **Record** button that downloads raw MediaPipe results as JSON (`src/input/replay.js` format).
- **Replay real hand data:** put the JSON under `tests/fixtures/`, then `/?replay=/tests/fixtures/x.json`
  (app or test page, DEV only, real time; `&replayLoop` repeats) or in Node
  `replayThrough(loadRecordingFile(path))` from `tests/helpers/replay.js` -> per-frame HandFrames.
- **Signals:** `window.__gsTest.bus.get(name)` / `.manifest()` shows what is published.
- **Pure logic** (`tests/*.unit.spec.js`) imports `src/` modules directly in Node. Real-hand regressions:
  `tests/fixtures/<name>.json` + `<name>.expect.json` (docs/testing.md "Real-hand data").
- **Timing asserts** never get looser tolerances; audio timing tests run in `retryOnCaptureGlitch` (docs/testing.md).
- **Sound:** `tests/helpers/audio.js` taps everything going to `AudioContext.destination`.
  `recordAudio(page)` returns PCM; `assertNotes(spectrum(...), freqs)` checks the FFT peaks are
  exactly the expected pitches. Each chord test writes a WAV to `test-results/audio/`.
- **UI:** tests save screenshots to `test-results/screens/` — Read them to eyeball layout.
  Mobile layout test checks controls are on-screen and non-overlapping at 390×844.
- Microsoft Clarity analytics (Eric's project) loads only from production builds on a non-localhost
  host (see `src/services/analytics.js`). `tests/analytics.spec.js` asserts nothing is sent locally;
  `tests/production.build.spec.js` checks the built app (off on localhost, on + events on a real host).

## Known issues (tracked by tests)
- (fixed in M1) Output clipping: the master now has a limiter + soft clipper; `audio.spec.js › output never clips` passes.
- Audio-continuity tests record through a main-thread ScriptProcessor tap; under heavy parallel load it can drop a render
  quantum (spike/gap on a 128-sample join). `tests/m1-integration.spec.js` ignores quantum joins; lab timing tests can flake.
