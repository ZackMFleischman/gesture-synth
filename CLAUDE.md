# Gesture Synth — dev notes

Vanilla JS + Vite. All app logic is in `main.js`, all markup/CSS in `index.html`.
Hand tracking: MediaPipe HandLandmarker (wasm + model loaded from CDN at runtime). Sound: Web Audio.

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
  `rightHand(quality, {volume, tilt, thumb})`. `window.__gsTest.synth` exposes the SynthEngine.
- **Sound:** `tests/helpers/audio.js` taps everything going to `AudioContext.destination`.
  `recordAudio(page)` returns PCM; `assertNotes(spectrum(...), freqs)` checks the FFT peaks are
  exactly the expected pitches. Each chord test writes a WAV to `test-results/audio/`.
- **UI:** tests save screenshots to `test-results/screens/` — Read them to eyeball layout.
  Mobile layout test checks controls are on-screen and non-overlapping at 390×844.
- Microsoft Clarity analytics (Eric's project) loads only from production builds on a non-localhost
  host (see top of `main.js`). `tests/analytics.spec.js` asserts nothing is sent locally.

## Known issues (tracked by tests)
- Output clips: 4 full-scale oscillators summed at gain ≤1 exceed ±1 above ~30% volume.
  `audio.spec.js › output never clips` is marked `test.fail()`; remove that when fixed.
