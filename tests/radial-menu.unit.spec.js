// Radial menu: pure state-machine unit tests (Node). Lab page (browser) tests: menu-lab.int.spec.js.
// Default flow = auto-select (crossing the select radius chooses an arc; no open-hand confirm, no tick sound) with a
// 2 s re-arm cooldown. The live config (src/menu/menu-config.js) is reset after every test.
import { test as base, expect as baseExpect } from "@playwright/test";
import { createMenuState, MENU_GEOMETRY as G, MENU_TIMING as T, pickDirection } from "../src/menu/menu-state.js";
import { menuConfig, setMenuConfig, resetMenuConfig, MENU_CONFIG_DEFAULTS } from "../src/menu/menu-config.js";

// Distances inside the approach band (past the dead zone, short of the select radius), from the geometry.
const APPROACH = (G.DEAD_R + G.SELECT_R) / 2;
const along = (f) => G.DEAD_R + f * (G.SELECT_R - G.DEAD_R);

// ---------------------------------------------------------------------------------------
// Unit tests: pure state machine
// ---------------------------------------------------------------------------------------

const ITEMS = [
  { id: "chords", type: "mode", label: "Chords", color: "#f2b14c", direction: "up" },
  { id: "arp", type: "mode", label: "Arp", color: "#4fb3ff", direction: "right" },
  { id: "lead", type: "mode", label: "Lead", color: "#5fd08a", direction: "left" },
];
const FOUR = [...ITEMS, { id: "bass", type: "mode", label: "Bass", color: "#c77dff", direction: "down" }];
const DT = 16;

/** Small driver: a fake right hand + clock. Positions in display-normalized coords. */
function rig({ items = ITEMS, current = "chords", aspect = 1, size = 0.1, x = 0.5, y = 0.5 } = {}) {
  const m = createMenuState({ items: () => items, currentId: () => current, aspect });
  const h = { fist: false, x, y, size, thumb: false, visible: true };
  let now = 1000;
  const frame = () =>
    h.visible
      ? {
          handedness: "Right",
          fist: h.fist,
          fingers: { thumb: h.thumb, index: !h.fist, middle: !h.fist, ring: !h.fist, pinky: !h.fist },
          pos: { x: h.x, y: h.y },
          handSize: h.size,
          t: now,
        }
      : null;
  const results = [];
  const run = (ms) => {
    let r;
    const end = now + ms;
    do {
      now += DT;
      r = m.update(frame(), now);
      results.push(r);
    } while (now < end);
    return r;
  };
  /** Move by (dx, dy) in hand sizes, isotropic (dy scaled by aspect). */
  const moveTo = (dxS, dyS, cx = x, cy = y) => {
    h.x = cx + dxS * h.size;
    h.y = cy + dyS * h.size * aspect;
  };
  /** Fist until the menu is open and its ring has grown in (selection armed). */
  const open = (ms = T.ENTER_STABLE_MS + T.LEVEL_ARM_MS + 32) => {
    h.fist = true;
    return run(ms);
  };
  const any = (key) => results.some((r) => r[key]);
  return { m, h, run, moveTo, open, results, any, get now() { return now; } };
}

