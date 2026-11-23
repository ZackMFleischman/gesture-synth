// Signal bus + params (contract: docs/architecture.md "Signal bus").
//
// Every part of the app publishes through one shared bus. Consumers (on-screen
// widgets today, the WebRTC output later) subscribe to the names they care about.
//
// Cost model: with no consumer for a name, set()/emit() do a Map lookup and a
// couple of field writes — no allocation, and lazy value functions are NOT
// called. Each signal keeps its own list of matching consumers, so the check is
// a single length test. Consumer lists are copy-on-write, so (un)subscribing
// during a dispatch is safe.

const NONE = Object.freeze([]);

function makeMatcher(filter) {
  if (filter == null) return () => true;
  if (typeof filter === "function") return filter;
  const patterns = Array.isArray(filter) ? filter : [filter];
  return (name) =>
    patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

export function createBus() {
  /** @type {Map<string, {name:string,type:string,owner?:string,value:any,fn:Function|null,version:number,subs:object[]}>} */
  const signals = new Map();
  /** @type {{consumer:object, match:(name:string)=>boolean}[]} */
  let consumers = [];

  function entry(name, type) {
    let e = signals.get(name);
    if (e) return e;
    e = { name, type, owner: undefined, value: undefined, fn: null, version: 0, subs: NONE };
    const subs = [];
    for (const c of consumers) if (c.match(name)) subs.push(c.consumer);
    if (subs.length) e.subs = subs;
    signals.set(name, e);
    return e;
  }

  function declare(name, { type = "continuous", owner } = {}) {
    const e = entry(name, type);
    e.type = type;
    if (owner !== undefined) e.owner = owner;
    return name;
  }

  /** Continuous/state value. `valueOrFn` may be a function: evaluated only when consumed. */
  function set(name, valueOrFn) {
    const e = signals.get(name) || entry(name, "continuous");
    const subs = e.subs;
    if (subs.length === 0) {
      // Nobody listening: just remember it (lazily). No allocation, fn not called.
      if (typeof valueOrFn === "function") {
        e.fn = valueOrFn;
      } else {
        e.fn = null;
        if (!Object.is(e.value, valueOrFn)) {
          e.value = valueOrFn;
          e.version++;
        }
      }
      return;
    }
    e.fn = null;
    const v = typeof valueOrFn === "function" ? valueOrFn() : valueOrFn;
    if (Object.is(e.value, v)) return; // unchanged: nothing to tell anyone
    e.value = v;
    e.version++;
    for (let i = 0; i < subs.length; i++) {
      const c = subs[i];
      if (c.onSet) c.onSet(name, v);
    }
  }

  /** Event. `playTime` = AudioContext time the sound plays (optional). */
  function emit(name, data, playTime) {
    const e = signals.get(name) || entry(name, "event"); // undeclared: register once
    const subs = e.subs;
    if (subs.length === 0) return;
    for (let i = 0; i < subs.length; i++) {
      const c = subs[i];
      if (c.onEvent) c.onEvent(name, data, playTime);
    }
  }

  /** Last value (evaluates a pending lazy fn). */
  function get(name) {
    const e = signals.get(name);
    if (!e) return undefined;
    if (e.fn) {
      const v = e.fn();
      e.fn = null;
      if (!Object.is(e.value, v)) {
        e.value = v;
        e.version++;
      }
    }
    return e.value;
  }

  /** True if anyone consumes `name` — lets producers skip building event payloads. */
  function wants(name) {
    const e = signals.get(name);
    return !!e && e.subs.length > 0;
  }

  /**
   * consumer: { onSet?(name, value), onEvent?(name, data, playTime) }
   * filter: name | "prefix/*" | array of those | (name) => boolean; omitted = everything.
   */
  function subscribe(consumer, filter) {
    const rec = { consumer, match: makeMatcher(filter) };
    consumers = [...consumers, rec];
    for (const e of signals.values()) {
      if (rec.match(e.name)) e.subs = [...e.subs, consumer];
    }
    return function unsubscribe() {
      consumers = consumers.filter((c) => c !== rec);
      for (const e of signals.values()) {
        if (e.subs.includes(consumer)) {
          const next = e.subs.filter((c) => c !== consumer);
          e.subs = next.length ? next : NONE;
        }
      }
    };
  }

  function manifest() {
    return [...signals.values()].map(({ name, type, owner }) => ({ name, type, owner }));
  }

  return { declare, set, emit, get, wants, subscribe, manifest };
}

/**
 * A mode/control parameter: setting `.value` drives the sound (via `onChange`) and
 * publishes to the bus in one step. `onChange` runs on every set (even if unchanged),
 * so audio stays in sync with whatever the caller asked for; the bus itself only
 * notifies consumers when the value actually changes.
 */
export function createParam(bus, name, { type = "continuous", value, min, max, owner, onChange } = {}) {
  bus.declare(name, { type, owner });
  let v = value;
  if (v !== undefined) bus.set(name, v);
  return {
    name,
    min,
    max,
    get value() {
      return v;
    },
    set value(x) {
      if (typeof x === "number") {
        if (min !== undefined && x < min) x = min;
        if (max !== undefined && x > max) x = max;
      }
      v = x;
      if (onChange) onChange(x);
      bus.set(name, x);
    },
  };
}

/** The app-wide bus. Any module may import it. */
export const bus = createBus();
