import fs from "node:fs";
import path from "node:path";

// Injected before page scripts run. Every node connected to an AudioContext's
// destination is routed through a pass-through ScriptProcessor that can record
// the final mixed output, so tests analyse exactly what the speakers would get.
export const AUDIO_TAP_SCRIPT = `(() => {
  const cap = (window.__audioCap = { recording: false, sampleRate: 0, chunks: [] });
  const origConnect = AudioNode.prototype.connect;
  const taps = new WeakMap();
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const ctx = this.context;
      let tap = taps.get(ctx);
      if (!tap) {
        tap = ctx.createScriptProcessor(4096, 1, 1);
        tap.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          e.outputBuffer.getChannelData(0).set(input);
          if (cap.recording) cap.chunks.push(Array.from(input));
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

/** Records `ms` of the page's audio output. Returns { samples: Float32Array, sampleRate }. */
export async function recordAudio(page, ms = 900) {
  await page.evaluate(() => {
    window.__audioCap.chunks = [];
    window.__audioCap.recording = true;
  });
  await page.waitForTimeout(ms);
  const { chunks, sampleRate } = await page.evaluate(() => {
    window.__audioCap.recording = false;
    return { chunks: window.__audioCap.chunks, sampleRate: window.__audioCap.sampleRate };
  });
  return { samples: Float32Array.from(chunks.flat()), sampleRate };
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
