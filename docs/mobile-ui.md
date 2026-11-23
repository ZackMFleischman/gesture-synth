# Mobile UI: compact, minimizable chrome for phones and tablets

Status: Phase A (design + prototype + tests) on branch `ws/mobile-ui`. Phase B (adoption in the real app) waits for
`ws/m1-ui` to merge. Change requests go through the lead.

- Prototype: `labs/mobile-lab.html?m=<state>` (dev server; open with a phone viewport in devtools). States:
  `playing-collapsed`, `expanded`, `controls-sheet`, `guide-sheet`, `help`, `minimal-hud`, `mode-chords`, `mode-arp`,
  `mode-lead`, `menu`. Landscape = a landscape viewport. `&layout=mobile|desktop` forces the system on/off.
- Code to adopt: `src/ui/mobile/mobile-ui.js` (`mountMobileUI`), `src/ui/mobile/mobile.css`,
  `src/ui/mobile/layout-metrics.js` (pure metrics; also used by the tests).
- Tests: `tests/mobile-ui.spec.js` (+ `tests/helpers/mobile-ui.js`). Numbers land in `test-results/mobile-audit/*.json`,
  screens in `test-results/screens/mobile-*.png`.

User feedback this implements: *"It wasn't great for mobile before. The UI elements were taking up too much room and
couldn't be minimized."*

---

## 1. The player's situation

The phone is propped up 1–2 m away. Both hands are in the air; nobody touches the screen while playing. Touch happens
before a take (key, tone, mode, settings) and between takes (help, guide). So on a phone:

1. **While playing**, the screen belongs to the camera picture. Only status the player can read in a glance from 1.5 m
   stays (mode, key, chord, tempo), plus the hand feedback that the spec puts at the hands and the edges.
2. **Between takes**, everything is one tap away, with targets big enough for a thumb (44 px).
3. Nothing needs a second visit to put away: the bar folds itself once the hands play; sheets close with ✕, a drag,
   Escape, or the toggle that opened them.

## 2. Audit (before → after)

Method: `tests/mobile-ui.spec.js › audit (before)` and `› mobile lab (after)` / `› real app + mobile system`.
Coverage = union of the boxes of all **persistent** UI (DOM chrome + canvas edge/status regions; the two edge tracks
count with their drawn body, 10 px; hand-anchored feedback and the Lead ladder (§6) are excluded) ÷ screen area.
In brackets: DOM chrome only. "incl." rows add the user-opened panel. ⚠n = n persistent elements inside the
clear area (`clearArea()` in `src/ui/theme.js`). Chord hand / expression hand zones (`handZones()`): 0 % overlap in
every row, before and after (the left column ends above the hands), so they are not repeated in the table.

| State | 390×844 | 360×740 | 320×568 | 844×390 | 768×1024 |
|---|---|---|---|---|---|
| **Today**, playing | 8.4% (8.4) | 10.4% (10.4) | 15.3% (15.3) ⚠2 | 8.4% (8.4) | 3.5% (3.5) |
| Today, guide open (incl. guide) | 14.7% | 18.2% | 26.6% ⚠2 | 14.4% | 6.1% |
| **Today + mobile system**, playing | **3.5%** | **4.3%** | **5.3%** | **2.9%** | **2.1%** |
| Today + mobile, guide strip (incl.) | 8.9% | 10.4% | 13.3% | 9.3% | 6.8% |
| **Planned chrome** (ui-lab), Chords | 14.0% (9.0) | 16.6% (11.2) | 22.2% (16.2) ⚠3 | 11.3% (9.0) ⚠1 | 6.3% (3.8) |
| Planned chrome, Arp | 16.0% (11.0) | 19.0% (13.7) | 25.9% (19.9) ⚠3 | 14.2% (11.9) ⚠2 | 7.5% (5.0) |
| Planned chrome, Lead | 9.7% (7.2) | 11.6% (8.9) | 15.9% (12.9) ⚠3 | 8.3% (7.2) ⚠1 | 4.3% (3.0) |
| Planned chrome, guide open (incl.) | 32.8% | 39.7% | 54.1% ⚠3 | 24.7% ⚠2 | 14.2% |
| Planned chrome, controls open (incl.) | 41.7% | 51.4% | 67.4% ⚠3 | 38.1% ⚠2 | 17.9% |
| **Mobile system**, Chords collapsed | **8.6% (3.6)** | **9.8% (4.4)** | **11.0% (5.1)** | **5.4% (3.2)** | **4.5% (2.0)** |
| Mobile, Arp collapsed | 9.8% (4.8) | 11.3% (5.9) | 13.1% (7.1) | 7.0% (4.8) | 5.7% (3.1) |
| Mobile, Lead collapsed | 6.0% (3.5) | 7.0% (4.3) | 8.7% (5.7) | 4.3% (3.2) | 3.1% (1.8) |
| Mobile, minimal HUD (Arp) | 7.8% (2.8) | 8.8% (3.5) | 10.2% (4.2) | 4.6% (2.3) | 4.2% (1.7) |
| Mobile, guide strip (incl.) | 20.3% | 23.2% | 28.3% | 16.6% | 12.7% |
| Mobile, controls sheet (incl.) | 56.2% | 60.6% | 61.2% | 50.8% | 27.2% |

