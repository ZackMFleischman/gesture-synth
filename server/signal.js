#!/usr/bin/env node
// Gesture Synth signaling + relay server (milestone 3).
//
// Small self-hosted WebSocket server. It does three things:
//   1. Rooms with short codes ("K7QF-2M"): the synth hosts a room, a visualizer joins it.
//   2. Relays WebRTC setup messages (offer / answer / ICE candidates) between them.
//   3. Fallback data relay: when a direct WebRTC connection can't be made, data
//      messages are forwarded over the WebSockets ({t:"relay"}).
// No third-party services. ICE servers (STUN/TURN) are OFF by default (local/LAN use);
// set GS_ICE_SERVERS='[{"urls":"stun:stun.example.org:3478"}]' to hand them to clients.
//
// Usage: npm run signal            (port 5417, or SIGNAL_PORT=xxxx)
//
// Protocol (JSON text frames, field `t` = type):
//   host -> server   {t:"host", room?}             room = previous code to reclaim (optional)
//   server -> host   {t:"hosted", room, iceServers}
//   viewer -> server {t:"join", room}
//   server -> viewer {t:"joined", room, id, iceServers} | {t:"error", reason}
//   server -> host   {t:"peer-joined", id} | {t:"peer-left", id}
//   server -> viewer {t:"host-left"} | {t:"host-back"}
//   any -> server    {t:"signal", to, data}   -> forwarded as {t:"signal", from, data}
//   any -> server    {t:"relay",  to, ch, d}  -> forwarded as {t:"relay",  from, ch, d}
//   ("host" is the id of the synth in every room)

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.SIGNAL_PORT) || 5417;
const HOST_GRACE_MS = 60_000; // a room survives a host reconnect for this long
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
const ROOM_RE = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{2}$/;

function parseIceServers() {
  try {
    const v = JSON.parse(process.env.GS_ICE_SERVERS || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    console.warn("[signal] GS_ICE_SERVERS is not valid JSON; using none");
    return [];
  }
}
const ICE_SERVERS = parseIceServers();

/** @type {Map<string, {code:string, host:any, viewers:Map<string,any>, nextId:number, expire:any}>} */
const rooms = new Map();

function newCode() {
  for (;;) {
    let s = "";
    for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    const code = `${s.slice(0, 4)}-${s.slice(4)}`;
    if (!rooms.has(code)) return code;
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
}

function hostRoom(ws, wanted) {
  let room = null;
  const code = typeof wanted === "string" ? wanted.toUpperCase() : null;
  if (code && ROOM_RE.test(code)) {
    const existing = rooms.get(code);
    if (!existing) {
      room = { code, host: null, viewers: new Map(), nextId: 1, expire: null };
      rooms.set(code, room);
    } else if (!existing.host || existing.host.readyState !== 1) {
      room = existing; // reclaim after a host reconnect
    }
  }
  if (!room) {
    room = { code: newCode(), host: null, viewers: new Map(), nextId: 1, expire: null };
    rooms.set(room.code, room);
  }
  clearTimeout(room.expire);
  room.expire = null;
  room.host = ws;
  ws.role = "host";
  ws.room = room;
  send(ws, { t: "hosted", room: room.code, iceServers: ICE_SERVERS });
  // Viewers still waiting in the room: tell both sides.
  for (const [id, v] of room.viewers) {
    send(v, { t: "host-back" });
    send(ws, { t: "peer-joined", id });
  }
}

function joinRoom(ws, code) {
  const room = rooms.get(String(code || "").toUpperCase().trim());
  if (!room) return send(ws, { t: "error", reason: "no-room" });
  const id = `v${room.nextId++}`;
  room.viewers.set(id, ws);
  ws.role = "viewer";
  ws.room = room;
  ws.id = id;
  send(ws, { t: "joined", room: room.code, id, iceServers: ICE_SERVERS, hostPresent: !!room.host });
  if (room.host) send(room.host, { t: "peer-joined", id });
}

function target(ws, to) {
  const room = ws.room;
  if (!room) return null;
  if (ws.role === "viewer") return to === "host" || to == null ? room.host : null; // viewers talk only to the host
  return room.viewers.get(to) || null;
}

function from(ws) {
  return ws.role === "host" ? "host" : ws.id;
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.role === "host" && room.host === ws) {
    room.host = null;
    for (const v of room.viewers.values()) send(v, { t: "host-left" });
    room.expire = setTimeout(() => {
      for (const v of room.viewers.values()) send(v, { t: "error", reason: "room-closed" });
      rooms.delete(room.code);
    }, HOST_GRACE_MS);
  } else if (ws.role === "viewer") {
    room.viewers.delete(ws.id);
    send(room.host, { t: "peer-left", id: ws.id });
  }
  ws.room = null;
}

export function startSignalServer({ port = PORT, log = true } = {}) {
  const http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      return res.end("ok");
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 256 * 1024 });

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("message", (buf) => {
      let m;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      switch (m.t) {
        case "host":
          if (ws.room) leave(ws);
          return hostRoom(ws, m.room);
        case "join":
          if (ws.room) leave(ws);
          return joinRoom(ws, m.room);
        case "signal":
          return send(target(ws, m.to), { t: "signal", from: from(ws), data: m.data });
        case "relay": {
          const dest = target(ws, m.to);
          if (dest) send(dest, `{"t":"relay","from":${JSON.stringify(from(ws))},"ch":${JSON.stringify(m.ch)},"d":${JSON.stringify(m.d)}}`);
          return;
        }
        case "ping":
          return send(ws, { t: "pong" });
      }
    });
    ws.on("close", () => leave(ws));
    ws.on("error", () => {});
  });

  // Drop dead sockets (laptop lid closed, network gone) so the host learns about it.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 10_000);
  wss.on("close", () => clearInterval(beat));

  http.listen(port, () => {
    if (log) console.log(`[signal] Gesture Synth signaling on ws://localhost:${port} (ICE servers: ${ICE_SERVERS.length || "none"})`);
  });
  return {
    close() {
      clearInterval(beat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.close();
    },
  };
}

// Run directly: `node server/signal.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startSignalServer();
}
