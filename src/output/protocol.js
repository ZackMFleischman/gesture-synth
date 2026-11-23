// Wire protocol shared by the synth output (webrtc-output.js) and visualizers (viewer-client.js).
// Pure: no DOM, no WebRTC — safe to import anywhere (and from Node tests).
//
// Every message is one JSON object: { a: address, v: value, t?: sharedClockMs, ... }
//   reliable channel ("gs-reliable", ordered): manifest, state snapshot, state changes, events,
//                                              beat grid
//   fast channel ("gs-fast", unordered, maxRetransmits 0): one frame of continuous values per
//                                              message, clock-sync pings
// Shared clock = the SYNTH's clock in epoch ms (performance.timeOrigin + performance.now()).
// Visualizers measure their offset to it with pings and convert: localMs = t - offset.

export const CHANNELS = {
  reliable: { label: "gs-reliable", init: { ordered: true } },
  fast: { label: "gs-fast", init: { ordered: false, maxRetransmits: 0 } },
};
/** Short channel ids used by the WebSocket relay ({t:"relay", ch}). */
export const CH = { reliable: "r", fast: "f" };

// System addresses (not bus signals).
export const SYS = {
  manifest: "/gs/sys/manifest", //  v: [{name, address, type, owner}]
  state: "/gs/sys/state", //        v: { state: {address: value}, continuous: {address: value} } — full snapshot
  frame: "/gs/sys/frame", //        v: {address: value} — all continuous values that changed this frame; n: seq
  beatgrid: "/gs/sys/beatgrid", //  v: { bpm, beatTime (shared ms of a beat), beat (index in bar), beatsPerBar }
  ping: "/gs/sys/ping", //          c: sender clock ms, id
  pong: "/gs/sys/pong", //          c: echoed, h: responder clock ms, id
  hello: "/gs/sys/hello", //        v: { app, version } (synth -> visualizer, first message)
};

export const STATE_RESEND_MS = 2000;
export const PROTOCOL_VERSION = 1;

/**
 * THE mapping from bus names to wire addresses (spec "Output to a remote visualizer" tables).
 * `encode` turns the bus value into the wire value. Names not listed map to `/gs/<name>`
 * with the value passed through, so new signals reach visualizers with no transport change.
 */
const vec2 = (p) => (p ? [round4(p.x), round4(p.y)] : null);
const num = (x) => (typeof x === "number" ? round4(x) : x);
export const ADDRESS_TABLE = {
  // continuous (each video frame)
  "left/pos": { address: "/gs/left/pos", encode: vec2 },
  "right/pos": { address: "/gs/right/pos", encode: vec2 },
  "left/height": { address: "/gs/left/height", encode: num },
  "right/height": { address: "/gs/right/height", encode: num },
  "left/tilt": { address: "/gs/left/tilt", encode: num },
  "right/tilt": { address: "/gs/right/tilt", encode: num },
  volume: { address: "/gs/volume", encode: num },
  filter: { address: "/gs/filter", encode: num },
  "arp/gate": { address: "/gs/gate", encode: num },
  // state (on change + every 2 s)
  mode: { address: "/gs/mode" },
  chord: { address: "/gs/chord", encode: encodeChord },
  voicing: { address: "/gs/voicing" },
  "lead/noteset": { address: "/gs/noteset" },
  "lead/octave": { address: "/gs/octave" },
  bpm: { address: "/gs/bpm" },
  // events (once, with the play time)
  "note/on": { address: "/gs/note/on", encode: encodeNote },
  "note/off": { address: "/gs/note/off", encode: encodeNote },
  beat: { address: "/gs/beat" },
  pinch: { address: "/gs/pinch" },
  menu: { address: "/gs/menu" },
};

export function addressOf(name) {
  const e = ADDRESS_TABLE[name];
  return e ? e.address : `/gs/${name}`;
}

export function encodeValue(name, value) {
  const e = ADDRESS_TABLE[name];
  if (e && e.encode) return e.encode(value);
  if (value && typeof value === "object" && "x" in value && "y" in value && Object.keys(value).length === 2) return vec2(value);
  return value;
}

/** Chord: degree (1–7), major/minor, root as MIDI note (+ display name). */
export function encodeChord(c) {
  if (!c) return null;
  return { degree: c.degree, major: !!c.isMajor, root: c.rootMidi, name: c.name, roman: c.roman };
}

export function freqToMidi(f) {
  return Math.round(69 + 12 * Math.log2(f / 440));
}

/** Note: MIDI note + voice (chords | arp | lead | ...). */
export function encodeNote(d) {
  if (!d) return d;
  const out = { voice: d.voice ?? "default" };
  if (typeof d.midi === "number") out.note = d.midi;
  else if (typeof d.freq === "number") out.note = freqToMidi(d.freq);
  if (typeof d.freq === "number") out.freq = Math.round(d.freq * 100) / 100;
  if (typeof d.velocity === "number") out.velocity = d.velocity;
  return out;
}

function round4(x) {
  return typeof x === "number" ? Math.round(x * 10000) / 10000 : x;
}

/** This machine's clock in epoch ms (high resolution, monotonic within a page). */
export function clockNow() {
  return performance.timeOrigin + performance.now();
}

/**
 * NTP-style clock sync from ping/pong samples. Keeps the last `window` samples and uses the
 * one with the lowest RTT (least queuing noise).
 *   offset = remoteClock - localClock  (so remote -> local: t - offset)
 */
export function createClockSync({ window = 8 } = {}) {
  const samples = [];
  let best = null;
  return {
    /** sent = local ms when the ping left, remote = responder's clock in the pong, recv = local ms now. */
    add(sent, remote, recv) {
      const rtt = Math.max(0, recv - sent);
      const offset = remote - (sent + recv) / 2;
      samples.push({ rtt, offset, at: recv });
      if (samples.length > window) samples.shift();
      best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      return { rtt, offset };
    },
    get rtt() { return best ? best.rtt : null; },
    /** Latest sample's RTT (for display). */
    get lastRtt() { return samples.length ? samples[samples.length - 1].rtt : null; },
    get offset() { return best ? best.offset : 0; },
    get synced() { return samples.length > 0; },
    get count() { return samples.length; },
    reset() { samples.length = 0; best = null; },
  };
}

/** Room code format: 4 + 2 chars from an unambiguous alphabet, e.g. "K7QF-2M". */
export const ROOM_CODE_RE = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{2}$/;
export function normalizeRoomCode(s) {
  const raw = String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return raw.length === 6 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : String(s || "").toUpperCase().trim();
}

/** Default signaling URL: ?signal=ws://... overrides, else VITE_SIGNAL_URL, else same host :5417. */
export function defaultSignalUrl(loc = globalThis.location, env = {}) {
  try {
    const q = new URLSearchParams(loc.search).get("signal");
    if (q) return q;
  } catch {}
  if (env.VITE_SIGNAL_URL) return env.VITE_SIGNAL_URL;
  const proto = loc && loc.protocol === "https:" ? "wss:" : "ws:";
  const host = (loc && loc.hostname) || "localhost";
  return `${proto}//${host}:5417`;
}
