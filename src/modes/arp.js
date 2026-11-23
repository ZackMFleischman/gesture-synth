// Arp mode: the left-hand chord played as an arpeggio on the shared clock.
//
// Right hand: fingers (1-4) = voicing, height = gate length, tilt = filter, thumb = double time,
// pinch + height = tempo (milestone 1.6, see "Pinch = tempo" below). Left fist (no chord) = rest while
// the clock keeps counting. Right hand gone = keep the last values.
//
// Notes are decided in the clock's step callback (~100 ms before they play) and scheduled at the
// step's exact AudioContext time. If the chord / voicing / pattern changes while steps are already
// scheduled but not yet sounding, those steps are re-bound to the new notes, so a change always
// lands on the very next step (not one lookahead later).

import { createArpVoice } from "./arp-voice.js";
import { arpNoteAt, midiToHz, PATTERNS, PATTERN_LABELS } from "./arp-patterns.js";
import { RATES, MIN_BPM, MAX_BPM } from "../services/clock.js";
import { drawEnergy } from "./chords.js";
import { drawX2Pill, drawBpmPlate } from "../ui/hand-overlays.js";
import { COLORS, LAYOUT, MOTION, withAlpha, drawPlate } from "../ui/theme.js";
import { PINCH_LOOKBACK_MS } from "../input/hand-input.js";

export const ARP_COLOR = "#4fb3ff"; // placeholder accent (see requirements: mode colors TBD)
const REBIND_MARGIN = 0.008; // s: steps starting later than now + this can still be re-bound
const RATE_LABELS = new Map([[1 / 4, "1/4"], [1 / 8, "1/8"], [1 / 16, "1/16"]]);

// ---------- Pinch = tempo (spec "Right pinch, then height", "Pinch rules") ----------
// While pinched: tempo = start tempo + (vertical hand movement since the pinch start, in hand sizes) *
// BPM_PER_HAND, in whole BPM, clamped to the clock's range. Voicing (restored from before the pinch),
// gate, filter and double time are locked. After release the gate stays at its held value until the
// hand reaches it (Return state: hollow + solid markers); the filter crossfades back to the hand.
export const PINCH_TEMPO = Object.freeze({
  /** BPM per hand size (wrist -> middle MCP) of vertical movement: ±20 BPM ≈ ±1.5 hand sizes (~15 cm at arm's length). */
  BPM_PER_HAND: 13,
  /** Hysteresis (BPM) beyond the half-step before the integer tempo changes: tracking jitter never flickers it. */
  HYSTERESIS: 0.2,
  /** Return state ends when the hand height is within this of the held gate (or crosses it). */
  PICKUP: 0.02,
  /** Filter crossfade from the held tilt to the hand after the release (same as the menu's RESUME_MS). */
  FILTER_RETURN_MS: 200,
  /** The thumb (x2) is ignored this long after a release (the thumb leaves the index finger). */
  THUMB_SETTLE_MS: 300,
});

/**
 * Pure: the pinch tempo for a vertical movement of `dyHands` hand sizes (up = +) since the pinch start.
 * `prev` = the tempo currently set by this pinch (hysteresis); no movement -> exactly `startBpm`.
 */
export function pinchTempo(startBpm, dyHands, prev = startBpm, o = PINCH_TEMPO) {
  const raw = startBpm + dyHands * o.BPM_PER_HAND;
  let b = prev;
  if (raw > b + 0.5 + o.HYSTERESIS || raw < b - 0.5 - o.HYSTERESIS) b = Math.round(raw);
  return Math.max(MIN_BPM, Math.min(MAX_BPM, b));
}

