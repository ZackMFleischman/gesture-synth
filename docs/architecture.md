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
 *   handedness: "Left"|"Right",   // MediaPipe label; "Left" = chord hand = the player's physical left hand
 *                                 // (verified with a real camera); displayed on the screen LEFT (mirrored view)
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
const menu = createRadialMenu({ items: () => MenuItem[], currentId: () => string });  // no tick (auto-select amendment)
// MenuItem: { id, type: "mode", label, icon, color, direction: "up"|"right"|"down"|"left" }
menu.update(right /* HandFrame|null */, now) -> {
  state: "closed"|"open"|"countdown",  // open = right hand held/locked
  hoverId, progress /* 0..1 */, selectedId,
  confirmed?: id,   // set on the frame the fist crosses the item's select radius (auto-select amendment)
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
  `registerMenuItemType()` (`playTick()` removed by the auto-select amendment). Choosing the current item = `cancelled` + `reason:"same-item"`.
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
    left hand was seen). It is Chords' only volume control (see "Chords volume = left hand only" below). `menu` (state): `{state, hoverId, selectedId, progress}` while
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
    flashes (`.gs-flash`) on a change. Lead first-use labels: "Height: note", "1–3 or 🤘: notes", "Pinch: play".
- M3 hookups: `clock.onTransport(cb)` (start/stop/bpm/rate/double). Wire: `menu` goes out as a `/gs/menu` event
  (open → update{arc, progress} → countdown → close{confirmed|cancelled}); every note event carries `id`; `/gs/note/cancel`;
  `/gs/pinch` 1/0 from the shared `pinch` bus event (derived from `right/pinch` if absent, marked `derivedFrom`);
  beat grid carries `rate`/`double` and is re-sent on every scheduled beat. Chip: hidden while output is off, pressing it
  opens Controls (`setPressHandler`, `newRoom`, `onStatus`), `data-gs-kind="status"`.
- Hand input publishes `left|right/top`: the highest fingertip in display space (the filter arc anchors above it).
- Camera feedback on Lead (ws/camera-feedback, first real-camera session):
  - Note sets come from distinct shapes (`SET_SHAPES` / `validCount` in src/modes/lead-notes.js): 1 = index, 2 = index+middle,
    3 = index+middle+ring, 4 = rock sign (index+pinky, middle+ring curled); thumb either way. An open hand (4 fingers ± thumb)
    never selects a set (it is the shape a pinch release opens into). Still 0.3 s stable + the pinch-approach/post-pinch rules.
  - Lead pitch is discrete: moving while pinched steps to the next note (`stepTo`, 3 ms exponential ramp `PITCH_STEP_S`; the
    controller event is `step`, was `glide`; legato `note/on` carries `legato: true`, was `glide: true`). Supersedes the
    "short glide" of spec 2.3 (user decision).
  - Setting confirmed (note set, octave; any Lead setting): `CONFIRM` + `confirmPhase()` in src/ui/theme.js: pop (scale 1.15 -> 1
    + flash, 150 ms), fully visible until 1 s after the confirm, 300 ms fade. Octave changes show an "Octave up: A5" toast at the arrow.
  - Every ladder line shows its note name (small, halo; chord notes brighter); the current note is the larger plate in the mode
    color in the same column (size shrinks from 28/22 px to fit between its neighbours). Narrow ladders drop the octave digit;
    landscape-phone ladders too tight for one label per semitone label chord notes only.
  - One filter visual: the arc at the right hand carries the value ("Filter +40%", region `filter-arc`.label). `#distortionDisplay`
    stays in the DOM (still updated) but is `display: none` under `body.gs-modes`. First-use "arc" labels stack above the value.
