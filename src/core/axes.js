// Horizontal reach axes -> sound (lead decision: right hand sideways = Drive, left hand sideways = Space, every mode).
// THE table: change an assignment here (e.g. `param: "arp/swing"`) and the switches, guide rows, help text and
// at-hand indicators follow. HandFrame.x is 0 at the inner end of the hand's horizontal band (near the middle of the
// screen), 0.5 in the neutral dead zone, 1 at the outer end (src/input/reach-zones.js).
//
// Bus: each axis publishes its `param` (continuous 0..1) and `<id>/on` (state, the Controls-panel switch, default on).
// While the menu holds the right hand, right-hand axes hold their value; a lost hand holds its value too (like the
// master volume). Switched off -> the param is 0 (no effect) and the hand is ignored.

/** Neutral in the middle of the band and inward; outward from the dead zone ramps 0 -> 1 at the outer end. */
export const outward = (x) => (typeof x === "number" ? Math.max(0, Math.min(1, (x - 0.5) * 2)) : null);

export const AXES = Object.freeze([
  Object.freeze({
    id: "drive", hand: "right", source: "right/x", param: "drive", label: "Drive", curve: outward,
    guide: "Right hand sideways → Drive", apply: (audio, v) => audio?.setDrive?.(v),
  }),
  Object.freeze({
    id: "space", hand: "left", source: "left/x", param: "space", label: "Space", curve: outward,
    guide: "Left hand sideways → Space", apply: (audio, v) => audio?.setSpace?.(v),
  }),
]);

/** One-pole smoothing of the amount (MediaPipe jitter); the audio params de-zipper on top. */
const TAU_MS = 60;
const q = (v) => Math.round(v * 1000) / 1000;

/**
 * @param {{bus, audio}} o  audio = ctx.audio facade (setDrive / setSpace)
 * @returns {{ update(left, right, {now, rightHeld}): void, setOn(id, on): void, isOn(id): boolean, values: object }}
 */
export function createAxes({ bus, audio, axes = AXES }) {
  const st = {};
  for (const a of axes) {
    bus.declare(a.param, { type: "continuous", owner: "axes" });
    bus.declare(`${a.id}/on`, { type: "state", owner: "ui" });
    if (typeof bus.get(`${a.id}/on`) !== "boolean") bus.set(`${a.id}/on`, true);
    st[a.id] = { value: 0, lastT: null };
    bus.set(a.param, 0);
  }

  function publish(a, v) {
    const s = st[a.id];
    if (s.value === v) return;
    s.value = v;
    a.apply(audio, v);
    bus.set(a.param, v);
  }

  return {
    update(left, right, { now = 0, rightHeld = false } = {}) {
      for (const a of axes) {
        const s = st[a.id];
        if (bus.get(`${a.id}/on`) === false) { s.lastT = null; publish(a, 0); continue; }
        const f = a.hand === "left" ? left : right;
        if (!f || (a.hand === "right" && rightHeld)) { s.lastT = null; continue; } // hold
        const target = a.curve(f.x);
        if (target == null) continue;
        const dt = s.lastT == null ? Infinity : Math.max(0, now - s.lastT);
        s.lastT = now;
        let v = s.value + (target - s.value) * (1 - Math.exp(-dt / TAU_MS));
        if (Math.abs(target - v) < 0.002) v = target;
        publish(a, q(v));
      }
    },
    setOn(id, on) { bus.set(`${id}/on`, !!on); },
    isOn(id) { return bus.get(`${id}/on`) !== false; },
    get values() { return Object.fromEntries(axes.map((a) => [a.param, st[a.id].value])); },
  };
}
