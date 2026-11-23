// Karplus-Strong plucked string (AudioWorklet processor "ks-string"). One node = one string. Loaded by the Electric
// instrument plugin (./index.js, onReady). No imports: served as-is (vite asset).
//
// Loop: y[n] = exc[n] + rho * LP(x),  x = buf read D - S samples back (linear interpolation, fractional),
//       LP = two-point weighted average (1-S)*x[n] + S*x[n-1] (phase delay S)  => loop delay = D = sampleRate / freq.
// rho from the wanted T60 at the current pitch: rho = 10^(-3 / (T60 * f)). The delay follows the `freq` AudioParam
// sample by sample, so a pitch step is a short glide of the read position (no jump, no click). Excitation:
// low-passed noise with a pick-position comb, one period long, ADDED to whatever is already vibrating (a re-pluck is
// legato-friendly).
//
// Everything is driven by AudioParams (sample-accurate, also in an OfflineAudioContext, where port messages would
// only arrive after the render):
//   freq (a-rate, Hz)   t60 (k-rate, s)   pluck (a-rate: every CHANGE of its value = one pluck, strength = pluckAmp)
//   pluckAmp (a-rate)   alive (k-rate: 0 = stop now)
// processorOptions: { tone (pick brightness 0..1), bright (loop filter weight S), pickPos, persistent (never ends
// when silent; only alive = 0) }. Posts {type: "ended"} when it stops.

class KSString extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "freq", defaultValue: 220, minValue: 10, maxValue: 20000, automationRate: "a-rate" },
      { name: "t60", defaultValue: 3, minValue: 0.005, maxValue: 120, automationRate: "k-rate" },
      { name: "pluck", defaultValue: 0, automationRate: "a-rate" },
      { name: "pluckAmp", defaultValue: 0.5, minValue: 0, maxValue: 4, automationRate: "a-rate" },
      { name: "alive", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.L = Math.ceil(sampleRate / 10) + 8;
    this.buf = new Float32Array(this.L);
    this.w = 0;
    this.S = o.bright ?? 0.4; // weight of the previous sample in the loop filter (0..0.5; more = darker)
    this.pickPos = o.pickPos ?? 0.13;
    this.tone = o.tone ?? 0.5;
    this.persistent = !!o.persistent;
    this.prevX = 0;
    this.lastPluck = 0;
    this.exc = null;
    this.excI = 0;
    this.started = false;
    this.sleeping = true;
    this.quiet = 0;
    this.seed = (o.seed ?? Math.floor(Math.random() * 1e9)) >>> 0;
  }

  rnd() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 2147483648 - 1;
  }

  excitation(D, amp) {
    // The string's shape at the pick: a triangle with its apex at the pick position (strong, reliable fundamental;
    // harmonic k ~ sin(k*pi*pickPos)/k^2), plus low-passed noise for the pick's grit, then the pick-position comb
    // on the noise part only.
    const n = Math.max(2, Math.round(D));
    const a = 0.15 + 0.8 * (1 - this.tone); // one-pole low-pass on the noise: higher = darker pick
    const e = new Float32Array(n);
    let lp = 0;
    for (let i = 0; i < n; i++) e[i] = lp = (1 - a) * this.rnd() + a * lp;
    const m = Math.max(1, Math.round(this.pickPos * n));
    const c = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const tri = i < m ? i / m : (n - i) / (n - m);
      mean += (c[i] = tri + 0.35 * (e[i] - (i >= m ? e[i - m] : 0)));
    }
    mean /= n;
    let peak = 1e-9;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs((c[i] -= mean)));
    const edge = Math.min(8, n >> 2); // short fades at the burst ends: a sharp pick, never a step
    for (let i = 0; i < n; i++) {
      let w = 1;
      if (i < edge) w = i / edge;
      else if (i > n - 1 - edge) w = (n - 1 - i) / edge;
      c[i] = (c[i] / peak) * amp * w;
    }
    return c;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0] && outputs[0][0];
    if (params.alive[0] < 0.5) {
      if (out) out.fill(0);
      this.port.postMessage({ type: "ended" });
      return false;
    }
    if (!out) return true;
    const L = this.L;
    const buf = this.buf;
    const S = this.S;
    const fr = params.freq;
    const pl = params.pluck;
    const pa = params.pluckAmp;
    // Idle (a pooled string): nothing vibrating and no pluck in this block -> silence without running the loop.
    if (this.sleeping) {
      let wake = false;
      for (let i = 0; i < pl.length; i++) if (pl[i] !== this.lastPluck) { wake = true; break; }
      if (!wake) {
        out.fill(0);
        return true;
      }
      this.sleeping = false;
    }
    const t60 = params.t60[0];
    const f0 = fr[0];
    const rho = Math.pow(10, -3 / (Math.max(0.005, t60) * f0));
    let maxAbs = 0;
    for (let i = 0; i < out.length; i++) {
      const f = fr.length > 1 ? fr[i] : f0;
      const D = sampleRate / f;
      const p = pl.length > 1 ? pl[i] : pl[0];
      if (p !== this.lastPluck) {
        this.lastPluck = p;
        this.exc = this.excitation(D, pa.length > 1 ? pa[i] : pa[0]);
        this.excI = 0;
        this.started = true;
        this.quiet = 0;
      }
      let rp = this.w - (D - S);
      while (rp < 0) rp += L;
      const i0 = Math.floor(rp);
      const frac = rp - i0;
      const x = buf[i0 % L] * (1 - frac) + buf[(i0 + 1) % L] * frac;
      const lp = (1 - S) * x + S * this.prevX;
      this.prevX = x;
      let y = rho * lp;
      if (this.exc) {
        y += this.exc[this.excI++];
        if (this.excI >= this.exc.length) this.exc = null;
      }
      buf[this.w] = y;
      this.w = (this.w + 1) % L;
      out[i] = y;
      const a = y < 0 ? -y : y;
      if (a > maxAbs) maxAbs = a;
    }
    if (!this.exc && maxAbs < 1e-6) {
      this.sleeping = true;
      this.buf.fill(0);
      this.prevX = 0;
    }
    if (this.started && !this.persistent && !this.exc) {
      this.quiet = maxAbs < 1e-4 ? this.quiet + out.length : 0;
      if (this.quiet > sampleRate * 0.05) {
        this.port.postMessage({ type: "ended" });
        return false;
      }
    }
    return true;
  }
}

registerProcessor("ks-string", KSString);