export function createArpMode() {
  let ctx = null;
  let voice = null;
  let unsub = [];
  let pos = 0; // pattern position: counts every clock step (rests included) so it resumes in phase
  let voicing = 1;
  let thumbWas = null;
  let pending = []; // scheduled steps not yet sounding: { step, pos, time, dur, handle, midi }
  let boundKey = null;
  const steps = []; // recent steps for visuals/tests: { step, pos, time, beat, beats, dur, midi|null }
  const changeListeners = new Set();
  let params = null;

  let tilt = 0;
  // Pinch = tempo state (see PINCH_TEMPO).
  let pinch = null; // while pinched: { startBpm, bpm, startY, size, gate, tilt }
  let ret = null; // after a release, until the hand reaches the held gate: { gate, side: -1|0|1|null }
  let tiltFade = null; // { from, t0 } filter crossfade after a release
  let thumbSettleUntil = -Infinity;
  let shown = null; // tempo visuals after a release: { startBpm, bpm, startY, size, until (ms, linger end) }
  const dblHistory = []; // { t, v } requested double time per frame (restored at a pinch start)
  let drawnTempo = null;
  const notify = () => changeListeners.forEach((cb) => cb());

  // Chord display / quality read these (Chords publishes them itself; in Arp the chord is the left hand's).
  function publishChord() {
    const bus = ctx?.bus;
    if (!bus) return;
    bus.set("chord", ctx.harmony.chord ?? null);
    bus.set("voicing", ctx.harmony.chord ? voicing : 0);
    bus.set("chords/octave", false);
  }

  function noteKey() {
    const c = ctx.harmony.chord;
    if (!c) return "rest";
    return `${c.rootMidi}|${c.isMajor}|${voicing}|${params.octaves.value}|${params.pattern.value}`;
  }

  function currentNote(p) {
    const c = ctx.harmony.chord;
    if (!c) return null;
    return arpNoteAt(
      { rootMidi: c.rootMidi, isMajor: c.isMajor, voicing, octaves: params.octaves.value, pattern: params.pattern.value },
      p
    );
  }

  function schedule(entry) {
    entry.midi = currentNote(entry.pos);
    entry.handle = null;
    if (entry.midi == null) return;
    if (ctx.audio.waveform) voice.waveform = ctx.audio.waveform;
    entry.handle = voice.playStep(midiToHz(entry.midi), entry.time, entry.dur, params.gate.value, {
      midi: entry.midi,
      step: entry.step,
      pos: entry.pos,
      voice: "arp",
    });
  }

  function onStep(stepIndex, time, info) {
    const now = ctx.audio.ac.currentTime;
    if (stepIndex === 0) {
      // Clock (re)started: the pattern starts from the top.
      pos = 0;
      steps.length = 0;
    }
    pending = pending.filter((e) => e.time > now);
    const entry = { step: stepIndex, pos: pos++, time, dur: info.stepDur, beat: info.beat, beats: info.stepBeats };
    boundKey = noteKey();
    schedule(entry);
    pending.push(entry);
    steps.push(entry);
    if (steps.length > 256) steps.shift();
  }

  // The clock re-timed a scheduled step (tempo / double time just before it): re-schedule its note
  // with the new length if it has not started.
  function onStepChange(stepIndex, time, info) {
    const e = pending.find((x) => x.step === stepIndex);
    if (!e) return;
    e.dur = info.stepDur;
    e.beats = info.stepBeats;
    if (e.handle && e.handle.cancel(REBIND_MARGIN)) schedule(e);
  }

  // Re-decide steps that are scheduled but not sounding yet (chord / voicing / pattern changed).
  function rebind() {
    const key = noteKey();
    if (key === boundKey) return;
    boundKey = key;
    const limit = ctx.audio.ac.currentTime + REBIND_MARGIN;
    for (const e of pending) {
      if (e.time <= limit) continue;
      const midi = currentNote(e.pos);
      if (midi === e.midi) continue;
      if (e.handle && !e.handle.cancel(REBIND_MARGIN)) continue;
      schedule(e);
    }
  }

  function cancelPending() {
    for (const e of pending) e.handle?.cancel(0);
    pending = [];
  }

  function onNote(ev) {
    const bus = ctx?.bus;
    if (!bus) return;
    const name = ev.type === "on" ? "note/on" : ev.type === "off" ? "note/off" : "note/cancel";
    if (bus.wants && !bus.wants(name)) return;
    bus.emit(name, { midi: ev.midi, freq: ev.freq, voice: "arp", id: ev.id }, ev.time);
  }

  function startPinch(right, t) {
    // The pinch shape reads as 3 fingers: restore the voicing from ~PINCH_LOOKBACK_MS before the pinch.
    const v = right.voicingBeforePinch;
    if (v >= 1 && v <= 4) voicing = v;
    if (ctx.harmony) ctx.harmony.voicing = voicing;
    // Same for double time (the thumb moves onto the index finger just before the pinch is detected).
    let dbl = null;
    for (let i = dblHistory.length - 1; i >= 0; i--) {
      if (dblHistory[i].t <= t - PINCH_LOOKBACK_MS) { dbl = dblHistory[i].v; break; }
    }
    if (dbl === null && dblHistory.length) dbl = dblHistory[0].v;
    if (dbl !== null && dbl !== ctx.clock.doubleTime) ctx.clock.doubleTime = dbl;
    const bpm = ctx.clock.bpm;
    pinch = {
      startBpm: bpm,
      bpm,
      startY: right.pos ? right.pos.y : null, // set by pinchMove() once a position is known
      size: right.handSize > 0 ? right.handSize : null,
      gate: ret ? ret.gate : params.gate.value, // a re-pinch during Return keeps the original held gate
      tilt,
    };
    ret = null;
    tiltFade = null;
    shown = null;
    notify();
  }

  function pinchMove(right) {
    // Without a position / hand size (e.g. a synthetic frame) the pinch only holds; the tempo stays.
    if (!right.pos || !(right.handSize > 0)) return;
    if (pinch.startY == null || pinch.size == null) {
      pinch.startY = right.pos.y;
      pinch.size = right.handSize;
      return;
    }
    const dy = (pinch.startY - right.pos.y) / pinch.size; // up = +, in hand sizes (both display-height units)
    const b = pinchTempo(pinch.startBpm, dy, pinch.bpm);
    if (b === pinch.bpm) return;
    pinch.bpm = b;
    ctx.clock.bpm = b; // the clock's own tempo-change rule: no lost or doubled step; publishes `bpm`
    notify();
  }

  function endPinch(right, t) {
    const h = right ? clamp01(right.height) : null;
    ret = { gate: pinch.gate, side: h == null ? null : Math.sign(h - pinch.gate) };
    if (h != null && Math.abs(h - pinch.gate) <= PINCH_TEMPO.PICKUP) ret = null;
    tiltFade = { from: pinch.tilt, t0: t };
    thumbSettleUntil = t + PINCH_TEMPO.THUMB_SETTLE_MS;
    shown = { startBpm: pinch.startBpm, bpm: pinch.bpm, startY: pinch.startY, size: pinch.size, until: performance.now() + MOTION.bpmLinger };
    pinch = null;
    notify();
  }

  function resetPinch() {
    pinch = null;
    ret = null;
    tiltFade = null;
    shown = null;
    dblHistory.length = 0;
    publishTempo();
  }

  let tempoKey = "";
  /** `arp/tempo` while the tempo feedback shows (UI: no edge guide through the big BPM). Built on change only. */
  function publishTempo() {
    if (shown && !pinch && performance.now() >= shown.until) shown = null;
    const tp = pinch || shown;
    const key = tp ? `${tp.startBpm}|${tp.bpm}|${!!pinch}` : "";
    if (key === tempoKey) return;
    tempoKey = key;
    ctx?.bus?.set("arp/tempo", tp ? { startBpm: tp.startBpm, bpm: tp.bpm, delta: tp.bpm - tp.startBpm, pinching: !!pinch } : null);
  }

  const mode = {
    id: "arp",
    name: "Arp",
    icon: "↗",
    color: ARP_COLOR,
    direction: "right",
    signals: [
      { name: "arp/gate", type: "continuous" },
      { name: "arp/pattern", type: "state" },
      { name: "arp/octaves", type: "state" },
      { name: "arp/rate", type: "state" },
      { name: "arp/double", type: "state" },
      { name: "voicing", type: "state" },
      { name: "filter", type: "continuous" }, // right tilt (ctx.audio.setFilter publishes it)
      { name: "chord", type: "state" }, // the left-hand chord (chord display, energy wave)
      // Pinch tempo feedback while it shows at the hand (pinch + ~1 s): {startBpm, bpm, delta, pinching} | null.
      { name: "arp/tempo", type: "state" },
    ],
    menuItems: [],
    guide: [["✊", "Menu"], ["↕", "Gate"], ["👍", "Double time"], ["🤏", "Tempo"]],
    rightTrack: { param: "arp/gate", label: "Gate" },

    enter(c) {
      ctx = c;
      // Coming from another mode via the menu: the voicing is shared (harmony.voicing) and the gate
      // starts at the locked right-hand height, so the router's crossfade to the live hand is seamless.
      const hv = ctx.harmony?.voicing;
      if (hv >= 1 && hv <= 4) voicing = hv;
      const locked = ctx.rightLocked;
      const gate0 = locked ? clamp01(locked.height) : params?.gate.value ?? 0.35;
      params = {
        gate: ctx.param("arp/gate", { type: "continuous", value: gate0, min: 0, max: 1 }),
        pattern: ctx.param("arp/pattern", { type: "state", value: params?.pattern.value ?? "up" }),
        octaves: ctx.param("arp/octaves", { type: "state", value: params?.octaves.value ?? 1, min: 1, max: 3 }),
      };
      voice = createArpVoice(ctx.audio.ac, ctx.audio.out, { waveform: ctx.audio.waveform, onNote, nextId: ctx.audio.nextNoteId });
      unsub = [ctx.clock.onStep(onStep), ctx.clock.onStepChange(onStepChange), ctx.clock.onStop(cancelPending)];
      thumbWas = null;
      resetPinch();
      if (!ctx.clock.running) ctx.clock.start();
    },

    exit() {
      unsub.forEach((u) => u());
      unsub = [];
      resetPinch();
      cancelPending();
      voice?.releaseAll(0.15); // sounding notes ring out briefly (overlapping the next mode); the clock keeps running (shared)
    },

    update(right, c = ctx) {
      ctx = c;
      if (right) {
        const t = right.t || performance.now();
        if (right.pinch) {
          if (!pinch) startPinch(right, t);
          pinchMove(right);
        } else {
          if (pinch) endPinch(right, t);
          if (right.voicingCount >= 1 && right.voicingCount <= 4) voicing = right.voicingCount;
          if (ctx.harmony) ctx.harmony.voicing = voicing;
          // A screen control listed in `ui/override` wins until the hand moves (the panel decides that).
          const ov = ctx.bus?.get?.("ui/override");
          const gateOverridden = Array.isArray(ov) && ov.includes("arp/gate");
          if (gateOverridden) ret = null;
          const h = clamp01(right.height);
          if (ret) {
            // Return state: the gate stays held until the hand gets to it (within PICKUP, or crosses it).
            const d = h - ret.gate;
            const side = Math.sign(d);
            if (Math.abs(d) <= PINCH_TEMPO.PICKUP || (ret.side != null && ret.side !== 0 && side !== ret.side)) ret = null;
            else if (ret.side == null) ret.side = side;
          }
          if (!ret && !gateOverridden) params.gate.value = h;
          let tl = right.tilt;
          if (tiltFade) {
            const k = (t - tiltFade.t0) / PINCH_TEMPO.FILTER_RETURN_MS;
            if (k >= 1) tiltFade = null;
            else tl = tiltFade.from + (right.tilt - tiltFade.from) * smoothstep(Math.max(0, k));
          }
          ctx.audio.setFilter(tl);
          tilt = tl;
          const thumb = !!right.fingers?.thumb;
          if (t < thumbSettleUntil) thumbWas = thumb; // follow the thumb without toggling while it settles
          else if (thumb !== thumbWas) {
            // Edge-triggered so the screen toggle still works while the hand is up.
            if (thumbWas !== null || thumb) ctx.clock.doubleTime = thumb;
            thumbWas = thumb;
          }
          dblHistory.push({ t, v: ctx.clock.doubleTime });
          while (dblHistory.length > 1 && dblHistory[0].t < t - 1000) dblHistory.shift();
          notify();
        }
      } else if (pinch) {
        endPinch(null, performance.now()); // pinching hand lost: the pinch ends, the held values stay
      }
      // Right hand null: keep the last values. Chord null (left fist): steps rest (in onStep).
      rebind();
      publishChord();
      publishTempo();
    },

    /** Right-hand values this mode holds itself (router -> `held` signal): pinch = held, after it = return. */
    heldState() {
      if (pinch) return { phase: "held", values: { "arp/gate": pinch.gate } };
      if (ret) return { phase: "return", values: { "arp/gate": ret.gate } };
      return null;
    },

    /** Pinch-tempo state for visuals / tests: { startBpm, bpm, startY, size, pinching, returning } | null. */
    get pinchTempo() {
      const base = pinch || shown;
      if (!base) return null;
      return { startBpm: base.startBpm, bpm: base.bpm, startY: base.startY, size: base.size, pinching: !!pinch, returning: !!ret };
    },

    /** Menu holds the right hand: keep the locked values; left-hand chord changes still land on the next step. */
    hold(c = ctx) {
      ctx = c;
      rebind();
      publishChord();
      publishTempo();
    },

    /** Programmatic setters (screen controls, lab). */
    set(values) {
      if (values.voicing != null) voicing = Math.max(1, Math.min(4, values.voicing | 0));
      if (values.gate != null) params.gate.value = clamp01(values.gate);
      if (values.pattern != null && PATTERNS.includes(values.pattern)) params.pattern.value = values.pattern;
      if (values.octaves != null) params.octaves.value = Math.max(1, Math.min(3, values.octaves | 0));
      if (values.rate != null) ctx.clock.rate = values.rate;
      if (values.doubleTime != null) ctx.clock.doubleTime = values.doubleTime;
      if (values.bpm != null) ctx.clock.bpm = values.bpm;
      ctx.bus?.set("arp/rate", ctx.clock.rate);
      ctx.bus?.set("arp/double", ctx.clock.doubleTime);
      rebind();
      notify();
    },

    get state() {
      return {
        voicing,
        gate: params?.gate.value,
        pattern: params?.pattern.value,
        octaves: params?.octaves.value,
        rate: ctx?.clock.rate,
        doubleTime: ctx?.clock.doubleTime,
        doubleTimeActive: ctx?.clock.doubleTimeActive,
        bpm: ctx?.clock.bpm,
        pos,
      };
    },

    /** Recent steps (newest last) with their play time and note (null = rest). */
    get steps() {
      return steps;
    },

    onChange(cb) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },

    controls(container, c = ctx) {
      return buildControls(mode, container, c);
    },

    draw(g, c = ctx) {
      // The energy wave stays in every mode (docs/ui-integration.md §3): gate = thickness here.
      const ch = c.harmony?.chord;
      drawEnergy(g, params?.gate.value ?? 0, ch ? voicing : 0, tilt, ch ? ch.roman : null);
      // Tempo / beat / step dots are src/ui/transport.js in the app; here only the feedback at the hand:
      // the tempo scale + big BPM during a pinch (and ~1 s after), else the x2 pill
      // (docs/ui-integration.md §6: shown with the thumb out, hidden while pinched, while the menu holds
      // the hand or when the hand is lost).
      const clock = c.clock;
      const bus = c.bus;
      drawnTempo = null;
      if (!clock || bus.get("right/held")) return;
      const pos = bus.get("right/pos");
      const size = bus.get("right/size");
      if (!pos || !(size > 0)) return;
      const p = c.toCanvas(pos);
      const now = performance.now();
      if (shown && !pinch && now >= shown.until) shown = null;
      const tp = pinch || shown;
      if (tp) {
        const alpha = pinch ? 1 : Math.min(1, (shown.until - now) / MOTION.fast);
        drawnTempo = drawTempoFeedback(g, { p, size, tp, alpha, exprSide: bus.get("ui/sides")?.expr ?? "right" });
        if (pinch) return;
      }
      if (!(clock.doubleTime || clock.doubleTimeActive)) return;
      drawX2Pill(g, {
        x: p.x,
        y: p.y,
        hs: size * g.canvas.height * 1.9, // hand span in px (same as src/ui/mode-ui.js)
        color: ARP_COLOR,
        filled: !!(clock.doubleTimeActive && clock.doubleTime),
      });
    },

    /** What the last draw() showed at the hand for the pinch (tests): rects + tick positions, or null. */
    get drawnTempo() {
      return drawnTempo;
    },

    /** The old minimal tempo/beat/step bar (labs/arp-lab.html; the app uses src/ui/transport.js). */
    drawTransport(g, c = ctx) {
      drawArp(g, c, steps);
    },
  };
  return mode;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

