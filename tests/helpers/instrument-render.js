// Offline renders of the real engine + voices with instrument plugins (browser page; tests/instruments.e2e.spec.js).
// Tapped at the limiter INPUT (masterGain output at master 1): the gain-staging measuring point.
//
// renderVoice(page, {
//   inst, voice: "chords"|"arp"|"lead"|"source"|"ks-clean", freqs, dur (s), tilt?, drive?,
//   events?: [{t, do: "chord"|"inst"|"noteOn"|"stepTo"|"noteOff", f?, freqs?, id?}],   // at time t (render quantum)
//   arpStep?, gate?, windows?: [[t0, t1], ...], keep?: true
// }) -> { sampleRate, windows: [{rms, peak}], samples? }
//   chords: playNotes(freqs) at 0;  arp: notes every arpStep cycling freqs;  lead: noteOn(freqs[0]) at 0;
//   source: the instrument alone (its source + post chain, no voice envelope / filters) at freqs[0], voice "lead";
//   ks-clean: the same Karplus-Strong string with NO amp, through Electric's post chain (its clean reference).

export async function renderVoice(page, opts) {
  return page.evaluate(async (o) => {
    const { SynthEngine, createAudioFacade } = await import("/src/services/audio.js");
    const { CHORDS_LEVEL } = await import("/src/modes/chords.js");
    const { createBus } = await import("/src/core/bus.js");
    const { prepareInstrument, createSource, createPost } = await import("/src/instruments/index.js");
    const { STRING_OPTIONS } = await import("/src/instruments/electric/index.js");
    const { createArpVoice } = await import("/src/modes/arp-voice.js");
    const { createLeadVoice } = await import("/src/modes/lead-voice.js");
    const sr = 48000;
    const WARM = 0.2; // see below: everything starts WARM s into the render, which is cut off the result
    const TAIL = 0.4; // room for a late-running suspend (see start())
    const dur = (o.dur ?? 1.6) + WARM + TAIL;
    const off = new OfflineAudioContext(1, Math.round(sr * dur), sr);
    const Orig = window.AudioContext;
    window.AudioContext = function () { return off; };
    const s = new SynthEngine({ bus: createBus() });
    try { s.ensureContext(); } finally { window.AudioContext = Orig; }
    await prepareInstrument(off, o.inst);
    for (const e of o.events || []) if (e.do === "inst") await prepareInstrument(off, e.id);
    s.setMasterVolume(1);
    s.updateFilterSweep(o.tilt ?? 0);
    s.updateFilterSweep(o.tilt ?? 0, s.layerFilter);
    if (o.drive) s.setDrive(o.drive);
    s.masterGain.disconnect();
    s.masterGain.connect(off.destination); // the limiter's input
    const audio = createAudioFacade(s);
    let lead = null;
    const act = {
      chord: (e) => s.playNotes(e.freqs),
      inst: (e) => s.setInstrument(o.voice === "lead" ? "lead" : "base", e.id),
      noteOn: (e) => lead.noteOn(e.f),
      stepTo: (e) => lead.stepTo(e.f),
      noteOff: () => lead.noteOff(),
    };
    // The voice starts at a suspend at WARM s (pooled worklet strings get their processors meanwhile). Chrome runs
    // offline suspend callbacks with the graph already rendered ahead (observed: 8192 frames), so whatever is
    // scheduled "now" sounds later than currentTime says; every action shares the same lag. The result starts at
    // the voice's first sound (every render starts with a note), so t = 0 = the voice's start.
    const start = () => {
      if (o.voice === "chords") {
        if (o.freqs) s.playNotes(o.freqs);
      } else if (o.voice === "arp") {
        const v = createArpVoice(off, s.inBus, { instrument: o.inst });
        const step = o.arpStep ?? 0.125;
        let i = 0;
        for (let t = 0.02; t < (o.dur ?? 1.6) - 0.3; t += step, i++) {
          const seq = o.arpSeq ? o.arpSeq.find((x) => t >= x[0] && t < x[1]) : null;
          const fs = seq ? seq[2] : o.freqs;
          v.play(fs[i % fs.length], off.currentTime + t, step * (o.gate ?? 0.8));
        }
      } else if (o.voice === "lead") {
        if (o.freqs) lead.noteOn(o.freqs[0]);
      } else if (o.voice === "ks-clean") {
        ksClean.parameters.get("pluck").setValueAtTime(1, off.currentTime);
      } else if (o.voice === "source") {
        const src = createSource(off, o.inst, o.freqs[0], off.currentTime, { voice: "lead" });
        const post = createPost(off, o.inst);
        post.output.connect(off.destination);
        src.connect(post.input);
      }
    };
    let ksClean = null;
    if (o.voice === "chords") {
      s.setInstrument("base", o.inst);
      s.chordGain.gain.value = CHORDS_LEVEL;
    } else if (o.voice === "arp") {
      s.setInstrument("base", o.inst);
    } else if (o.voice === "lead") {
      s.setInstrument("lead", o.inst);
      lead = createLeadVoice(audio);
      lead.setPad(null);
    } else if (o.voice === "ks-clean") {
      const node = new AudioWorkletNode(off, "ks-string", {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { ...STRING_OPTIONS, seed: 1000 }, // = the pool's first string: same pick, no amp
      });
      node.parameters.get("freq").value = o.freqs[0];
      node.parameters.get("t60").value = o.t60 ?? 8;
      node.parameters.get("pluckAmp").value = 0.5;
      ksClean = node;
      const post = createPost(off, o.inst);
      post.output.connect(off.destination);
      node.connect(post.input);
    }
    // events at render-quantum times (offline suspend granularity)
    const q = 128 / sr;
    const byT = new Map([[Math.round(WARM / q) * q, [{ do: "start" }]]]);
    act.start = start;
    for (const e of o.events || []) {
      const t = Math.round((e.t + WARM) / q) * q + (e.t <= 0 ? q : 0);
      if (!byT.has(t)) byT.set(t, []);
      byT.get(t).push(e);
    }
    for (const [t, evs] of byT) {
      off.suspend(t).then(async () => {
        for (const e of evs) act[e.do](e);
        // new AudioWorklet nodes get their processor asynchronously: give it a moment while the render is paused
        await new Promise((r) => setTimeout(r, 30));
        off.resume();
      });
    }
    const rendered = await off.startRendering();
    const all = rendered.getChannelData(0);
    let i0 = Math.round(WARM * sr);
    while (i0 < all.length && Math.abs(all[i0]) < 1e-6) i0++;
    if (i0 >= all.length) i0 = Math.round(WARM * sr);
    const d = all.subarray(i0);
    const wins = (o.windows || [[0.3, dur]]).map(([a, b]) => {
      const from = Math.round(a * sr);
      const to = Math.min(d.length, Math.round(b * sr));
      let pk = 0;
      let ss = 0;
      for (let i = from; i < to; i++) {
        pk = Math.max(pk, Math.abs(d[i]));
        ss += d[i] * d[i];
      }
      return { rms: Math.sqrt(ss / Math.max(1, to - from)), peak: pk };
    });
    let samples = null;
    if (o.keep) {
      // base64 Float32 (fast transfer)
      const u8 = new Uint8Array(d.slice().buffer);
      let b = "";
      for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      samples = btoa(b);
    }
    return { sampleRate: sr, windows: wins, samples };
  }, opts);
}

