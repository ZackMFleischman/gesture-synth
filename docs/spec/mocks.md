# Mocks embedded in the requirements doc (summary)

The source doc embeds 6 SVG mocks (JSX). Their source can be read with the Claude Docs `read` tool:
container `{"kind":"project","id":"1f59c445-7762-414c-869e-300e3cdad209"}`, ref `{"object":"node","id":<id>}`.
Mocks show layout and states, not final colors. Colors: one neutral ink for structure, one accent per mode
(Chords / Arp / Lead), green = good, amber = warning only.

## 1. Screen layout, shown in Arp mode (node 09f74520-4e82)
- Top-left: mode badge (pill, mode color 15% fill + 1.5px mode-color stroke, "Arp").
- Top-center: chord name large (26px, "Dm7") with a small detail line under it ("ii, voicing 3").
- Top-right: connection chip (pill outline, green dot, "Connected").
- Left edge: full-height thin track (8px wide, rounded, outline). Fill below the marker (ink 35%), a short
  horizontal marker line level with the left hand, dotted guide line from track to the hand. Label "Master volume".
- Right edge: same track in the mode color, label = current right-height control ("Gate length").
- Filter arc above the right hand: thin arc ~120° wide (from -150° to -30°), dot (mode color) moves along it with tilt. Label "Filter".
- Bottom: "110 BPM", 4 beat dots (current filled, mode color), 8 small step dots (current lit), Settings pill bottom-right.
- Center: dashed "clear area: the player in the video" — nothing drawn there.

## 2. Radial menu, 4 states Chords -> Arp (node 9cd21d1b-1c58)
- Ring: 3 annular arc segments (inner r 24, outer r 50 at mock scale; ~82° each with gaps): up = Chords, right = Arp, left = Lead (down free).
  Thin 1.25px neutral outlines. Small dot just outside the up arc = current mode marker. Fist = solid dot in center.
- 1 Enter: ring grows from the fist; label "Right hand held" below.
- 2 Approach: target arc fills from the inner edge out to the fist distance (mode color 40%), arc outline in mode color,
  dashed line center -> fist, label goes bold/bright. "Fill follows the fist".
- 3 Selected: full fill (45%) + 2px stroke + a thick 3px rounded rim arc just outside; other arcs and labels dim to 35-50%.
  Text "Open hand to confirm".
- 4 Get ready: badge already switched to the new mode color; a small ring (r 22) around the hand closes (3px, mode color),
  hand drawn as hollow circle; mode name under it; "Play when the ring closes".

## 3. Arp mode: play and pinch (node 978f9619-9f80)
- Play: left volume track + marker + dotted guide to left hand. Right edge "Gate" track in Arp color, marker level with
  right hand. Filter arc above right hand with dot. "x2" small pill under the right hand when thumb out.
  Bottom: "110 BPM" + 4 beat dots + 8 step dots.
- Pinch: gate track dims (40%) and shows a hollow marker "Gate held". Next to the hand: a vertical tempo scale with ticks
  (1 tick = 1 BPM), "start" tick and current tick with "+6"; large "116" + "BPM" next to the pinch (two dots = pinch).
  Text "Gate, filter, and voicing are held".

## 4. Lead mode, 4 states (node a08a0959-d8d7)
- Note ladder at the right: 7 horizontal lines; chord notes thick/bright, others thin. Up arrow above, down arrow below
  (outline triangles). 4 octave marks beside the ladder (one lit). Note-set badge top-left: 4 small segments, one lit.
- 1 Preview: hollow ring (mode color stroke) on the nearest line, dotted guide from hand; large note name "E4" + "will play".
- 2 Playing: pinch (two dots); ring filled + soft glow; "plays now".
- 3 Note set: larger 4-segment badge at the hand, target segment filling; set name "Full scale", "hold 0.3 s"; ladder dims.
- 4 Octave: arrow filled with progress ring around it (0.3 s hold) while pinched on it; "Octave up".

## 5. Gesture test page and screen controls (node 3020bc2d-0ab5)
- Test page (dense, developer-facing): per hand rows: Fingers (5 dots, lit = extended) + count; Pinch distance track with
  two threshold ticks (start, end) + state; Fist toggle; Height track + value; Tilt track centered + value; "Last event: pinch end (0.4 s ago)".
- Screen controls panel: Mode segmented (Chords | Arp); Tempo [-] 110 [+] [Tap]; Rate segmented 1/4 | 1/8 | 1/16;
  Pattern Up | Down | Up-down | Random; Gate slider; Double time toggle; Master volume slider.

## 6. Output status chip, 4 states (node c6679009-a17f)
- Off: outline pill, empty dot, "Output off". Waiting: dashed outline, empty dot, "Code K7QF-2M".
- Connected: green tint + green dot, "Direct, 24 ms". Relayed: amber tint + amber dot, "Relayed, 85 ms".
