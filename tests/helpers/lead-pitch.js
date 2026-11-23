// Pure analysis for Lead's discrete pitch steps (tests/lead.spec.js in the lab, tests/camera-feedback.e2e.spec.js
// in the app): per-cycle pitch, FFT per short window, and the click metric. No browser APIs.
import { spectrum, peaks, rms } from "./audio.js";

/** Per-cycle frequency from upward zero crossings (works on the clean triangle lead). [{at (sample), f}] */
export function cycleFreqs(samples, sampleRate) {
  const out = [];
  let last = -1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) {
      const frac = -samples[i - 1] / (samples[i] - samples[i - 1]);
      const x = i - 1 + frac;
      if (last >= 0) out.push({ at: x, f: sampleRate / (x - last) });
      last = x;
    }
  }
  return out;
}

/** RMS envelope in `win`-sample windows. */
export function envelope(samples, win = 240) {
  const env = [];
  for (let i = 0; i + win <= samples.length; i += win) env.push(rms(samples.subarray(i, i + win)));
  return env;
}

/**
 * Steps between target pitches. Every cycle is classified as one of `targets` (Hz, within `tol`) or
 * "between" (a pitch that is none of them). Returns
 *   { cycles, segments: [{target, from, to}] (runs of cycles on one target, in samples),
 *     between: [{at, f}] (cycles on no target, outside silence), maxBetweenRun (longest run of such cycles) }.
 * A 70 ms glide between two notes a whole tone apart = ~25 consecutive "between" cycles at 300-600 Hz; a discrete
 * step = at most one (the cycle the step falls into is a mix of both periods).
 */
export function stepAnalysis(samples, sampleRate, targets, { tol = 0.012 } = {}) {
  const cycles = cycleFreqs(samples, sampleRate);
  const which = (f) => targets.findIndex((t) => Math.abs(f / t - 1) < tol);
  const segments = [];
  const between = [];
  let run = 0;
  let maxBetweenRun = 0;
  for (const c of cycles) {
    const k = which(c.f);
    if (k < 0) {
      between.push(c);
      run++;
      maxBetweenRun = Math.max(maxBetweenRun, run);
      continue;
    }
    run = 0;
    const seg = segments.at(-1);
    if (seg && seg.target === k) seg.to = c.at;
    else segments.push({ target: k, from: c.at, to: c.at });
  }
  return { cycles, segments, between, maxBetweenRun };
}

/**
 * Strongest FFT peak in each window of `win` samples (hop `hop`), Hann window.
 * win 4096 = 85 ms at 48 kHz (93 ms at 44.1 kHz): [{start, end, freq}]
 */
export function windowPitches(samples, sampleRate, { win = 4096, hop = 1024 } = {}) {
  const out = [];
  for (let s = 0; s + win <= samples.length; s += hop) {
    const p = peaks(spectrum(samples.subarray(s, s + win), sampleRate, win), 0.3);
    out.push({ start: s, end: s + win, freq: p.length ? p[0].freq : 0 });
  }
  return out;
}

/**
 * Click metric used by the Lead audio tests: the largest sample-to-sample jump vs the largest one inside
 * steady, loud stretches. The triangle's steepest slope is 4*A*f/sr; a click is far above that.
 */
export function clickRatio(samples, win = 240) {
  let steadyMax = 0;
  let allMax = 0;
  const env = envelope(samples, win);
  const peakEnv = Math.max(...env);
  for (let i = 1; i < samples.length; i++) {
    const d = Math.abs(samples[i] - samples[i - 1]);
    allMax = Math.max(allMax, d);
    const w = Math.floor(i / win);
    if (env[w] > 0.9 * peakEnv && env[w - 1] > 0.9 * peakEnv && env[w + 1] > 0.9 * peakEnv) steadyMax = Math.max(steadyMax, d);
  }
  return { allMax, steadyMax, ratio: steadyMax > 0 ? allMax / steadyMax : Infinity };
}
