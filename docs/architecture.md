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
