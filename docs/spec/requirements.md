<!-- Source: Claude Doc "Gesture Synth: Mode Selection Requirements" https://claude.ai/artifact/4sY6SNyv8zbqMLfwiZ3BUL (rev 35, copied 2026-11-22).
Plain-text export: tables are flattened (one cell per line, header cells first). The doc also embeds 6 SVG mocks
(screen layout, radial menu states, Arp play/pinch, Lead states, gesture test page + screen controls, output chip)
that are summarised in docs/spec/mocks.md. -->

Gesture Synth: Mode Selection Requirements
 · 
Overview
Goal: add more gesture features to Gesture Synth without new finger shapes. The app gets modes. Each mode gives the right-hand inputs a new meaning.
Main requirement: the user can change mode while the left hand continues to play. The change must not interrupt the sound.
Scope of this document: the mode selection flow and the hand roles. Loops are a later feature. Mode selection must not depend on loops.
Status: requirements only. Not implemented.
Code base: github.com/ericwei97-cloud/gesture-synth (main.js). The license permits non-commercial use with credit only.
Current gesture mapping (baseline)
The app has one fixed mapping now. There are no modes.
Input
Left hand
Right hand
Finger count
Chord degree (I–VII). The thumb counts.
Voicing (1–4). The thumb does not count.
Thumb
Part of the finger count
One octave down
Height
Not used
Volume
Tilt
Major or minor
Filter sweep
Fist
Mute, if the app reads the thumb as tucked in
Mute (finger count 0)
The waveform comes from a dropdown on the screen, not from a gesture.
The app holds a gesture state for 100 ms (CHORD_HOLD_TIME_MS) before it accepts it.
Known issue: the thumb check is a simple x-position compare. It can flicker, mainly in a fist.
Decided changes to hand roles
Left height = master volume. It works in every mode and while the menu is open. This keeps volume always available.
Use more smoothing on the left height than on the right height.
Add a small dead zone, so small movements during chord changes do not change the volume.
Right height = expression for each mode. In Chords mode, it stays a second volume. The app multiplies it with the master volume. Other modes can use it for a different control.
Right fist = open the mode menu. It is no longer a mute.
Ways to rest after this change: a left fist, a low left hand (master volume), a right hand out of the frame, or a low right hand in Chords mode.
Mode selection flow: fist radial menu
Steps
Enter. The user makes a right fist. When the fist is stable for about 100 ms, the menu opens at once. The ring grows out from the fist.
Lock. The right-hand values lock: voicing, right-hand volume, and filter. The left hand continues to play chords. The master volume (left height) stays live.
Approach. The user moves the fist toward an arc. The angle from the center picks the arc. The arc lights up more as the fist moves farther from the center. Inside a small center zone, no arc lights up.
Selected. Past the select radius, the arc shows the full "selected" look. It stays selected until the fist moves back well inside the radius (hysteresis).
Confirm. The user opens the hand. If an arc is selected, the mode changes. If no arc is selected, the menu closes and nothing changes.
Get ready. A short countdown shows at the hand, about 0.4 s.
Resume. The right-hand controls of the new mode start. The values crossfade from the locked values to the live values, so there is no jump.
Geometry
The center of the ring is the fist position at entry.
The ring size scales with the hand size on screen, so it works at any distance from the camera.
The select radius is about one hand width.
Start with 4 arcs: up, down, left, right. Wide arcs allow imprecise movement.
If the fist is near the frame edge, draw the ring where it fits. Measure movement relative to the entry point.
Edge cases
Tracking lost while the menu is open: keep the menu for 0.3 s. Then close it with no change.
Thumb flicker in the fist: the menu entry must not depend on the thumb state.
Menu open: the right hand must not change the voicing, volume, or filter until the resume step.
Visual design requirements
The approach, selection, and countdown visuals must be polished and professional. They must be easy to read, but not cover too much of the screen.
Thin arcs and one accent color.
Each arc has a mode name and an icon. The labels fade in as the fist approaches.
The approach state is a progressive glow. The selected state is clearly different from the approach state.
The current mode has a marker on its arc.
The countdown is a small ring that closes around the hand.
Nothing covers the center of the video.
Each mode has its own color and badge, because there is no haptic feedback.
Modes (open)
Chords: decided. This is the current behavior.
The other 3 modes are not decided. They should use the free right-hand height.
Candidates from earlier discussion: Arp, Lead, Bass, Drums, FX.
Arp mode (decided, to be tested)
Design rule: a control keeps its meaning across modes where possible. The right tilt is the filter in every mode. The right height is the expression control that changes in each mode.
Gesture
Control in Arp mode
Same as Chords?
Left fingers and tilt
Chord
Yes
Left height
Master volume
Yes
Right fingers (1–4)
Voicing: which notes the arp uses
Yes
Right tilt
Filter
Yes
Right height (not pinched)
Gate length. Low = short, plucked notes. High = long notes that overlap.
New
Right thumb
Double time. The change starts on the next beat.
New
Right pinch, then height
Tempo, in steps of 1 BPM, relative to the pinch start
New
Right fist
Mode menu
Yes
Settings on the screen: BPM, base rate (default 1/8), pattern (up, down, up-down, random), octave range.
Behavior
The arp speed is the tempo (BPM) multiplied by the rate. Notes are scheduled on the audio clock, not on the video frames.
A chord change starts on the next step. The pattern position continues.
Left fist: the arp rests and the clock continues.
Right hand out of the frame: the arp continues with the last values.
Menu open: the arp continues with the locked values.
Pinch rules
While the user pinches, the voicing, gate length, and filter lock. Only the tempo changes.
The BPM number and a beat pulse show during the pinch and for a moment after.
Check for the pinch before the finger count. Use the distance between the thumb tip and the index tip, scaled to the hand size.
Use two thresholds (near to start, clearly apart to end) to prevent flicker.
When a pinch starts, restore the voicing from about 0.3 s before.
A pinch needs the middle finger extended. A fist needs it closed.
Test first: make a small test page that shows pinch, fist, and finger count live. If the pinch is not reliable, use the thumb as the clutch.
Deferred or replaced
Conductor taps to set the tempo: deferred. The pinch replaces them for the first version.
A separate Tempo arc in the menu: removed. The setting-arc pattern stays available for later settings, such as the scale.
Rate on the right height: rejected. A continuous movement is a poor match for a control with 4 steps.
Gate length on the right tilt: replaced. The tilt stays the filter for consistency.
Lead mode (in design)
The left hand holds a chord as a soft pad. The right hand plays one melody line on top.
Decided
Pinch to play. The note sounds while the user pinches and stops at release.
Right height = the note. The pitch always snaps to notes.
Right fingers (1–4) = the note set. This is a toggle: the user shows a finger count one time, and the set stays until the user shows a different count.
Right tilt = filter, the same as in all modes.
The mode must have strong visual indicators for each setting and for the current note.
The note indicator shows which note will play at the current hand height, also when the user does not pinch.
Proposed, not confirmed
Note sets: 1 = chord notes only. 2 = five-note scale. 3 = full scale. 4 = all 12 notes.
The finger count must be stable for about 0.3 s to change the note set. This is longer than the usual hold, so finger movement before a pinch does not change it. A badge on the screen shows the current set.
If the hand moves while it is pinched, the pitch moves to the next note with a short glide. A new pinch plays the note again.
A note guide on the screen: horizontal lines at the note heights, with the chord notes marked. Note edges have hysteresis.
Range: 2 octaves over the hand travel.
The right thumb has no function in this mode, because the pinch uses it.
The pinch has a different meaning here than in Arp mode (play, not adjust). The shared meaning is "take hold of something".
Proposed visuals
Note ladder: horizontal lines at the right side of the screen, one for each note in the current set, with note names. The chord notes are brighter.
Note cursor: a marker on the ladder at the snapped hand height. Not pinched = a hollow ring (preview). Pinched = a filled ring with a glow (playing). The note name shows next to the cursor in large text.
Note set badge: 4 segments, with the active one lit. While the user holds a finger count, a progress ring fills on the target segment for 0.3 s. A short flash confirms the change. The ladder then changes to the new lines with an animation.
Octave indicator: a small stack of marks that shows the current octave. At an octave change, the ladder slides up or down.
All setting changes use the same visual pattern as the radial menu: progress first, then a clear confirmed state.
Octave change
Decided: the note ladder has an arrow button above the top note and below the bottom note. The user moves the right hand to an arrow and pinches it to change the octave by one step.
Proposed: a pinch that is held for about 0.3 s activates the arrow. A ring fills during the hold. A double pinch is not used, because two fast pinches are hard to read with a camera.
Proposed: an arrow activates only if the pinch starts on it. If the user slides into the arrow zone during a pinched note, the cursor stops at the last note and nothing changes.
Proposed: one step for each pinch. At the octave limit, the arrow is grey. The arrow lights up when the cursor is on it, before the pinch.
The tilt stays the filter. It does not change the octave.
Rejected: the "rock" sign plus a vertical move. It was too complicated for a simple step.
Architecture
Decided
The transport to the visualizer is WebRTC, with a self-hosted signaling server.
The architecture is simple and easy to expand. A new mode or a new output signal is a plugin, with no change to the core.
Signals go out only when a visualizer is connected. With no connection, the app does no output work.
Design (decided): four layers
Hand input. One module reads the camera and gives a clean description of each hand for each frame: finger states, pinch, fist, height, tilt, position. All gesture checks are here, so each mode gets the same reliable input.
Router. It handles the gestures that are the same in all modes: the left hand (chord and master volume) and the right fist (menu). It sends the right-hand input to the active mode.
Modes. Each mode is one file with a fixed interface: id, name, icon, color, enter(), exit(), update(hand, ctx), draw(), and a list of the signals it sends. A mode registers itself, and the radial menu then shows it automatically.
Shared services. The modes get these through ctx: the clock (tempo and note scheduler), the audio engine, the harmony (current chord and notes), and the signal bus.
Signal bus
A mode declares each signal one time, with a name and a type: continuous, state, or event.
A mode sends with signals.set(name, value) or signals.emit(name, data, playTime).
With no output connected, these calls return at once. The app builds no message. A value that is expensive to calculate is given as a function, and the bus calls it only when an output is connected.
The WebRTC output is one consumer of the bus. It attaches at connection and detaches at disconnection. The WebRTC library loads only when the user turns the output on.
At connection, the output sends a manifest (the list of all declared signals) and the full current state. The visualizer then finds new signals with no change to the transport code.
The output sends all continuous values of one frame as one message on the fast channel. State and events go on the reliable channel.
Scope rule (decided): do not build item types or bus consumers before they are necessary. The first build has only the mode item type, and the on-screen visuals are the only consumer of the bus. The design keeps the path open for the other types.
Menu as a tree of items (requirement: the plugin design must allow sub-menus and later item types)
The radial menu does not show a list of modes. It shows a tree of menu items. A mode is one type of item.
Item types: mode (change the play mode), submenu (holds child items), setting (pick one value from a list, shown as a sub-ring), action (do one thing and go back), and custom.
A custom item takes control of the right hand with its own handler. The handler gets the hand input for each frame and returns "continue", "done", or "cancel". This is the path for later item types that do not fit the others.
A mode can add its own items to the menu. These items show only while that mode is active.
The menu code (rings, approach, selection, visuals) is generic. It does not know about specific modes.
Sub-menu behavior (decided; built in src/menu, see docs/architecture.md)
A sub-menu opens while the fist moves through its arc. The user does not open the hand between levels.
The sub-ring opens when the fist passes the outer edge of the arc and continues in that direction for about 0.15 s. The center of the sub-ring is the fist position at that moment. The parent ring becomes a small breadcrumb.
To go back one level, the user moves the fist back in the direction of the parent ring.
Nothing changes until the hand opens. Open on a selected item = confirm. Open at any other place = cancel all levels.
An arc with a sub-menu has a clear mark on its outer edge.
Limit: 2 levels.
Signals as a cross-cutting concern
The signal bus is one shared module. Each part of the app can import it, not only the modes.
Shared parts publish automatically, so a mode gets these signals with no code: the audio engine (note on and off for each voice), the clock (beat and BPM), the hand input (hand values), the router and menu (mode and menu state).
A mode declares its own controls as parameters, for example const gate = ctx.param("arp/gate", { type: "continuous" }). When the mode sets gate.value, the value drives the sound and goes to the bus in one step. There is no second call to forget.
The on-screen visuals read from the same bus as the WebRTC output. The app then has one data flow.
The bus marks changed values. With no consumer for a value, the app does no work for it.
Output to a remote visualizer (proposed)
Goal: send the state of the instrument to a visualizer program with OSC.
Transport
Context: the user owns the synth app and the visualizer. The visualizer is an Electron app or a web app on a different computer, connected over the internet. OSC and a local bridge are not necessary.
Proposed transport: a WebRTC data connection between the two apps, with JSON messages. A library such as PeerJS does the connection setup.
Pairing: the synth app shows a short room code. The user types the code in the visualizer.
Two channels: a reliable channel for state and events, and a fast channel that can drop messages for the continuous values.
Fallback: a small relay server with WebSockets, for networks that block a direct connection.
Settings: output on or off, and the room code.
The app has one emit(address, ...values) function. All modes use it. The transport behind it can change with no change to the modes.
The messages keep the address names in the tables below.
Continuous values (each video frame, range 0 to 1)
Address
Value
/gs/left/pos, /gs/right/pos
x and y of each hand
/gs/left/height, /gs/right/height
Hand height
/gs/left/tilt, /gs/right/tilt
Hand tilt, -1 to 1
/gs/volume
Master volume
/gs/filter
Filter position
/gs/gate
Gate length (Arp mode)
State (sent on change, and again each 2 s)
Address
Value
/gs/mode
Mode name
/gs/chord
Degree (1–7), major or minor, root as a MIDI note
/gs/voicing
1–4
/gs/noteset
1–4 (Lead mode)
/gs/octave
Octave number
/gs/bpm
Tempo
Events (sent one time, at the moment they occur)
Address
Value
/gs/note/on, /gs/note/off
MIDI note and voice (arp or lead)
/gs/beat
Beat number in the bar
/gs/pinch
1 at start, 0 at release
/gs/menu
Open, the arc under the fist, the progress (0 to 1), close
Rules
Send musical meaning (chord, note, beat), not only raw hand data.
Each note and beat event carries the time at which the sound plays. The scheduler works about 100 ms ahead, so the app can send an event before its sound. The visualizer then shows it at the correct time, and this hides part of the network delay. The two apps measure their clock difference with a ping.
UDP can lose messages, and the visualizer can start late. The repeat of the state each 2 s corrects this.
Optional later: the 21 raw landmarks of each hand, for visuals that draw the hands.
Latency requirements (decided: as little delay as possible, with corrections)
The data goes directly between the two apps. A server is used only for the connection setup (signaling), not for the data.
The fast channel does not send a lost message again. A new value replaces it.
Shared clock: the two apps measure their clock difference with a ping, and repeat this regularly.
Beat grid: the synth sends the BPM and the time of a reference beat. The visualizer runs its own beat clock from these values, so beat visuals have no network delay. Each new sync corrects the drift.
Scheduled notes (Arp): the synth sends each note about 100 ms before it plays, with its play time. The visualizer shows it on time.
Live input (Lead notes, hand positions): these cannot be sent early. The delay is the network delay. The visualizer smooths the values and can predict a short time ahead from the speed of the movement.
Server options for the setup: a self-hosted signaling server (small), a managed service, or no server with a private network such as Tailscale between the two computers.
UI and UX design (proposed)
Visual language
Each indicator in the app uses the same small set of states. The player learns the states one time, in the radial menu, and then reads them in each mode.
State
Look
What it tells the player
Available
Thin outline, quiet label
"This is here. You can use it."
Approach
A fill that grows in proportion to the movement or the hold time
"You are this near. You can still stop."
Selected
Full fill, thick rim, bold label. The other options go dim.
"If you release now, this occurs."
Confirmed
A short flash (about 150 ms), then the new state
"Done."
Held
A hollow marker at the held value. The control is dim.
"Your hand does not control this now."
Return
The hollow marker (held value) and the solid marker (hand) show together. They become one when the hand gets to the value.
"Move here to take control again."
Preview
Hollow ring
"This will play."
Active
Filled ring with a soft glow
"This plays now."
Hand lost
The markers of that hand change to dashed lines, in amber
"The camera cannot see this hand."
Rules for the amount of information
Feedback for an action is at the hand. The player looks at the hand during a gesture. The ring, the cursor, and the countdown are there.
Status is at the screen edges. Mode, chord, tempo, and connection do not change often. The player reads them with a short look.
The center of the screen stays clear. It shows the player in the video.
Position and brightness before text. A marker that is level with the hand needs no number. A label has a maximum of two words.
A large number shows only for the value in change, for example the BPM during a pinch. It goes away after the change.
Approach is continuous, selected is a clear step. The fill grows smoothly, but the selected look adds a rim and a bold label at the threshold. The player must not have to estimate if the fill is "full".
One accent color for each mode. Structure is neutral. Amber is only for a warning.
Movement is short: 120 to 200 ms. The beat pulse is the only movement that repeats.
Sound supports the visuals. A soft tick plays when an option becomes selected, because the player cannot feel a click.
Screen layout
Each hand has a full-height track at its own screen edge. The marker on the track is level with the hand, so the hand is the pointer and no number is necessary.
Left edge: master volume. It is the same in all modes.
Right edge: the control that the right height has in the current mode. It uses the mode color. In Lead mode, the note ladder is here.
At the right hand: the filter arc. The dot moves on the arc as the hand tilts.
Top: the mode badge, the chord, and the connection status.
Bottom: the tempo, the beat dots (they pulse on the beat), the step dots, and the settings button.
Radial menu
The player must always know two things: which option is under the fist, and what occurs if the hand opens now.
Element
What it tells the player
How
Ring at the fist
"The menu is open. The right hand is held."
The ring grows from the fist in about 150 ms. The right-hand controls go dim. The left side of the screen does not change, so the player sees that the left hand is still live.
Dot on an arc
"This is the current mode."
A small dot. If the player selects this arc, nothing changes.
Dashed line from the center
"The app tracks this point."
The line goes from the entry point to the tracked center of the fist.
Fill in the arc
"You are this near."
The fill grows from the inner edge. Its outer edge is at the same distance as the fist.
Rim and bold label
"Release now and you get this mode."
The look changes in one step at the select radius, with a soft tick sound. The other arcs go dim.
No arc lit
"Release now and nothing changes."
In the center zone, all arcs are in the available state.
Flash
"Confirmed."
The selected arc flashes for about 150 ms. The other arcs go away.
Countdown ring
"The new mode starts soon. Put your hand in position."
The ring gets smaller and closes around the hand in about 0.4 s. The mode badge changes color at the start of the countdown.
Hollow and solid markers
"Move here to take control again."
After the countdown, each right-hand control shows its held value until the hand gets to it.
Layout rules
Each mode has a fixed direction: Chords is up, Arp is right, Lead is left. Down is free for a later mode. A fixed direction lets the player change mode from memory.
The labels are outside the ring, in the direction of the movement. The fist does not cover them.
Cancel has no flash and no countdown. The ring goes away in about 100 ms, and the controls return with the hollow and solid markers.
Arp mode
In play, each control shows its value by position, with no number. In a pinch, one large number shows, because the player makes a fine adjustment.
Element
What it tells the player
How
Gate track (right edge)
"This is the note length."
The marker is level with the right hand. The fill below it uses the mode color.
Filter arc
"This is the tone."
A dot moves on the arc at the hand as the hand tilts. It is the same in all modes.
x2 badge
"Double time is on."
The badge shows at the hand only while the thumb is out. It shows as an outline until the next beat, and then as filled.
Beat dots
"This is the beat."
One dot for each beat of the bar. The current dot is filled and pulses.
Step dots
"This is the position in the pattern."
One small dot for each step. They also show a chord change that waits for the next step.
Large BPM number
"You change the tempo now."
It shows next to the hand during a pinch, and for about 1 s after.
Tempo scale
"You moved this far from the start."
The scale is relative. The start tick is where the pinch started. One tick is 1 BPM.
Hollow markers
"These values are held."
The gate track goes dim and shows a hollow marker at the held value. After the pinch, the hollow and solid markers show until the hand gets to the value.
The first seconds in the mode
At the first use of Arp mode, a short label shows next to each control for about 3 s: "Gate", "Filter", "Thumb: x2", "Pinch: tempo". Then the labels go away.
The same labels show again when the player opens the gesture guide.
Lead mode
The player must know the note before the pinch. So the cursor and the note name always show, also when no note plays.
Element
What it tells the player
How
Note ladder (right edge)
"These are the notes that you can play."
One line for each note in the current set. The chord notes are thick and bright. The other notes are thin. The lines have no names, so the ladder stays easy to read.
Cursor, hollow
"A pinch will play this note."
A hollow ring on the line nearest to the hand. It moves from line to line in steps, not smoothly, so the player sees the snap.
Cursor, filled
"This note plays now."
The ring fills and gets a soft glow at the pinch.
Note name
"This is the note."
One name, in large text, next to the cursor. It is the only note name on the screen.
Note set badge (top left)
"This is the current note set."
Four segments, with one lit.
Note set change
"You change to this set."
A larger copy of the badge shows at the hand, with the name of the target set. The target segment fills in 0.3 s. Then it flashes, and the ladder changes to the new lines.
Arrows
"Pinch here to change the octave."
An arrow above and below the ladder. The arrow lights up when the cursor is on it. In a pinch, a ring fills around it in 0.3 s. Then the ladder slides one octave.
Octave marks
"This is the current octave."
Four small marks next to the ladder, with one lit.
Details
When the chord changes, the thick lines move to the notes of the new chord. The move takes about 150 ms, so the player sees where the safe notes went.
At the octave limit, the arrow is grey and does not light up.
The left hand shows the same master volume track as in all modes. The pad chord shows at the top of the screen.
Gesture test page and screen controls
These two screens are tools for the build. They are plain and dense, because the reader is the developer, not the player.
Gesture test page. It shows the raw values of each hand, live. The pinch row shows the two thresholds: the distance at which a pinch starts, and the larger distance at which it ends. The developer can then set the thresholds by test, not by estimate.
Screen controls. Each value that a gesture will control has a screen control first. When a gesture step is complete, the screen control stays. It shows the value that the gesture sets, and it is a fallback if tracking is bad.
A screen control that a gesture has under control shows a small hand mark. If the player moves the screen control, the screen control wins until the hand moves again.
Connection status (Milestone 3)
The output has one small chip at the top right of the screen. The player must be able to check it with a short look during a performance.
The chip uses shape and color together: an empty dot, a dashed outline, a green dot, an amber dot. The player does not have to read the text.
The delay number changes at most one time each second, so it does not flicker.
If the connection is lost, the chip goes back to the "Waiting" state and the app tries again. The music does not stop.
A press on the chip opens the settings: output on or off, and the room code.
UX for each step of the build plan
Each step has a UX check. The step is complete only when the check passes.
Step
What the player sees
UX check
0.1 Refactor
No change
The app behaves the same as the current app in a side-by-side test.
0.2 Signal bus
The chord, volume, and filter indicators read from the bus. The look does not change.
The indicators have no visible delay behind the hands.
0.3 Test page
The gesture test page
A pinch starts and ends correctly in 20 of 20 tries, from each finger count. The app never reads a fist as a pinch.
1.1 Arp with screen controls
The mode badge, beat dots, step dots, and screen controls
The arp stays in time for 2 minutes. A chord change does not break the rhythm.
1.2 Radial menu
The ring, fill, rim, countdown, and the hollow and solid markers
A new player changes mode at the first try, with only the on-screen labels as help. The sound has no click or gap. An open hand in the center zone changes nothing.
1.3 Left height = master volume
The left track, with the marker level with the hand
A chord change with the left hand does not move the volume.
1.4 Right height = gate
The gate track at the right edge
The marker stays level with the hand. The player hears the difference between a low hand and a high hand.
1.5 Thumb = double time
The x2 badge: an outline until the next beat, then filled
No false x2 in 1 minute of normal play.
1.6 Pinch = tempo
The large BPM number, the scale, and the held markers
The tempo does not jump at the start of a pinch. A pinch never changes the voicing.
2.1 Lead with screen controls
The note ladder and the pad chord. The cursor follows the mouse.
The thick lines move to the correct notes at each chord change.
2.2 Right height = note cursor
The hollow ring and the note name
The cursor does not flicker between two notes when the hand is still.
2.3 Pinch to play
The filled ring with a glow
The note that plays is always the note that the preview showed.
2.4 Note set toggle
The badge at the hand, with the fill for the hold
Finger movement before a pinch never changes the note set.
2.5 Octave arrows
The ring around the arrow, then the slide of the ladder
A slide to the top note during a pinch never changes the octave.
3 WebRTC output
The status chip
The chip shows the correct state in less than 1 s. With the output off, the frame rate of the app does not change.
Notes on the mocks
The mocks show the layout and the states. They do not show the final colors.
In the app, the indicators are on top of the camera video. Each line and label needs a dark outline or a soft dark plate behind it, so that it is easy to read on a bright or busy background.
The mode colors in the mocks are placeholders: one color for Chords, one for Arp, and one for Lead.
Build plan (decided)
Rules
One mode at a time. Each mode is a milestone.
In each milestone, the mode first works with screen controls only. Then each gesture is a sub-milestone.
The WebRTC output comes after the Arp and Lead modes work. But the architecture is prepared for it from the start: each mode publishes its state through parameters and the signal bus.
Milestone 0: foundation
0.1 Refactor main.js into the four layers. Chords becomes a mode plugin. The behavior does not change.
0.2 Add the signal bus and parameters. Chords publishes its state. The on-screen visuals read from the bus.
0.3 Gesture test page: pinch, fist, and finger count shown live. Confirm that the pinch is reliable.
Milestone 1: Arp mode and mode change
1.1 Arp works with screen controls only: a mode button, BPM, base rate, pattern, gate, double time. This includes the shared clock and the note scheduler.
1.2 Radial menu with the right fist: lock, approach, selection, countdown, and smooth return. The user can change between Chords and Arp.
1.3 Left height = master volume.
1.4 Right height = gate length.
1.5 Right thumb = double time.
1.6 Right pinch = tempo.
Done when: the user can change between Chords and Arp by gesture with no break in the sound, and can control all Arp values by hand.
Milestone 2: Lead mode
2.1 Lead works with screen controls only: the left-hand pad, notes from the mouse or keyboard, the note ladder.
2.2 Right height = note cursor with preview.
2.3 Pinch to play, with glide and repeated notes.
2.4 Finger toggle for the note set, with the badge.
2.5 Octave arrows.
Milestone 3: WebRTC output
Signaling server and room code.
Connection with two channels, the manifest, and the full state at connection.
Clock sync, beat grid, and early send of scheduled notes.
Not in this plan (deferred): more modes (Bass and Drums are candidates), sub-menus and other menu item types, the scale setting, loops, conductor taps.
Rejected options
Thumb-out to enter the menu: the thumb check is the least reliable signal. Closing the thumb as confirm leaves no clean cancel. Thumb-only also occurs in normal play.
Long fist hold with a timer: it gives the fist two jobs (rest and menu). A long rest can open the menu by accident.
Finger count to pick a mode: it has two timers and a limit of 4 modes. It can come back later as a shortcut for expert users.
Side dock at the frame edge: tracking is weakest at the edge, and the hand can drift into it.
Both hands together to enter, with a loop at each switch: too large for a first step, and it makes mode selection depend on loops.
Pinch: the classifier reads a pinch as 3 fingers.
Wrist rotation: a rotated hand miscounts fingers, and tilt already controls the filter.
Open questions
Names, icons, and controls for the other 3 modes.
Length of the get-ready countdown (0.4 s is a starting value).
Size of the dead zone for the left-height volume.
What the right thumb does in modes other than Chords.
Arc layout if there are more than 4 modes.
Loops: when to add them and how they connect to modes.
Deferred: scale setting
A scale setting (for example Dorian or Mixolydian) is deferred. Notes for later:
The app now takes chord roots from the major scale only. Left tilt changes only the third of the chord (major or minor).
A scale setting would choose each chord's quality from the scale. This conflicts with the current tilt. One option: tilt flips the quality of the current chord (a borrowed chord).

Decided after real-camera testing: Lead plays on top of the current mode
(Appended note; the Lead text above is unchanged and describes the original design.)
Going from Arp to Lead used to stop Arp and play a pad under the lead. Players wanted the accompaniment to keep going. Now Lead is a layer: it plays on top of the base mode (Chords or Arp) and does not replace it.
The base mode keeps running. The left hand still changes its chord and the master volume. Its right-hand values (voicing, Chords volume, Arp gate / double time / tempo, its filter) are held at their last values. The right hand plays the lead. The Lead pad does not play while there is a base mode.
In the menu, the Lead arc turns the layer on. Choosing Lead again changes nothing, like choosing the current mode. To leave Lead, choose Chords or Arp. If it is the mode that was underneath, the right hand goes back to it with the usual crossfade from the held values.
The mode badge (and the phone pill) shows both parts, for example "Arp + Lead". The base mode's visuals stay. The Controls panel shows the base mode's held settings (still changeable) and the Lead settings in two labelled groups.
Right tilt is the filter of the lead voice. The base keeps its own filter value.
Output: /gs/mode stays the base mode. A new state /gs/layer is "lead" while the layer is on, else null.
