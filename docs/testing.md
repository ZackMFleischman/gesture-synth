# Testing strategy

One runner (Playwright, system Chrome) and four layers. A spec file's layer comes from its **name**, so a
new file lands in the right place without editing config. Merge gate: `PW_PORT=52xx npm run verify`.

## Layers

| Layer | Name | Runs in | Speed | What belongs here |
|---|---|---|---|---|
| **unit** | `*.unit.spec.js` | Node only: no page, no dev server | ms per test, layer < 2 s | Pure `src/` logic: hand-input classification (fist, pinch hysteresis, thumb, lookback), signal bus + params, harmony / music theory, arp patterns, clock math on a fake clock, lead-notes (sets, ladder, snapping, octave/set state machine), menu state machine, output protocol (address table, clock sync, room codes), signaling server, recorded-hand regression (`replayThrough`), test helpers' own logic (audio capture policy), the suite-layout guard |
| **integration** | `*.int.spec.js` | Browser, one subsystem through its **lab page** or real module | 1–15 s | Things a lab proves in isolation: menu drawing + timing in `labs/menu-lab.html`, arp scheduler + voice on recorded audio in `labs/arp-lab.html`, Lead in `labs/lead-lab.html`, live HandFrame view + Record in `labs/gesture-test.html`, layout contract in `labs/ui-lab.html` |
| **e2e** | `*.e2e.spec.js`, `mN-*.spec.js` | Browser, the **real app** (`index.html` + `main.js`) via `?mockHands` / `?replay=` | 1–20 s | User journeys in the shipped page: play chords (pitches on recorded audio), switch modes with the fist menu, each mode end to end, controls panel, help/guide, output on/off with a visualizer, no regression of the original behavior, page smoke for every served page, visual baselines |
| **build** | `*.build.spec.js` | `vite build` + `vite preview` (PW_PORT + 100) | ~6 s | What users get: no test hooks in `dist/`, app + start overlay work, `?mockHands` / `?replay=` inert, Clarity off on localhost and on (with events) on a real host |

The runner choice: Playwright for every layer (not `node --test`) so units keep the same `expect`, reporter,
filtering and `--list` as the rest. A unit file never touches the `page` fixture, so no browser launches, and
`playwright.config.js` starts no dev/signal server when only `--project=unit` / `--project=build` is requested
(`npm run test:unit`: ~2 s wall, of which ~1.3 s are tests).

**Which layer?** Write the test at the lowest layer that can see the bug, then add exactly one test per UX
item at the layer the user experiences it:
- A rule you can state without a DOM or AudioContext (thresholds, state machines, note math, protocol) → unit.
- How a subsystem sounds/draws/feels with real Web Audio + canvas, before it is wired into the app → integration
  in its lab.
- Anything a user does in the app → e2e. **A feature is not done while it is only tested in a lab** (see
  "Owed by integration").
- Production-only behavior (analytics, stripped dev hooks, bundling) → build.

## Commands
```
export PATH=$HOME/.local/node/bin:$PATH        # node is not on the default PATH here
PW_PORT=52xx npm run verify      # THE merge gate: unit -> integration -> e2e -> build, per-layer times
PW_PORT=52xx npm test            # unit + integration + e2e in one parallel run (no build)
npm run test:unit                # Node only, no server
PW_PORT=52xx npm run test:int | test:e2e | test:build | test:pages | test:visual
PW_PORT=52xx npx playwright test --project=e2e audio -g "Dmaj7"     # one test
```
Use your own `PW_PORT` per worktree (the dev server never reuses a port). Derived ports: signaling server
PW_PORT + 200, `vite preview` PW_PORT + 100. Extra args to `verify` go to every run (e.g. `--workers=4`).
`npx playwright test` with no `--project` runs all four layers in parallel — fine, but `verify` is the gate.

## Naming convention (enforced)
- New spec files **must** end in `.unit.spec.js`, `.int.spec.js`, `.e2e.spec.js` or `.build.spec.js`.
- Milestone acceptance specs `mN-<area>.spec.js` (e.g. `m1-integration.spec.js`, `m1-ui.spec.js`) drive the
  real app and are **e2e** by pattern.
- Pre-convention files keep their names and are classified by the `LEGACY` table in `playwright.config.js`
  (some are edited by in-flight branches). Don't add to `LEGACY`; rename instead.
- `tests/suite-layout.unit.spec.js` fails if a spec file matches no layer (or two), if `LEGACY` lists a
  missing file, or if a unit file imports `./fixtures.js` / a browser helper, uses a page fixture or `goto`.