base.describe("radial menu state machine", () => {
  const expect = baseExpect;
  base.afterEach(() => resetMenuConfig());

  base("enters only after ~100 ms of stable fist", () => {
    const r = rig();
    r.h.fist = true;
    expect(r.run(64).state).toBe("closed");
    expect(r.m.isHoldingRight()).toBe(false);
    const res = r.run(64); // total >= 100 ms
    expect(res.state).toBe("open");
    expect(r.any("opened")).toBe(true);
    expect(r.m.isHoldingRight()).toBe(true);
    expect(r.m.snapshot().center).toEqual({ x: 0.5, y: 0.5 });
  });

  base("a flickering fist never opens the menu", () => {
    const r = rig();
    for (let i = 0; i < 20; i++) {
      r.h.fist = true;
      r.run(64);
      r.h.fist = false;
      r.run(16);
    }
    expect(r.results.every((x) => x.state === "closed")).toBe(true);
  });

  base("thumb state is irrelevant for entry", () => {
    const r = rig();
    r.h.fist = true;
    for (let i = 0; i < 8; i++) {
      r.h.thumb = !r.h.thumb;
      r.run(16);
    }
    expect(r.results.at(-1).state).toBe("open");
  });

  base("angle from the entry point picks the arc in all 4 directions", () => {
    const cases = [
      [0, -1, "chords"],
      [1, 0, "arp"],
      [0, 1, "bass"],
      [-1, 0, "lead"],
      [0.7, -0.5, "arp"], // within the right sector
      [-0.3, -0.8, "chords"],
    ];
    for (const [dx, dy, id] of cases) {
      const r = rig({ items: FOUR });
      r.open();
      r.moveTo(dx * APPROACH, dy * APPROACH);
      const res = r.run(16);
      expect(res.hoverId, `${dx},${dy}`).toBe(id);
      expect(res.selectedId).toBe(null);
      expect(res.progress).toBeGreaterThan(0);
      expect(res.progress).toBeLessThan(1);
    }
  });

  base("empty direction (down, no item) lights nothing", () => {
    const r = rig();
    r.open();
    r.moveTo(0, 1.2);
    const res = r.run(16);
    expect(res.hoverId).toBe(null);
    expect(res.selectedId).toBe(null);
  });

  base("center dead zone: no arc lit, progress grows with distance", () => {
    const r = rig();
    r.open();
    r.moveTo(G.DEAD_R * 0.8, 0);
    let res = r.run(16);
    expect(res.hoverId).toBe(null);
    expect(res.progress).toBe(0);
    const ps = [];
    for (const d of [along(0.2), along(0.5), along(0.8)]) {
      r.moveTo(d, 0);
      ps.push(r.run(16).progress);
    }
    expect(ps[0]).toBeLessThan(ps[1]);
    expect(ps[1]).toBeLessThan(ps[2]);
    r.moveTo(G.SELECT_R - 0.01, 0);
    expect(r.run(16).progress).toBeGreaterThan(0.95);
  });


  base("auto-select: crossing the select radius confirms at once, without opening the hand", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R - 0.05, 0);
    let res = r.run(16);
    expect(res.state).toBe("open");
    expect(res.selectedId).toBe(null);
    expect(r.any("confirmed")).toBe(false);
    r.moveTo(G.SELECT_R + 0.02, 0); // the fist stays closed throughout
    res = r.run(16);
    expect(res.confirmed).toBe("arp");
    expect(res.state).toBe("countdown");
    expect(res.selectedId).toBe("arp");
    expect(r.h.fist).toBe(true);
    expect(r.m.isHoldingRight()).toBe(true);
    const snap = r.m.snapshot();
    expect(snap.confirmedId).toBe("arp");
    expect(snap.confirmKind).toBe("mode");
    expect(snap.confirmedAt).toBe(r.now);
  });

  base("no selection sound: the menu takes no tick callback and exports no tick helper", async () => {
    let called = 0;
    // A legacy onTick option is ignored (not part of the contract any more).
    const m = createMenuState({ items: () => ITEMS, currentId: () => "chords", onTick: () => called++ });
    let now = 1000;
    const hand = (x, fist = true) => ({ fist, pos: { x, y: 0.5 }, handSize: 0.1 });
    for (let i = 0; i < 20; i++) m.update(hand(0.5), (now += 16));
    for (let i = 0; i < 4; i++) m.update(hand(0.5 + (G.SELECT_R + 0.1) * 0.1), (now += 16));
    expect(m.snapshot().confirmedId).toBe("arp");
    expect(called).toBe(0);
    const api = await import("../src/menu/radial-menu.js");
    expect(api.playTick).toBeUndefined();
  });

  base("hysteresis near the radius never double-fires", () => {
    const r = rig();
    r.open();
    // jitter right across the select radius (and across the arp|chords diagonal) for half a second
    for (const [d, a] of [[G.SELECT_R - 0.01, 0], [G.SELECT_R + 0.01, -0.2], [G.SELECT_R - 0.02, 0.1], [G.SELECT_R + 0.03, -0.9]]) {
      r.moveTo(d * Math.cos(a), d * Math.sin(a));
      r.run(16);
    }
    for (let i = 0; i < 30; i++) {
      const d = G.SELECT_R + (i % 2 ? 0.02 : -0.02);
      r.moveTo(d, 0);
      r.run(16);
    }
    expect(r.results.filter((x) => x.confirmed).length).toBe(1);
    expect(r.results.find((x) => x.confirmed).confirmed).toBe("arp");
    // same-item: jitter around the current item's radius closes once, then nothing (not re-armed)
    const q = rig({ current: "arp" });
    q.open();
    for (let i = 0; i < 40; i++) {
      q.moveTo(G.SELECT_R + (i % 2 ? 0.02 : -0.02), 0);
      q.run(16);
    }
    expect(q.results.filter((x) => x.cancelled).length).toBe(1);
    expect(q.results.filter((x) => x.opened).length).toBe(1);
    expect(q.any("confirmed")).toBe(false);
  });

  base("the first arc crossed wins: moving on to another arc during the countdown changes nothing", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    expect(r.run(16).confirmed).toBe("arp");
    r.moveTo(0, -(G.SELECT_R + 0.1));
    const res = r.run(64);
    expect(res.state).toBe("countdown");
    expect(res.selectedId).toBe("arp");
    expect(r.results.filter((x) => x.confirmed).length).toBe(1);
  });

  base("an empty direction past the radius selects nothing", () => {
    const r = rig();
    r.open();
    r.moveTo(0, G.SELECT_R + 0.3); // "down": no item
    const res = r.run(64);
    expect(res.state).toBe("open");
    expect(res.selectedId).toBe(null);
    expect(r.any("confirmed")).toBe(false);
  });

  base("sector hysteresis: a diagonal does not flicker between arcs", () => {
    expect(pickDirection(-40, null)).toBe("right");
    expect(pickDirection(-50, null)).toBe("up");
    expect(pickDirection(-50, "right")).toBe("right"); // within 45 + 10
    expect(pickDirection(-60, "right")).toBe("up");
  });

  base("a new ring selects nothing while it grows in (LEVEL_ARM_MS), then the held position confirms", () => {
    const r = rig();
    r.h.fist = true;
    r.run(T.ENTER_STABLE_MS + 16); // just opened
    expect(r.results.at(-1).state).toBe("open");
    r.moveTo(G.SELECT_R + 0.1, 0); // flick out immediately
    let res = r.run(T.LEVEL_ARM_MS - 48);
    expect(res.state).toBe("open");
    expect(res.hoverId).toBe("arp");
    expect(r.any("confirmed")).toBe(false);
    res = r.run(64);
    expect(r.any("confirmed")).toBe(true);
    expect(res.state).toBe("countdown");
  });

  base("countdown -> closed while the fist stays closed (flash + countdown timing unchanged)", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    const t0 = r.now;
    r.run(T.FLASH_MS + T.COUNTDOWN_MS - 48);
    expect(r.m.isHoldingRight()).toBe(true);
    expect(r.results.at(-1).state).toBe("countdown");
    const end = r.run(64);
    expect(end.state).toBe("closed");
    expect(r.any("finished")).toBe(true);
    expect(r.m.isHoldingRight()).toBe(false);
    const fin = r.results.findIndex((x) => x.finished);
    expect(fin).toBeGreaterThan(0);
    expect(r.m.snapshot().closedAt - t0).toBeGreaterThanOrEqual(T.FLASH_MS + T.COUNTDOWN_MS);
    expect(r.m.snapshot().closeReason).toBe("done");
    expect(r.any("cancelled")).toBe(false);
  });

  base("cancel: open hand before anything was chosen -> cancelled, no change", () => {
    const r = rig();
    r.open();
    r.moveTo(APPROACH, 0); // approaching, not selected
    expect(r.run(16).hoverId).toBe("arp");
    r.h.fist = false;
    const res = r.run(T.OPEN_DEBOUNCE_MS + 16);
    expect(res.state).toBe("closed");
    const c = r.results.find((x) => x.cancelled);
    expect(c.reason).toBe("empty");
    expect(r.any("confirmed")).toBe(false);
    expect(r.m.isHoldingRight()).toBe(false);
  });

  base("a single non-fist frame does not cancel (debounce)", () => {
    const r = rig();
    r.open();
    r.moveTo(APPROACH, 0);
    r.run(16);
    r.h.fist = false;
    r.run(16);
    r.h.fist = true;
    let res = r.run(64);
    expect(res.state).toBe("open");
    expect(res.hoverId).toBe("arp");
    r.moveTo(G.SELECT_R + 0.1, 0);
    res = r.run(16);
    expect(res.confirmed).toBe("arp");
  });

  base("crossing the current item = no change: closes quietly, no countdown", () => {
    const r = rig({ current: "arp" });
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    const res = r.run(16);
    expect(res.state).toBe("closed");
    expect(r.any("confirmed")).toBe(false);
    expect(r.results.find((x) => x.cancelled).reason).toBe("same-item");
    expect(r.m.isHoldingRight()).toBe(false);
    expect(r.m.snapshot().confirmedId).toBe(null);
  });

  base("tracking lost: kept for 0.3 s, then cancelled; recovery within grace continues", () => {
    const r = rig();
    r.open();
    r.moveTo(APPROACH, 0);
    r.run(16);
    r.h.visible = false;
    let res = r.run(T.LOST_GRACE_MS - 50);
    expect(res.state).toBe("open");
    r.h.visible = true;
    res = r.run(16);
    expect(res.state).toBe("open");
    expect(res.hoverId).toBe("arp");
    r.h.visible = false;
    res = r.run(T.LOST_GRACE_MS + 20);
    expect(res.state).toBe("closed");
    expect(r.results.find((x) => x.cancelled).reason).toBe("tracking-lost");
    // a fist re-appearing does not immediately reopen; the hand must open first
    r.h.visible = true;
    expect(r.open(200).state).toBe("closed");
    r.h.fist = false;
    r.run(32);
    expect(r.open().state).toBe("open");
  });

  base("cooldown: a fist held after a confirm does NOT reopen before REARM_MS, DOES after it", () => {
    expect(T.REARM_MS).toBe(2000);
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    r.run(T.FLASH_MS + T.COUNTDOWN_MS + 32); // countdown over, fist still closed
    const closedAt = r.m.snapshot().closedAt;
    expect(r.results.at(-1).state).toBe("closed");
    r.moveTo(0, 0); // back to the middle, still a fist
    while (r.now < closedAt + T.REARM_MS - 16) expect(r.run(16).state, `t=${r.now - closedAt}`).toBe("closed");
    // 2 s after the close: the still-held fist counts again, the menu opens after the usual stability time
    r.run(T.ENTER_STABLE_MS - 32);
    expect(r.results.at(-1).state).toBe("closed");
    const res = r.run(64);
    expect(res.state).toBe("open");
    expect(r.results.filter((x) => x.opened).length).toBe(2);
    const opened = r.results.length - 1 - [...r.results].reverse().findIndex((x) => x.opened);
    expect(opened).toBeGreaterThan(0);
  });

  base("cooldown after a same-item close and after a cancel-by-tracking is the same 2 s", () => {
    const r = rig({ current: "arp" });
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16); // same-item: closed, fist still closed
    const closedAt = r.m.snapshot().closedAt;
    r.run(T.REARM_MS - 64);
    expect(r.results.filter((x) => x.opened).length).toBe(1);
    r.run(64 + T.ENTER_STABLE_MS + 16);
    expect(r.results.at(-1).state).toBe("open");
    expect(r.now - closedAt).toBeGreaterThanOrEqual(T.REARM_MS + T.ENTER_STABLE_MS);
  });

  base("opening the hand then fisting again reopens at once (after the stability time)", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    r.run(T.FLASH_MS + T.COUNTDOWN_MS + 32); // closed, fist still closed
    expect(r.results.at(-1).state).toBe("closed");
    r.h.fist = false;
    r.run(32); // seen open once
    r.h.fist = true;
    r.run(T.ENTER_STABLE_MS - 16);
    expect(r.results.at(-1).state).toBe("closed");
    expect(r.run(32).state).toBe("open");
  });

  base("a hand seen open during the countdown re-arms at once: a fist made again reopens after the countdown", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    r.h.fist = false;
    r.run(64); // open during the countdown
    r.h.fist = true; // fist again during the countdown
    r.run(T.FLASH_MS + T.COUNTDOWN_MS);
    const res = r.run(T.ENTER_STABLE_MS + 32); // countdown over, still fist -> reopens (no 2 s wait)
    expect(res.state).toBe("open");
  });

  base("scale invariance: same relative movement gives same result at any hand size", () => {
    for (const size of [0.05, 0.1, 0.22]) {
      const r = rig({ size });
      r.open();
      r.moveTo(APPROACH, 0);
      const res = r.run(16);
      expect(res.hoverId, `size ${size}`).toBe("arp");
      expect(res.selectedId).toBe(null);
      expect(res.progress).toBeCloseTo((APPROACH - G.DEAD_R) / (G.SELECT_R - G.DEAD_R), 5);
      r.moveTo(G.SELECT_R + 0.05, 0);
      expect(r.run(16).confirmed, `size ${size}`).toBe("arp");
    }
  });

  base("aspect: vertical distance is measured isotropically", () => {
    const aspect = 16 / 9;
    const r = rig({ aspect, current: "arp" });
    r.open();
    r.moveTo(0, -(G.SELECT_R - 0.05)); // moveTo scales dy by aspect: just short of the radius
    expect(r.run(16).state).toBe("open");
    r.moveTo(0, -(G.SELECT_R + 0.05));
    expect(r.run(16).confirmed).toBe("chords");
  });

  base("edge entry: movement is measured relative to the real entry point", () => {
    const r = rig({ x: 0.97, y: 0.04 });
    r.open();
    const snap = r.m.snapshot();
    expect(snap.center).toEqual({ x: 0.97, y: 0.04 });
    r.moveTo(-(G.SELECT_R + 0.1), 0, 0.97, 0.04);
    const res = r.run(16);
    expect(res.confirmed).toBe("lead");
    expect(r.m.snapshot().offset.x).toBeCloseTo(-(G.SELECT_R + 0.1) * 0.1, 6);
  });
});

