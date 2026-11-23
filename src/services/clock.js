// Tempo clock + lookahead step scheduler on the AudioContext clock.
//
// Classic "two clocks" design: a coarse JS timer wakes up every ~25 ms and emits every step whose
// play time falls within the next ~100 ms, with that exact AudioContext time. Listeners schedule
// their sound at `time` (sample accurate), and visuals/bus get the play time ahead of the sound.
// Never driven by video frames.
//
// Musical position is counted in beats (quarter notes). A step lasts `4 * rate` beats
// (rate 1/4 -> 1 beat, 1/8 -> 0.5, 1/16 -> 0.25), halved while double time is active. Beat
// positions are sums of powers of two, so they stay exact in floating point (no drift).
//
// Change rules:
//  - Tempo: applies from the next step that has not been scheduled yet. The duration of the last
//    scheduled step is fixed only when its successor is scheduled, so no step is lost or doubled.
//  - Rate and double time: take effect at the next beat boundary (the first step starting on a whole
//    beat that has not sounded yet), so the grid never ends up off the beat.
//  - A scheduled step that has not started yet gets its new length right away (onStepChange), so
//    listeners can re-time that note; its start time never moves.

const DEFAULTS = { bpm: 120, rate: 1 / 8, lookahead: 0.1, interval: 0.025, startDelay: 0.06 };
export const RATES = [1 / 4, 1 / 8, 1 / 16];
export const MIN_BPM = 40;
export const MAX_BPM = 240;

// A worker-driven ticker keeps firing in background tabs (main-thread timers get throttled to 1 s).
function createTicker(intervalMs, tick) {
  let worker = null;
  let id = null;
  try {
    const src = `let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);}`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = tick;
  } catch {
    worker = null;
  }
  return {
    start() {
      if (worker) worker.postMessage(intervalMs);
      else id = setInterval(tick, intervalMs);
    },
    stop() {
      if (worker) worker.postMessage(0);
      else clearInterval(id);
    },
  };
}

/**
 * @param {AudioContext} ac
 * @param {{bpm?:number, rate?:number, lookahead?:number, interval?:number, startDelay?:number, bus?:object}} opts
 */
