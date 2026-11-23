// Arp mode: the left-hand chord played as an arpeggio on the shared clock.
//
// Right hand: fingers (1-4) = voicing, height = gate length, tilt = filter, thumb = double time,
// pinch = tempo (milestone 1.6, TODO hook below). Left fist (no chord) = rest while the clock keeps
// counting. Right hand gone = keep the last values.
//
// Notes are decided in the clock's step callback (~100 ms before they play) and scheduled at the
// step's exact AudioContext time. If the chord / voicing / pattern changes while steps are already
// scheduled but not yet sounding, those steps are re-bound to the new notes, so a change always
// lands on the very next step (not one lookahead later).

import { createArpVoice } from "./arp-voice.js";
import { arpNoteAt, midiToHz, PATTERNS, PATTERN_LABELS } from "./arp-patterns.js";
import { RATES, MIN_BPM, MAX_BPM } from "../services/clock.js";
import { drawEnergy } from "./chords.js";

export const ARP_COLOR = "#4fb3ff"; // placeholder accent (see requirements: mode colors TBD)
const REBIND_MARGIN = 0.008; // s: steps starting later than now + this can still be re-bound
const RATE_LABELS = new Map([[1 / 4, "1/4"], [1 / 8, "1/8"], [1 / 16, "1/16"]]);

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
      if (!ctx.clock.running) ctx.clock.start();
    },

    exit() {
      unsub.forEach((u) => u());
      unsub = [];
      cancelPending();
      voice?.releaseAll(0.08); // sounding notes ring out briefly; the clock keeps running (shared)
    },

    update(right, c = ctx) {
      ctx = c;
      if (right) {
        if (right.pinch) {
          // TODO(1.6): pinch = tempo. Voicing, gate and filter are held; bpm = startBpm + round(dy * k).
          // Restore the voicing from ~0.3 s before the pinch started (HandInput should provide it).
        } else {
          if (right.voicingCount >= 1 && right.voicingCount <= 4) voicing = right.voicingCount;
          if (ctx.harmony) ctx.harmony.voicing = voicing;
          params.gate.value = clamp01(right.height);
          ctx.audio.setFilter(right.tilt);
          tilt = right.tilt;
          const thumb = !!right.fingers?.thumb;
          if (thumb !== thumbWas) {
            // Edge-triggered so the screen toggle still works while the hand is up.
            if (thumbWas !== null || thumb) ctx.clock.doubleTime = thumb;
            thumbWas = thumb;
          }
          notify();
        }
      }
      // Right hand null: keep the last values. Chord null (left fist): steps rest (in onStep).
      rebind();
      publishChord();
    },

    /** Menu holds the right hand: keep the locked values; left-hand chord changes still land on the next step. */
    hold(c = ctx) {
      ctx = c;
      rebind();
      publishChord();
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
      drawArp(g, c, steps);
    },
  };
  return mode;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
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
    row("Tempo", el("div", { class: "arp-row" }, [minus, bpm, plus])),
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