const smoothstep = (k) => k * k * (3 - 2 * k);

// ---------- pinch feedback at the hand (mocks.md §3, docs/ui-integration.md §4 "Pinch (Arp)") ----------

const TICKS_SHOWN = 10; // ticks each side of the start tick (more when the tempo moved further)

/**
 * Relative tempo scale (1 tick = 1 BPM; start tick + current tick, the current tick level with the hand)
 * next to the right hand on the outer side when there is room, else the inner side; beyond it the big
 * BPM number on a plate with the delta ("BPM +6"). Canvas px = CSS px (the main canvas is unscaled).
 */
function drawTempoFeedback(g, { p, size, tp, alpha, exprSide }) {
  const W = g.canvas.width;
  const H = g.canvas.height;
  const hs = Math.max(50, Math.min(size * H * 1.9, W * 0.32, 280)); // hand span (as src/ui/mode-ui.js)
  // Tick spacing = the hand movement for 1 BPM, so the ticks slide past the hand as it moves (kept readable).
  const step = Math.max(4, Math.min(14, (size * H) / PINCH_TEMPO.BPM_PER_HAND));
  const delta = tp.bpm - tp.startBpm;
  let out = exprSide === "left" ? -1 : 1; // towards the expression edge
  const room = out > 0 ? W - LAYOUT.gutter - p.x : p.x - LAYOUT.gutter;
  if (room < hs * 0.55 + 150) out = -out;
  const curY = Math.max(90, Math.min(H - 110, p.y));
  const startY = curY + delta * step;
  const lo = Math.min(-TICKS_SHOWN, delta - 4);
  const hi = Math.max(TICKS_SHOWN, delta + 4);
  const sx = p.x + out * hs * 0.55;
  const top = startY - hi * step;
  const bottom = startY - lo * step;

  g.save();
  g.globalAlpha *= alpha;
  const scale = drawPlate(g, Math.min(sx, sx + out * 18) - 5, top - 6, 28, bottom - top + 12, { radius: 6, fill: "rgba(20, 20, 20, 0.5)" });
  g.lineCap = "round";
  for (let i = lo; i <= hi; i++) {
    const y = startY - i * step;
    if (y < 4 || y > H - 4) continue;
    const isStart = i === 0;
    const isCur = i === delta;
    const len = isCur ? 18 : isStart ? 14 : i % 5 === 0 ? 9 : 5;
    g.beginPath();
    g.moveTo(sx, y);
    g.lineTo(sx + out * len, y);
    // Dark halo under the start/current ticks so they read on bright video.
    if (isStart || isCur) {
      g.lineWidth = (isCur ? 3 : 2) + 3;
      g.strokeStyle = COLORS.halo;
      g.stroke();
    }
    g.lineWidth = isCur ? 3 : isStart ? 2 : 1;
    g.strokeStyle = isCur ? ARP_COLOR : isStart ? COLORS.ink : withAlpha(COLORS.ink, Math.max(0.2, 0.6 - Math.abs(i - delta) * 0.025));
    g.stroke();
  }
  g.restore();

  // The one large number in change, beyond the scale, level with the hand.
  g.save();
  g.globalAlpha *= alpha;
  const plate = drawBpmPlate(g, { x: sx + out * 34, y: curY, bpm: tp.bpm, delta, align: out > 0 ? "left" : "right" });
  g.restore();
  return { scale, plate, startTickY: startY, currentTickY: curY, tickStep: step, side: out > 0 ? "outer" : "inner", alpha };
}

