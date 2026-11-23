// Small helpers shared by the instrument plugins (src/instruments/*.js). Not part of the plugin contract.

/** Move an AudioParam to `value` at t: a jump, or an exponential ramp of `ramp` s (holding what was scheduled before). */
export function stepParam(param, value, t, ramp = 0) {
  if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(t);
  else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
  if (ramp > 0) param.exponentialRampToValueAtTime(value, t + ramp);
  else param.setValueAtTime(value, t);
}

/**
 * Wraps a node graph as a Source (see src/instruments/registry.js). `out` = the source's output node;
 * `parts` = { stop, release, excite, setFreq, ... }. Call src._fireEnded() when the last node has ended.
 */
export function wrapSource(id, out, hz, parts) {
  const freqBox = { value: hz };
  let ended = null;
  const src = {
    instrument: id,
    type: id,
    frequency: freqBox,
    connect: (n) => out.connect(n),
    disconnect: () => { try { out.disconnect(); } catch {} },
    set onended(cb) { ended = cb; },
    get onended() { return ended; },
    ...parts,
  };
  src._fireEnded = () => {
    try { out.disconnect(); } catch {}
    if (ended) ended();
  };
  return src;
}

/** Output gain helpers: a short fade at a note's release, back to 1 at a new attack. */
export function fadeOut(gainParam, t, s) {
  stepParam(gainParam, 1, t, 0);
  gainParam.linearRampToValueAtTime(0, t + s);
}
export function fadeIn(gainParam, t) {
  stepParam(gainParam, 1, t, 0);
}

export function biquad(ac, type, f, q = 0.7, gain = 0) {
  const b = ac.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  b.gain.value = gain;
  return b;
}

/** Connects nodes in series -> { input, output }. */
export function series(nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return { input: nodes[0], output: nodes[nodes.length - 1] };
}

const cache = new WeakMap();
/** Per-AudioContext cache: perContext(ac, key, () => make()). */
export function perContext(ac, key, make) {
  let m = cache.get(ac);
  if (!m) cache.set(ac, (m = new Map()));
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
}

/** 2 s of deterministic white noise (looped by breath / bow sources). */
export function noiseBuffer(ac) {
  return perContext(ac, "noise", () => {
    const n = Math.round(ac.sampleRate * 2);
    const b = ac.createBuffer(1, n, ac.sampleRate);
    const d = b.getChannelData(0);
    let s = 987654321;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      d[i] = s / 2147483648 - 1;
    }
    return b;
  });
}
