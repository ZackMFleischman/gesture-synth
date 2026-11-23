// Signal analysis for rhythmic (arp) recordings: onsets, note lengths, per-note pitch, clicks.
import { spectrum, peaks } from "./audio.js";

/**
 * Starts a recording and returns the AudioContext time at which it started (approximate: the tap's
 * own latency is unknown, so timing checks compare against it via a fitted constant offset).
 */
export async function startRecording(page) {
  return page.evaluate(() => {
    window.__audioCap.chunks = [];
    window.__audioCap.recording = true;
    return window.__lab.ctx.audio.ac.currentTime;
  });
}

export async function stopRecording(page) {
  const { chunks, sampleRate, acEnd } = await page.evaluate(() => {
    window.__audioCap.recording = false;
    return {
      chunks: window.__audioCap.chunks,
      sampleRate: window.__audioCap.sampleRate,
      acEnd: window.__lab.ctx.audio.ac.currentTime,
    };
  });
  return { samples: Float32Array.from(chunks.flat()), sampleRate, acEnd };
}

/** Onsets = first sample above `thresh` after at least `gap` s below it. Returns seconds. */
export function detectOnsets(samples, sr, { thresh = 0.004, gap = 0.006 } = {}) {
  const gapN = Math.round(gap * sr);
  const out = [];
  let quiet = gapN; // treat the start as silence only if it really is
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) < thresh) quiet++;
    else {
      if (quiet >= gapN && i > 0) out.push(i / sr);
      quiet = 0;
    }
  }
  return out;
}

/** For each onset, the time until the signal stays below `thresh` for `gap` s (note length incl. release). */
export function noteLengths(samples, sr, onsets, { thresh = 0.004, gap = 0.006 } = {}) {
  const gapN = Math.round(gap * sr);
  return onsets.map((t) => {
    let i = Math.round(t * sr);
    let lastLoud = i;
    let quiet = 0;
    for (; i < samples.length && quiet < gapN; i++) {
      if (Math.abs(samples[i]) >= thresh) {
        lastLoud = i;
        quiet = 0;
      } else quiet++;
    }
    return (lastLoud - Math.round(t * sr)) / sr;
  });
}

/** Strongest pitch in a window starting at `t` s. */
export function pitchAt(samples, sr, t, size = 8192) {
  const i0 = Math.round(t * sr);
  const win = samples.subarray(i0, i0 + size);
  const found = peaks(spectrum(win, sr, size), 0.15);
  return found.length ? found[0].freq : 0;
}

/** All strong pitches (>= minRatio of strongest) in a window starting at `t`. */
export function pitchesAt(samples, sr, t, size = 4096, minRatio = 0.25) {
  const i0 = Math.round(t * sr);
  return peaks(spectrum(samples.subarray(i0, i0 + size), sr, size), minRatio).map((p) => p.freq);
}

export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);

/** Peak |sample|. */
export function peakAbs(samples) {
  let p = 0;
  for (const s of samples) p = Math.max(p, Math.abs(s));
  return p;
}

/**
 * Click metric: |second difference| (a discontinuity in value or slope shows up as a spike).
 * Returns the max inside +-`win` s of each boundary time and the max in the note bodies.
 */
export function clickStats(samples, sr, boundaries, win = 0.003) {
  const d2 = new Float32Array(samples.length);
  for (let i = 2; i < samples.length; i++) d2[i] = Math.abs(samples[i] - 2 * samples[i - 1] + samples[i - 2]);
  const near = new Uint8Array(samples.length);
  const w = Math.round(win * sr);
  let atBoundary = 0;
  for (const t of boundaries) {
    const c = Math.round(t * sr);
    for (let i = Math.max(2, c - w); i < Math.min(samples.length, c + w); i++) {
      near[i] = 1;
      atBoundary = Math.max(atBoundary, d2[i]);
    }
  }
  let body = 0;
  for (let i = 2; i < samples.length; i++) if (!near[i]) body = Math.max(body, d2[i]);
  return { atBoundary, body };
}

/**
 * Matches onsets (recording seconds) to scheduled play times (AudioContext seconds).
 * The recording's AudioContext start time is only approximate, so the constant offset is fitted
 * (median) and the residuals are the timing errors.
 */
export function matchToSchedule(onsets, scheduled, recStartAc) {
  const approx = onsets.map((t) => t + recStartAc);
  const nearest = (x) => scheduled.reduce((b, s) => (Math.abs(s - x) < Math.abs(b - x) ? s : b), scheduled[0]);
  const diffs0 = approx.map((x) => x - nearest(x)).sort((a, b) => a - b);
  const off0 = diffs0[Math.floor(diffs0.length / 2)];
  const pairs = approx.map((x) => {
    const s = nearest(x - off0);
    return { onset: x, sched: s, d: x - s };
  });
  const ds = pairs.map((p) => p.d).sort((a, b) => a - b);
  const offset = ds[Math.floor(ds.length / 2)];
  const errors = pairs.map((p) => p.d - offset);
  return { offset, pairs, errors };
}

export const stats = (xs) => {
  const abs = xs.map(Math.abs);
  return {
    n: xs.length,
    meanAbs: abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length),
    maxAbs: Math.max(0, ...abs),
  };
};