- Helpers live in `tests/helpers/` (never named `*.spec.js`). Pure helpers (`hands.js`, `replay.js`,
  `theory.js`, the analysis half of `audio.js`) may be used by units; `fixtures.js`, `lead-lab.js`,
  `screencast.js` are browser-only.

## Current files

| File | Layer | Verdict |
|---|---|---|
| `arp-patterns.spec.js` | unit | Right place (patterns + clock on a fake clock). Legacy name. |
| `audio-capture.unit.spec.js` | unit | New: capture-glitch policy. |
| `gesture-reliability.unit.spec.js` | unit | Split out of `gesture-reliability.spec.js` (browser parts moved). |
| `hand-input.unit.spec.js` | unit | Split out of `hand-input.spec.js` (app geometry test moved to e2e). |
| `mobile-layout.unit.spec.js` | unit | Mobile layout math (coverage, clear area, hand zones, budgets) + safe-area edge-track x. |
| `lead-notes.unit.spec.js` | unit | Split out of `lead.spec.js` (was Node tests inside a browser file). |
| `output-protocol.spec.js` | unit | Right place (starts the signaling server in-process on its own port). Legacy name. |
| `radial-menu.unit.spec.js` | unit | Split out of `radial-menu.spec.js`. |
| `recordings.unit.spec.js` | unit | New: every `tests/fixtures/**/*.expect.json` is a test. |
| `suite-layout.unit.spec.js` | unit | New: convention guard. |
| `arp.spec.js` | integration | Right place for engine timing (±3 ms) on recorded audio. Lab-only: **app-level timing owed** (M1). Includes a WAV demo (not a gate-worthy assert; keep, it's cheap). |
| `gesture-test.int.spec.js` | integration | From `gesture-reliability.spec.js`. |
| `lead.spec.js` | integration | Right place for Lead UX checks 2.1–2.5 in the lab. Lab-only: **app journeys owed** (M2). Mode-switch test (Chords→Lead) belongs in e2e once Lead is registered in the app. |
| `lead-demo.spec.js` | integration | Demo artifact (melody WAV + screenshots), 1 assert. Keep; candidate for a non-gating demo tag later. |
| `mobile-ui.int.spec.js` | integration | Mobile system prototype in `labs/mobile-lab.html` (+ planned chrome as the before): budgets, clear area, 2-tap reach, sheets, 44 px targets, auto-collapse. |
| `menu-lab.int.spec.js` | integration | From `radial-menu.spec.js` (lab visuals). |
| `radial-menu-video.spec.js` | integration | Demo video, few asserts, slowest integration test (~15 s). Same note as `lead-demo`. |
| `ui-lab.spec.js` | integration | Layout contract on mock-ups. Duplicated by `m1-ui.spec.js` for every state the real app can show; after M1/M2 keep only states the app can't reach yet, then retire. |
| `analytics.spec.js` | e2e | Right place (dev never loads Clarity). Production side is in `production.build.spec.js`. |
| `app-input.e2e.spec.js` | e2e | From `hand-input` + `gesture-reliability` (`?replay` and view geometry in the app). |
| `audio.spec.js` | e2e | Right place: Chords pitches/expression on recorded audio. In-flight (m1-wiring). `output never clips` is `test.fail()` until the limiter lands. |
| `bus.spec.js` | e2e (legacy) | **Mixed**: 7 Node unit tests + 3 app tests in one file. Split the `bus (unit)` block into `bus.unit.spec.js` after m1-wiring merges (it edits this file). |
| `gain-staging.e2e.spec.js` | e2e | Gain staging around the master limiter: every chord (1344, offline render of the real engine) under the threshold at max settings; loudness linear in right volume and master; no limiting in steady loud Chords/Arp/Lead; peak <= 1. |
| `gestures.spec.js` | e2e | Right place (gesture → UI mapping in the app). Overlaps `hand-input.unit` on purpose: unit proves classification, this proves the wiring. |
| `m1-ui.spec.js` | e2e | Milestone spec, right place. |
| `mobile-ui.e2e.spec.js` | e2e | The app's mobile system: before/after audit, tray/sheets/guide strip/minimal HUD with the real handlers, first visit, blocked storage, phone first-use labels, desktop inert, real-app screens + video. |
| `output.spec.js` | e2e | Right place (app + visualizer, two contexts). Its demo-video test is the slowest e2e test (~19 s). |
| `pages.e2e.spec.js` | e2e | New: every served page (auto-discovers `labs/*.html`). |
| `smoke.spec.js` | e2e | Real MediaPipe from the CDN: **needs network**. The only test of the real tracker. |
| `ui.spec.js` | e2e | Right place. Overlaps `visual.e2e` (structure vs pixels) — intended. |
| `visual.e2e.spec.js` | e2e | New: pixel baselines of stable chrome. |
| `production.build.spec.js` | build | New. |

Duplicated coverage worth knowing (all intentional unless noted): `pages.e2e` `/?mockHands` ⊂ `ui.spec`
(smoke vs behavior); `analytics.spec` (dev) vs `production.build` (prod); `ui-lab.spec` vs `m1-ui.spec` (retire
the lab copy, above). Browser tests that should be unit: none left except the `bus (unit)` block. Unit tests
that need a browser: none.

## Tools
- **Mock hands** (`?mockHands`, dev only): each frame reads `window.__gsTest.results`. Build hands with
  `tests/helpers/hands.js` (`leftHand(degree, {minor})`, `rightHand(q, {volume, tilt, thumb})`, `fist()`,
  `pinch({distance})`, all with `pos`/`view`/`scale`); in specs use the `synthPage` + `setHands` fixtures
  (`tests/fixtures.js`), which also fail the test on any uncaught page error.
- **Replay** (`?replay=/tests/fixtures/x.json`, dev only, real time, `&replayLoop`): real or synthetic
  recordings through the real pipeline. In Node: `replayThrough(loadRecordingFile(f))` → HandFrames.
- **Audio capture** (`tests/helpers/audio.js`): `recordAudio(page, ms)` → `{ samples, sampleRate, health }`;
  `spectrum` / `assertNotes` / `peaks` / `centroid`; arp-specific onset/length/pitch/click analysis in
  `helpers/arp-analysis.js`. Write WAVs to `test-results/audio/` for ears.
- **Screenshots / video**: `page.screenshot` into `test-results/screens/` for review (not compared);
  `helpers/screencast.js` records WebM from CDP frames (no ffmpeg needed). Pixel comparison only via
  `toHaveScreenshot` (below).
- **Debug hooks**: `window.__gsTest` (`bus`, `router`, `ctx`, `synth`, `handInput`, `output`) in the app;
  `__menuLab`, `__lab`, `__uiLab`, `__viz`, `__gsTest.lead._debug()` in labs. Never in the build (tested).

## Timing tolerance policy
- Tolerances come from the spec (arp ±3 ms, chip < 1 s, …) or from a **measurement written next to the
  assert** (`// measured 64.8–66.3 ms over 20 runs`). Never widen one to make a test pass; if a tolerance must
  change, the commit message and the comment carry the new measurement and the reason.
- **Capture glitches.** The audio tap is a main-thread ScriptProcessor: under heavy machine load it can be
  starved, and the arp scheduler can be starved past its 100 ms lookahead. The tap records each block's
  `playbackTime`; `captureHealth()` reports discontinuities and captured-vs-expected samples, and the arp lab
  logs when each step was emitted (late steps = starved main thread). Timing tests run inside
  `retryOnCaptureGlitch(info, async ({ track }) => …)` and pass every recording to `track(rec)`:
  - assertions pass → pass (the strict tolerance was met);
  - assertions fail on a **clean** capture → fail immediately, never retried (a real timing bug);
  - assertions fail on a **glitched** capture → annotated `capture-glitch`, run once more; a second glitched
    failure fails with `CaptureGlitch: …` (the reason names the environment, not the code).
  Measured (36 busy loops on 20 cores, load ~56): `playbackTime` shows 2–14 ±128/±512-sample jumps per 10 s
  capture while onsets stay within 0.1 ms of the grid, so glitch flags alone never fail or retry a test.
  Limitation: a capture glitch that leaves no `playbackTime` trace is reported as a real failure.
- **Workers.** `arp.spec.js` runs its tests one after another (`mode: "default"`) but alongside other files.
  Isolating it completely (nothing else running) would add ~30–40 s to the integration layer (it is already
  the layer's critical path: ~75 s alone vs ~72 s for the whole layer); not done, because the observed
  flakes came from other agents' load, which a worker cap can't prevent. If timing flakes persist on a quiet
  machine, run `npx playwright test --project=integration arp --workers=1` to triage.
- Prefer event/condition waits (`expect.poll`, `waitForFunction`) over `waitForTimeout`; a fixed wait is only
  for letting audio/animation settle, with the reason in a comment.

## Visual baselines
- `tests/visual.e2e.spec.js` with `toHaveScreenshot`; PNGs in `tests/__screenshots__/<spec>/<name>-<platform>.png`
  (this machine: `-linux`). Thresholds in `playwright.config.js`: `maxDiffPixelRatio 0.002`, `threshold 0.2`,
  animations disabled, caret hidden.
- Only **stable** surfaces: start overlay, Chords chrome while playing (desktop + mobile), help modal, gesture
  guide. The canvas (fake-camera pattern, energy wave = `performance.now()` + `Math.random()`) is hidden during
  the screenshot via `stylePath: tests/helpers/visual.css`; canvas visuals are asserted structurally instead.
- After an intended UI change: `PW_PORT=52xx npm run test:visual -- --update-snapshots`, **Read the new PNGs**,
  commit them in the same commit as the change. A baseline diff you didn't intend is a regression.
- Arp / Lead / radial-menu chrome gets baselines after M1 wiring + M2 integration land (still in flux).

## Real-hand data → regression tests
1. On the dev server open `/labs/gesture-test.html` (real camera), do one thing on purpose (e.g. "pinch 3×
   from voicing 2", "fist then open, thumb flapping"), press **Record**, save the JSON.
2. Put it in `tests/fixtures/<name>.json` (keep it short: 5–15 s).
3. Add `tests/fixtures/<name>.expect.json` with what *should* happen, e.g.
   `{ "description": "...", "expect": { "right.pinchStarts": 3, "right.voicingChanges": { "max": 0 } } }`.
   `recordings.unit.spec.js` runs it in Node (metrics: `framesSeen pinchStarts pinchEnds fistStarts
   fistFrames fingerCountChanges voicingChanges thumbChanges`, per `left.` / `right.`).
4. If it fails, tune thresholds on the gesture test page (sliders live-edit `setThresholds()`), re-run.
5. For an app-level check, `page.goto(replayUrl("tests/fixtures/<name>.json"))` in an e2e test.

## Per milestone UX item (required checks)
Each automated check in `docs/plan.md` needs: logic at unit level where it exists, the measurement at
integration level, and **one e2e journey in the real app**. Status:

| Check | unit | integration | e2e (app) |
|---|---|---|---|
| M0 pinch 20/20, fist never pinch | gesture-reliability.unit, hand-input.unit | gesture-test.int | gestures.spec |
| M1 arp timing ±3 ms, no drift | arp-patterns (clock) | arp.spec | **owed (M1 wiring)** |
| M1 menu state machine, cancel = no change | radial-menu.unit | menu-lab.int | m1-integration (in flight) |
| M1 no click/gap on mode switch | — | lead.spec (Chords→Lead) | m1-integration (Chords↔Arp, in flight) |
| M1 height/thumb/pinch roles | hand-input.unit | arp.spec | m1-integration + m1-ui; **pinch = tempo on audio owed** |
| M2 preview == played, no flicker, set/octave rules | lead-notes.unit | lead.spec | **owed (M2)** |
| M3 chip < 1 s, zero work when off, visualizer data | output-protocol | — | output.spec |

## Owed by integration
| Gap | Milestone that delivers it |
|---|---|
| Arp timing in the real app (record in `/?mockHands` with Arp active, `matchToSchedule`, ±3 ms, inside `retryOnCaptureGlitch`) | M1 wiring |
| Pinch = tempo (1.6) heard on recorded audio in the app (not only the transport readout) | M1 wiring |
| Split `bus.spec.js` → `bus.unit.spec.js` (Node block) + app block | M1 wiring merge (lead) |
| Remove `test.fail()` from `audio.spec › output never clips` once the master limiter lands | M1 wiring |
| Re-baseline `visual.e2e` after m1-wiring merges (main.js changes meter/volume roles); add baselines for Arp chrome, menu open, controls panel | M1 wiring + M1 UI |
| Retire `ui-lab.spec` states now covered by `m1-ui.spec` in the app | M1 UI (after wiring) |
| Lead in the real app: select via the fist menu, pinch plays the previewed note (FFT), note-set toggle, octave arrows, pad under the melody, Lead↔Chords/Arp without a gap, Lead visual baseline (`m2-*.spec.js`) | M2 Lead integration |
| Output with modes: Arp/Lead notes reach the visualizer early with their playTime, manifest lists mode signals, chip clear of the new chrome on mobile | M3 hookups |
| Real-hand recordings (pinch, fist/menu entry, thumb flapping) with `.expect.json` | each milestone's dev-instance session (needs a person + camera) |

## Before a merge
`PW_PORT=52xx npm run verify` is green (all four layers). New behavior has tests at the layers above; new
pages are smoke-tested automatically (add a `PAGES` entry in `pages.e2e.spec.js` for their core interaction);
intended visual changes come with updated baselines; no assert was loosened without a measurement.
