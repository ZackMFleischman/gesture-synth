// Signal bus: pure-logic tests (Node, no browser).
import { test as nodeTest, expect } from "@playwright/test";
import { PerformanceObserver } from "node:perf_hooks";
import { createBus, createParam } from "../src/core/bus.js";

nodeTest.describe("bus (unit)", () => {
  nodeTest("declare / set / get / manifest", () => {
    const bus = createBus();
    bus.declare("volume", { type: "continuous", owner: "chords" });
    bus.declare("chord", { type: "state", owner: "chords" });
    bus.declare("note/on", { type: "event", owner: "audio" });
    expect(bus.get("volume")).toBeUndefined();
    bus.set("volume", 0.4);
    expect(bus.get("volume")).toBe(0.4);
    expect(bus.manifest()).toEqual([
      { name: "volume", type: "continuous", owner: "chords" },
      { name: "chord", type: "state", owner: "chords" },
      { name: "note/on", type: "event", owner: "audio" },
    ]);
  });

  nodeTest("subscribe gets changes only; unsubscribe stops them", () => {
    const bus = createBus();
    const sets = [];
    const off = bus.subscribe({ onSet: (n, v) => sets.push([n, v]) });
    bus.set("a", 1);
    bus.set("a", 1); // unchanged -> no notification
    bus.set("a", 2);
    off();
    bus.set("a", 3);
    expect(sets).toEqual([["a", 1], ["a", 2]]);
    expect(bus.get("a")).toBe(3);
  });

  nodeTest("filters: exact name, prefix/*, array, function; late-declared names match", () => {
    const bus = createBus();
    const got = { exact: [], prefix: [], arr: [], fn: [] };
    bus.subscribe({ onSet: (n) => got.exact.push(n) }, "volume");
    bus.subscribe({ onSet: (n) => got.prefix.push(n) }, "left/*");
    bus.subscribe({ onSet: (n) => got.arr.push(n) }, ["volume", "filter"]);
    bus.subscribe({ onSet: (n) => got.fn.push(n) }, (n) => n.endsWith("/tilt"));
    for (const n of ["volume", "filter", "left/height", "left/tilt", "right/tilt"]) bus.set(n, 1);
    expect(got).toEqual({
      exact: ["volume"],
      prefix: ["left/height", "left/tilt"],
      arr: ["volume", "filter"],
      fn: ["left/tilt", "right/tilt"],
    });
  });

  nodeTest("emit delivers data + playTime to onEvent", () => {
    const bus = createBus();
    bus.declare("note/on", { type: "event" });
    const events = [];
    bus.subscribe({ onEvent: (n, d, t) => events.push([n, d, t]) }, "note/*");
    bus.emit("note/on", { freq: 440 }, 1.5);
    bus.emit("note/off", { freq: 440 }, 2); // undeclared, but matches the filter
    expect(events).toEqual([["note/on", { freq: 440 }, 1.5], ["note/off", { freq: 440 }, 2]]);
    expect(bus.wants("note/on")).toBe(true);
    expect(bus.wants("volume")).toBe(false);
  });

  nodeTest("lazy value fn is not evaluated without a consumer", () => {
    const bus = createBus();
    bus.declare("expensive", { type: "continuous" });
    let calls = 0;
    const fn = () => (calls++, 42);
    for (let i = 0; i < 1000; i++) bus.set("expensive", fn);
    expect(calls).toBe(0);
    // consuming it (get) evaluates once
    expect(bus.get("expensive")).toBe(42);
    expect(calls).toBe(1);
    // with a subscriber, it is evaluated on set
    const seen = [];
    bus.subscribe({ onSet: (n, v) => seen.push(v) }, "expensive");
    bus.set("expensive", () => 7);
    expect(seen).toEqual([7]);
  });

  nodeTest("set/emit without subscribers is ~free (no allocation, no GC)", async () => {
    const bus = createBus();
    bus.declare("x", { type: "continuous" });
    bus.declare("ev", { type: "event" });
    // an unrelated consumer must not make unrelated names expensive
    bus.subscribe({ onSet() {}, onEvent() {} }, "other");
    const fn = () => ({ big: new Array(100) });
    const payload = { freq: 1 };
    const run = (n) => {
      for (let i = 0; i < n; i++) {
        bus.set("x", i);
        bus.set("x", fn);
        bus.emit("ev", payload, i);
      }
    };
    run(200_000); // warm up / JIT

    let gcs = 0;
    const obs = new PerformanceObserver((list) => (gcs += list.getEntries().length));
    obs.observe({ entryTypes: ["gc"] });
    const t0 = performance.now();
    run(3_000_000); // allocating even 16 bytes per call would be ~150 MB -> many scavenges
    const ms = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 50)); // let GC entries flush
    obs.disconnect();

    expect(gcs, "garbage collections during 9M no-consumer calls").toBeLessThanOrEqual(2);
    expect(ms, "9M no-consumer calls").toBeLessThan(1000);
  });

  nodeTest("param: setting .value drives sound (onChange) and publishes", () => {
    const bus = createBus();
    const applied = [];
    const seen = [];
    bus.subscribe({ onSet: (n, v) => seen.push([n, v]) }, "arp/gate");
    const gate = createParam(bus, "arp/gate", { type: "continuous", value: 0.5, min: 0, max: 1, owner: "arp", onChange: (v) => applied.push(v) });
    expect(gate.value).toBe(0.5);
    gate.value = 0.8;
    gate.value = 2; // clamped
    gate.value = 1; // unchanged on the bus, but sound is still told
    expect(applied).toEqual([0.8, 1, 1]);
    expect(seen).toEqual([["arp/gate", 0.5], ["arp/gate", 0.8], ["arp/gate", 1]]);
    expect(bus.manifest()).toContainEqual({ name: "arp/gate", type: "continuous", owner: "arp" });
  });
});
