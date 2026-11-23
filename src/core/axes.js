// Horizontal reach axes -> sound (lead decision: right hand sideways = Drive, left hand sideways = Space, every mode).
// THE table: change an assignment here (e.g. `param: "arp/swing"`) and the switches, guide rows, help text and
// at-hand indicators follow. HandFrame.x is 0 at the inner end of the hand's horizontal band (near the middle of the
// screen), 0.5 in the neutral dead zone, 1 at the outer end (src/input/reach-zones.js).
//
// EXPERIMENTAL, OFF by default (user, after real-camera testing: "the side-to-side for space and drive makes things too
// complicated right now. Mark it as an experimental feature and disable it for the moment."). The Controls panel's
// "Experimental" group switches each axis on; nothing is persisted, so every load starts off.
// Bus: each axis has `<id>/on` (state, the switch; false by default, true = on). While on it publishes its `param`
// (continuous 0..1). While the menu holds the right hand, right-hand axes hold their value; a lost hand holds its
// value too (like the master volume). Off -> the audio effect is neutral (Drive bypassed at 0, Space wet 0), the hand
// is ignored and the param is not published (not set at all until first switched on; a single 0 when switched off
// after being on). Hand input does not publish the axis' source (`left|right/x`) while it is off either.

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

/** Bus name of an axis' switch. On only when exactly `true` (default off). */
export const onName = (a) => `${a.id}/on`;
export const isAxisOn = (bus, a) => bus?.get?.(onName(a)) === true;

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
    bus.declare(onName(a), { type: "state", owner: "ui" });
    if (typeof bus.get(onName(a)) !== "boolean") bus.set(onName(a), false);
    st[a.id] = { value: 0, lastT: null, published: false };
  }

  function publish(a, v) {
    const s = st[a.id];
    if (s.value === v && s.published) return;
    if (s.value !== v) a.apply(audio, v);
    s.value = v;
    s.published = true;
    bus.set(a.param, v);
  }
  /** Off: neutral sound; the param goes to 0 once if it was ever published, then nothing more is published. */
  function off(a) {
    const s = st[a.id];
    s.lastT = null;
    if (s.value !== 0) { s.value = 0; a.apply(audio, 0); }
    if (s.published && bus.get(a.param) !== 0) bus.set(a.param, 0);
  }

  return {
    update(left, right, { now = 0, rightHeld = false } = {}) {
      for (const a of axes) {
        const s = st[a.id];
        if (!isAxisOn(bus, a)) { off(a); continue; }
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
    isOn(id) { return bus.get(`${id}/on`) === true; },
    get values() { return Object.fromEntries(axes.map((a) => [a.param, st[a.id].value])); },
  };
}
