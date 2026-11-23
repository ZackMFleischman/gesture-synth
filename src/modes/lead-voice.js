// Lead mode sound: a monophonic lead voice (glide, retrigger, click-free envelope) and the left-hand chord as
// a soft pad. Both feed ctx.audio.out (the pre-master bus: waveshaper -> shared tilt filter -> master volume),
// so the shared filter and master volume apply. src/services/audio.js is NOT modified.
//
// Levels leave headroom for the resonant filter: lead peak 0.2, pad <= ~0.16 total.

// ---- Tunables ----
export const LEAD_PEAK = 0.2;
export const LEAD_SUSTAIN = 0.16;
export const ATTACK_S = 0.01; // linear attack
export const DECAY_TAU = 0.08; // peak -> sustain
export const RELEASE_TAU = 0.03; // ~150 ms to silence
export const RETRIGGER_DIP_S = 0.008; // a new pinch on a sounding voice dips to 0 first (audible onset, no click)
export const GLIDE_S = 0.07; // portamento between notes while pinched
export const LEAD_TONE_HZ = 3200; // fixed lowpass that takes the edge off bright waveforms

export const PAD_LEVEL = 0.03; // per pad note (4 notes, 2 oscillators each)
export const PAD_ATTACK_TAU = 0.12;
export const PAD_RELEASE_TAU = 0.25;
export const PAD_TONE_HZ = 900;

/** Cancel future automation but keep the param where it is right now. */
function hold(param, t) {
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(t);
  } else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}

/**
 * @param {object} audio ctx.audio facade ({ ac, out, synth? })
 * @param {{ bus?: object, voice?: string, padVoice?: string }} [opts]
 */
export function createLeadVoice(audio, { bus = null, voice = "lead", padVoice = "pad" } = {}) {
  let nodes = null; // built lazily once the AudioContext exists
  let soundingFreq = null; // freq of the current lead note (null = released)
  let pad = []; // [{ freq, gain, oscs }]
  let padKey = "";

  function waveform() {
    return (audio.synth && audio.synth.waveform) || "triangle";
  }

  function ensure() {
    const ac = audio.ac;
    const out = audio.out;
    if (!ac || !out) return null;
    if (nodes && nodes.ac === ac) return nodes;
    const osc = ac.createOscillator();
    osc.type = waveform();
    osc.frequency.value = 440;
    const tone = ac.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = LEAD_TONE_HZ;
    tone.Q.value = 0.5;
    const env = ac.createGain();
    env.gain.value = 0;
    osc.connect(tone);
    tone.connect(env);
    env.connect(out);
    osc.start();

    const padTone = ac.createBiquadFilter();
    padTone.type = "lowpass";
    padTone.frequency.value = PAD_TONE_HZ;
    padTone.Q.value = 0.4;
    padTone.connect(out);

    nodes = { ac, osc, tone, env, padTone };
    return nodes;
  }

  function emit(name, freq, t, extra) {
    if (bus && bus.wants(name)) bus.emit(name, { freq, voice, ...extra }, t);
  }

  // ---- Lead ----

  /** Starts (or retriggers) the lead note. */
  function noteOn(freq, extra) {
    const n = ensure();
    if (!n) return;
    const t = n.ac.currentTime;
    const g = n.env.gain;
    hold(g, t);
    let ts = t;
    if (g.value > 0.002) {
      // Still sounding (releasing or a fast re-pinch): dip to silence first so the new note has an onset.
      g.linearRampToValueAtTime(0, t + RETRIGGER_DIP_S);
      ts = t + RETRIGGER_DIP_S;
    }
    const wf = waveform();
    if (n.osc.type !== wf) n.osc.type = wf;
    hold(n.osc.frequency, t);
    n.osc.frequency.setValueAtTime(freq, ts);
    g.linearRampToValueAtTime(LEAD_PEAK, ts + ATTACK_S);
    g.setTargetAtTime(LEAD_SUSTAIN, ts + ATTACK_S, DECAY_TAU);
    if (soundingFreq != null) emit("note/off", soundingFreq, t);
    soundingFreq = freq;
    emit("note/on", freq, ts, extra);
  }

  /** Moves the sounding note to `freq` with a short portamento. */
  function glideTo(freq, extra) {
    const n = ensure();
    if (!n || soundingFreq == null) return;
    const t = n.ac.currentTime;
    hold(n.osc.frequency, t);
    n.osc.frequency.exponentialRampToValueAtTime(freq, t + GLIDE_S);
    emit("note/off", soundingFreq, t);
    soundingFreq = freq;
    emit("note/on", freq, t, { glide: true, ...extra });
  }

  function noteOff() {
    const n = nodes;
    if (!n || soundingFreq == null) return;
    const t = n.ac.currentTime;
    hold(n.env.gain, t);
    n.env.gain.setTargetAtTime(0, t, RELEASE_TAU);
    emit("note/off", soundingFreq, t);
    soundingFreq = null;
  }

  // ---- Pad ----

  function releasePadVoice(v, t) {
    hold(v.gain.gain, t);
    v.gain.gain.setTargetAtTime(0, t, PAD_RELEASE_TAU);
    for (const o of v.oscs) o.stop(t + PAD_RELEASE_TAU * 8);
    v.oscs[0].onended = () => {
      try { v.gain.disconnect(); } catch {}
    };
    emit("note/off", v.freq, t, { voice: padVoice });
  }

  /** Holds `freqs` as the pad chord (crossfades from the previous one). null/[] = pad off. */
  function setPad(freqs) {
    const key = freqs && freqs.length ? freqs.map((f) => f.toFixed(2)).join(",") : "";
    if (key === padKey) return;
    const n = ensure();
    if (!n) return;
    padKey = key;
    const t = n.ac.currentTime;
    for (const v of pad) releasePadVoice(v, t);
    pad = [];
    if (!key) return;
    for (const freq of freqs) {
      const gain = n.ac.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(PAD_LEVEL, t, PAD_ATTACK_TAU);
      const a = n.ac.createOscillator();
      a.type = "triangle";
      a.frequency.value = freq;
      const b = n.ac.createOscillator();
      b.type = "sine";
      b.frequency.value = freq;
      b.detune.value = 6;
      const bGain = n.ac.createGain();
      bGain.gain.value = 0.6;
      a.connect(gain);
      b.connect(bGain);
      bGain.connect(gain);
      gain.connect(n.padTone);
      a.start(t);
      b.start(t);
      pad.push({ freq, gain, oscs: [a, b] });
      emit("note/on", freq, t, { voice: padVoice });
    }
  }

  /** Releases everything and frees the nodes shortly after (mode exit). */
  function stop() {
    noteOff();
    setPad(null);
    const n = nodes;
    if (!n) return;
    nodes = null;
    const t = n.ac.currentTime;
    n.osc.stop(t + 0.5);
    n.osc.onended = () => {
      try { n.env.disconnect(); n.padTone.disconnect(); } catch {}
    };
  }

  return {
    noteOn,
    glideTo,
    noteOff,
    setPad,
    stop,
    get sounding() { return soundingFreq; },
    get padFreqs() { return pad.map((v) => v.freq); },
    /** Live nodes (tests / debugging). */
    get nodes() { return nodes; },
  };
}
