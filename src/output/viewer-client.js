// Visualizer side of the Gesture Synth output (used by labs/visualizer.html; reusable by an
// Electron/web visualizer). Joins a room on the signaling server, answers the synth's WebRTC
// offer (or uses the WebSocket relay when told to), keeps the shared clock in sync with pings,
// and hands every data message to `onMessage(msg, channel)`.
//
//   const client = createViewerClient({ signalUrl, onMessage, onStatus });
//   client.connect("K7QF-2M");
//   client.toLocal(msg.t)   // shared (synth) ms -> this page's performance.now() ms

import { CHANNELS, CH, SYS, clockNow, createClockSync, normalizeRoomCode } from "./protocol.js";

const PING_MS = 1000;
const RETRY_MS = 1000;

export function createViewerClient({ signalUrl, onMessage = () => {}, onStatus = () => {} }) {
  let ws = null;
  let room = null;
  let id = null;
  let pc = null;
  let rel = null;
  let fast = null;
  let mode = "idle"; // idle | connecting | joining | waiting | direct | relay | error
  let error = null;
  let wanted = false;
  let retryTimer = null;
  let pingTimer = null;
  let pingSeq = 0;
  let iceServers = [];
  let signalChain = Promise.resolve();
  const clock = createClockSync();
  const counts = { reliable: 0, fast: 0 };

  function status() {
    return {
      state: mode,
      room,
      error,
      rttMs: clock.rtt,
      lastRttMs: clock.lastRtt,
      offsetMs: clock.synced ? clock.offset : null,
      synced: clock.synced,
      samples: clock.count,
      counts: { ...counts },
    };
  }
  function setMode(m, err = null) {
    mode = m;
    error = err;
    onStatus(status());
  }

  function wsSend(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function openSocket() {
    clearTimeout(retryTimer);
    setMode("connecting");
    const sock = new WebSocket(signalUrl);
    ws = sock;
    sock.onopen = () => {
      setMode("joining");
      wsSend({ t: "join", room });
    };
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onSignal(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (mode === "relay") dataLost();
      if (wanted && mode !== "error") {
        if (mode !== "direct") setMode("connecting");
        retryTimer = setTimeout(openSocket, RETRY_MS);
      }
    };
    sock.onerror = () => {};
  }

  function onSignal(m) {
    switch (m.t) {
      case "joined":
        id = m.id;
        iceServers = Array.isArray(m.iceServers) ? m.iceServers : [];
        setMode("waiting");
        break;
      case "error":
        if (m.reason === "no-room") {
          // The synth may not be up yet (or restarting): keep trying.
          setMode("error", "Room not found");
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { if (wanted) { setMode("joining"); wsSend({ t: "join", room }); } }, RETRY_MS);
        } else {
          setMode("error", m.reason);
        }
        break;
      case "host-left":
        dataLost();
        break;
      case "signal":
        // Serialize: a candidate must not be added before the offer is applied.
        signalChain = signalChain.then(() => onHostSignal(m.data || {})).catch((e) => console.warn("[viewer] signal", e));
        break;
      case "relay":
        if (mode === "relay") onData(m.d, m.ch === CH.fast ? "fast" : "reliable");
        break;
    }
  }

  async function onHostSignal(data) {
    if (data.type === "offer") {
      closePc();
      pc = new RTCPeerConnection({ iceServers });
      const thisPc = pc;
      pc.onicecandidate = (e) =>
        wsSend({ t: "signal", to: "host", data: { type: "candidate", candidate: e.candidate ? e.candidate.toJSON() : null } });
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        const which = dc.label === CHANNELS.fast.label ? "fast" : "reliable";
        if (which === "fast") fast = dc; else rel = dc;
        dc.onmessage = (ev) => onData(ev.data, which);
        dc.onopen = checkOpen;
        dc.onclose = () => { if (pc === thisPc && mode === "direct") dataLost(); };
        checkOpen();
      };
      pc.onconnectionstatechange = () => {
        if (pc === thisPc && (pc.connectionState === "failed" || pc.connectionState === "closed") && mode === "direct") dataLost();
      };
      await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ t: "signal", to: "host", data: { type: "answer", sdp: pc.localDescription.sdp } });
    } else if (data.type === "candidate" && data.candidate && pc) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    } else if (data.type === "relay") {
      closePc();
      ready("relay");
    }
  }

  function checkOpen() {
    if (rel && fast && rel.readyState === "open" && fast.readyState === "open" && mode !== "direct") ready("direct");
  }

  function ready(m) {
    clock.reset();
    setMode(m);
    clearInterval(pingTimer);
    for (let i = 0; i < 5; i++) setTimeout(ping, i * 100);
    pingTimer = setInterval(ping, PING_MS);
  }

  function dataLost() {
    clearInterval(pingTimer);
    pingTimer = null;
    closePc();
    if (wanted) setMode(ws && ws.readyState === 1 ? "waiting" : "connecting");
  }

  function closePc() {
    if (pc) {
      pc.onicecandidate = pc.ondatachannel = pc.onconnectionstatechange = null;
      try { pc.close(); } catch {}
    }
    pc = rel = fast = null;
  }

  function send(ch, str) {
    if (mode === "direct") {
      const dc = ch === CH.fast ? fast : rel;
      if (dc && dc.readyState === "open") dc.send(str);
    } else if (mode === "relay") {
      wsSend({ t: "relay", to: "host", ch, d: str });
    }
  }

  function ping() {
    if (mode !== "direct" && mode !== "relay") return;
    send(CH.fast, JSON.stringify({ a: SYS.ping, c: clockNow(), id: ++pingSeq }));
  }

  function onData(raw, which) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    counts[which]++;
    if (m.a === SYS.ping) {
      send(CH.fast, JSON.stringify({ a: SYS.pong, c: m.c, h: clockNow(), id: m.id }));
      return;
    }
    if (m.a === SYS.pong) {
      clock.add(m.c, m.h, clockNow());
      onStatus(status());
      return;
    }
    onMessage(m, which);
  }

  return {
    connect(code) {
      this.disconnect();
      room = normalizeRoomCode(code);
      wanted = true;
      openSocket();
    },
    disconnect() {
      wanted = false;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      closePc();
      if (ws) {
        const s = ws;
        ws = null;
        s.onclose = null;
        try { s.close(); } catch {}
      }
      clock.reset();
      setMode("idle");
    },
    /** Shared (synth) clock ms -> local performance.now() ms. */
    toLocal(sharedMs) {
      return sharedMs - clock.offset - performance.timeOrigin;
    },
    get status() { return status(); },
    get clock() { return clock; },
  };
}