/** Decodes `samples` of a renderVoice({keep: true}) result to a Float32Array (Node). */
export function decodeSamples(r) {
  const buf = Buffer.from(r.samples, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Frequency (Hz) of the strongest component within ±rangeCents of f: Hann-windowed DFT on a 0.5-cent grid. */
export function finePeak(x, sr, f, { rangeCents = 60, stepCents = 0.5 } = {}) {
  const n = x.length;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  let best = { f, mag: -1 };
  for (let c = -rangeCents; c <= rangeCents; c += stepCents) {
    const fc = f * Math.pow(2, c / 1200);
    const m = dftMag(w, sr, fc);
    if (m > best.mag) best = { f: fc, mag: m };
  }
  return best;
}

/** |DFT| at one frequency (already windowed signal), normalized by length. */
export function dftMag(w, sr, f) {
  const k = (2 * Math.PI * f) / sr;
  let re = 0;
  let im = 0;
  const c = Math.cos(k);
  const s = Math.sin(k);
  let cr = 1;
  let ci = 0;
  for (let i = 0; i < w.length; i++) {
    re += w[i] * cr;
    im -= w[i] * ci;
    const nr = cr * c - ci * s;
    ci = cr * s + ci * c;
    cr = nr;
  }
  return Math.hypot(re, im) / w.length;
}

export function hann(x) {
  const n = x.length;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export const cents = (a, b) => 1200 * Math.log2(a / b);
export const dB = (x) => 20 * Math.log10(Math.max(1e-12, x));
