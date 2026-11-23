# UI integration: modes UI around the existing UI

Status: proposal from the UI pass (branch `ws/ui-pass`). Implement against this. Change requests go through the lead.
Visual reference: `labs/ui-lab.html?state=<state>` (dev server). Add `&debug` to see the clear area and the boxes the
layout test checks, `&swap` to put the chord hand on the screen right (the unusual case; real use = chord hand on the
screen LEFT, see Q1), `&bg=bright` for a bright room.
Tokens and canvas primitives: `src/ui/theme.js`. Layout contract test: `tests/ui-lab.spec.js`.

User constraint this doc implements: *don't replace the current UI; augment it. The radial UI is new, but the
side elements must integrate with what exists.*

---

## 1. Decisions at a glance

| # | Decision | Why |
|---|---|---|
| D1 | **Chord display stays bottom-center** (spec puts it top). | The energy wave is anchored to it (`drawEnergy` centerY = h-56); moving it would break the existing look. The bottom is also where it is today, so players already look there. Top-center stays empty: it is the player's head. |
| D2 | **Amber stays the app color and becomes the Chords mode color.** Warnings use **coral red `#ff5a5f`**, not amber. | Spec says "amber only for warnings", but amber is the existing brand on every control. Repainting the app would clobber it. Chords *is* the existing behavior, so Chords mode looks exactly like today. Warnings get a hue no mode uses, plus a dashed pattern so they don't rely on color alone. |
| D3 | **Color rule:** global/left-hand/chrome = amber (selects, guide, help, chord display, wave) or neutral ink (master volume track). Everything the **right hand** controls = **mode color** (right track, meter, filter readout, filter-arc dot, menu fills, x2, cursor). | Gives "one accent per mode" without recoloring the existing chrome. In Chords both are amber = today's look. |
| D4 | **Mode colors:** Chords `#e8a13d` (amber), Arp `#4fb3ff` (sky blue), Lead `#c08cff` (violet). Good/connected `#5ad17a`. | Three hues ~120° apart, all readable on the dark plates; none collides with warning coral or with green "good". |
| D5 | **The 8-bar meter (top right) becomes the right-hand expression meter**: it shows the value of whatever right height controls in the active mode (Arp = gate), bars in the mode color. Hidden in Lead (right height is the note; the ladder shows it). *Amended (ws/volume-bpm):* Chords' volume is the left hand only, so in Chords the meter shows the master volume (`mode.meter`) and does not dim with the right hand. | Keeps the existing widget with its existing meaning in Chords (the `ui.spec` meter test stays green), and gives it a meaning in other modes. |
| D6 | **"Filter: x%" readout stays** as the numeric twin of the filter arc (status at the edge; the arc is the feedback at the hand). Text takes the mode color + a 1px text shadow for bright video. | Augment, not replace. |
| D7 | **Mode badge** goes on the first row, right of the key select (x=110). In Lead the 4-segment note-set badge follows it. | Top-left is the existing settings column; the badge joins it instead of fighting it. Click/tap on the badge opens the controls panel. |
| D8 | **Screen controls** = a `Controls` toggle on the third row (next to `Open Guide`) that opens a panel **in the same slot and style as the gesture guide**. Guide and panel are mutually exclusive. The spec's bottom-right "Settings" pill is dropped. | Extends the existing dropdown column (key, tone are already settings). Keeps the bottom free for the chord + transport. |
| D9 | **Transport** (BPM, 4 beat dots, 8 step dots) is a small plate **centered just above the chord display**, Arp only. | Status at the bottom edge as the spec asks, tied to the chord it plays. Same position on desktop and mobile. |
| D10 | **Edge tracks live in a 20px gutter.** The existing left column, help button, meter and readout move in by 8px (12 → 20px) via an additive, class-scoped CSS rule. | Full-height tracks need the screen edge; an 8px shift is the smallest change that gives them room without overlapping anything. |
| D11 | **Tracks follow the hands, not the words "left/right"**: the master-volume track is on the screen edge where the chord hand is displayed. | Real use (Q1, verified with a real camera): the chord ("Left") hand shows on the screen LEFT, so the master track is on the left edge and the right-hand control (track / Lead ladder) on the right. The rule still covers crossed hands; layout works either way (tested with `&swap` / the tests' `swap` scenes). |
| D12 | **Connection chip** sits top right, left of the meter; on narrow screens (<520px) it collapses to its dot. It shows only once the output is turned on. | Fits the top-right status group without moving the meter. |

---

## 2. Layout maps

Coordinates are CSS px. `gutter` = 20. Canvas elements are drawn on `#overlay`; DOM elements are absolutely
positioned in `#stage`.

### Desktop 1280 x 800

```
 0 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
   │▌[A ▾] (● Arp)                                                  (● Direct 24ms) ▀▀▀▀▀▀▀▀ ▐│ y 12  row 1: key, mode badge (+note-set in Lead) | chip, meter
   │▌[Warm Synth ▾]                                                                ▀▀▀▀▀▀▀▀ ▐│ y 48  row 2: tone
   │▌[Open Guide][Controls]                                                     Filter: +20%▐│ y 90  row 3: guide, controls | y 105 readout
   │▌┌ guide OR controls panel ┐  ┌ - - - - - - - - - clear area - - - - - - - - ┐          ▐│ y 128 panel slot (user-opened)
   │▌│                          │  ¦ x 282..998, y 128..608                       ¦          ▐│
   │▌└──────────────────────────┘  ¦          (player; only hand-anchored         ¦  ◠ filter▐│
   │▌                              ¦           feedback may enter)                ¦  ✋ arc  ▐│
   │█━ ·· ·· ·· ✋ chord hand        ¦                                    ✋ ·· ·· ·· ·· ·· ━█│ markers level with hands, dotted guides
   │▌                              ¦                                       (x2)   ¦          ▐│
   │▌                              └ - - - - - - - - - - - - - - - - - - - - - - ┘          ▐│
   │▌                                  ( 110 BPM  ○●○○ | ··•····· )                         ▐│ y 676..700 transport (Arp)
   │▌ (?)  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ Bm(ii) ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~▐│ chord + wave (existing)
800└───────────────────────────────────── Minor 7th ────────────────────────────────────────┘
    ↑ master-volume track (x 3..17)                                     right track (x 1263..1277) ↑
```

### Mobile 390 x 844

```
 0 ┌──────────────────────────────────────┐
   │▌[A ▾] (● Arp)            (●) ▀▀▀▀▀▀▀ ▐│ y 12   chip collapses to its dot (x 262..288), meter x 300..370
   │▌[Warm Synth ▾]               ▀▀▀▀▀▀▀ ▐│ y 48
   │▌[Open Guide][Controls]  Filter: +20%▐│ y 90 / 105
   │▌┌ guide OR controls (330 wide) ┐    ▐│ y 128 panel slot (covers the center when open: user's choice)
   │▌└──────────────────────────────┘    ▐│
   │▌     ┌ - - - clear area - - - ┐     ▐│ x 86..304, y 160..624
   │▌     ¦                        ¦  ◠  ▐│
   │█━··✋¦                        ¦  ✋··━█│
   │▌     └ - - - - - - - - - - - -┘     ▐│
   │▌    ( 110 BPM ○●○○ | ··•····· )    ▐│ y 720..744 transport
   │▌(?) ~~~~~~~~~ Bm(ii) ~~~~~~~~~~~~~~ ▐│ chord + wave (existing)
844└──────────── Minor 7th ───────────────┘
```

Clear area (`clearArea(w, h)` in `theme.js`): x 22%–78% of the width; y 16%–76% (landscape) or 19%–74% (portrait).
**No persistent status element (new or existing) may intersect it.** Exempt: hand-anchored feedback (it follows the
hand), first-use labels (3 s), and user-opened panels (gesture guide, controls panel, help modal).

---

## 3. Existing elements: what each becomes

| Existing element | Today | With modes | Change needed |
|---|---|---|---|
| `#keySelect`, `#toneSelect` | top-left column, x=12 | Same, x=20 (D10). Global, never hidden. | CSS `left` under `body.gs-modes` |
| `#guideToggle` + `#gestureGuide` | row 3 / panel at y=128 | Same place, x=20. Guide gets a mode section appended (§6). Opening it closes the controls panel. While open, the active mode's first-use labels show at the hand. | Append rows in `updateGestureGuide()`; mutual exclusion |
| `#helpButton` + `#helpModal` | bottom-left, x=16 | Same, x=20. Modal gets new sections (§6). | CSS `left`; modal HTML additions |
| `#chordDisplay` + `#qualityDisplay` | bottom-center | **Unchanged, all modes** (D1). It is the left hand's output, so it keeps amber. In Lead it is the pad chord. | none |
| Energy wave (`drawEnergy`) | canvas, bottom | **Unchanged, all modes.** Bottom layer of the overlay, below all new canvas elements. | none |
| `#volumeMeter` (8 bars) | right-hand volume | Right-height expression meter in the mode color (D5): Chords = master volume (left height; does not dim), Arp = gate (dims, opacity .4, while the right hand is held or lost). **Hidden in Lead.** | `.lit` color via `--gs-mode`; feed it the mode's right-height param |
| `#distortionDisplay` "Filter: x%" | below meter | Same text and position (x=20 from right), mode color, dims when held. All modes. | CSS only |
| Landmark dots | white 50% | Unchanged. Drawn with the video, under all new overlays. | none |
| `#startOverlay` | z 10 | Unchanged. New canvas UI is not drawn until it is dismissed (canvas is `.dimmed` anyway). | none |

## 4. New elements: placement

All sizes scale with `handSize` where noted; `hs` below = the hand's on-screen span (wrist to fingertips).

**Screen edges (status, persistent)**
- **Master-volume track** (canvas): full height (y 12 → h-12), center 9px from the chord hand's edge, 6px wide,
  neutral ink, fill below the marker at 35 %. Marker: 14px tick level with the chord hand's palm; dotted guide from
  the tick to the hand. All modes, also while the menu is open (left stays live).
- **Right track** (canvas): same geometry on the other edge, in the mode color. Arp = gate; none in Chords (right height has no function there). Lead:
  replaced by the note ladder. Held (menu/countdown/pinch): track dims to 40 %, hollow marker at the held value, no
  guide. Return: hollow + solid markers together until they meet.
- **Lead note ladder** (canvas): replaces the right track. Lines from 8px off the edge inward (scale notes 40px thin
  ink 55 %; chord notes 54px, 2.5px, mode color). Top line at y=176 (below the filter readout), bottom at h-100 (the down arrow then clears the help button if the ladder is on the left).
  Up/down outline arrows 24px beyond the ends; 4 octave dots on the inner side of the up arrow.
- **Mode badge** (DOM `#modeBadge`): row 1, x=110, 26px pill, mode color 15 % fill + 1.5px stroke + dot + name.
  Color switches at the **start** of the countdown (spec). Click → opens the controls panel.
- **Note-set badge** (DOM `#noteSetBadge`, Lead only): right after the mode badge, 4 segments, one lit.
- **Controls toggle** (DOM `#controlsToggle`): row 3, x=136, same style as `#guideToggle`; `aria-pressed` + amber
  border when open.
- **Controls panel** (DOM `#controlsPanel`): y=128, x=20, width min(330px, 100vw-40px), same plate as the guide.
  Rows: Mode (segmented) / Tempo [−] 110 [+] [Tap] / Rate 1/4·1/8·1/16 / Pattern Up·Down·Up-down·Random / Gate
  slider / Double time switch / Master vol slider. Mode-specific rows come from `mode.controls(container, ctx)`;
  Mode + Master vol are global. A ✋ mark sits on rows a gesture currently controls.
- **Transport** (DOM `#transport`, Arp only): centered, bottom 100px (just above the chord), 24px plate:
  `110 BPM` · 4 beat dots (current filled in mode color, pulses) · divider · 8 step dots (current lit; a step
  ringed in the mode color = chord change waiting for that step).
- **Connection chip** (DOM `#outputChip`, milestone 3): row 1, right of the mode group, `right: 102px` (left of the
  meter). States per mock 6; relayed uses the warning color. <520px wide: dot only.

**At the hand (feedback, follows the hand, exempt from the clear area)**
- **Filter arc**: centered on the right palm, r = 0.95 hs, −150° → −30° (above the hand), 1.5px quiet ink; dot in
  the mode color at the tilt value. Held: arc 45 %, hollow dot. All modes.
- **Radial menu**: center = fist entry point, clamped so ring + labels fit inside the gutters and below y=150
  (movement stays relative to the entry point). r1 = 0.95 hs, r0 = r1/2, select radius 0.92 r1, arcs 82° with 8°
  gaps. Labels: up label above the ring; side labels above the outer end of their arc (out of the fist's path).
  Current mode = small ink dot just outside its arc. "Open hand" caption under the ring only in the selected state.
- **Countdown**: ring around the open hand, 3px, mode color, sweeps closed while shrinking from 0.95 hs to 0.65 hs
  over 400 ms; mode name under it.
- **x2 pill** (Arp): 0.9 hs under the right palm; outline until the next beat, then filled.
- **Pinch (Arp)**: tempo scale (1 tick = 1 BPM, ±10 visible, start tick + current tick) level with the pinch point
  (thumb tip + index tip midpoint, `right/pinchpt`), to the LEFT of it on screen and clear of the hand box; beyond it
  (further left) the big BPM on a plate + `BPM +6`. On the right only when the left has less room (user request).
  Visible during the pinch and 1 s after.
- **Lead cursor**: ring (r 9) on the nearest ladder line; hollow = preview, filled + glow = playing. The note name
  (28px bold, on a plate) sits just inside the ladder next to the ring; dotted guide from the hand to the name.
- **First-use labels** (3 s at first entry to a mode, and whenever the guide is open): plates, ≤ 2 words:
  `Gate` (next to the right-track marker), `Filter` (above the arc), `Thumb: x2` (thumb side), `Pinch: tempo` (under
  the hand).
- **Hand lost**: that hand's track dims; its markers turn dashed coral; a 10px `Hand lost` plate hugs the edge at
  the last marker. Hand-anchored elements of that hand are not drawn. The other hand is unaffected.

## 5. Z-order

Canvas `#overlay` (single canvas, painter's order), then DOM above it:

1. video frame + landmark dots (existing)
2. energy wave (existing)
3. edge tracks / Lead ladder (+ dotted guides)
4. hand feedback: filter arc, x2, tempo scale, Lead cursor + name
5. radial menu / countdown (top of canvas; only one of 4–5 group is "active" at the hand at a time)
6. first-use labels
7. DOM, z-index 4: `#transport`, `#chordDisplay`, `#qualityDisplay`, `#volumeMeter`, `#distortionDisplay` (existing ones have `z-index:auto`)
8. DOM, z-index 5: selects, guide toggle, `#modeBadge`, `#noteSetBadge`, `#controlsToggle`, `#gestureGuide`, `#controlsPanel`, `#outputChip`
9. `#helpButton` 6 · `#startOverlay` 10 · `#helpModal` 20 (existing)

Canvas guides that run under DOM controls (e.g. the master guide under an open guide panel) are simply covered.

## 6. Visibility by mode and state

| Element | Chords | Arp | Lead | Menu open / countdown | Pinch (Arp) | Right hand lost |
|---|---|---|---|---|---|---|
| Master track | ✓ | ✓ | ✓ | ✓ live | ✓ | ✓ |
| Right track | — (none) | ✓ gate | — (ladder) | dim + hollow | dim + hollow | dim, dashed coral marker |
| Note ladder + cursor | — | — | ✓ | ladder dims | — | cursor hidden |
| Meter (8 bars) | ✓ master volume, amber | ✓ gate, blue | hidden | dim | dim | dim |
| Filter readout | ✓ | ✓ | ✓ | dim | dim | dim |
| Filter arc | ✓ | ✓ | ✓ | hidden | dim, hollow dot | hidden |
| Mode badge | ✓ | ✓ | ✓ + note-set | switches at countdown start | ✓ | ✓ |
| Transport | — | ✓ | — | ✓ (arp keeps running) | ✓ (live BPM) | ✓ |
| x2 pill | — | thumb out | — | hidden | hidden | hidden |
| Chord + quality + wave | ✓ | ✓ | ✓ (pad) | ✓ | ✓ | ✓ |
| Key/tone/guide/help/controls | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Hand-anchored elements never show for a hand that is not tracked.

## 7. Guide and help extensions

**Gesture guide** (`#gestureGuide`): keep the 7 degree rows exactly as `updateGestureGuide()` renders them, then
append a separator, a header with the mode dot + mode name, and right-hand rows for the active mode
(`.gesture-guide-row.gs-guide-mode`: emoji in `.gesture-guide-gesture`, then `.gs-guide-label`):

| Chords | Arp | Lead |
|---|---|---|
| ✊ Menu · 👍 Octave down (volume = left height) | ✊ Menu · ↕ Gate · 👍 Double time · 🤏 Tempo | ✊ Menu · ↕ Note · 🤏 Play · 1️⃣2️⃣3️⃣🤘 Note set |

Rows come from the mode plugin (proposed `guide: [[emoji, label], ...]`, see §10). The existing
`tests/ui.spec.js` guide test selects `.gesture-guide-note`, which the appended rows don't use, so it stays green.

**Help modal** (`#helpModal .help-content`): keep everything; insert after the intro paragraph:

```html
<h3>Modes</h3>
<p><b>Right fist</b> → mode menu. Move the fist toward a mode (Chords up, Arp right, Lead left),
then open the hand. Open in the middle to cancel. Your left hand keeps playing.</p>
```

add to **Left Hand**: `<p><b>Height</b><br>Higher → Louder (master volume, all modes)</p>`; retitle the existing
right-hand section **Right Hand (Chords mode)** and note that a **fist opens the menu** (no longer mutes); then add:

```html
<h3>Arp mode</h3>
<p><b>Height</b> → gate (short to long notes)<br><b>Thumb out</b> → double time<br>
<b>Pinch + move up/down</b> → tempo<br><b>Fingers</b> → which chord notes · <b>Tilt</b> → filter</p>
<h3>Lead mode</h3>
<p><b>Height</b> → note · <b>Pinch</b> → play it<br><b>Fingers (hold)</b> → note set<br>
<b>Pinch an arrow</b> → octave up/down · <b>Tilt</b> → filter</p>
```

## 8. DOM additions and CSS (all additive)

New nodes, inserted by `src/ui/*` at startup (not in `index.html`, so it stays untouched):
`#modeBadge` and `#noteSetBadge` after `#keySelect`; `#controlsToggle` after `#guideToggle`; `#controlsPanel` after
`#gestureGuide`; `#transport` and `#outputChip` appended to `#stage`. Each carries `data-gs-kind` (`status` or
`panel`) so layout tests can find them.

CSS: `labs/ui-lab.css` is the proposed stylesheet. Everything is scoped under `body.gs-modes` (set by `main.js`
once the modes UI is wired), so it is inert until then. `body[data-mode]` sets `--gs-mode`; `body.gs-right-held`
dims the right-hand readouts. The only overrides of existing rules are the 8px edge shift (R1) and the meter/readout
color, both scoped. Suggested home: `src/ui/modes.css` imported from `main.js` (Vite handles CSS imports).

## 9. Ownership

| Element | Owner module (architecture.md layout) | DOM / canvas |
|---|---|---|
| Tokens, primitives, `clearArea()` | `src/ui/theme.js` (this pass) | — |
| Additive CSS (`body.gs-modes …`) | `src/ui/modes.css` | DOM |
| Master-volume track | `src/ui/edge-tracks.js` (reads `volume`, left HandFrame) | canvas |
| Right track (generic: value, held, lost) | `src/ui/edge-tracks.js`; the mode supplies value + color via its param | canvas |
| Filter arc | `src/ui/hand-overlays.js` (reads `filter`, right HandFrame) | canvas |
| Hand-lost styling | `src/ui/edge-tracks.js` (from router hand presence) | canvas |
| Meter + filter readout updates | `src/ui/readouts.js` (existing elements; bus `right/height`-param, `filter`) | DOM (existing) |
| Mode badge, note-set badge | `src/ui/badges.js` (bus `mode`, `lead/noteset`) | DOM |
| Controls toggle + panel shell, Mode + Master rows | `src/ui/controls-panel.js` | DOM |
| Mode-specific control rows | each mode's `controls(container, ctx)` | DOM |
| Transport (BPM, beat, step dots) | `src/ui/transport.js` (bus `bpm`, `beat`, clock steps) | DOM |
| Connection chip | `src/output/status-chip.js` (milestone 3) | DOM |
| Gesture guide mode rows, first-use labels | `src/ui/guide.js` (+ mode `guide` list) | DOM + canvas |
| Radial menu ring, fills, rim, labels, countdown | `src/menu/radial-menu.js` | canvas |
| x2 pill, tempo scale, big BPM | `src/modes/arp.js` `draw()` | canvas |
| Note ladder, cursor, note name, arrows, octave marks, note-set change at hand | `src/modes/lead.js` `draw()` | canvas |
| Chord display, quality, wave, landmarks | existing (`src/modes/chords.js` / router after refactor) | DOM / canvas |

## 10. `src/ui/theme.js` API (summary)

Tokens: `MODE_COLORS`, `COLORS` (`brand ink quiet faint plate halo good warn`), `STROKE` (`hair 1, thin 1.5, mid 2,
rim 3, halo 2`), `MOTION` (`fast 120, base 150, slow 200, countdown 400, hold 300, bpmLinger 1000, firstUse 3000`),
`FONT`, `LAYOUT` (`gutter 20, trackInset 9, trackWidth 6, markerLength 14 …`), `DIR_ANGLE`, `deg()`, `easeOut()`,
`withAlpha()`, `clearArea(w,h)`, `rectsOverlap()`, `edgeTrackX(side, w)`.

Primitives (all `(g, …) → {x,y,w,h}`; every line has a dark halo or plate):
`drawLabel`, `drawPlate`, `drawPill`, `drawGuideLine`, `drawEdgeTrack` (live / dim / lost, hollow held marker,
guide to hand), `drawArc` (thin arc + optional value dot; filter arc, rims), `drawArcSegment` (menu arc with
available/approach/selected fills), `drawRing` (cursor, countdown, hold progress; glow), `drawDots` (beat/step/
octave/segments), `drawTriangle` (octave arrows). Return rects let modules register regions for layout tests.

## 11. Test contract

`tests/ui-lab.spec.js` renders every lab state at 1280×800 and 390×844 (+ swapped sides) and asserts: new
`edge`/`status`/`panel` elements stay on screen and never overlap an existing control; new persistent elements
don't overlap each other; no persistent element (new or existing, except user-opened panels) intersects
`clearArea()`. When the real UI lands, the same `checkLayout` can run against the app with `?mockHands`
(register canvas regions on `window.__gsTest` the way the lab does on `window.__uiLab`).

## 12. Open questions

- **Q1 Which screen side is the chord hand?** RESOLVED (see the lead decisions below): the player's physical LEFT
  hand is labelled "Left" and plays chords; the mirrored (selfie) display shows it on the screen **LEFT**, the right
  hand on the screen **right**, as the spec assumed (master volume on the left edge). The original concern (MediaPipe
  might label the physical right hand "Left") did not hold with a real camera. The mock helper
  (`tests/helpers/hands.js` `hand()`) used to place "Left" at display x≈0.7 (screen right), so every synthetic scene
  was mirrored vs reality; since ws/real-sides it places "Left" at display x≈0.3 (raw image x 0.7) and "Right" at
  display x≈0.7. Tests' `swap` scenes now cover the unusual case (chord hand on the screen right).
- **Q2** Should the meter in Arp show gate (D5) or the master/output level? Gate keeps "meter = what right height
  does"; output level would be more useful in Lead (where the meter is hidden now).
- **Q3** Dropping the spec's bottom-right "Settings" pill in favor of the `Controls` toggle (D8): OK with the user?
- **Q4** Chip visibility: hide until output is turned on (proposed), or always show "Output off"?
- **Q5** On narrow portrait screens the hands are close to the edges, so the Lead cursor/name and the right hand
  can overlap. A narrower mobile ladder (44px) may be needed once tested on a phone.

## Lead decisions on the open questions (2026-11-22)
- **Q1 chord-hand side — RESOLVED (user, real camera, 2026-11-22): the player's physical LEFT hand plays chords;
  MediaPipe's "Left" label is correct as the app uses it, and the mirrored display shows the chord hand on the screen
  LEFT (master track left edge; right-hand track, Lead ladder, filter arc, fist menu, BPM plate on the right half).
  Synthetic test hands, the labs and `npm run capture` use this orientation; `swap` = the mirrored case. Help text
  "Left Hand" stays.** Original note: keep the hand-following rule (master track on the edge where the chord hand is displayed). It is correct
  whichever way MediaPipe labels hands. Do not change help text ("Left Hand") until confirmed with a real camera; the user will check
  on the M1 instance.
- **Q2 meter in Arp:** shows gate (the right-height control), as proposed.
- **Q3 Settings pill:** replaced by the `Controls` toggle in the left column. Accepted (augments the existing column).
- **Q4 connection chip:** hidden while output is off; the on/off switch + room code live in the Controls panel ("Output" row).
  The chip appears when output is turned on. Pressing it opens the Controls panel.
- **Q5 Lead on phones:** narrow the ladder below 520 px width; resolve during Lead integration.