- Radial menu sub-menus + settings (ws/sound-menu, generic, `src/menu/*` only):
  - Item types: `mode`, `submenu` (`{…, items: SettingItem[] | () => SettingItem[], current?: () => id, setting?: key}`),
    `setting` (`{id, label, icon?, color? (default: the submenu's color), value? (default: id)}`). Max 2 levels (a submenu
    inside a submenu is dropped; at most `MAX_SUB_ITEMS` 8 children). Children are resolved when the sub-ring opens.
  - Sub-ring: opens when a selected submenu arc has the fist past its outer edge (`SELECT_R`) for `SUB_OPEN_MS` 150 ms
    (dipping back inside restarts the timer); center = the fist at that moment; same radii as the main ring. Children
    form a fan over 360° minus the back sector (`BACK_SPAN_DEG` 60°, pointing at the parent): list order starts next to
    the back sector, counter-clockwise on screen. 6 children under a down arc -> 50° sectors centered at -145 (up-left),
    165, 115, 65, 15, -35 (up-right); none straight down. Sector hysteresis = min(10°, 20% of the span).
    The fist reaching `BACK_R` (0.6) inside the back sector = back one level (main ring re-grows at its own entry point,
    selection cleared). The parent ring shrinks to a breadcrumb beyond the back sector ("Back" caption).
  - `update()` result adds `level` (0|1), `path` ([] | [submenuId]), `entered` (submenu id, frame the sub-ring opens),
    `back` (true), `setting: {key, submenu, id, value}` (open hand on a setting; `key` = `submenu.setting ?? submenu.id`),
    reason `"submenu"` (open hand on a submenu arc = no change), state `"flash"` (setting confirm: FLASH_MS only, no
    countdown — the right hand's controls don't change; then `finished`). `confirmed` stays mode-only. hoverId/selectedId
    are ids within the active ring. Snapshot: active ring at top level + `level`, `slots`, `back`, `host`, `hoverBack`,
    `subPending` (0..1), `parent` (main ring + `hostId`), `levelAt`, `levelFrom`, `confirmKind`, `confirmedItem`.
  - Pure helpers exported: `fanLayout(n, backAngle, backSpan)`, `pickSlot(angle, slots, prevKey, hyst)`, `BACK_ID`.
  - Drawing: an arc with a sub-menu has an outward chevron on its outer edge (slides out while passing through; hint
    "Keep going to open"); the sub-ring's back sector is a short dashed neutral arc; a setting confirm shows the picked
    value pill at the hand (~0.4 s) instead of the countdown ring. Lab: `labs/menu-lab.html` (down = "Sound", 6 instruments).
- Reach zones + sideways axes (ws/reach-zones, user feedback "my hand starts to get cut off"):
  - HandFrame `height` = the palm's position over the hand's vertical reach zone (display space; 0 bottom .. 1 top), no
    longer the wrist over 90 % of the camera image (that is now `rawHeight`). Zone (`src/input/reach-zones.js`, pure):
    palm y limits where the whole hand stays in frame = max(preset top, up + 3 %) .. min(preset bottom, 1 − down − 3 %),
    up/down = the hand's extent above/below the palm (max of the 21 landmarks and 1.3 / 0.9 hand sizes); band never shorter
    than 0.12 (centered when a hand is too big). Presets (`reach/range`, Controls "Range"): comfort 20–80 % (default), wide
    10–90 %, compact 30–70 %. Extents smoothed per hand (one-pole 400 ms, changes < 12 % ignored, so a tilt / pinch / fist
    never moves the value of a still hand); reset when the hand is lost.
  - HandFrame adds `x` (0 inner .. 0.5 neutral .. 1 outer of a horizontal band on the side the hand is DISPLAYED on, from
    `ui/sides`, else guessed from the palms; dead zone 16 % of the band around its middle), `zone`
    ({top, bottom, inner, outer, side, range}), `extents`, `rawHeight`. Bus (hand input): `left|right/x` (null when lost),
    `left|right/zone` (state, quantized to 1/1000); `reach/range` (state, ui).
  - Edge tracks span their hand's zone (marker = palm y, clamped to the band; hollow markers on the band). Lead's ladder
    spans the right hand's zone: arrows at the band ends, lines between (`ladderGeometry(..., band)`), DOM clearance still wins.
  - `src/core/axes.js` = THE mapping table (one line per axis): right x -> `drive`, left x -> `space`, curve `outward`
    (0 up to the neutral middle, 1 at the outer end); `<id>/on` switches (state, default true). The router calls
    `axes.update(left, right, {now, rightHeld})` every frame (right axes hold while the menu holds the right hand; lost
    hands hold). ctx.axes, router.axes.
  - Audio graph: `out` is a GainNode bus -> driveIn -> waveshaper (fixed tanh curve, null until Drive is first used) ->
    driveOut -> filter -> dry -> master; reverb send after the filter (`spaceSend` 0..0.8 -> ConvolverNode with a generated
    2.8 s IR, RT60 2.4 s, created on first use) -> master; dry trimmed by up to 22 % as Space rises. Drive = makeup ·
    tanh(g·x), g 0.05..9 (squared), makeup keeps a 0.3 reference peak (× 0.62 at full drive for the RMS rise):
    loudness within ±2 dB, limiter input falls as Drive rises. `audio.setDrive/setSpace`, `audio.drive/space`.
  - Wire: `/gs/drive`, `/gs/space`, `/gs/left/x`, `/gs/right/x` (ADDRESS_TABLE).