(The planned-chrome rows include the two edge tracks, ~4–6 % on their own; the "Today" rows have none.)

**Elements in the clear area before:** 320×568: `#guideToggle`, `#distortionDisplay` (today) + `#controlsToggle`
(planned); 844×390: `#controlsToggle`, `#transport` (planned). **After: none, at every size.**

**What could not be dismissed before:** key + tone selects, guide toggle, help button, 8-bar meter, filter readout,
chord + quality (today); plus mode badge, note-set badge, Controls toggle, transport, output chip, edge tracks
(planned). Only the gesture guide, the help modal and the controls panel could be closed, and the guide/panel took
33–67 % of a phone screen. **After:** the six top-left controls fold into one pill and fold back by themselves; the
minimal HUD hides meter, readout and transport; guide/controls/help are sheets with a 44 px ✕ + drag + Escape.

Screens: `mobile-before-app-playing-<size>.png`, `mobile-before-lab-<state>-<size>.png` vs
`mobile-<state>-<size>.png`, `mobile-after-app-<state>-<size>.png`.

## 3. The design (chosen)

| # | Decision | Why / what was rejected |
|---|---|---|
| M1 | **One collapsible bar** (`#gsBar`) top-left. Collapsed it is a 34 px pill: mode dot + mode name (mode color) · key (ink) · caret. One tap expands a tray holding the **existing** nodes: header row [pill ▴] [?] [◐ Minimal]; row 1 [key ▾] [tone ▾]; row 2 [Controls] [Open Guide]. The modes UI's `#modeBadge` moves into the tray but stays hidden there: the pill shows the mode and Controls opens the same panel (the review found three ways to change mode in one view). **First visit**: the tray shows open once (`localStorage["gs.mobile.seen"]`) and folds away when the hands play, so new players see what the pill holds. | Every control ≤ 2 taps. The pill keeps the status the player reads (mode, key) visible. Rejected: a hamburger icon (hides the status), a bottom toolbar (the bottom belongs to the chord + wave). |
| M2 | **Reuse, don't copy**: `mountMobileUI` moves the existing elements into the tray (comment placeholders mark their homes) and moves them back when the layout switches to desktop. Their listeners, ids and texts (`Open Guide`/`Close Guide`) are untouched. | Augment, don't remove. Existing tests and handlers keep working. A desktop ↔ mobile resize restores every node (tested). |
| M3 | **Auto-collapse** 2.5 s after the last touch on the bar once hands are playing (bus `left/pos` / `right/pos`, or `setPlaying()`); tap outside or Escape also collapses. **Never auto-expands.** Opening a sheet collapses the bar. | Controls get out of the way without the player walking to the phone. Rejected: auto-hiding the pill itself (the way back must always be visible). |
| M4 | **Controls = bottom sheet** (side sheet from the right in landscape, floating card on tablets): drag handle, title, 44 px ✕, drag down/right to close, Escape. The modes UI's `#controlsPanel` is re-homed inside it; rows get 44 px targets, segmented controls wrap instead of clipping. Max 56 % of the height in portrait. | Thumb-reachable; the head and raised hands stay visible above it. |
| M5 | **Help = bottom sheet** (full height in landscape): the existing modal restyled, sticky 44 px ✕, drag handle, backdrop tap still closes. | Same content, no new modal. |
| M6 | **Gesture guide = compact strip** under the pill: 7 degree cells (note over 22 px gesture) in one row, the mode's right-hand rows wrapped below, 44 px ✕ at its right end. In landscape it keeps to the left half (≤ 48 vw), off the face and the raised right hand. It does **not** collapse on play: it is the one panel meant for playing. | The old vertical list covered 33–54 % of a phone in planned form and ran into the hands; the strip sits above the hands (top 64 px … ~165 px). |
| M7 | **Compact status**: meter 34×38 px (8 bars, 3 px), filter readout 11–14 px on a plate, output chip collapsed to its dot (44 px hit area). Chord `clamp(34px, 6vmin, 56px)` (28 px on screens ≤ 640 px high) with a hard dark outline + soft scrim so the bright wave does not run through the letters; text center kept at h−56 where the energy wave is. With the landscape Controls side sheet open, the chord re-centers in the visible part. Transport tighter below 400 px; **bottom-right in landscape** (above the chord it cut into the clear area). | Coverage while playing drops to 3.4–5.2 % DOM (today's UI) / ≤ 12 % incl. edge tracks (modes UI). |
| M8 | **Minimal HUD** toggle (◐ in the tray header): keeps pill (dot + key + a ◐ marker that says minimal is on), chord + quality, Lead note-set badge, edge tracks and hand feedback; hides meter, readout, transport and an "off" output chip. Remembered in `localStorage["gs.mobile.hud"]` (try/catch; blocked storage = per-session only). | One switch for "just let me play". Rejected: per-element toggles (too many decisions on a phone). |
| M9 | **Scope**: `body.gs-mobile` when `(max-width: 599px), (max-height: 499px), (pointer: coarse) and (max-width: 1366px)` — phones in both orientations and touch tablets. All rules live under that class (`html body.gs-mobile …` so they win over `body.gs-modes #id` whatever the CSS order). Desktop: identical boxes before/after mounting (tested). Safe-area insets on every edge element (`viewport-fit=cover` is already set). `prefers-reduced-motion`: no sheet/pill transitions. | Tablets get the same minimizable system because the player situation is the same (propped device, touch). |
| M10 | **Budgets enforced by tests** (`BUDGET` in `layout-metrics.js`): while playing collapsed ≤ 12 % total and ≤ 6 % DOM (≤ 14 % / 7.5 % below 360 px wide, where the two edge tracks alone are ~6 %); minimal HUD ≤ 4 % DOM (4.5 %); nothing persistent in the clear area; nothing off screen; expanded targets ≥ 44 px. | Keeps future additions honest. |

### Layout maps

Portrait 390×844, collapsed while playing (Arp):
```
 0 ┌──────────────────────────────────────┐
   │▌(● A Arp ▾)                (●) ≡≡≡ ▐│ y 10  pill | chip dot, meter 34×38
   │▌                      Filter: +20% ▐│ y 54  readout (plate)
   │▌      ┌ - - - clear area - - - ┐   ▐│ y 160 (nothing persistent inside)
   │█━··✋ ¦                        ¦ ✋··━█│
   │▌      └ - - - - - - - - - - - -┘   ▐│ y 624
   │▌      ( 110 ○●○○ | ··•····· )      ▐│ transport (tighter below 400 px)
   │▌ ~~~~~~~~~~~ Bm(ii) ~~~~~~~~~~~~~~~ ▐│ chord 34 px, center h-56 (wave)
844└──────────── Minor 7th ───────────────┘
```
Expanded (tap the pill; folds back 2.5 s after the last touch once playing):
```
   ┌────────────────────────────────────┐
   │(● A Chords ▴)          (?) (◐ Minimal)│ 44 px rows
   │[ A        ▾] [ Warm Synth         ▾]│
   │(● Chords) [ Controls ] [ Open Guide ]│
   └────────────────────────────────────┘  y 10..~172
```
Landscape 844×390: pill top-left, meter + readout top-right, guide strip = one row under the pill, chord bottom
center (28 px), transport bottom-right, controls = side sheet from the right (≤ 56 vw), help = full-height sheet.

## 4. What every existing / planned element becomes on a phone

| Element | Collapsed (playing) | Expanded / sheet | Minimal HUD |
|---|---|---|---|
| `#keySelect`, `#toneSelect` | in the tray (key shown in the pill) | tray row 1, 44 px | same |
| `#modeBadge` (modes UI) | in the tray, hidden (mode shown in the pill) | hidden (Controls does the same) | same |
| `#noteSetBadge` (Lead) | right of the pill (status) | same | same |
| `#controlsToggle` / `#controlsPanel` | in the tray | toggle in row 2 → bottom/side sheet | same |
| `#guideToggle` / `#gestureGuide` | in the tray | toggle in row 2 → strip under the pill, ✕ | same |
| `#helpButton` / `#helpModal` | in the tray | header `?` → bottom sheet | same |
| `#volumeMeter` | 34×38 top right (hidden < 360 px wide with the modes UI: the right track shows the same value, L1) | visible | hidden |
| `#distortionDisplay` | 11 px on a plate, under the meter | same | hidden |
| `#chordDisplay`, `#qualityDisplay` | 34/11 px (28 px on short screens) | same | same |
| `#transport` (Arp) | above the chord; bottom-right in landscape | same | hidden |
| `#outputChip` (+ popover) | dot only, left of the meter, 44 px hit area | popover under it, inside the screen | dot; hidden when off |
| Edge tracks, filter arc, menu, Lead ladder (canvas) | unchanged (see §6 for Phase B tweaks) | unchanged | unchanged |
| `#startOverlay` | unchanged | – | – |

## 5. `mountMobileUI` API

```js
import { mountMobileUI } from "./src/ui/mobile/mobile-ui.js";      // imports mobile.css
const mobile = mountMobileUI({ bus });   // AFTER mountControls + mountModeUI + mountStatusChip
mobile.setPlaying(bool)    // optional: bus left/pos|right/pos already drive it when `bus` is passed
mobile.expand() / collapse() / toggle() / isOpen() / isMobile()
mobile.setMinimal(bool) / isMinimal()
mobile.openSheet("controls" | "guide" | "help") / closeSheets()
mobile.refresh()           // re-scan if UI nodes are added later (e.g. a mode adds a badge)
mobile.destroy()
```
Options: `doc`, `win`, `storage` (default `localStorage`, `null` = none), `force: "mobile" | "desktop"`.
It opens/closes panels only by clicking the existing toggles (`#guideToggle`, `#controlsToggle`, `#helpButton`,
`#closeHelp`), and mirrors their `hidden` classes with a `MutationObserver`, so `controls.js` and the modes UI keep
owning that state. Body classes: `gs-mobile`, `gs-bar-open`, `gs-playing`, `gs-hud-min`, `gs-sheet-open`,
`gs-guide-open`.

## 6. Canvas items (Phase B, owned by other modules)

The lab draws the canvas with `labs/ui-lab.js` (unchanged), so these are recommendations, not prototyped:
- **Edge tracks** (`src/ui/edge-tracks.js`): add the safe-area inset in landscape (notch side). Read it once with a
  probe element (`padding-left: env(safe-area-inset-left)`), since canvas cannot read `env()`.
- **Lead ladder** (`src/modes/lead.js`, Q5): below 520 px width use 44 px lines (chord 44, scale 32) instead of 54/40,
  and a 22 px note name. Today the 60 px ladder overlaps 30–40 % of the right-hand zone on phones (`mobile-mode-lead-*.png`).
- **First-use labels**: on phones show only `Gate` and `Filter` (the two that sit at edges / above the hand); the
  `Thumb: x2` / `Pinch: tempo` plates land on the player's torso at 320–390 px.
- Optional: read `body.gs-hud-min` to also drop the dotted edge-to-hand guides.

## 7. Fresh-eyes review (applied)

A reviewer subagent read the before/after screens against the spec's information rules. Applied: chord legibility over the
wave (outline + scrim) and tablet size (clamp); chord re-centered beside the landscape side sheet; landscape guide off the
face/right hand; pill key in ink (one accent per mode); tray mode badge hidden (mode changeable in 3 places); ◐ marker on
the pill while minimal is on; bigger opaque caret + first-visit open tray; visible help drag handle; scroll shade on the
Controls sheet + tighter rows; bigger guide emoji. Not applied (owned elsewhere / needs the lead): Help title "Gesture Synth
Guide" vs the "Open Guide" button (index.html; L4); a glyph inside the output chip dot (status-chip.js, M3); a legend for
the ✋ marks in the Controls panel (modes UI); amber sheet titles/labels in Arp/Lead (kept: D3 says chrome = amber).

## 8. Lead decisions requested

- **L1** Hide the 8-bar meter while collapsed on phones? Done only below 360 px wide (it duplicates the right edge track,
  D5). Extending it to all phones saves ~0.4 % more and declutters the top right.
- **L2** Tablets (coarse pointer, ≤ 1366 px) get the mobile system (bar + sheets). Alternative: desktop layout + only the
  minimal-HUD toggle.
- **L3** Auto-collapse delay 2.5 s after the last touch once hands are seen. Shorter feels jumpy while choosing a key with
  a hand still in view; longer keeps the tray over the picture.
- **L4** Rename the help modal title ("Gesture Synth Guide") to "How to play": on phones it sits next to "Open Guide",
  which opens the gesture strip, a different thing. (index.html text change.)
- **L5** The tray hides `#modeBadge` (status is in the pill, action is Controls). OK, or keep it visible in row 2?

## 9. Phase B plan (after `ws/m1-ui` merges)

1. `main.js`: after `mountModeUI(...)` (and `mountStatusChip`), add
   `const mobileUI = mountMobileUI({ bus });` and expose it as `window.__gsTest.mobile` in DEV.
2. `src/ui/mode-ui.js`: nothing to call if main.js mounts it first (step 1). If the modes UI ever mounts later,
   call `mobileUI.refresh()` once after mounting. Make sure `#controlsPanel` / `#gestureGuide` open state stays class-based (`hidden`).
3. `src/ui/modes.css`: remove the `@media (max-width: 519px)` chip/panel tweaks that the mobile CSS supersedes (or keep:
   mobile wins by specificity either way).
4. `src/output/status-chip.js` (Q4): when the chip moves to "hidden while off" + Controls "Output" row, nothing changes
   here; the minimal-HUD rule already hides an off chip.
5. Canvas tweaks from §6 in `edge-tracks.js` and `lead.js`.
6. Tests: switch the "real app + mobile system" block of `tests/mobile-ui.spec.js` from injecting `mountMobileUI` to the
   app's own instance (pass `intro: false` or pre-set `gs.mobile.seen`); add the lab-only checks (reachability, sheets,
   budgets) against `/?mockHands` with the real modes UI. **`tests/ui.spec.js › mobile viewport` must change**: on a
   phone `#keySelect`, `#toneSelect`, `#guideToggle`, `#helpButton` live in the collapsed tray (hidden), so that test
   must tap `#gsPill` first and check the tray instead of the old column (its no-overlap check still applies to the
   visible elements). `tests/output.spec.js` mobile tests: the chip is a dot on phones (label hidden).
7. Update `CLAUDE.md` (code layout: `src/ui/mobile/`; lab: `labs/mobile-lab.html`).

What `ws/m1-ui` should keep in mind: keep ids (`#modeBadge`, `#noteSetBadge`, `#controlsToggle`, `#controlsPanel`,
`#gestureGuide`, `#transport`, `#outputChip`); keep panel visibility as the `hidden` class; don't set inline
`style.position` / `style.display` on nodes the tray holds (inline `left/top` are harmless there: they become static);
don't cache `getBoundingClientRect()` of those nodes at mount (they move into the tray on phones); keep the guide mode
rows as `.gesture-guide-row.gs-guide-mode` + `.gs-guide-sep` / `.gs-guide-head` (the strip layout keys on them); and give
new top-left controls an id so they can be added to the tray list (`MOVES` in `mobile-ui.js`). Canvas hit regions
(`covers` in mode-ui.js) should be recomputed when panels open, since the panel is now a bottom/side sheet.
