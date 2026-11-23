import fs from "node:fs";
import path from "node:path";

// Injected before page scripts run. Every node connected to an AudioContext's
// destination is routed through a pass-through ScriptProcessor that can record
// the final mixed output, so tests analyse exactly what the speakers would get.
// The ScriptProcessor runs on the main thread, so a starved main thread can lose or shift captured
// blocks. Each recorded block therefore also stores its playbackTime (AudioContext time of its first
// sample) and the context time when the callback ran; captureHealth() turns these into a glitch report.
export const TAP_BLOCK = 4096;
export const AUDIO_TAP_SCRIPT = `(() => {
  const cap = (window.__audioCap = { recording: false, sampleRate: 0, chunks: [], blocks: [] });
  const origConnect = AudioNode.prototype.connect;
  const taps = new WeakMap();
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const ctx = this.context;
      let tap = taps.get(ctx);
      if (!tap) {
        tap = ctx.createScriptProcessor(${TAP_BLOCK}, 1, 1);
        tap.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          e.outputBuffer.getChannelData(0).set(input);
          if (cap.recording) {
            cap.chunks.push(Array.from(input));
            cap.blocks.push({ t: e.playbackTime, n: input.length, cbAt: ctx.currentTime });
          }
        };
        origConnect.call(tap, dest);
        taps.set(ctx, tap);
        cap.sampleRate = ctx.sampleRate;
      }
      return origConnect.call(this, tap, ...rest);
    }
    return origConnect.call(this, dest, ...rest);
  };
})();`;

/** Records `ms` of the page's audio output. Returns { samples: Float32Array, sampleRate, health }. */
export async function recordAudio(page, ms = 900) {
  await page.evaluate(() => {
    window.__audioCap.chunks = [];
    window.__audioCap.blocks = [];
    window.__audioCap.recording = true;
  });
  await page.waitForTimeout(ms);
  const { chunks, blocks, sampleRate } = await page.evaluate(() => {
    window.__audioCap.recording = false;
    return { chunks: window.__audioCap.chunks, blocks: window.__audioCap.blocks, sampleRate: window.__audioCap.sampleRate };
  });
  return { samples: Float32Array.from(chunks.flat()), sampleRate, health: captureHealth(blocks, sampleRate) };
}

/**
 * Glitch report for a capture from the tap. A clean capture is gap-free: block k+1 starts exactly where
 * block k ended (playbackTime + n / sampleRate, within one sample). Anything else means the main thread was
 * starved and the captured timeline no longer matches the AudioContext timeline, so sample-index timing
 * measurements on it are meaningless.
 * @returns {{ ok: boolean, blocks: number, capturedSamples: number, expectedSamples: number,
 *             discontinuities: {at: number, deltaSamples: number}[], maxCallbackLagMs: number, reason: string }}
 */
export function captureHealth(blocks, sampleRate) {
  const discontinuities = [];
  let captured = 0;
  let maxLag = 0;
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    captured += b.n;
    maxLag = Math.max(maxLag, b.cbAt - b.t);
    if (k > 0) {
      const want = blocks[k - 1].t + blocks[k - 1].n / sampleRate;
      const deltaSamples = Math.round((b.t - want) * sampleRate);
      if (deltaSamples !== 0) discontinuities.push({ at: b.t, deltaSamples });
    }
  }
  const expected = blocks.length ? Math.round((blocks.at(-1).t - blocks[0].t) * sampleRate) + blocks.at(-1).n : 0;
  const ok = blocks.length > 0 && discontinuities.length === 0 && captured === expected;
  const reason = ok
    ? ""
    : blocks.length === 0
      ? "no audio blocks captured"
      : `captured ${captured} samples, timeline spans ${expected}; ${discontinuities.length} discontinuities ` +
        discontinuities.slice(0, 3).map((d) => `${d.deltaSamples > 0 ? "+" : ""}${d.deltaSamples} samples at ${d.at.toFixed(3)} s`).join(", ");
  return { ok, blocks: blocks.length, capturedSamples: captured, expectedSamples: expected, discontinuities,
    maxCallbackLagMs: maxLag * 1000, reason };
}

/** A timing measurement failed on a glitched capture, twice. See docs/testing.md "Timing tolerance policy". */
export class CaptureGlitch extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "CaptureGlitch";
    this.cause = cause;
  }
}

