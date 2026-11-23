// Karplus-Strong plucked string (AudioWorklet processor "ks-string"). One node = one string.
// Loaded by src/services/instruments.js (ensureInstrumentWorklet). No imports: served as-is (vite asset).
//
// Loop: y[n] = exc[n] + rho * LP(x),  x = buf read D - S samples back (linear interpolation, fractional),
//       LP = two-point weighted average (1-S)*x[n] + S*x[n-1] (phase delay S)  => loop delay = D = sampleRate / f.
// rho from the wanted T60 at f: rho = 10^(-3 / (T60 * f)). The delay glides (pitch steps without a jump in the read
// position, so no click). Excitation: low-passed noise with a pick-position comb, one period long, ADDED to whatever
// is already vibrating (a re-pluck is legato-friendly).
//
// Messages (port): {type: "pluck", time, freq?, amp?, tone?}  {type: "freq", time, freq, ramp}
//                  {type: "damp", time, t60}  {type: "t60", time, t60}  {type: "end", time}
// Constructor processorOptions: {freq, t60, amp, tone, bright, pickPos, start, persistent} (start = time of the first
// pluck, none if null; persistent = never ends when silent, only on "end": the Lead's mono string).
// Posts {type: "ended"} when it stops (end message, or silent after it started).

class KSString extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.L = Math.ceil(sampleRate / 15) + 8;
    this.buf = new Float32Array(this.L);
    this.w = 0;
    this.S = o.bright ?? 0.4; // weight of the previous sample in the loop filter (0..0.5; more = darker)
    this.pickPos = o.pickPos ?? 0.13;
    this.tone = o.tone ?? 0.5; // excitation brightness 0..1
    this.amp = o.amp ?? 0.5;
    this.D = sampleRate / (o.freq || 220);
    this.dStep = 0;
    this.dLeft = 0;
    this.t60 = o.t60 ?? 3;
    this.rho = this.rhoFor(this.t60);
    this.prevX = 0;
    this.exc = null;
    this.excI = 0;
    this.started = false;
    this.quiet = 0;
    this.done = false;
    this.persistent = !!o.persistent; // a mono voice's string: never ends by itself (only on "end")
    this.events = [];
    this.seed = (o.seed ?? Math.floor(Math.random() * 1e9)) >>> 0;
    if (o.start != null) this.events.push({ type: "pluck", time: o.start, amp: this.amp });
    this.port.onmessage = (e) => {
      const ev = e.data;
      if (!ev || !ev.type) return;
      this.events.push(ev);
      this.events.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    };
  }

  rhoFor(t60) {
    const f = sampleRate / this.D;
    return Math.pow(10, -3 / (Math.max(0.01, t60) * f));
  }

  rnd() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 2147483648 - 1;
  }

  pluck(ev) {
    if (ev.freq) {
      this.D = sampleRate / ev.freq;
      this.dLeft = 0;
    }
    this.rho = this.rhoFor(this.t60);
    const n = Math.max(2, Math.round(this.D));
    const e = new Float32Array(n);
    const tone = ev.tone ?? this.tone;
    const a = 0.15 + 0.8 * (1 - tone); // one-pole low-pass on the noise: higher = darker pick
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp = (1 - a) * this.rnd() + a * lp;
      e[i] = lp;
    }
    // pick position: comb (string plucked at pickPos of its length)
    const m = Math.max(1, Math.round(this.pickPos * n));
    const c = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      c[i] = e[i] - (i >= m ? e[i - m] : 0);
      mean += c[i];
    }
    mean /= n;
    let peak = 1e-9;
    for (let i = 0; i < n; i++) {
      c[i] -= mean; // no DC into the loop
      peak = Math.max(peak, Math.abs(c[i]));
    }
    const amp = ev.amp ?? this.amp;
    // short fade-in/out at the ends of the burst: the pick attack stays sharp, but never a step
    const edge = Math.min(8, n >> 2);
    for (let i = 0; i < n; i++) {
      let w = 1;
      if (i < edge) w = i / edge;
      else if (i > n - 1 - edge) w = (n - 1 - i) / edge;
      c[i] = (c[i] / peak) * amp * w;
    }
    this.exc = c;
    this.excI = 0;
    this.started = true;
    this.quiet = 0;
  }

  apply(ev) {
    switch (ev.type) {
      case "pluck":
        this.pluck(ev);
        break;
      case "freq": {
        const target = sampleRate / ev.freq;
        const n = Math.max(1, Math.round((ev.ramp ?? 0.003) * sampleRate));
        this.dStep = (target - this.D) / n;
        this.dLeft = n;
        break;
      }
      case "damp":
      case "t60":
        this.t60 = ev.t60;
        this.rho = this.rhoFor(this.t60);
        break;
      case "end":
        this.done = true;
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return !this.done;
    const L = this.L;
    const buf = this.buf;
    const S = this.S;
    let t = currentTime;
    const dt = 1 / sampleRate;
    let maxAbs = 0;
    for (let i = 0; i < out.length; i++, t += dt) {
      while (this.events.length && (this.events[0].time ?? 0) <= t + dt * 0.5) this.apply(this.events.shift());
      if (this.done) {
        for (let k = i; k < out.length; k++) out[k] = 0;
        this.port.postMessage({ type: "ended" });
        return false;
      }
      if (this.dLeft > 0) {
        this.D += this.dStep;
        this.dLeft--;
        if (this.dLeft === 0) this.rho = this.rhoFor(this.t60);
      }
      // fractional read D - S samples back
      const back = this.D - S;
      let rp = this.w - back;
      while (rp < 0) rp += L;
      const i0 = Math.floor(rp);
      const fr = rp - i0;
      const x = buf[i0 % L] * (1 - fr) + buf[(i0 + 1) % L] * fr;
      const lp = (1 - S) * x + S * this.prevX;
      this.prevX = x;
      let y = this.rho * lp;
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
    if (this.started && !this.persistent && !this.exc && this.events.length === 0) {
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
