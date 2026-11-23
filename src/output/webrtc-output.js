// WebRTC output to a remote visualizer (milestone 3). Spec: "Output to a remote visualizer",
// "Latency requirements", "Connection status". Wire format: ./protocol.js.
//
// LAZY: this module is only ever loaded by a dynamic import() when the user turns the output on
// (see status-chip.js). With the output off nothing here exists: no bus subscription, no timers,
// no message building.
//
// The output is ONE consumer of the signal bus. It subscribes when the first visualizer is ready
// and unsubscribes when the last one goes away:
//   - on connect: hello, manifest (bus.manifest()), full state snapshot, beat grid (if a clock exists)
//   - state + events -> reliable channel (events carry playTime on the shared clock)
//   - continuous values -> fast channel, all values of one frame batched in one message
//   - full state again every 2 s
//   - ping each peer every second (RTT for the chip; the visualizer pings us for its offset)
// Transport per visualizer: direct WebRTC data channels, or the WebSocket relay of the signaling
// server when a direct connection can't be made (or `forceRelay`). The music never depends on this.

import {
  CHANNELS, CH, SYS, STATE_RESEND_MS, PROTOCOL_VERSION,
  addressOf, encodeValue, clockNow, createClockSync,
} from "./protocol.js";

const DIRECT_TIMEOUT_MS = 5000; // no open data channels by then -> relay
const PING_MS = 1000;
const PEER_TIMEOUT_MS = 6000; // no pong for this long -> peer is gone
const FAST_BUFFER_LIMIT = 64 * 1024; // skip a frame rather than queue stale values
const RECONNECT_MS = [300, 1000, 2000, 5000];
const ROOM_STORAGE_KEY = "gs.output.room";

/**
 * @param {{
 *   bus: ReturnType<import("../core/bus.js").createBus>,
 *   signalUrl: string,
 *   getAudioContext?: () => AudioContext|null,   // for playTime -> shared clock
 *   getClock?: () => ({bpm:number, nextBeatTime?:()=>number, beatAt?:(t:number)=>number, beatsPerBar?:number}|null),
 *   forceRelay?: boolean,                         // test switch: never try direct
 *   room?: string,                                // preferred room code (else the last one used)
 *   onStatus?: (status) => void,
 *   directTimeoutMs?: number,
 * }} opts
 */