// ---------- screen controls (mocks.md §5) ----------

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const ch of children) e.append(ch);
  return e;
}

function segmented(name, options, onPick) {
  const wrap = el("div", { class: "arp-seg", role: "radiogroup", "aria-label": name, "data-control": name });
  const buttons = options.map(([value, label]) => {
    const b = el("button", { type: "button", role: "radio", text: label, "data-value": String(value) });
    b.addEventListener("click", () => onPick(value));
    wrap.append(b);
    return [value, b];
  });
  return {
    el: wrap,
    sync(current) {
      for (const [v, b] of buttons) {
        const on = v === current;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      }
    },
  };
}

function row(label, control) {
  return el("div", { class: "arp-row" }, [el("span", { class: "arp-label", text: label }), control]);
}

export const CONTROLS_CSS = `
.arp-controls{--arp:${ARP_COLOR};display:flex;flex-direction:column;gap:10px;font:13px/1.2 system-ui,sans-serif;color:#e8eef5}
.arp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.arp-label{min-width:64px;opacity:.7}
.arp-seg{display:inline-flex;border:1.5px solid rgba(255,255,255,.25);border-radius:999px;overflow:hidden}
.arp-seg button,.arp-btn{background:transparent;color:inherit;border:0;padding:6px 12px;font:inherit;cursor:pointer}
.arp-seg button+button{border-left:1px solid rgba(255,255,255,.18)}
.arp-seg button.on{background:color-mix(in srgb,var(--arp) 30%,transparent);color:#fff;font-weight:600}
.arp-btn{border:1.5px solid rgba(255,255,255,.25);border-radius:999px;min-width:34px}
.arp-bpm{min-width:40px;text-align:center;font-variant-numeric:tabular-nums;font-size:16px;font-weight:600}
.arp-toggle[aria-pressed=true]{background:color-mix(in srgb,var(--arp) 30%,transparent);border-color:var(--arp)}
.arp-controls input[type=range]{accent-color:var(--arp);width:160px}
`;