/** Why a recording is not trustworthy for timing, or "" if it is clean. */
export function glitchReason(rec) {
  const why = [];
  if (rec.health && !rec.health.ok) why.push(rec.health.reason);
  if (rec.lateSteps?.length)
    why.push(`${rec.lateSteps.length} step(s) emitted after their play time (main thread starved), worst ` +
      `${(Math.max(...rec.lateSteps.map((s) => s.at - s.time)) * 1000).toFixed(1)} ms late`);
  return why.join("; ");
}

/**
 * Runs a timing measurement `fn({ track })`. `fn` must open its own page/lab (so it can run twice) and pass
 * every recording it measures through `track(rec)`.
 *   - fn passes                          -> pass (the strict tolerance was met; nothing is retried).
 *   - fn fails, every capture clean       -> fail immediately: a real timing failure, never retried.
 *   - fn fails on a glitched capture      -> logged as a capture glitch and run once more; if the second
 *                                            run also fails on a glitched capture -> CaptureGlitch error.
 * Tolerances are the same in every attempt; this only decides whether a failure is trustworthy.
 */
export async function retryOnCaptureGlitch(testInfo, fn) {
  for (let attempt = 1; ; attempt++) {
    const recs = [];
    try {
      return await fn({ track: (rec) => (recs.push(rec), rec) });
    } catch (e) {
      const why = recs.map(glitchReason).filter(Boolean);
      if (!why.length) throw e;
      const first = String(e.message).split("\n").find((l) => l.trim()) || String(e);
      const msg = `capture glitch (test environment, not a timing result): ${why.join("; ")} | failed on it: ${first}`;
      testInfo.annotations.push({ type: "capture-glitch", description: msg });
      console.log(`[capture glitch] attempt ${attempt}: ${msg}`);
      if (attempt >= 2) throw new CaptureGlitch(`${msg} (twice in a row; rerun on a quieter machine)`, e);
    }
  }
}

export function rms(samples) {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export function writeWav(file, samples, sampleRate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2);
  });
  fs.writeFileSync(file, buf);
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Hann-windowed magnitude spectrum of the last `size` samples. */
export function spectrum(samples, sampleRate, size = 32768) {
  const start = Math.max(0, samples.length - size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size && start + i < samples.length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    re[i] = samples[start + i] * w;
  }
  fft(re, im);
  const mags = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mags[i] = Math.hypot(re[i], im[i]);
  return { mags, binHz: sampleRate / size };
}

/** Local maxima above `minRatio` of the strongest bin, as [{ freq, ratio }], strongest first. */
export function peaks({ mags, binHz }, minRatio = 0.2, maxFreq = 5000) {
  const maxBin = Math.min(mags.length - 2, Math.floor(maxFreq / binHz));
  let top = 0;
  for (let i = 1; i < maxBin; i++) top = Math.max(top, mags[i]);
  const out = [];
  for (let i = 2; i < maxBin; i++) {
    const m = mags[i];
    if (m >= top * minRatio && m > mags[i - 1] && m >= mags[i + 1] && m > mags[i - 2] && m >= mags[i + 2]) {
      // Parabolic interpolation for sub-bin accuracy.
      const a = mags[i - 1], b = m, c = mags[i + 1];
      const p = (0.5 * (a - c)) / (a - 2 * b + c || 1);
      out.push({ freq: (i + p) * binHz, ratio: m / top });
    }
  }
  return out.sort((x, y) => y.ratio - x.ratio);
}

/** Spectral centroid in Hz: a rough "brightness" measure. */
export function centroid({ mags, binHz }) {
  let num = 0, den = 0;
  for (let i = 1; i < mags.length; i++) {
    num += i * binHz * mags[i];
    den += mags[i];
  }
  return num / (den || 1);
}

/** Equal-tempered frequency `semitones` above `base`. */
export const et = (base, semitones) => base * Math.pow(2, semitones / 12);

/** Fails unless the strong spectral peaks are exactly the expected notes (within 1%). */
export function assertNotes(spec, expected, { minRatio = 0.25 } = {}) {
  const found = peaks(spec, minRatio);
  const near = (a, b) => Math.abs(a - b) / b < 0.01;
  const missing = expected.filter((f) => !found.some((p) => near(p.freq, f)));
  const extra = found.filter((p) => !expected.some((f) => near(p.freq, f)));
  const fmt = (fs) => fs.map((f) => (typeof f === "number" ? f : f.freq).toFixed(1)).join(", ");
  if (missing.length || extra.length) {
    throw new Error(
      `Spectrum mismatch.\n  expected: ${fmt(expected)}\n  found:    ${fmt(found)}\n` +
        `  missing:  ${fmt(missing)}\n  extra:    ${fmt(extra)}`
    );
  }
  return found;
}
