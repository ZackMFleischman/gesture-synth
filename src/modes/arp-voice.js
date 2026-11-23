// One-shot note voice for the arp: oscillator (current waveform) -> per-note gain envelope -> destination.
//
// Every envelope point is scheduled up front on the audio clock, as explicit, continuous segments
// (no jumps), so notes start and end click-free at any length:
//   0 --linear attack--> peak --exponential decay--> sustain ... hold end --exp release--> ~0 --> 0, stop.
// Gain values leave headroom: several overlapping notes (high gate) stay well below full scale.

import { gateToDuration } from "./arp-patterns.js";

export const VOICE_DEFAULTS = {
  peak: 0.22, // per-note peak; ~3 notes overlap at most (gate 1 = 2 steps + release)
  attack: 0.004, // s — long enough to avoid a click, short enough to stay sample-tight
  decayTau: 0.09, // s — pluck character
  sustain: 0.55, // fraction of peak
  release: 0.035, // s — exponential to -60 dB
};

/**
 * @param {AudioContext} ac
 * @param {AudioNode} destination
 * @param {{waveform?: OscillatorType, onNote?: (ev) => void} & Partial<typeof VOICE_DEFAULTS>} opts
 *   onNote({type: "on"|"off"|"cancel", freq, time, id, ...}) is called at schedule time with the play time.
 *   nextId?: () => number — note id source (the app passes ctx.audio.nextNoteId so ids are unique across voices).
 */
export function createArpVoice(ac, destination, opts = {}) {
  const cfg = { ...VOICE_DEFAULTS, ...opts };
  let waveform = opts.waveform || "triangle";
  let onNote = opts.onNote || null;
  let localId = 1;
  const newId = typeof opts.nextId === "function" ? opts.nextId : () => localId++;
  const live = new Set();

  /**
   * Schedules one note. Returns a handle with cancel() (only silences notes that have not started).
   * @param {number} freq Hz
   * @param {number} time AudioContext start time
   * @param {number} dur hold length in s (release comes after)
   */
  function play(freq, time, dur, meta = {}) {
    const A = cfg.attack;
    const R = cfg.release;
    const peak = cfg.peak * (meta.velocity ?? 1);
    const t0 = Math.max(time, ac.currentTime);
    const end = t0 + Math.max(dur, A + 0.004);
    const stopAt = end + R + 0.006;

    const osc = ac.createOscillator();
    osc.type = waveform;
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.value = 0;
    const p = g.gain;
    const sus = peak * cfg.sustain;
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(peak, t0 + A);
    p.setTargetAtTime(sus, t0 + A, cfg.decayTau);
    // Value of the decay curve at `end`, so the release starts exactly where the curve is.
    const vEnd = sus + (peak - sus) * Math.exp(-(end - t0 - A) / cfg.decayTau);
    p.setValueAtTime(vEnd, end);
    p.exponentialRampToValueAtTime(Math.max(vEnd * 0.001, 1e-5), end + R);
    p.linearRampToValueAtTime(0, end + R + 0.004);
    osc.connect(g);
    g.connect(destination);
    osc.start(t0);
    osc.stop(stopAt);

    const id = newId();
    const note = { id, freq, time: t0, end, stopAt, osc, gain: g, meta, cancelled: false };
    live.add(note);
    osc.onended = () => {
      live.delete(note);
      osc.disconnect();
      g.disconnect();
    };
    if (onNote) {
      onNote({ type: "on", id, freq, time: t0, dur: end - t0, ...meta });
      onNote({ type: "off", id, freq, time: end, ...meta });
    }
    return {
      id,
      time: t0,
      end,
      /** Silences the note if it has not started yet (returns true), else leaves it alone. */
      cancel(margin = 0.005) {
        if (note.cancelled || t0 <= ac.currentTime + margin) return false;
        note.cancelled = true;
        p.cancelScheduledValues(0);
        p.value = 0;
        osc.stop(); // before its start time -> never sounds
        if (onNote) onNote({ type: "cancel", id, freq, time: t0, ...meta });
        return true;
      },
    };
  }

  return {
    play,
    /** Plays a note for one arp step: duration from gate and step length. */
    playStep(freq, time, stepDur, gate, meta) {
      return play(freq, time, gateToDuration(gate, stepDur), meta);
    },
    get waveform() {
      return waveform;
    },
    set waveform(w) {
      waveform = w;
    },
    set onNote(cb) {
      onNote = cb;
    },
    /** Fades out everything (sounding or scheduled) quickly and click-free. */
    releaseAll(fade = 0.03) {
      const now = ac.currentTime;
      for (const n of live) {
        if (n.time > now + 0.005) {
          n.gain.gain.cancelScheduledValues(0);
          n.gain.gain.value = 0;
          try { n.osc.stop(); } catch {}
          continue;
        }
        const p = n.gain.gain;
        if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
        else {
          p.cancelScheduledValues(now);
          p.setValueAtTime(p.value, now);
        }
        p.linearRampToValueAtTime(0, now + fade);
        try { n.osc.stop(now + fade + 0.005); } catch {}
      }
    },
    get activeCount() {
      return live.size;
    },
  };
}