function buildControls(mode, container, ctx) {
  const set = (v) => mode.set(v);
  const minus = el("button", { type: "button", class: "arp-btn", "aria-label": "Tempo down", text: "−", "data-control": "bpm-down" });
  const plus = el("button", { type: "button", class: "arp-btn", "aria-label": "Tempo up", text: "+", "data-control": "bpm-up" });
  const bpm = el("span", { class: "arp-bpm", "data-control": "bpm" });
  minus.addEventListener("click", () => set({ bpm: ctx.clock.bpm - 1 }));
  plus.addEventListener("click", () => set({ bpm: ctx.clock.bpm + 1 }));
  // Tap tempo: the average interval of the last taps (a pause > 2 s starts over).
  const tap = el("button", { type: "button", class: "arp-btn", "aria-label": "Tap tempo", text: "Tap", "data-control": "bpm-tap" });
  const taps = [];
  tap.addEventListener("click", () => {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(t);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) {
      const bpmTapped = 60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1));
      set({ bpm: Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpmTapped))) });
    }
  });

  const rate = segmented("rate", RATES.map((r) => [r, RATE_LABELS.get(r)]), (r) => set({ rate: r }));
  const pattern = segmented("pattern", PATTERNS.map((p) => [p, PATTERN_LABELS[p]]), (p) => set({ pattern: p }));
  const octaves = segmented("octaves", [[1, "1"], [2, "2"], [3, "3"]], (n) => set({ octaves: n }));

  const gate = el("input", { type: "range", min: "0", max: "1", step: "0.01", "aria-label": "Gate length", "data-control": "gate" });
  gate.addEventListener("input", () => set({ gate: Number(gate.value) }));

  const dbl = el("button", { type: "button", class: "arp-btn arp-toggle", "aria-pressed": "false", text: "x2", "data-control": "double" });
  dbl.addEventListener("click", () => set({ doubleTime: !ctx.clock.doubleTime }));

  const style = el("style", { text: CONTROLS_CSS });
  const panel = el("div", { class: "arp-controls" }, [
    style,
    row("Tempo", el("div", { class: "arp-row" }, [minus, bpm, plus, tap])),
    row("Rate", rate.el),
    row("Pattern", pattern.el),
    row("Octaves", octaves.el),
    row("Gate", gate),
    row("Double", dbl),
  ]);
  container.append(panel);

  const sync = () => {
    const s = mode.state;
    bpm.textContent = String(s.bpm);
    rate.sync(s.rate);
    pattern.sync(s.pattern);
    octaves.sync(s.octaves);
    if (document.activeElement !== gate) gate.value = String(s.gate);
    dbl.setAttribute("aria-pressed", String(!!s.doubleTime));
  };
  sync();
  const off = mode.onChange(sync);
  return () => {
    off();
    panel.remove();
  };
}