export function createWebRtcOutput({
  bus,
  signalUrl,
  getAudioContext = () => null,
  getClock = () => null,
  forceRelay = false,
  room: preferredRoom = null,
  onStatus = () => {},
  directTimeoutMs = DIRECT_TIMEOUT_MS,
}) {
  let ws = null;
  let stopped = true;
  let reconnectTry = 0;
  let reconnectTimer = null;
  let room = preferredRoom || loadRoom();
  let iceServers = [];
  /** @type {Map<string, Peer>} */
  const peers = new Map();

  // Bus-consumer state (exists only while attached).
  let unsubscribe = null;
  let types = new Map(); // bus name -> type
  let frame = null; // pending continuous values of this frame
  let frameScheduled = false;
  let frameSeq = 0;
  let stateTimer = null;
  let pingTimer = null;
  let pingSeq = 0;
  const counters = { frames: 0, state: 0, events: 0, snapshots: 0, bytes: 0 };

  // ---------------------------------------------------------------- status
  let lastStatusKey = "";
  function status() {
    let best = null;
    for (const p of peers.values()) {
      if (!p.ready) continue;
      if (!best || (p.mode === "direct" && best.mode !== "direct") ||
          (p.mode === best.mode && (p.clock.rtt ?? 1e9) < (best.clock.rtt ?? 1e9))) best = p;
    }
    const state = best ? (best.mode === "direct" ? "connected" : "relayed") : room ? "waiting" : "connecting";
    return {
      state,
      room,
      rttMs: best ? best.clock.rtt : null,
      peers: [...peers.values()].filter((p) => p.ready).length,
      signaling: !!ws && ws.readyState === 1,
      forceRelay,
    };
  }
  function emitStatus(force = false) {
    const s = status();
    const key = `${s.state}|${s.room}|${s.rttMs}|${s.peers}|${s.signaling}`;
    if (!force && key === lastStatusKey) return;
    lastStatusKey = key;
    try { onStatus(s); } catch (e) { console.error(e); }
  }

  // ---------------------------------------------------------------- signaling
  function wsSend(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connectSignaling() {
    clearTimeout(reconnectTimer);
    let sock;
    try {
      sock = new WebSocket(signalUrl);
    } catch (e) {
      console.warn("[output] bad signaling URL", signalUrl, e);
      return scheduleReconnect();
    }
    ws = sock;
    sock.onopen = () => {
      reconnectTry = 0;
      wsSend({ t: "host", room });
      emitStatus();
    };
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onSignal(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      // Relayed peers depend on the socket; direct peers keep playing.
      for (const p of [...peers.values()]) if (p.mode !== "direct") dropPeer(p.id);
      emitStatus();
      if (!stopped) scheduleReconnect();
    };
    sock.onerror = () => {};
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const ms = RECONNECT_MS[Math.min(reconnectTry++, RECONNECT_MS.length - 1)];
    reconnectTimer = setTimeout(() => !stopped && connectSignaling(), ms);
  }

  function onSignal(m) {
    switch (m.t) {
      case "hosted":
        room = m.room;
        iceServers = Array.isArray(m.iceServers) ? m.iceServers : [];
        saveRoom(room);
        emitStatus();
        break;
      case "peer-joined":
        dropPeer(m.id);
        createPeer(m.id);
        break;
      case "peer-left":
        dropPeer(m.id);
        break;
      case "signal": {
        const p = peers.get(m.from);
        if (p) onPeerSignal(p, m.data || {});
        break;
      }
      case "relay": {
        const p = peers.get(m.from);
        if (p && p.mode === "relay") onPeerData(p, m.d);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- peers
  /** @typedef {{id:string, mode:"pending"|"direct"|"relay", pc:RTCPeerConnection|null, rel:RTCDataChannel|null,
   *   fast:RTCDataChannel|null, ready:boolean, clock:ReturnType<typeof createClockSync>, lastPong:number,
   *   readyAt:number, timer:any, chain:Promise<void>}} Peer */

  function createPeer(id) {
    /** @type {Peer} */
    const p = {
      id, mode: "pending", pc: null, rel: null, fast: null, ready: false,
      clock: createClockSync(), lastPong: 0, readyAt: 0, timer: null, chain: Promise.resolve(),
    };
    peers.set(id, p);
    if (forceRelay || typeof RTCPeerConnection === "undefined") {
      goRelay(p);
      return;
    }
    const pc = new RTCPeerConnection({ iceServers });
    p.pc = pc;
    p.rel = pc.createDataChannel(CHANNELS.reliable.label, CHANNELS.reliable.init);
    p.fast = pc.createDataChannel(CHANNELS.fast.label, CHANNELS.fast.init);
    for (const [ch, dc] of [[CH.reliable, p.rel], [CH.fast, p.fast]]) {
      dc.onopen = () => {
        if (p.rel.readyState === "open" && p.fast.readyState === "open" && p.mode === "pending") markReady(p, "direct");
      };
      dc.onclose = () => {
        if (peers.get(id) === p && p.mode === "direct") lostDirect(p);
      };
      dc.onmessage = (e) => onPeerData(p, e.data, ch);
    }
    pc.onicecandidate = (e) => {
      wsSend({ t: "signal", to: id, data: { type: "candidate", candidate: e.candidate ? e.candidate.toJSON() : null } });
    };
    pc.onconnectionstatechange = () => {
      if (peers.get(id) !== p) return;
      if (pc.connectionState === "failed") {
        if (p.mode === "pending") goRelay(p);
        else if (p.mode === "direct") lostDirect(p);
      }
    };
    p.timer = setTimeout(() => {
      if (peers.get(id) === p && p.mode === "pending") goRelay(p);
    }, directTimeoutMs);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => wsSend({ t: "signal", to: id, data: { type: "offer", sdp: pc.localDescription.sdp } }))
      .catch((err) => {
        console.warn("[output] offer failed, using relay", err);
        if (peers.get(id) === p && p.mode === "pending") goRelay(p);
      });
  }

  function onPeerSignal(p, data) {
    // Serialized per peer: candidates must not be added before the answer is applied.
    p.chain = p.chain.then(async () => {
      if (!p.pc) return;
      if (data.type === "answer") await p.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      else if (data.type === "candidate" && data.candidate) await p.pc.addIceCandidate(data.candidate).catch(() => {});
    }).catch((e) => console.warn("[output] signal", e));
  }

  function closePc(p) {
    clearTimeout(p.timer);
    if (p.pc) {
      for (const dc of [p.rel, p.fast]) if (dc) { dc.onopen = dc.onclose = dc.onmessage = null; }
      p.pc.onicecandidate = p.pc.onconnectionstatechange = null;
      try { p.pc.close(); } catch {}
    }
    p.pc = p.rel = p.fast = null;
  }

  function goRelay(p) {
    closePc(p);
    if (!ws || ws.readyState !== 1) return dropPeer(p.id);
    p.mode = "relay";
    wsSend({ t: "signal", to: p.id, data: { type: "relay" } });
    markReady(p, "relay");
  }

  function lostDirect(p) {
    // The direct path broke. If the visualizer left, "peer-left" arrives from the signaling
    // server right away; otherwise it is still in the room, so fall back to the relay.
    closePc(p);
    p.ready = false;
    p.mode = "pending";
    if (![...peers.values()].some((q) => q.ready)) detach();
    emitStatus();
    if (!ws || ws.readyState !== 1) return dropPeer(p.id);
    p.timer = setTimeout(() => {
      if (peers.get(p.id) === p && !p.ready) goRelay(p);
    }, 1500);
  }

  function dropPeer(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    closePc(p);
    p.ready = false;
    if (![...peers.values()].some((q) => q.ready)) detach();
    emitStatus();
  }

  function markReady(p, mode) {
    clearTimeout(p.timer);
    p.mode = mode;
    p.ready = true;
    p.readyAt = clockNow();
    p.lastPong = 0;
    p.clock.reset();
    attach();
    // Connect sequence: hello, manifest, full state, beat grid.
    sendTo(p, CH.reliable, JSON.stringify({ a: SYS.hello, v: { app: "gesture-synth", version: PROTOCOL_VERSION, transport: mode }, t: clockNow() }));
    sendTo(p, CH.reliable, manifestMessage());
    sendTo(p, CH.reliable, snapshotMessage());
    const bg = beatGridMessage();
    if (bg) sendTo(p, CH.reliable, bg);
    // Quick ping burst so the RTT shows up right away.
    for (let i = 0; i < 4; i++) setTimeout(() => p.ready && ping(p), i * 120);
    emitStatus();
  }

  function sendTo(p, ch, str) {
    if (!p.ready) return;
    if (p.mode === "direct") {
      const dc = ch === CH.fast ? p.fast : p.rel;
      if (!dc || dc.readyState !== "open") return;
      if (ch === CH.fast && dc.bufferedAmount > FAST_BUFFER_LIMIT) return; // drop: a newer value follows
      dc.send(str);
    } else if (p.mode === "relay") {
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ t: "relay", to: p.id, ch, d: str }));
    }
    counters.bytes += str.length;
  }

  function broadcast(ch, str) {
    for (const p of peers.values()) if (p.ready) sendTo(p, ch, str);
  }

  function onPeerData(p, raw, ch) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.a === SYS.ping) {
      sendTo(p, CH.fast, JSON.stringify({ a: SYS.pong, c: m.c, h: clockNow(), id: m.id }));
    } else if (m.a === SYS.pong) {
      const now = clockNow();
      p.clock.add(m.c, m.h, now);
      p.lastPong = now;
      emitStatus();
    }
  }

  function ping(p) {
    sendTo(p, CH.fast, JSON.stringify({ a: SYS.ping, c: clockNow(), id: ++pingSeq }));
  }

  // ---------------------------------------------------------------- bus consumer
  const consumer = {
    onSet(name, value) {
      const type = typeOf(name);
      if (type === "continuous") {
        if (!frame) frame = {};
        frame[addressOf(name)] = encodeValue(name, value);
        if (!frameScheduled) {
          frameScheduled = true;
          // All bus.set() calls of one animation frame run in the same task (main loop),
          // so a microtask flushes exactly once per frame, right after the loop body.
          queueMicrotask(flushFrame);
        }
      } else {
        counters.state++;
        broadcast(CH.reliable, JSON.stringify({ a: addressOf(name), v: encodeValue(name, value), t: clockNow() }));
        if (name === "bpm") {
          const bg = beatGridMessage();
          if (bg) broadcast(CH.reliable, bg);
        }
      }
    },
    onEvent(name, data, playTime) {
      typeOf(name); // registers undeclared events in the manifest
      counters.events++;
      const now = clockNow();
      const t = typeof playTime === "number" ? audioToShared(playTime) : now;
      broadcast(CH.reliable, JSON.stringify({ a: addressOf(name), v: encodeValue(name, data), t, at: now }));
    },
  };

  function typeOf(name) {
    let type = types.get(name);
    if (type) return type;
    // A signal declared after connect: send the new manifest first (same reliable, ordered
    // channel), so the visualizer knows its type before its first value arrives.
    refreshTypes();
    type = types.get(name) || "continuous";
    broadcast(CH.reliable, manifestMessage());
    return type;
  }

  function refreshTypes() {
    types = new Map(bus.manifest().map((s) => [s.name, s.type]));
  }

  function flushFrame() {
    frameScheduled = false;
    if (!frame) return;
    const msg = JSON.stringify({ a: SYS.frame, n: ++frameSeq, t: clockNow(), v: frame });
    frame = null;
    counters.frames++;
    broadcast(CH.fast, msg);
  }

  function manifestMessage() {
    refreshTypes();
    const v = bus.manifest().map((s) => ({ name: s.name, address: addressOf(s.name), type: s.type, owner: s.owner ?? null }));
    return JSON.stringify({ a: SYS.manifest, v, t: clockNow() });
  }

  function snapshotMessage() {
    const state = {};
    const continuous = {};
    for (const s of bus.manifest()) {
      if (s.type === "event") continue;
      const v = bus.get(s.name);
      if (v === undefined) continue;
      (s.type === "state" ? state : continuous)[addressOf(s.name)] = encodeValue(s.name, v);
    }
    counters.snapshots++;
    return JSON.stringify({ a: SYS.state, v: { state, continuous }, t: clockNow() });
  }

  /**
   * Beat grid: BPM + the shared time of a reference beat, so the visualizer runs its own beat
   * clock with no network delay. Lights up as soon as ctx.clock exists (milestone 1 Arp clock).
   */
  function beatGridMessage() {
    let clock = null;
    try { clock = getClock(); } catch {}
    if (!clock || !(clock.bpm > 0)) return null;
    const ac = getAudioContext();
    const nowAc = ac ? ac.currentTime : 0;
    let beatAc = typeof clock.nextBeatTime === "function" ? clock.nextBeatTime() : null;
    if (typeof beatAc !== "number" || !isFinite(beatAc)) beatAc = nowAc;
    const beatsPerBar = clock.beatsPerBar || 4;
    let beat;
    if (typeof clock.beatAt === "function") {
      const b = clock.beatAt(beatAc);
      if (typeof b === "number" && isFinite(b)) beat = ((Math.round(b) % beatsPerBar) + beatsPerBar) % beatsPerBar;
    }
    const running = clock.running ?? clock.isRunning ?? true;
    return JSON.stringify({
      a: SYS.beatgrid,
      v: { bpm: clock.bpm, beatTime: audioToShared(beatAc), beat: beat ?? 0, beatsPerBar, running: !!running },
      t: clockNow(),
    });
  }

  /** AudioContext time (s) -> shared clock (synth epoch ms) at the moment the sound is heard. */
  function audioToShared(t) {
    const ac = getAudioContext();
    if (!ac) return clockNow();
    let perf;
    const ts = typeof ac.getOutputTimestamp === "function" ? ac.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) perf = ts.performanceTime + (t - ts.contextTime) * 1000;
    else perf = performance.now() + (t - ac.currentTime) * 1000 + (ac.outputLatency || 0) * 1000;
    return performance.timeOrigin + perf;
  }

  function attach() {
    if (unsubscribe) return;
    refreshTypes();
    unsubscribe = bus.subscribe(consumer); // all names, including ones declared later
    stateTimer = setInterval(() => {
      broadcast(CH.reliable, snapshotMessage());
      const bg = beatGridMessage();
      if (bg) broadcast(CH.reliable, bg);
    }, STATE_RESEND_MS);
    pingTimer = setInterval(() => {
      const now = clockNow();
      for (const p of [...peers.values()]) {
        if (!p.ready) continue;
        const last = p.lastPong || p.readyAt;
        if (now - last > PEER_TIMEOUT_MS) {
          if (p.mode === "direct") lostDirect(p);
          else dropPeer(p.id);
          continue;
        }
        ping(p);
      }
    }, PING_MS);
  }

  function detach() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    clearInterval(stateTimer);
    clearInterval(pingTimer);
    stateTimer = pingTimer = null;
    frame = null;
    frameScheduled = false;
    types = new Map();
  }

  // ---------------------------------------------------------------- public
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connectSignaling();
      emitStatus(true);
    },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      for (const id of [...peers.keys()]) dropPeer(id);
      detach();
      if (ws) {
        const s = ws;
        ws = null;
        s.onclose = s.onmessage = s.onopen = null;
        try { s.close(); } catch {}
      }
    },
    /** Ask for a fresh room code (drops current visualizers). */
    newRoom() {
      room = null;
      saveRoom(null);
      for (const id of [...peers.keys()]) dropPeer(id);
      if (ws && ws.readyState === 1) wsSend({ t: "host", room: null });
      emitStatus(true);
    },
    get status() { return status(); },
    get attached() { return !!unsubscribe; },
    /** Debug/test view of the connection. */
    stats() {
      return {
        ...status(),
        counters: { ...counters },
        peers: [...peers.values()].map((p) => ({
          id: p.id, mode: p.mode, ready: p.ready, rttMs: p.clock.rtt, lastRttMs: p.clock.lastRtt, offsetMs: p.clock.offset,
        })),
      };
    },
  };
}

function loadRoom() {
  try { return localStorage.getItem(ROOM_STORAGE_KEY) || null; } catch { return null; }
}
function saveRoom(code) {
  try {
    if (code) localStorage.setItem(ROOM_STORAGE_KEY, code);
    else localStorage.removeItem(ROOM_STORAGE_KEY);
  } catch {}
}
