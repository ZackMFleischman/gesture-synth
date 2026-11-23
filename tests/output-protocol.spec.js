// Pure pieces of the M3 output, in Node: wire mapping, clock sync, and the signaling server.
import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import {
  ADDRESS_TABLE, addressOf, encodeValue, createClockSync, normalizeRoomCode, ROOM_CODE_RE,
} from "../src/output/protocol.js";
import { startSignalServer } from "../server/signal.js";

test("bus names map to the spec addresses (one table)", () => {
  expect(addressOf("chord")).toBe("/gs/chord");
  expect(addressOf("arp/gate")).toBe("/gs/gate");
  expect(addressOf("lead/noteset")).toBe("/gs/noteset");
  expect(addressOf("lead/octave")).toBe("/gs/octave");
  expect(addressOf("right/pos")).toBe("/gs/right/pos");
  expect(addressOf("some/new/signal")).toBe("/gs/some/new/signal"); // unknown names pass through
  for (const { address } of Object.values(ADDRESS_TABLE)) expect(address).toMatch(/^\/gs\//);
  expect(encodeValue("right/pos", { x: 0.123456, y: 0.5 })).toEqual([0.1235, 0.5]);
  expect(encodeValue("chord", { roman: "IV", degree: 4, isMajor: true, name: "D", rootMidi: 62, tones: [1] }))
    .toEqual({ degree: 4, major: true, root: 62, name: "D", roman: "IV" });
  expect(encodeValue("note/on", { freq: 440, voice: "arp" })).toEqual({ voice: "arp", note: 69, freq: 440 });
});

test("clock sync keeps the lowest-RTT sample", () => {
  const c = createClockSync();
  // remote clock is +1000 ms: a symmetric 10 ms RTT sample, then a noisy 80 ms one
  c.add(0, 1005, 10);
  c.add(100, 1170, 180);
  expect(c.rtt).toBe(10);
  expect(c.offset).toBe(1000);
  expect(c.lastRtt).toBe(80);
});

test("room codes", () => {
  expect(normalizeRoomCode("k7qf2m")).toBe("K7QF-2M");
  expect(normalizeRoomCode(" k7qf-2m ")).toBe("K7QF-2M");
  expect(ROOM_CODE_RE.test("K7QF-2M")).toBe(true);
  expect(ROOM_CODE_RE.test("O0I1-LL")).toBe(false);
});

function openClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const inbox = [];
    const waiters = [];
    ws.on("message", (b) => {
      const m = JSON.parse(b.toString());
      const i = waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else inbox.push(m);
    });
    ws.next = (t) =>
      new Promise((r) => {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) r(inbox.splice(i, 1)[0]);
        else waiters.push({ t, resolve: r });
      });
    ws.json = (o) => ws.send(JSON.stringify(o));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

test("signaling server: host/join, signal + relay forwarding, peer-left, room reclaim", async () => {
  const port = 5900 + Math.floor(Math.random() * 90);
  const srv = startSignalServer({ port, log: false });
  await new Promise((r) => setTimeout(r, 100));
  try {
    const host = await openClient(port);
    host.json({ t: "host" });
    const { room, iceServers } = await host.next("hosted");
    expect(room).toMatch(ROOM_CODE_RE);
    expect(iceServers).toEqual([]); // no STUN by default

    const viewer = await openClient(port);
    viewer.json({ t: "join", room: room.toLowerCase() });
    const joined = await viewer.next("joined");
    expect((await host.next("peer-joined")).id).toBe(joined.id);

    host.json({ t: "signal", to: joined.id, data: { type: "offer", sdp: "x" } });
    expect(await viewer.next("signal")).toEqual({ t: "signal", from: "host", data: { type: "offer", sdp: "x" } });
    viewer.json({ t: "relay", to: "host", ch: "f", d: '{"a":"/gs/sys/ping"}' });
    expect(await host.next("relay")).toEqual({ t: "relay", from: joined.id, ch: "f", d: '{"a":"/gs/sys/ping"}' });

    const bad = await openClient(port);
    bad.json({ t: "join", room: "ZZZZ-ZZ" });
    expect((await bad.next("error")).reason).toBe("no-room");

    viewer.close();
    expect((await host.next("peer-left")).id).toBe(joined.id);

    // Host reconnects and reclaims its code; a waiting viewer is re-announced.
    const viewer2 = await openClient(port);
    viewer2.json({ t: "join", room });
    const j2 = await viewer2.next("joined");
    await host.next("peer-joined");
    host.close();
    await viewer2.next("host-left");
    const host2 = await openClient(port);
    host2.json({ t: "host", room });
    expect((await host2.next("hosted")).room).toBe(room);
    expect((await host2.next("peer-joined")).id).toBe(j2.id);
    await viewer2.next("host-back");
    for (const s of [viewer2, host2, bad]) s.close();
  } finally {
    srv.close();
  }
});