export function createClock(ac, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const bus = opts.bus || null;
  let bpm = clampBpm(o.bpm);
  let rate = RATES.includes(o.rate) ? o.rate : DEFAULTS.rate;
  let doubleTime = false; // requested

  let running = false;
  let stepIndex = 0;
  // The most recently scheduled step (its duration is decided when the next one is scheduled).
  let last = null; // { index, time, beat, beats }
  // Grid currently in effect (changes only on beat boundaries).
  let activeRate = rate;
  let activeDouble = false;
  const history = []; // recent steps { index, time, beat, beats, dur } for beatAt()/visuals
  const HISTORY = 128;

  const stepListeners = new Set();
  const beatListeners = new Set();
  const stopListeners = new Set();
  const changeListeners = new Set();
  const transportListeners = new Set();

  // Transport / grid listeners (start, stop, tempo, rate, double time): e.g. the visualizer output
  // re-sends its beat grid right away instead of waiting for its periodic resend.
  function notifyTransport(what) {
    for (const cb of transportListeners) {
      try { cb(what); } catch (e) { console.error(e); }
    }
  }

  const ticker = createTicker(o.interval * 1000, () => schedule());

  const stepBeatsFor = (r, dbl) => (4 * r) / (dbl ? 2 : 1);

  const stepInfo = (step) => ({
    beat: step.beat,
    isBeat: Number.isInteger(step.beat),
    beatInBar: Math.floor(step.beat) % 4,
    stepBeats: step.beats,
    stepDur: step.dur,
    bpm,
    double: activeDouble,
  });

  function emitStep(step) {
    const info = stepInfo(step);
    for (const cb of stepListeners) cb(step.index, step.time, info);
    if (info.isBeat) {
      for (const cb of beatListeners) cb(step.beat, step.time, info);
      if (bus) bus.emit("beat", info.beatInBar + 1, step.time);
    }
  }

  function gridChangePending() {
    return rate !== activeRate || doubleTime !== activeDouble;
  }

  function schedule() {
    if (!running) return;
    const horizon = ac.currentTime + o.lookahead;
    while (true) {
      let next;
      if (!last) {
        if (startTime > horizon) return;
        next = { index: stepIndex, time: startTime, beat: 0 };
      } else {
        const dur = (last.beats * 60) / bpm;
        if (last.time + dur > horizon) return;
        last.dur = dur;
        pushHistory(last);
        next = { index: last.index + 1, time: last.time + dur, beat: last.beat + last.beats };
      }
      if (Number.isInteger(next.beat) && gridChangePending()) {
        activeRate = rate;
        activeDouble = doubleTime;
      }
      next.beats = stepBeatsFor(activeRate, activeDouble);
      next.dur = (next.beats * 60) / bpm; // provisional (tempo/grid may change before the successor)
      last = next;
      stepIndex = next.index + 1;
      emitStep(next);
    }
  }

  // A tempo / rate / double-time request can still change the length of the last scheduled step if
  // it has not started yet (its start time never moves). For a step on a whole beat this makes a
  // grid change requested just before the beat (within the lookahead) start exactly on that beat.
  function reviseLast() {
    if (!running || !last || last.time <= ac.currentTime + 0.002) return;
    if (Number.isInteger(last.beat) && gridChangePending()) {
      activeRate = rate;
      activeDouble = doubleTime;
    }
    const beats = Number.isInteger(last.beat) ? stepBeatsFor(activeRate, activeDouble) : last.beats;
    const dur = (beats * 60) / bpm;
    if (beats === last.beats && dur === last.dur) return;
    last.beats = beats;
    last.dur = dur;
    const info = stepInfo(last);
    for (const cb of changeListeners) cb(last.index, last.time, info);
  }

  function pushHistory(step) {
    history.push({ index: step.index, time: step.time, beat: step.beat, beats: step.beats, dur: step.dur });
    if (history.length > HISTORY) history.shift();
  }

  let startTime = 0;

  // Piecewise-linear beat <-> time mapping through the known steps, extrapolated with the
  // current tempo beyond the last scheduled step.
  function segments() {
    const segs = history.slice();
    if (last) segs.push({ ...last, dur: (last.beats * 60) / bpm });
    return segs;
  }

  function beatAt(time) {
    if (!last) return 0;
    const segs = segments();
    let s = segs[0];
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].time <= time) {
        s = segs[i];
        break;
      }
    }
    return s.beat + ((time - s.time) * s.beats) / s.dur;
  }

  function timeAtBeat(beat) {
    if (!last) return startTime + (beat * 60) / bpm;
    const segs = segments();
    let s = segs[0];
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].beat <= beat) {
        s = segs[i];
        break;
      }
    }
    return s.time + (beat - s.beat) * (s.dur / s.beats);
  }

  const clock = {
    get bpm() {
      return bpm;
    },
    set bpm(v) {
      const nb = clampBpm(v);
      if (nb === bpm) return;
      bpm = nb;
      reviseLast();
      if (bus) bus.set("bpm", bpm);
      notifyTransport("bpm");
    },
    get rate() {
      return rate;
    },
    set rate(v) {
      if (!RATES.includes(v) || v === rate) return;
      rate = v;
      reviseLast();
      notifyTransport("rate");
    },
    /** Requested double time (x2 rate). Takes effect on the next beat. */
    get doubleTime() {
      return doubleTime;
    },
    set doubleTime(v) {
      v = !!v;
      if (v === doubleTime) return;
      doubleTime = v;
      reviseLast();
      notifyTransport("double");
    },
    /** Double time actually in effect for the latest scheduled step. */
    get doubleTimeActive() {
      return activeDouble;
    },
    get running() {
      return running;
    },
    get lookahead() {
      return o.lookahead;
    },
    /** Starts at step 0 / beat 0, `startDelay` s from now. */
    start(at) {
      if (running) return;
      running = true;
      stepIndex = 0;
      last = null;
      history.length = 0;
      activeRate = rate;
      activeDouble = doubleTime;
      startTime = at ?? ac.currentTime + o.startDelay;
      if (bus) bus.set("bpm", bpm);
      schedule();
      ticker.start();
      notifyTransport("start");
    },
    stop() {
      if (!running) return;
      running = false;
      ticker.stop();
      for (const cb of stopListeners) cb();
      notifyTransport("stop");
    },
    /** cb(stepIndex, time, info) for each step, ~lookahead s before it plays. Returns unsubscribe. */
    onStep(cb) {
      stepListeners.add(cb);
      return () => stepListeners.delete(cb);
    },
    /** cb(beatNumber, time, info) on each whole beat (also delivered as a step). */
    onBeat(cb) {
      beatListeners.add(cb);
      return () => beatListeners.delete(cb);
    },
    /** cb(stepIndex, time, info) when a scheduled, not yet sounding step gets a new length. */
    onStepChange(cb) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
    /**
     * cb(what) after start/stop and tempo/rate/double-time requests ("start"|"stop"|"bpm"|"rate"|"double"),
     * synchronously, once the clock state reflects the change. Returns unsubscribe.
     */
    onTransport(cb) {
      transportListeners.add(cb);
      return () => transportListeners.delete(cb);
    },
    onStop(cb) {
      stopListeners.add(cb);
      return () => stopListeners.delete(cb);
    },
    /** Musical position (beats, fractional) at an AudioContext time. */
    beatAt,
    /** AudioContext time of a beat position. */
    timeAtBeat,
    /** AudioContext time of the next whole beat after now. */
    nextBeatTime() {
      const now = ac.currentTime;
      if (!running || !last) return now;
      return timeAtBeat(Math.floor(beatAt(now)) + 1);
    },
    /** Recently scheduled steps (newest last), for visuals that render at play time. */
    recentSteps() {
      return segments();
    },
    /** Forces a scheduling pass (normally driven by the ticker). */
    tick: schedule,
  };
  return clock;
}

function clampBpm(v) {
  return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(Number(v) || DEFAULTS.bpm)));
}
