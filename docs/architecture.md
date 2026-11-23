# Architecture contracts (lead-owned)

These are the interfaces parallel workstreams build against. Change them only via the lead
(note the change in your final report; don't silently diverge). Spec: `docs/spec/requirements.md`.

## Ground rules
- **Augment, don't replace.** The existing UI stays: key select, tone select, guide toggle + gesture
  guide, help button + modal, start overlay, chord display (bottom center), quality display, the right-hand
  volume meter (top right), filter readout, energy wave, landmark dots. New UI must fit around them per
  `docs/ui-integration.md` (written by the UI pass). Existing help/guide content gets *extended* for new gestures.
- Existing tests must keep passing. Chords-mode behavior stays identical except the decided role changes
  (left height = master volume, right fist = menu instead of mute) which land in milestone 1.
- Vanilla JS ES modules, no framework, no new runtime deps unless the lead approves (exception: the WebRTC
  library in milestone 3, lazy-loaded).

## File layout
```
main.js                  entry (index.html loads /main.js) — becomes thin: wires layers together
src/core/bus.js          signal bus + params
src/core/registry.js     registerMode(), getModes(), menu items
src/input/hand-input.js  landmarks -> HandFrame (all gesture classification lives here)
src/router.js            left hand (chord, master volume), right fist (menu), forwards right hand to active mode
src/services/audio.js    SynthEngine (+ voices for arp/lead), master gain
src/services/clock.js    tempo + lookahead note scheduler on the AudioContext clock
src/services/harmony.js  current chord -> notes (existing music theory moves here)
src/modes/chords.js      current behavior as a mode
src/modes/arp.js         milestone 1
src/modes/lead.js        milestone 2
src/menu/radial-menu.js  generic radial menu (knows nothing about specific modes)
src/ui/*                 overlay drawing + DOM widgets (edge tracks, badges, beat dots, controls)
src/output/*             milestone 3 (WebRTC), lazy-loaded
```

## HandFrame (output of src/input/hand-input.js, one per visible hand per video frame)
```js
/** @typedef {{
 *   handedness: "Left"|"Right",   // MediaPipe label; "Left" = chord hand (existing convention)
 *   landmarks: {x,y,z}[],          // raw 21 MediaPipe landmarks (unmirrored image space)
 *   fingers: {thumb:boolean, index:boolean, middle:boolean, ring:boolean, pinky:boolean},
 *   fingerCount: number,           // incl. thumb (left-hand chord degree semantics)
 *   voicingCount: number,          // index..pinky only (right-hand voicing semantics)
 *   fist: boolean,                 // index..pinky closed; must NOT depend on thumb
 *   pinch: boolean,                // hysteresis: start < PINCH_START, end > PINCH_END; requires middle extended
 *   pinchDistance: number,         // thumb tip <-> index tip / handSize
 *   height: number,                // 0 bottom .. 1 top (same mapping as existing getVolumeFromHeight)
 *   tilt: number,                  // -1..1, existing getHandHorizontalTilt semantics (right hand sign-flipped)
 *   pos: {x:number, y:number},     // palm center in DISPLAY space: 0..1 of the canvas, mirrored like the video
 *   handSize: number,              // wrist -> middle MCP distance in display-normalized units
 *   t: number,                     // performance.now() of the frame
 * }} HandFrame */
```
`ctx.toCanvas({x,y}) -> {x,y}` converts display-normalized coords to canvas pixels.

## Signal bus (src/core/bus.js)
```js
bus.declare(name, { type: "continuous"|"state"|"event", owner?: string })
bus.set(name, valueOrFn)          // continuous/state; fn evaluated only if someone consumes `name`
bus.emit(name, data, playTime?)   // events; playTime = AudioContext time the sound plays
bus.get(name)                      // last value (for on-screen visuals)
bus.subscribe(consumer, filter?) -> unsubscribe   // consumer: { onSet?(name,v), onEvent?(name,data,playTime) }
bus.manifest()                     // [{name,type,owner}]
ctx.param(name, { type, value, min?, max? }) -> { value }  // setting .value updates sound AND publishes
```
Names use the doc's addresses without the `/gs/` prefix: `left/height`, `volume`, `filter`, `mode`, `chord`,
`voicing`, `bpm`, `beat`, `note/on`, `note/off`, `pinch`, `menu`, `arp/gate`, `lead/noteset`, `lead/octave` …
With no subscriber, set/emit must be ~free (no allocation).

## Mode plugin (src/modes/*.js)
```js
export default {
  id: "arp", name: "Arp", icon: "<svg path or emoji>", color: "#4fb3ff",
  direction: "right",              // fixed menu direction: chords=up, arp=right, lead=left, down=free
  signals: [{ name: "arp/gate", type: "continuous" }],
  enter(ctx) {}, exit(ctx) {},
  update(right /* HandFrame|null */, ctx) {},  // NOT called while the menu holds the right hand
  draw(g /* CanvasRenderingContext2D */, ctx) {},
  controls(container /* HTMLElement */, ctx) { return () => {} },  // screen controls; returns cleanup
  menuItems: [],                   // optional extra items while this mode is active
};
registerMode(mode)  // menu shows registered modes automatically
```
Mode switching must never interrupt sound: the left hand keeps playing; values crossfade from locked to live.

## ctx (passed to modes)
```js
ctx = {
  audio,     // { ac: AudioContext, master: GainNode (master volume), out: AudioNode (pre-master bus),
             //   playChord(freqs), noteOn(freq, when, dur, {voice}), setFilter(tilt), setWaveform(type) }
  clock,     // { bpm, rate, start(), stop(), onStep(cb(stepIndex, time)), beatAt(time), nextBeatTime() }
  harmony,   // { chord: { roman, degree, isMajor, name, rootMidi, tones: Hz[] } | null, voicing: 1..4 }
  bus, param, toCanvas, now,
  masterVolume,  // 0..1, from left height (milestone 1.3)
}
```

## Radial menu (src/menu/radial-menu.js) — generic
```js
const menu = createRadialMenu({ items: () => MenuItem[], currentId: () => string, onTick?: () => void });
// MenuItem: { id, type: "mode", label, icon, color, direction: "up"|"right"|"down"|"left" }
menu.update(right /* HandFrame|null */, now) -> {
  state: "closed"|"open"|"countdown",  // open = right hand held/locked
  hoverId, progress /* 0..1 */, selectedId,
  confirmed?: id,   // set on the frame the hand opens on a selected item
  cancelled?: true, // open hand with nothing selected, or tracking lost > 0.3 s
}
menu.draw(g, ctx)   // ring, fills, rim, labels, countdown — all at the hand
menu.isHoldingRight()  // true from fist-entry until countdown end (router uses this to lock right-hand values)
```

## Testing
- `?mockHands` + `tests/helpers/hands.js` (extend it with fist/pinch/position helpers as needed).
- Each workstream adds specs under `tests/` and must leave `npm test` green.
- Always run with your own port: `PW_PORT=<assigned> npm test`. Node: `export PATH=$HOME/.local/node/bin:$PATH`.
- Labs: standalone pages (`labs/<name>.html`, served by vite) for developing a component in isolation are encouraged.
- Demo captures for the lead: save PNGs to `test-results/screens/` and videos (Playwright `video: "on"`) — report paths.

## Accepted amendments (lead, after wave 1)
- Bus: `bus.wants(name)`; `set()` notifies only on change (`Object.is`); `subscribe` filters accept name, `"prefix/*"`, array, or fn;
  `ctx.param(name, {…, onChange})`.
- ctx: `harmony.raw`, `harmony.notes()`, `harmony.describe()`, `harmony.keyVersion`; `audio.setVolume`, `audio.synth`.
- Radial menu `update()` result also has `reason` ("empty"|"same-item"|"tracking-lost"), `opened`, `finished`; extras `snapshot()`, `reset()`,
  `playTick()`, `registerMenuItemType()`. Choosing the current item = `cancelled` + `reason:"same-item"`.
- Units: `pos` is 0..1 of the canvas per axis; distances that must be isotropic use canvas-width units (divide dy by aspect).
- Mode plugin optional fields: `guide: [[emoji, label], …]` (right-hand gesture-guide rows) and `rightTrack: { param, label } | null`
  (what the right edge track shows; Lead sets null and draws its ladder).
- Layout contract: `clearArea()` from `src/ui/theme.js`; the master-volume track sits on the edge where the chord hand is displayed.
- UI files: `src/ui/{theme.js, modes.css, edge-tracks.js, hand-overlays.js, readouts.js, badges.js, controls-panel.js, transport.js, guide.js}`;
  chip in `src/output/status-chip.js`. Colors: Chords amber #e8a13d (unchanged), Arp #4fb3ff, Lead #c08cff, warning coral #ff5a5f.
- HandFrame (0.3): `voicingBeforePinch: number|null` — voicingCount from ~PINCH_LOOKBACK_MS (300 ms) before the pinch start,
  latched for the pinch; null when not pinching. Use it instead of `voicingCount` while `pinch`. Pinch is decided before the
  finger count. Thumb has hysteresis ±THUMB_BAND (0.08 hand sizes) when stateful. Thresholds: `setThresholds()/getThresholds()`.
  New files: `src/input/camera.js`, `src/input/replay.js`, `labs/gesture-test.html`.
- M1 wiring (ws/m1-wiring):
  - Audio graph: chord oscillators -> per-chord instance gain -> `chordGain` (Chords' right-height volume, `audio.setVolume`) ->
    `out` (PRE-FILTER waveshaper; every voice connects here) -> filter -> `master` (left height only, `audio.setMasterVolume`)
    -> limiter (DynamicsCompressor) -> soft clipper -> destination. Gain staging (ws/audio-gain-staging): steady playing
    never reaches the limiter. `CHORD_LEVEL` 0.13 per oscillator: the worst chord at master 1 / right 1 / sawtooth / filter
    fully open peaks at 0.67 (-3.5 dBFS) at the limiter input; Arp (gate 1, x2) ~0.5, Lead (lead + pad) ~0.36. Limiter
    `LIMITER` = -2 dBFS, knee 1, 20:1, 1 ms attack, 100 ms release (transients only; its fixed makeup is +1.0 dB); soft clipper
    linear to 0.9, |y| < 0.98, so the output never exceeds ±1. Loudness is linear in both volume controls
    (`tests/gain-staging.e2e.spec.js`).
  - ctx.audio adds: `waveform` (getter), `chordGain`, `masterVolume`, `releaseChord(fadeS)` (equal-power fade of the Chords
    pad; the next `playChord` starts a fresh chord with a 30 ms fade-in), `setMasterVolume(v)` (router only), `nextNoteId()`.
    `setFilter(tilt)` also publishes `filter`.
  - ctx: `clock` is a getter: one shared `createClock()` made with the AudioContext (null before the first user gesture);
    Arp's `enter` starts it, nothing stops it. `masterVolume` 0..1 (router). `rightLocked`: the right HandFrame locked when
    the menu opened (the last open-hand frame), for `enter()` of the next mode. `src/core/app-context.js` builds services +
    ctx + router for main.js and the labs alike.
  - Mode plugin optional `hold(ctx)`: called every frame INSTEAD of `update` while the menu holds the right hand (left hand
    live: chord changes, master volume). The router never passes a fist frame to a mode (it repeats the last open-hand frame).
    After the countdown or a cancel, the router crossfades frame `height`/`tilt` from `rightLocked` to the live hand over
    `RESUME_MS` (200 ms). On confirm: `mode` is set, `old.exit()`, `new.enter()` (same frame = countdown start).
  - `harmony.voicing` is shared across modes (Chords and Arp read/write it). `VOICING_SEMITONES` / `voicingSemitones()` live in
    `src/services/harmony.js`; the createChordStabilizer() function has `.prime(state, now)`.
  - Bus: `volume` = MASTER volume (left height; dead zone 0.04, ~140 ms smoothing, 0 at height <= 0.1, 1 at >= 0.55 (`MASTER_VOLUME`); 1 before a
    left hand was seen). Chords' right height = `chords/volume`. `menu` (state): `{state, hoverId, selectedId, progress}` while
    open/countdown, `null` when closed. `right/held` (state, bool). `bpm` declared at startup. Note events carry
    `{freq, midi, voice, id}`; `note/on` pairs with `note/off` or `note/cancel` by the globally unique `id`.
  - Router option `aspect()` (canvas w/h): the menu gets `handSize / aspect` (HandFrame.handSize is in display-HEIGHT units,
    the menu measures in canvas-WIDTH units).
  - For the modes UI: `menu` also has `confirmedId` during the countdown; `held` (state) = `{right: true, [rightTrack.param]:
    heldValue}` while the menu holds the right hand, `{[param]: heldValue}` during the 200 ms crossfade back, else null;
    hand input publishes `left/size`, `right/size` (handSize, display-height units). `ctx.setMasterVolume(v)` (router) =
    Controls slider: wins while bus `ui/override` lists `"master"`. Modes skip hand writes for params listed in `ui/override`
    (Arp: `arp/gate`). Arp publishes `filter` + `chord` + `voicing`; its bottom bar moved to `arp.drawTransport()` (lab only;
    the app uses src/ui/transport.js); `draw()` = energy wave + x2 pill at the hand (`drawX2Pill`). Tap tempo is in Arp's
    controls (`data-control="bpm-tap"`).
  - main.js redraws the video frame every animation frame (no build-up of translucent overlays) and schedules the next frame
    first, so an exception in a drawing layer never stops the router/sound.
- M1 1.6 pinch = tempo (ws/m1-pinch-tempo):
  - Bus: hand input emits `pinch` (event, owner hand-input) = 1 when the RIGHT (mode) hand starts a pinch, 0 at its release or
    when the pinching hand is lost (`/gs/pinch`). Left-hand pinches emit nothing. Arp publishes `arp/tempo` (state)
    `{startBpm, bpm, delta, pinching}` while the tempo feedback shows (pinch + ~1 s), else null; `bpm` comes from the clock.
  - Mode plugin optional `heldState()` -> `null | {phase: "held"|"return", values: {[param]: heldValue}}`: right-hand values a
    mode holds itself. The router publishes it as `held` (`held` -> `{right: true, ...values}`, `return` -> `{...values}`);
    the menu's own held/return wins. Arp: pinch = held `arp/gate`; after the release = return until the hand reaches it.
  - Arp pinch rules (`PINCH_TEMPO` + pure `pinchTempo()` in src/modes/arp.js): tempo = start + round(dy / handSize * 13) BPM
    (dy = vertical palm movement since the pinch start, up = +, display-height units; handSize latched at the start), with a
    0.2 BPM hysteresis band, clamped to MIN_BPM..MAX_BPM, applied through `clock.bpm` (its no-lost/no-doubled-step rule).
    While pinched: voicing = `voicingBeforePinch`, gate / filter / double time locked (double time restored from
    PINCH_LOOKBACK_MS before the pinch, the thumb ignored for 300 ms after the release). After the release the gate stays
    held until the hand height is within 0.02 of it or crosses it (Return); the filter crossfades back over 200 ms.
  - Visuals: Arp `draw()` draws the tempo scale + big BPM plate at the hand (outer side if >= 150 px room); edge tracks show
    "Gate held" next to the hollow marker during the pinch (hollow marker = the hand level at the pinch start) and drop
    the right guide while `arp/tempo` is set; first-use labels hide during a pinch.
  - Arp voicing hold (UX 1.6 follow-up): a new right-hand finger count must be stable CHORD_HOLD_TIME_MS (100 ms) before Arp
    applies it to scheduled steps and the bus `voicing`; a pinch forming (index curled, pinchDistance < 0.8 hand sizes, not
    pinched yet) waits PINCH_LOOKBACK_MS (300 ms). `VOICING_HOLD`, `voicingHoldMs()`, `isPinchApproach()` in src/modes/arp.js.
    Pinch start still restores `voicingBeforePinch`; `arp.set({voicing})` (screen/lab) applies at once; Chords is unchanged.
- M2 Lead integration (ws/m2-lead-integration):
  - Lead is registered in main.js (menu left). It never writes the master gain and never touches `synth.oscillators`
    (Chords' `exit` releases its chord; the router owns the master). `hold(ctx)`: the lead note stops, the ladder
    dims, the pad keeps playing and follows the left-hand chord; after the menu a pinch still closed from before
    must open once before it plays.
  - Lead publishes `chord` + `voicing` (1 = the pad's triad) + `chords/octave` (false), `filter` (right tilt),
    `lead/noteset`, `lead/octave`; note events `{freq, midi, voice: "lead"|"pad", id}` with ids from
    `ctx.audio.nextNoteId`.
  - The ladder follows `ui/sides` (`expr` edge; "right" when unpublished, e.g. the lab), mirrored on the left;
    narrower below 520 px (44 px to the inner end of the chord lines, 22 px note name); respects the safe-area
    inset of its edge; keeps its arrows clear of DOM controls on that edge (measured every 500 ms). With Lead
    following the sides, the master track always stays on the chord hand's edge (edge-tracks.js).
  - Lead's screen controls are Controls-panel rows (`.lead-controls`: note set `[data-control=noteset]`, octave
    `[data-control=octave-up|down|octave]`); its mouse strip `#leadPad` is mounted on `#stage` over the ladder band.
  - `#noteSetBadge` is placed with the CSS variable `--gs-noteset-left` on `body` (no inline position on the badge);
    flashes (`.gs-flash`) on a change. Lead first-use labels: "Height: note", "Fingers: notes", "Pinch: play".