base.describe("radial menu live config (src/menu/menu-config.js)", () => {
  const expect = baseExpect;
  base.afterEach(() => resetMenuConfig());

  base("defaults mirror the constants; setMenuConfig type-checks and ignores unknown keys; reset restores", () => {
    expect(MENU_CONFIG_DEFAULTS).toMatchObject({
      requireRelease: false,
      holdMs: 0,
      deadR: G.DEAD_R,
      innerR: G.INNER_R,
      selectR: G.SELECT_R,
      deselectR: G.DESELECT_R,
      cooldownMs: T.REARM_MS,
      countdownMs: T.COUNTDOWN_MS,
    });
    setMenuConfig({ holdMs: "250", requireRelease: 1, bogus: 3, selectR: -1, cooldownMs: NaN });
    expect(menuConfig.holdMs).toBe(250);
    expect(menuConfig.requireRelease).toBe(true);
    expect(menuConfig.selectR).toBe(G.SELECT_R);
    expect(menuConfig.cooldownMs).toBe(T.REARM_MS);
    expect("bogus" in menuConfig).toBe(false);
    resetMenuConfig();
    expect({ ...menuConfig }).toEqual({ ...MENU_CONFIG_DEFAULTS });
  });

  base("requireRelease: crossing only selects (and can switch arcs); opening the hand confirms", () => {
    setMenuConfig({ requireRelease: true });
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    let res = r.run(64);
    expect(res.state).toBe("open");
    expect(res.selectedId).toBe("arp");
    expect(r.any("confirmed")).toBe(false);
    r.moveTo(0, -(G.SELECT_R + 0.1)); // past the radius on another arc: selection moves (no commit)
    expect(r.run(16).selectedId).toBe("chords");
    r.moveTo(G.SELECT_R + 0.1, 0);
    expect(r.run(16).selectedId).toBe("arp");
    r.h.fist = false;
    res = r.run(T.OPEN_DEBOUNCE_MS + 16);
    expect(r.results.find((x) => x.confirmed).confirmed).toBe("arp");
    expect(res.state).toBe("countdown");
  });

  base("requireRelease: opening with nothing selected cancels; on the current item = same-item", () => {
    setMenuConfig({ requireRelease: true });
    const r = rig();
    r.open();
    r.moveTo(APPROACH, 0);
    r.run(16);
    r.h.fist = false;
    r.run(T.OPEN_DEBOUNCE_MS + 16);
    expect(r.results.find((x) => x.cancelled).reason).toBe("empty");
    const q = rig({ current: "arp" });
    q.open();
    q.moveTo(G.SELECT_R + 0.1, 0);
    expect(q.run(32).state).toBe("open"); // crossing the current item does nothing yet
    q.h.fist = false;
    q.run(T.OPEN_DEBOUNCE_MS + 16);
    expect(q.results.find((x) => x.cancelled).reason).toBe("same-item");
  });

  base("holdMs: the fist must stay past the select radius; holdProgress fills; dropping inside restarts it", () => {
    setMenuConfig({ holdMs: 200 });
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    let snap = r.m.snapshot();
    expect(snap.holdId).toBe("arp");
    expect(snap.holdProgress).toBeGreaterThanOrEqual(0);
    r.run(112);
    snap = r.m.snapshot();
    expect(r.any("confirmed")).toBe(false);
    expect(snap.holdProgress).toBeGreaterThan(0.4);
    expect(snap.holdProgress).toBeLessThan(1);
    // back inside the radius (still selected through the hysteresis) -> the hold restarts
    r.moveTo((G.DESELECT_R + G.SELECT_R) / 2, 0);
    r.run(16);
    expect(r.m.snapshot().holdProgress).toBe(0);
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(160);
    expect(r.any("confirmed")).toBe(false); // 160 < 200 since the restart
    r.run(64);
    expect(r.results.find((x) => x.confirmed).confirmed).toBe("arp");
  });

  base("runtime changes take effect on the next frame (radius, hold, release flow, cooldown)", () => {
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R - 0.05, 0);
    expect(r.run(16).state).toBe("open");
    setMenuConfig({ selectR: G.SELECT_R - 0.1 }); // radius pulled in: the same position is now past it
    expect(r.run(16).confirmed).toBe("arp");
    resetMenuConfig();

    const q = rig();
    q.open();
    setMenuConfig({ requireRelease: true });
    q.moveTo(G.SELECT_R + 0.1, 0);
    expect(q.run(16).state).toBe("open");
    setMenuConfig({ requireRelease: false }); // switched back while selected: chosen on the next frame
    expect(q.run(16).confirmed).toBe("arp");

    setMenuConfig({ cooldownMs: 500 });
    q.run(T.FLASH_MS + T.COUNTDOWN_MS + 32); // closed, fist held
    q.moveTo(0, 0);
    const closedAt = q.m.snapshot().closedAt;
    q.run(500 + T.ENTER_STABLE_MS + 32);
    expect(q.results.at(-1).state).toBe("open");
    expect(q.now - closedAt).toBeLessThan(T.REARM_MS);
  });

  base("countdownMs: the chosen arc's fade (right hand held) lasts countdownMs after the flash", () => {
    setMenuConfig({ countdownMs: 100 });
    const r = rig();
    r.open();
    r.moveTo(G.SELECT_R + 0.1, 0);
    r.run(16);
    r.run(T.FLASH_MS + 100 - 32);
    expect(r.m.isHoldingRight()).toBe(true);
    r.run(48);
    expect(r.m.isHoldingRight()).toBe(false);
    expect(r.any("finished")).toBe(true);
  });
});