// ---------- canvas: tempo + beat dots + step dots (minimal; polish comes with the UI pass) ----------

function drawArp(g, ctx, steps) {
  const ac = ctx.audio.ac;
  // Show a step when it is heard, not when it was scheduled.
  const now = ac.currentTime - (ac.outputLatency || 0);
  let cur = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].time <= now) {
      cur = steps[i];
      break;
    }
  }
  const W = g.canvas.width;
  const H = g.canvas.height;
  const dpr = W / (g.canvas.clientWidth || W);
  const y = H - 28 * dpr;
  const running = ctx.clock.running && cur;
  g.save();
  g.font = `600 ${15 * dpr}px system-ui, sans-serif`;
  g.textBaseline = "middle";
  g.fillStyle = "rgba(255,255,255,0.9)";
  const label = `${ctx.clock.bpm} BPM`;
  const x0 = W / 2 - 150 * dpr;
  g.fillText(label, x0, y);

  // Beat dots (4 per bar); the current one is filled and pulses.
  const beat = running ? Math.floor(cur.beat) : -1;
  const sinceBeat = running ? now - ctx.clock.timeAtBeat(beat) : 1;
  const pulse = Math.max(0, 1 - sinceBeat / 0.18);
  const bx = x0 + 80 * dpr;
  for (let i = 0; i < 4; i++) {
    const on = running && ((beat % 4) + 4) % 4 === i;
    g.beginPath();
    g.arc(bx + i * 18 * dpr, y, (on ? 5 + 2 * pulse : 5) * dpr, 0, Math.PI * 2);
    if (on) {
      g.fillStyle = ARP_COLOR;
      g.fill();
    } else {
      g.strokeStyle = "rgba(255,255,255,0.5)";
      g.lineWidth = 1.25 * dpr;
      g.stroke();
    }
  }

  // Step dots: one per step of the bar (max 16; finer grids wrap); current step lit, rests hollow.
  const stepBeats = cur?.beats ?? 4 * ctx.clock.rate;
  const count = Math.min(16, Math.round(4 / stepBeats));
  const idx = running ? Math.floor((((cur.beat % 4) + 4) % 4) / stepBeats) % count : -1;
  const sx = bx + 4 * 18 * dpr + 14 * dpr;
  for (let i = 0; i < count; i++) {
    g.beginPath();
    g.arc(sx + i * 10 * dpr, y, 2.6 * dpr, 0, Math.PI * 2);
    if (i === idx) {
      g.fillStyle = cur.midi == null ? "rgba(255,255,255,0.35)" : "#ffffff";
      g.fill();
    } else {
      g.fillStyle = "rgba(255,255,255,0.22)";
      g.fill();
    }
  }

  // x2: outline while requested but not yet active (waits for the next beat), filled when active.
  if (ctx.clock.doubleTime || ctx.clock.doubleTimeActive) {
    const px = sx + count * 10 * dpr + 14 * dpr;
    const active = ctx.clock.doubleTimeActive && ctx.clock.doubleTime;
    g.beginPath();
    g.roundRect(px, y - 9 * dpr, 30 * dpr, 18 * dpr, 9 * dpr);
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = ARP_COLOR;
    g.stroke();
    if (active) {
      g.fillStyle = ARP_COLOR;
      g.fill();
    }
    g.fillStyle = active ? "#0b1622" : ARP_COLOR;
    g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
    g.fillText("x2", px + 8 * dpr, y + 0.5 * dpr);
  }
  g.restore();
}

export default createArpMode();
