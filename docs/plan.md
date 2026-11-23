# Implementation plan: modes, radial menu, Arp, Lead, output

Spec: `docs/spec/requirements.md` (copy of the Claude Doc). Contracts: `docs/architecture.md`.
Integration branch: `feature/gesture-modes`. Every workstream runs in its own worktree on a `ws/*` branch
and is merged into the integration branch by the lead after its tests pass.

## Principles
- Augment the existing UI; never remove an existing control. `docs/ui-integration.md` (UI pass) decides placement.
- Build-plan order from the spec is kept for *integration*; *development* runs ahead in parallel against the contracts.
- Every step's "UX check" from the spec becomes an automated test where possible (mock hands + audio capture +
  screenshots/video). Checks that need a human (e.g. "a new player changes mode at first try") are listed on the
  progress page for you to try on the milestone dev instance.
- Timebox: an agent stuck ~3 attempts on one problem stops, reports, and the lead re-plans around it.

## Testing (cross-cutting; strategy in `docs/testing.md`)
- Three layers: **unit** (Node, pure logic), **integration** (one subsystem in the browser, usually its lab page),
  **e2e** (the real app via `?mockHands` / `?replay=`, plus a production-build smoke). Every page — the app and every
  `labs/*.html` — has a smoke test that loads it with no errors and exercises one core interaction.
- **Merge gate:** `npm run verify` (all layers + production build + no test hooks in `dist/`) must pass on the
  workstream branch AND again on `feature/gesture-modes` after the merge. A red gate blocks the next merge.
- A feature tested only in its lab is not done: each integration step owes an e2e test in the real app (listed under
  "Owed by integration" in docs/testing.md and tracked on the progress page).
- Visual baselines (`toHaveScreenshot`) for stable surfaces now; Arp/Lead/menu chrome gets baselines once integrated.
- Real-hand recordings from `labs/gesture-test.html` become replay regression tests in `tests/fixtures/`.

## Waves
| Wave | Workstreams (parallel) | Depends on |
|---|---|---|
| 1 | UI integration pass · Core refactor 0.1+0.2 · Radial menu component · Arp clock/engine | contracts |
| 2 | Integrate menu (1.2) + Arp mode (1.1) onto refactor · Gesture test page + pinch/fist tuning (0.3) · Shared UI chrome from the UI spec (edge tracks, badge, beat bar, controls panel) + left height master volume (1.3) · Lead engine (pure) · WebRTC output skeleton (bus consumer, signaling server) | wave 1 |
| 3 | Arp gestures 1.4 gate · 1.5 thumb x2 · 1.6 pinch tempo · Lead mode 2.1–2.5 integration · Output 3 (room code, chip, two channels, manifest, clock sync) + test visualizer page | wave 2 |
| 2b | **Test architecture**: layer split, verify gate, page smoke for all pages, prod-build smoke, visual baselines | wave 1 merged |
| 4 | End-to-end polish pass, help/guide content, full regression, milestone demos | all |

## Milestones (each ends with a dev instance for you to try)
| ID | Deliverable | Automated check |
|---|---|---|
| M0 | Refactor (no behavior change), signal bus, gesture test page, UI integration spec | all pre-existing tests unchanged + bus/hand-input tests; pinch 20/20 synthetic, fist never read as pinch |
| M1 | Arp mode + radial menu; left height = master volume; right height = gate; thumb = x2; pinch = tempo | arp timing (±3 ms, no drift), menu state machine, no click/gap on mode switch (audio capture), cancel = no change |
| M2 | Lead mode: pad + melody, note ladder, pinch to play, note-set toggle, octave arrows | preview note == played note, no flicker when still, note set never changes before pinch, slide-to-arrow never changes octave |
| M3 | WebRTC output: local signaling server, room code, status chip, reliable + fast channels, manifest, clock sync, early-sent scheduled notes; demo visualizer page | chip state < 1 s, zero output work when off (frame time unchanged), visualizer receives manifest + state + timed notes |

## Decisions made by the lead (veto any)
- Master bus gets a gentle limiter when Arp/Lead voices are added (the chords synth already clips above ~30% volume;
  more voices make it worse). Loudness stays similar; hard clipping goes away.
- Signaling server for M3 runs locally (small Node WebSocket server in `server/`); no third-party PeerJS cloud.
- Down arc stays free (spec).

## Dev instances
- Live integration branch (hot reload as merges land): http://localhost:5173
- Milestone snapshots (frozen worktrees): M0 http://localhost:5180 · M1 :5181 · M2 :5182 · M3 :5183
