# Gesture Synth — dev notes

Vanilla JS + Vite (ES modules, no framework). Markup/CSS in `index.html`; contracts in `docs/architecture.md`.
Hand tracking: MediaPipe HandLandmarker (wasm + model loaded from CDN at runtime). Sound: Web Audio.

## Code layout (four layers)
- `main.js` — thin entry: builds services + `ctx`, registers modes, runs the camera/render loop.
- `src/input/hand-input.js` — landmarks -> `HandFrame` (fingers, counts, fist, pinch w/ hysteresis, height,
  tilt, display-space pos, handSize). ALL gesture classification lives here; thresholds are exported
  constants (`FIST_TIP_RATIO`, `PINCH_START`, `PINCH_END`). Pure (no DOM) — unit-testable in Node.
- `src/router.js` — left hand -> chord (via harmony); right hand -> radial menu hook (`router.setMenu`) ->
  active mode. Publishes `mode`.
- `src/modes/*.js` — mode plugins (`chords.js` = the original right-hand behavior + energy wave).
- `src/services/` — `audio.js` (SynthEngine + `ctx.audio` facade, emits `note/on|off`), `harmony.js`
  (key, chord tones, voicings, names, chord stabilizer), `analytics.js` (Clarity, prod-only).
- `src/core/` — `bus.js` (signal bus + `createParam`), `registry.js` (`registerMode`, menu items).
- `src/ui/` — `overlay.js` (video + landmark dots), `indicators.js` (chord/quality/meter/filter — read
  from the bus), `controls.js` (key/tone selects, guide, help, start overlay).

## Setup
Node lives at `~/.local/node/bin` on this machine (not on the default PATH):
`export PATH=$HOME/.local/node/bin:$PATH`, then `npm ci`.

- `npm run dev` — dev server (http://localhost:5173). `.claude/launch.json` has a `gesture-synth` preview config.
- `npm test` — full Playwright suite (headless system Google Chrome, fake webcam). ~20s.
  - `npm run test:ui` (UI + gesture mapping), `npm run test:audio`, `npm run test:smoke` (real MediaPipe, needs network).

## How to verify changes yourself
- **Gestures without a camera:** open `/?mockHands` (dev server only). MediaPipe is skipped and
  each frame reads `window.__gsTest.results` (`{landmarks, handedness}`, same shape as
  `detectForVideo`). `tests/helpers/hands.js` builds these: `leftHand(degree, {minor})`,
  `rightHand(quality, {volume, tilt, thumb})`, `fist({...})`, `pinch({distance, ...})`; every builder
  also takes `pos` (display space), `view` and `scale`. `window.__gsTest` also exposes `synth`, `bus`,
  `router`, `ctx`, `handInput` (DEV only — never in the build).
- **Signals:** `window.__gsTest.bus.get(name)` / `.manifest()` shows what is published.
- **Pure logic** (`tests/bus.spec.js`, `tests/hand-input.spec.js`) imports `src/` modules directly in Node.
- **Sound:** `tests/helpers/audio.js` taps everything going to `AudioContext.destination`.
  `recordAudio(page)` returns PCM; `assertNotes(spectrum(...), freqs)` checks the FFT peaks are
  exactly the expected pitches. Each chord test writes a WAV to `test-results/audio/`.
- **UI:** tests save screenshots to `test-results/screens/` — Read them to eyeball layout.
  Mobile layout test checks controls are on-screen and non-overlapping at 390×844.
- Microsoft Clarity analytics (Eric's project) loads only from production builds on a non-localhost
  host (see `src/services/analytics.js`). `tests/analytics.spec.js` asserts nothing is sent locally.

## Known issues (tracked by tests)
- Output clips: 4 full-scale oscillators summed at gain ≤1 exceed ±1 above ~30% volume.
  `audio.spec.js › output never clips` is marked `test.fail()`; remove that when fixed.