- Lead layer (ws/lead-layer; spec note "Decided after real-camera testing: Lead plays on top of the current mode"):
  - Modes split into BASE modes (Chords, Arp: accompaniment, left hand) and LAYERS (mode plugin `layer: true`: Lead). The
    router keeps `active` = the base and `layer` = Lead or null. Bus: `mode` = the base id (unchanged meaning for
    consumers), new `layer` (state, owner router) = "lead" | null; wire `/gs/layer` (ADDRESS_TABLE). Router getters
    `layer`, `layerId`, `rightMode`, `rightModeId` (= the mode the right hand drives), `select` (= `setMode`).
  - `router.setMode(id)`: a layer id turns the layer on over the current base (Lead again = false/no change); a base id
    sets the base and turns the layer off; the base that was underneath gets the right hand back with the RESUME_MS
    crossfade from the frame it last saw (`ctx.rightLocked` = that frame). Without a base (lead lab) a layer runs alone.
  - While the layer is on, every frame: `base.hold(ctx)` (left hand live, right-hand values held — the existing menu-hold
    mechanism, now also used indefinitely), then `layer.update(frame, ctx)`; with the menu holding, both `hold()`. `held` is
    built from the right-hand mode (`rightMode`). `ctx.layerBase` = base id while a layer is on (null otherwise).
  - Lead under a base: no pad, no `chord`/`voicing`/`chords/octave` publishing, no own energy wave (the base's stays).
    Arp under the layer draws no feedback at the hand (x2 pill / tempo plate).
  - Audio routing: the lead voice goes `env -> ctx.audio.layerOut (layerIn) -> layerFilter -> master` (new facade
    `layerOut`, `setLayerFilter(tilt)`: same curve as `setFilter`, publishes nothing). Right tilt drives Lead's filter
    param -> `setLayerFilter` (+ `setFilter` only without a base, for the pad). The base's shared filter stays at its held
    value. Why: one filter can't hold the base's value and follow the hand at once; a separate one keeps both continuous
    when the layer turns on/off and costs one BiquadFilter. Bus `filter` = the right hand's (lead's) tilt.
  - Menu (generic, metadata only): `registry.menuItems(activeId, { layerId })`; item type "layer" (confirm = same rule as
    "mode": the current item is a no-change); `currentId` = `router.rightModeId`. Optional item fields `secondary: true`
    (also running under the current item: hollow marker; choosing it is a change) and `confirmHint` (hint text when
    approached / selected; the base gets "Lead off").
  - Screen controls: the router mounts the base's rows and the layer's rows in `.gs-ctl-group[data-group=base|layer]`
    (header: mode name + "right hand held" / "right hand"). Chords shows a held Volume row (`data-control=chords-volume`)
    only under the layer. Controls-panel Mode row lights base + layer; tap tempo / gate apply to the base (`S.base`).
  - UI (`S` in src/ui/mode-ui.js): `modeId/mode/rightTrack/color/name` = the right-hand mode (Lead while layered);
    `baseId/base/baseName/baseColor/baseRightTrack`, `layerId`, `meter` (Lead layer: the base's meter — held + dimmed, except a master `volume` meter, which stays live). body
    `data-mode` = base, `data-layer`, class `gs-layer`, `--gs-base-mode`. Badge `● Arp + ● Lead` (`.gs-part-base` quieter,
    `.gs-two`); mobile pill the same (`.gs-pill-base/.gs-pill-layer`). Transport follows the base. Guide adds
    "Lead plays on top of <base>". No right edge track (Lead's ladder only).

- Chords volume = left hand only + BPM shifter at the pinch (ws/volume-bpm, user requests):
  - Chords' right height has NO function (for now): the chord voice plays at the fixed `CHORDS_LEVEL` (1, the gain
    staging's "right = 1" worst case, src/modes/chords.js) and the left height (master `volume`) is the volume.
    `chords/volume` is gone from the bus/wire. Chords: `rightTrack: null` (no right edge track), `meter: "volume"`.
  - Mode field `meter` (bus name | null): what the top-right 8-bar meter shows; default = the right track's param
    (Arp: gate, D5; Lead: none = hidden). A `volume` meter (Chords) does not dim with the right hand (`gs-meter-master`).
    Mode field `rightLost: true` keeps the right hand's "Hand lost" plate + ghost ring without a right track (Chords).
  - HandFrame adds `pinchPoint` (display space, midpoint of thumb tip 4 / index tip 8; null when not pinching) and `box`
    ({x0, y0, x1, y1}, display bounding box of the 21 landmarks). Bus (hand input): `left|right/pinchpt` (null when not
    pinching; wire `/gs/<side>/pinchpt` by the default mapping).
  - Arp pinch feedback: tempo scale + big BPM level with the pinch point, to its LEFT on screen (scale next to the hand,
    plate further left), clear of the hand box; on the right only when the left has less room (pinch near the left edge).
    During the ~1 s linger after the release it keeps the last pinch point's offset from the palm.

- Real screen sides (ws/real-sides, user-verified with a real camera): the chord ("Left") hand is the player's physical
  left hand and shows on the screen LEFT (mirrored selfie view), the right hand on the screen RIGHT. So in real use the
  master track is on the left edge; the right edge track, Lead ladder, filter arc, fist menu and BPM plate are on the
  right half. App defaults already match it (`ui/sides` before any hand is seen = `{chord: "left", expr: "right"}`
  from `S.chordSide = "left"` in src/ui/mode-ui.js; Lead's ladder edge = "right" when `ui/sides` is unpublished;
  `handZones()` chord zone left). Synthetic hands (`tests/helpers/hands.js` `hand()`: "Left" at raw x 0.7 = display
  0.3, "Right" at raw 0.3 = display 0.7), the tests' scenes and `npm run capture` use this orientation; the tests'
  `swap` variants (and the labs' `&swap`) are the mirrored case (chord hand on the screen right). Hand-internal geometry
  (thumb direction, tilt sign) is unchanged.

- Radial menu auto-select + display smoothing (ws/menu-autoselect, user feedback after real-camera testing 2026-11-22):
  - **Auto-select:** the fist crossing an arc's select radius (`SELECT_R` 0.6) chooses it at once, no open hand: mode /
    layer -> `confirmed` + flash + countdown; setting -> `setting` + flash; the current item -> closes quietly (`cancelled`,
    reason `"same-item"`, no countdown). Opening the hand before anything was chosen = cancel (`"empty"`, or `"submenu"`
    while a submenu arc is selected); tracking lost 0.3 s = cancel (unchanged). The first arc crossed wins.
  - Submenu arcs are never chosen: the sub-ring still opens after the fist stays past the edge for `SUB_OPEN_MS` 150 ms
    (kept as a dwell: the sub-ring centers on the fist, so opening mid-motion would let the follow-through carry the fist
    into a down-facing instrument). Any new ring (main at open / after back, sub-ring) selects nothing for
    `LEVEL_ARM_MS` 150 ms (= its grow-in).
  - **Re-arm / cooldown:** after ANY close the menu opens again only once the hand was seen not-fist (also counts during
    the flash / countdown), or `REARM_MS` 2000 ms after the close with the fist still held (then `ENTER_STABLE_MS`).
  - **No tick:** the `onTick` option and `playTick()` are gone.
  - **Drawing:** the chosen arc bumps (scale 1 -> 1.12 -> 1 over 180 ms about its middle) with a selection indicator (rim
    sweeps out from the middle in 140 ms + one outline ring expanding off the arc, 260 ms). Then a mode's arc fades over
    `COUNTDOWN_MS` 400 ms while the right hand stays held (the router still switches `mode` at the start; the new mode
    gets the right hand at the end); NO countdown ring / mode pill at the hand any more (user: "too busy"). A setting's
    arc fades over 220 ms; its value pill at the hand stays. Hints: "Move to choose", an item's `confirmHint` while it is
    approached. Snapshot adds `holdId`, `holdProgress`, `requireRelease`.
  - **Live config** `src/menu/menu-config.js` (Tweaks panel): `menuConfig` read every frame by menu-state + menu-draw,
    `setMenuConfig(partial)`, `resetMenuConfig()`, `MENU_CONFIG_DEFAULTS` = `{requireRelease: false, holdMs: 0, deadR: 0.22,
    innerR: 0.3, selectR: 0.6, deselectR: 0.44, cooldownMs: 2000, countdownMs: 400}` (re-exported by radial-menu.js).
    `requireRelease: true` = the earlier flow (crossing selects, open hand confirms / cancels); `holdMs > 0` = the fist
    must stay past the select radius that long first (rim fills; dropping inside restarts). `createMenuState`'s
    `timing` / `geometry` options still win per instance.
  - **Display smoothing** (`src/ui/smooth.js`, One-Euro: min cutoff 1.0 Hz, beta 2.5 per display-unit/s, d-cutoff 4 Hz,
    restart after a 250 ms gap; presets `filter` beta 0.35, `size`, `px` beta 0.0025; `createSmoothers()` keyed per
    visual). DISPLAY ONLY: `S.drawPos()` in mode-ui is now smoothed (`S.rawDrawPos()` = the old value) and feeds the filter
    arc, axis scales, edge-track markers + guide lines and first-use labels; the hand span uses a smoothed size; the arc's
    dot (filter value) + its fingertip anchor, axis dots, Arp's x2 pill / tempo scale / BPM plate (pos, size, pinch point,
    hand box), Lead's hand anchor (guide line, set badge) and the menu's fist dot / dashed line / setting pill are
    smoothed. Tilt -> filter cutoff, heights -> gate / volume / notes, and all menu selection math stay raw.
