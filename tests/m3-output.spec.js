// Milestone 3 step 3.3: the visualizer output hooked into the integrated app (real app, ?mockHands, + the demo
// visualizer /labs/visualizer.html in a second browser context). tests/output.spec.js covers the transport itself
// (chip states, channels, relay, zero work when off); this file covers what the modes UI + shared clock add:
//   - beat grid sent at once on clock start/stop/tempo/rate/double time; visualizer beats on the synth's audio clock
//   - fist menu -> /gs/menu (open, arc, progress, countdown, close) + /gs/mode, shown by the visualizer
//   - Arp notes: sent before their playTime, shown on time, on/off paired by id, note/cancel honored
//   - /gs/pinch 1/0, mode signals (Arp, Lead) in the manifest
//   - Q4 chrome (Controls Output row, chip) screenshots + a real-time video of switching to Arp
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { results, leftHand, rightHand, fist, pinch, DESKTOP_VIEW, setPlacementView } from "./helpers/hands.js";
import { createScreencast } from "./helpers/screencast.js";
import { installSynthLog, checkRender } from "./helpers/output-timing.js";
import { menuChosen } from "./helpers/m2-lead.js";

const SCREENS = "test-results/screens";
const VIDEOS = "test-results/videos";
const SIGNAL = `ws://localhost:${process.env.PW_SIGNAL_PORT}`;
const CODE_RE = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{2}$/;

// Tolerances (same as tests/output.spec.js, not widened):
const SHOW_LATE_MS = 40; //     scheduled note drawn after its play time (render-frame granularity; output.spec)
const BEAT_LATE_MS = 60; //     beat dot drawn after the beat (~3 frames under load; output.spec "beat grid")
// Visualizer time vs the synth's audio-clock time of the same beat/note (output.spec "beat grid" phase bound).
// Both sides convert AudioContext time with getOutputTimestamp(), whose (contextTime, performanceTime) pair
// jitters by a few ms per call under load (measured up to 12 ms between two calls in one task), plus the
// ping-measured clock offset (< 5 ms on one machine).
const GRID_PHASE_MS = 15;
// New: a clock change reaches the visualizer "at once". Before 3.3 it waited for the 2 s state resend.
// Measured on this machine (direct WebRTC, localhost): 1-6 ms idle, < 40 ms with the full suite running.
const GRID_SEND_MS = 250;

// Headless Chrome hides local IPs behind mDNS names; resolve them as plain host candidates (as output.spec).
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
    ],
  },
});
// Timing checks: keep these tests off each other's CPU.
// Full gate: this file's tests run one after another (its @full audio measurements stay off each other's CPU).
// Fast run (PW_TIER=fast, no @full tests here): parallel, so the file is not one long serial job.
test.describe.configure({ mode: process.env.PW_TIER === "fast" ? "parallel" : "default" });

// Display-space positions on the 1280x800 synth (DESKTOP_VIEW), same as m1-integration.spec.js.
const R0 = { x: 0.7, y: 0.42 }; // right hand home (screen right, as in real use)
const STEP = { right: [0.014, 0], left: [-0.014, 0], up: [0, -0.022], down: [0, 0.022] };
const at = (p) => ({ pos: p, view: DESKTOP_VIEW });
const openRight = (q = 1, p = R0, o = {}) => rightHand(q, { ...at(p), ...o });
const fistAt = (p = R0) => fist(at(p));
const LEFT = leftHand(1);

function report(name, obj) {
  console.log(`[m3 metrics] ${name}: ${JSON.stringify(obj)}`);
}

async function openSynth(browser) {
  const context = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 800 } });
  setPlacementView(DESKTOP_VIEW); // hand builders place `volume` in this page's view (reach zone)
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(`/?mockHands&signal=${encodeURIComponent(SIGNAL)}`);
  await page.locator("#startOverlay").click();
  await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0 && window.__gsTest.ctx.audio.ac);
  const setHands = (...hands) => page.evaluate((r) => (window.__gsTest.results = r), results(...hands));
  return { context, page, errors, setHands };
}

async function openViz(browser, code) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(`/labs/visualizer.html?room=${code}&signal=${encodeURIComponent(SIGNAL)}`);
  return { context, page, errors };
}

/** Output on through the Controls panel's Output row (Q4), panel closed again. Returns the room code. */
async function turnOnFromControls(page) {
  await page.locator("#controlsToggle").click();
  const row = page.locator('#controlsPanel [data-hook="output"]');
  await row.locator('[data-control="output"]').click();
  await expect(page.locator("#outputChip")).toHaveAttribute("data-state", "waiting");
  await expect(row.locator('[data-hook="output-code"]')).toHaveText(CODE_RE);
  const code = (await row.locator('[data-hook="output-code"]').textContent()).trim();
  await page.locator("#controlsToggle").click();
  return code;
}

/** Synth + connected visualizer (manifest and first snapshot received). */
async function connected(browser, { before } = {}) {
  const s = await openSynth(browser);
  await s.setHands(LEFT, openRight(1));
  if (before) await before(s);
  const code = await turnOnFromControls(s.page);
  const v = await openViz(browser, code);
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "connected", { timeout: 5000 });
  await expect.poll(() => v.page.evaluate(() => window.__viz.snapshots)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => v.page.evaluate(() => window.__viz.status?.synced)).toBe(true);
  return { s, v, code };
}

/** Fist at `from`, move toward `dir` until `expectId` is selected (null: stay in the center). Returns the point. */
async function fistSelect(page, setHands, { from = R0, dir = "right", steps = 10, expectId }) {
  await setHands(LEFT, fistAt(from));
  await expect.poll(async () => (await page.evaluate(() => window.__gsTest.bus.get("menu")))?.state, { timeout: 2000 }).toBe("open");
  let p = from;
  for (let i = 1; i <= steps; i++) {
    p = { x: from.x + STEP[dir][0] * i, y: from.y + STEP[dir][1] * i };
    await setHands(LEFT, fistAt(p));
    await page.waitForTimeout(35);
  }
  // Auto-select: crossing the select radius chooses the item at once (polled via the menu snapshot: the countdown
  // can be over before a bus poll sees it); expectId null = stayed in the centre zone, nothing selected.
  if (expectId) await expect.poll(() => menuChosen(page), { timeout: 2000 }).toBe(expectId);
  else await expect.poll(async () => (await page.evaluate(() => window.__gsTest.bus.get("menu")))?.selectedId ?? null, { timeout: 2000 }).toBe(null);
  return p;
}

/** Full gesture switch (fist, move, open hand); resolves once the menu is closed again. */
async function switchMode(page, setHands, { dir, expectId }) {
  const p = await fistSelect(page, setHands, { dir, expectId });
  await setHands(LEFT, openRight(1, p));
  await expect.poll(() => page.evaluate(() => window.__gsTest.bus.get("mode")), { timeout: 1000 }).toBe(expectId);
  await expect.poll(() => page.evaluate(() => window.__gsTest.bus.get("menu")), { timeout: 2000 }).toBe(null);
  return p;
}

test("fist menu: /gs/menu (open → arc + progress → countdown → close) and /gs/mode reach the visualizer", async ({ browser }) => {
  const { s, v } = await connected(browser);
  await expect(v.page.locator("#modeName")).toHaveText("Chords");
  await v.page.evaluate(() => { window.__viz.menuEvents.length = 0; window.__viz.modeLog.length = 0; });

  // 1. Open in the center and open the hand again: cancelled, the mode does not change.
  await fistSelect(s.page, s.setHands, { steps: 0, expectId: null });
  await expect.poll(() => v.page.evaluate(() => window.__viz.menu?.phase)).toBe("open");
  await expect(v.page.locator("#menuInfo")).toContainText("open");
  await s.setHands(LEFT, openRight(1));
  await expect.poll(() => v.page.evaluate(() => window.__viz.menuEvents.at(-1)?.phase)).toBe("close");
  const cancel = await v.page.evaluate(() => window.__viz.menuEvents.slice());
  expect(cancel[0]).toMatchObject({ phase: "open", state: "open" });
  expect(cancel.at(-1)).toMatchObject({ phase: "close", state: "closed", confirmed: null, cancelled: true });
  expect(await v.page.evaluate(() => window.__viz.modeLog.length)).toBe(0);
  await expect(v.page.locator("#menuInfo")).toHaveText("closed · cancelled");

  // 2. Fist, move right across Arp's select radius: Arp (the open hand afterwards changes nothing).
  await v.page.evaluate(() => { window.__viz.menuEvents.length = 0; });
  await switchMode(s.page, s.setHands, { dir: "right", expectId: "arp" });
  await expect.poll(() => v.page.evaluate(() => window.__viz.menuEvents.at(-1)?.phase)).toBe("close");
  const seq = await v.page.evaluate(() => ({ menu: window.__viz.menuEvents.slice(), modes: window.__viz.modeLog.slice() }));
  const phases = seq.menu.map((e) => e.phase);
  expect(phases[0]).toBe("open");
  expect(phases.at(-1)).toBe("close");
  expect(phases.filter((p) => p === "open").length).toBe(1);
  expect(phases.filter((p) => p === "countdown").length).toBe(1);
  // The arc under the fist moves to Arp and its progress fills; crossing the select radius chooses it at once
  // (auto-select: no separate "selected" update before the choice — the next event is the countdown).
  const updates = seq.menu.filter((e) => e.phase === "update" || e.phase === "open");
  expect(updates.some((e) => e.arc === "arp")).toBe(true);
  const arpProgress = updates.filter((e) => e.arc === "arp").map((e) => e.progress);
  for (let i = 1; i < arpProgress.length; i++) expect(arpProgress[i]).toBeGreaterThanOrEqual(arpProgress[i - 1]);
  expect(updates.some((e) => e.selected === "arp")).toBe(false);
  const iCountdown = phases.indexOf("countdown");
  expect(seq.menu[iCountdown]).toMatchObject({ state: "countdown", confirmed: "arp" });
  expect(phases.slice(iCountdown + 1, -1).every((p) => p === "update")).toBe(true);
  expect(seq.menu.at(-1)).toMatchObject({ phase: "close", confirmed: "arp", cancelled: false });
  for (const e of seq.menu) if (typeof e.progress === "number") expect(e.progress).toBeGreaterThanOrEqual(0), expect(e.progress).toBeLessThanOrEqual(1);
  // /gs/mode = arp arrives with the countdown (the router switches at its start): after "open", before "close".
  expect(seq.modes.map((m) => m.mode)).toEqual(["arp"]);
  const openAt = seq.menu[0].recvLocal;
  const closeAt = seq.menu.at(-1).recvLocal;
  expect(seq.modes[0].recvLocal).toBeGreaterThanOrEqual(openAt);
  expect(seq.modes[0].recvLocal).toBeLessThanOrEqual(closeAt);
  expect(Math.abs(seq.modes[0].recvLocal - seq.menu[iCountdown].recvLocal)).toBeLessThan(100);
  // The visualizer shows it.
  await expect(v.page.locator("#modeName")).toHaveText("Arp");
  await expect(v.page.locator("#modeName")).toHaveAttribute("data-mode", "arp");
  await expect(v.page.locator("#menuInfo")).toHaveText("closed · switched to arp");

  report("menu", { cancel: cancel.map((e) => e.phase), toArp: phases, events: seq.menu.length });
  expect(s.errors).toEqual([]);
  expect(v.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
});

test("beat grid: sent at once on clock start / tempo / rate / x2 / stop; visualizer beats on the synth's audio clock", { tag: "@full" }, async ({ browser }, info) => {
  const { s, v } = await connected(browser);
  await installSynthLog(s.page);
  expect(await v.page.evaluate(() => window.__viz.beatgrid?.running ?? false)).toBe(false);
  const vizEpoch = (local) => v.page.evaluate((l) => l + performance.timeOrigin, local);

  /** Runs `fn` in the synth, waits for the grid matching `pred`, returns {sendMs} (synth change -> viz receive). */
  async function gridAfter(fn, pred, label) {
    const n0 = await v.page.evaluate(() => window.__viz.beatgridLog.length);
    const t0 = await s.page.evaluate(fn);
    await v.page.waitForFunction(({ n0, pred }) => window.__viz.beatgridLog.slice(n0).some(new Function("g", `return ${pred}`)),
      { n0, pred }, { timeout: 3000 });
    const g = await v.page.evaluate(({ n0, pred }) => window.__viz.beatgridLog.slice(n0).find(new Function("g", `return ${pred}`)), { n0, pred });
    const sendMs = (await vizEpoch(g.recvLocal)) - t0;
    expect(sendMs, `${label}: grid after the change`).toBeLessThan(GRID_SEND_MS);
    return { g, sendMs };
  }
  const epochNow = "performance.timeOrigin + performance.now()";

  // Start: entering Arp starts the shared clock.
  const start = await gridAfter(`(() => { const t = ${epochNow}; window.__gsTest.router.setMode("arp"); return t; })()`,
    "g.running === true", "start");
  // The clock's very first beat (~60 ms after start) gets its dot, on time. The grid usually arrives before
  // that beat (measured 88-94 ms ahead idle); under full-suite load it can land a few ms after it, and the
  // visualizer still shows that beat (catch-up window = the beat-late bound).
  await expect.poll(() => s.page.evaluate(() => window.__m3.beats.length)).toBeGreaterThan(0);
  const firstBeat = await s.page.evaluate(() => window.__m3.beats[0]);
  const startRecvEpoch = await vizEpoch(start.g.recvLocal);
  await expect.poll(() => v.page.evaluate(() => window.__viz.beatsShown.filter((b) => !b.event).length)).toBeGreaterThan(0);
  const firstDot = await v.page.evaluate(() => {
    const b = window.__viz.beatsShown.find((x) => !x.event);
    return { beat: b.beat, epoch: b.local + performance.timeOrigin, expected: b.expected + performance.timeOrigin };
  });
  expect(firstDot.beat).toBe(0);
  expect(Math.abs(firstDot.expected - firstBeat.epoch)).toBeLessThan(GRID_PHASE_MS);
  // (when this dot was painted is the browser's frame timing: covered by the render check of the dots below)
  expect(start.g.bpm).toBe(await s.page.evaluate(() => window.__gsTest.ctx.clock.bpm));
  expect(Math.abs(start.g.beatTime - firstBeat.epoch)).toBeLessThan(GRID_PHASE_MS); // reference = the first beat
  expect(start.g.beat).toBe(0);

  // Tempo, rate, double time: each sends the grid at once.
  const tempo = await gridAfter(`(() => { const t = ${epochNow}; window.__gsTest.ctx.clock.bpm = 96; return t; })()`, "g.bpm === 96", "bpm");
  const rate = await gridAfter(`(() => { const t = ${epochNow}; window.__gsTest.ctx.clock.rate = 1/16; return t; })()`, "g.rate === 1/16", "rate");
  const dbl = await gridAfter(`(() => { const t = ${epochNow}; window.__gsTest.ctx.clock.doubleTime = true; return t; })()`, "g.double === true", "double");
  await expect(v.page.locator("#beatInfo")).toContainText("96 BPM");
  await expect(v.page.locator("#beatInfo .x2")).toHaveText("x2");

  // Beat dots vs the synth's audio-clock beats at the new tempo (each dot matched to the nearest synth beat).
  await v.page.evaluate(() => (window.__viz.beatsShown.length = 0));
  await v.page.waitForTimeout(3300); // ~5 beats at 96 BPM
  const shown = await v.page.evaluate(() => window.__viz.beatsShown.filter((b) => !b.event)
    .map((b) => ({ beat: b.beat, epoch: b.local + performance.timeOrigin, expected: b.expected + performance.timeOrigin,
      prevFrame: b.prevFrame + performance.timeOrigin })));
  const synthBeats = await s.page.evaluate(() => window.__m3.beats.slice());
  expect(shown.length).toBeGreaterThanOrEqual(4);
  const period = 60000 / 96;
  const longTasks = await v.page.evaluate(() => window.__viz.longTasks.slice());
  // The visualizer's own beat clock (computed beat times) vs the synth's audio-clock beats: the spec requirement.
  const matches = shown.map((b) => {
    const m = synthBeats.reduce((a, x) => (Math.abs(x.epoch - b.expected) < Math.abs(a.epoch - b.expected) ? x : a));
    return { late: b.epoch - m.epoch, gridErr: b.expected - m.epoch, vizBeat: b.beat, synthBeat: m.beat - 1 };
  });
  for (const m of matches) {
    expect(Math.abs(m.gridErr)).toBeLessThan(GRID_PHASE_MS);
    expect(m.vizBeat).toBe(m.synthBeat); // same beat of the bar
  }
  const intervals = shown.slice(1).map((b, i) => b.expected - shown[i].expected); // computed, not painted
  for (const d of intervals) expect(Math.abs(d - period)).toBeLessThan(GRID_PHASE_MS);
  // Painting: first frame at/after each beat; < BEAT_LATE_MS unless that frame itself was stalled (annotated).
  const stalls = checkRender(info, "beat dots", shown.map((b) => ({ due: b.expected, shown: b.epoch, prevFrame: b.prevFrame })),
    { lateMs: BEAT_LATE_MS, longTasks });

  // Stop: grid with running=false at once, dots stop.
  const stop = await gridAfter(`(() => { const t = ${epochNow}; window.__gsTest.ctx.clock.stop(); return t; })()`, "g.running === false", "stop");
  await expect(v.page.locator("#beatInfo")).toContainText("clock stopped");
  // (/gs/beat events already scheduled before the stop still fire at their play time; the grid dots stop.)
  const gridDots = () => v.page.evaluate(() => window.__viz.beatsShown.filter((b) => !b.event).length);
  const n = await gridDots();
  await v.page.waitForTimeout(period * 2);
  expect(await gridDots()).toBe(n);
  expect(await v.page.locator("#beats .b.on").count()).toBe(0);

  report("beat-grid", {
    sendMs: { start: +start.sendMs.toFixed(1), bpm: +tempo.sendMs.toFixed(1), rate: +rate.sendMs.toFixed(1),
      double: +dbl.sendMs.toFixed(1), stop: +stop.sendMs.toFixed(1) },
    startGridBeforeFirstBeatMs: +(firstBeat.epoch - startRecvEpoch).toFixed(1),
    beatShownLateMs: matches.map((m) => +m.late.toFixed(1)),
    gridErrMs: matches.map((m) => +m.gridErr.toFixed(2)),
    renderStalls: stalls.length,
  });
  expect(s.errors).toEqual([]);
  expect(v.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
});

test("Arp notes: sent before their playTime, shown on time, on/off paired by id, note/cancel honored", { tag: "@full" }, async ({ browser }, info) => {
  const { s, v } = await connected(browser);
  // Log first: entering Arp starts the clock, which schedules (and sends) its first notes right away.
  await installSynthLog(s.page);
  await v.page.evaluate(() => { window.__viz.notesShown.length = 0; window.__viz.cancels.length = 0; window.__viz.events.length = 0; });
  await s.page.evaluate(() => window.__gsTest.router.setMode("arp"));
  // 1/16 at 120 BPM: steps 125 ms apart, so chord changes catch scheduled-but-not-sounding steps (-> note/cancel).
  await s.page.evaluate(() => { window.__gsTest.ctx.clock.rate = 1 / 16; });
  const chords = [1, 4, 5, 6, 2, 5, 1, 4];
  for (const deg of chords) {
    await s.setHands(leftHand(deg), openRight(1));
    await s.page.waitForTimeout(330);
    if ((await s.page.evaluate(() => window.__m3.notes.filter((n) => n.n === "note/cancel").length)) >= 2) break;
  }
  await s.page.waitForTimeout(500);
  // Leave Arp: no new arp notes; every shown note must be switched off by its own note/off.
  await s.page.evaluate(() => window.__gsTest.router.setMode("chords"));
  await s.page.waitForTimeout(600);

  const synth = await s.page.evaluate(() => window.__m3.notes.filter((n) => n.voice === "arp"));
  const viz = await v.page.evaluate(() => ({
    shown: window.__viz.notesShown.filter((n) => n.voice === "arp").map((n) => ({ ...n, playEpoch: n.playLocal + performance.timeOrigin })),
    offs: window.__viz.events.filter((e) => e.a === "/gs/note/off" && e.v.voice === "arp").map((e) => e.v.id),
    cancels: window.__viz.cancels.slice(),
    activeArp: [...window.__viz.active.values()].filter((n) => n.voice === "arp").length,
    longTasks: window.__viz.longTasks.slice(),
  }));
  const ons = new Map(synth.filter((n) => n.n === "note/on").map((n) => [n.id, n]));
  const cancelled = new Set(synth.filter((n) => n.n === "note/cancel").map((n) => n.id));
  expect(viz.shown.length).toBeGreaterThanOrEqual(10);
  expect(cancelled.size).toBeGreaterThan(0); // the chord changes did re-decide scheduled steps

  const early = [];
  const late = [];
  for (const n of viz.shown) {
    expect(typeof n.id).toBe("number");
    const src = ons.get(n.id);
    expect(src, `note ${n.id} came from the synth`).toBeTruthy();
    expect(n.note).toBe(src.midi);
    // Play time on the shared clock = the synth's audio-clock time of that note.
    expect(Math.abs(n.playEpoch - src.epoch)).toBeLessThan(GRID_PHASE_MS);
    early.push(n.playLocal - n.recvLocal);
    late.push(n.shownLocal - n.playLocal);
    expect(n.playLocal - n.recvLocal, "arrived before its play time").toBeGreaterThan(0);
    expect(viz.offs, `note/off for ${n.id}`).toContain(n.id);
    expect(cancelled.has(n.id), `cancelled note ${n.id} was shown`).toBe(false);
  }
  // Every cancel reached the visualizer and removed the pending note (+ its off) before it played.
  const vizCancelled = new Set(viz.cancels.map((c) => c.id));
  for (const id of cancelled) expect(vizCancelled.has(id)).toBe(true);
  for (const c of viz.cancels) expect(c.removed).toBeGreaterThan(0);
  expect(viz.activeArp).toBe(0);
  // Painting: each note in the first frame at/after its play time, < 40 ms (output.spec single-note bound) unless
  // that frame itself was stalled by a starved main thread (annotated "render-stall").
  const lateSorted = [...late].sort((a, b) => a - b);
  const stalls = checkRender(info, "arp notes", viz.shown.map((n) => ({ due: n.playLocal, shown: n.shownLocal, prevFrame: n.prevFrame })),
    { lateMs: SHOW_LATE_MS, longTasks: viz.longTasks });
  // ~100 ms lookahead (+ output latency, since playTime = when the sound is heard). Measured median 120-128 ms;
  // 50 ms = the single-note bound of output.spec.
  const sorted = [...early].sort((a, b) => a - b);
  expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThan(50);

  report("arp-notes", {
    shown: viz.shown.length, cancels: cancelled.size,
    arrivedEarlyMs: { min: +sorted[0].toFixed(1), median: +sorted[Math.floor(sorted.length / 2)].toFixed(1), max: +sorted.at(-1).toFixed(1) },
    shownLateMs: { median: +lateSorted[Math.floor(lateSorted.length / 2)].toFixed(1), max: +Math.max(...late).toFixed(1) },
    renderStalls: stalls.length,
  });
  expect(s.errors).toEqual([]);
  expect(v.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
});

test("manifest lists the mode signals; /gs/pinch 1/0; Lead noteset/octave reach the visualizer", async ({ browser }) => {
  const { s, v } = await connected(browser, {
    // Lead joins the app in M2 integration (in flight); register it here if main.js does not yet.
    before: (s) => s.page.evaluate(async () => {
      const { registry } = await import("/src/core/registry.js");
      if (!registry.getMode("lead")) registry.registerMode((await import("/src/modes/lead.js")).default);
    }),
  });
  const manifest = await v.page.evaluate(() => window.__viz.manifest);
  const byAddr = Object.fromEntries(manifest.map((m) => [m.address, m]));
  const expectSig = (addr, type, owner) => {
    expect(byAddr[addr], addr).toBeTruthy();
    expect(byAddr[addr].type, addr).toBe(type);
    if (owner) expect(byAddr[addr].owner, addr).toBe(owner);
  };
  // Spec tables: continuous / state / events.
  expectSig("/gs/volume", "continuous");
  expectSig("/gs/filter", "continuous");
  expectSig("/gs/gate", "continuous", "arp");
  expectSig("/gs/mode", "state", "router");
  expectSig("/gs/layer", "state", "router"); // Lead layer on top of the base mode
  expectSig("/gs/chord", "state");
  expectSig("/gs/voicing", "state");
  expectSig("/gs/noteset", "state", "lead");
  expectSig("/gs/octave", "state", "lead");
  expectSig("/gs/bpm", "state", "clock");
  expectSig("/gs/note/on", "event");
  expectSig("/gs/note/off", "event");
  expectSig("/gs/note/cancel", "event");
  expectSig("/gs/beat", "event", "clock");
  expectSig("/gs/pinch", "event");
  expectSig("/gs/menu", "event", "router"); // a bus state, an event on the wire (spec)
  // The bus's own `pinch` event if it has one, else derived by the output from right/pinch.
  const busHasPinch = await s.page.evaluate(() => window.__gsTest.bus.manifest().some((m) => m.name === "pinch"));
  if (!busHasPinch) expect(byAddr["/gs/pinch"]).toMatchObject({ owner: "output", derivedFrom: "right/pinch" });

  // Pinch in Arp (tempo gesture): 1 at the start, 0 at the release.
  await s.page.evaluate(() => window.__gsTest.router.setMode("arp"));
  await v.page.evaluate(() => (window.__viz.pinchEvents.length = 0));
  await s.setHands(LEFT, pinch(at(R0)));
  await expect.poll(() => s.page.evaluate(() => window.__gsTest.bus.get("right/pinch"))).toBe(true);
  await expect.poll(() => v.page.evaluate(() => window.__viz.pinchEvents.map((e) => e.v))).toEqual([1]);
  await expect(v.page.locator("#pinch")).toHaveText("on");
  await s.setHands(LEFT, openRight(1));
  await expect.poll(() => v.page.evaluate(() => window.__viz.pinchEvents.map((e) => e.v))).toEqual([1, 0]);
  await expect(v.page.locator("#pinch")).toHaveText("off");
  const pinchEv = await v.page.evaluate(() => window.__viz.events.filter((e) => e.a === "/gs/pinch"));
  for (const e of pinchEv) expect(e.ch).toBe("reliable");

  // Lead: a layer on top of Arp. /gs/mode stays the base, /gs/layer = "lead"; note set and octave are sent (on enter
  // and on change) and shown; the visualizer shows "Arp + Lead".
  await s.page.evaluate(() => window.__gsTest.router.setMode("lead"));
  await expect.poll(() => v.page.evaluate(() => window.__viz.state["/gs/layer"])).toBe("lead");
  expect(await v.page.evaluate(() => window.__viz.state["/gs/mode"])).toBe("arp");
  const synthLead = await s.page.evaluate(() => ({ set: window.__gsTest.bus.get("lead/noteset"), oct: window.__gsTest.bus.get("lead/octave") }));
  expect(typeof synthLead.set).not.toBe("undefined");
  await expect.poll(() => v.page.evaluate(() => window.__viz.state["/gs/noteset"])).toEqual(synthLead.set);
  await expect.poll(() => v.page.evaluate(() => window.__viz.state["/gs/octave"])).toEqual(synthLead.oct);
  await expect(v.page.locator("#modeName")).toHaveText("Arp + Lead");
  await expect(v.page.locator("#modeName")).toHaveAttribute("data-layer", "lead");
  await v.page.locator("#modeBox").screenshot({ path: `${SCREENS}/layer-visualizer.png` });
  await expect(v.page.locator("#modeSub")).toContainText("note set");
  await expect(v.page.locator("#modeSub")).toContainText("octave");
  // Layer off by choosing the base: /gs/layer back to null.
  await s.page.evaluate(() => window.__gsTest.router.setMode("arp"));
  await expect.poll(() => v.page.evaluate(() => window.__viz.state["/gs/layer"] ?? null)).toBe(null);
  await expect(v.page.locator("#modeName")).toHaveText("Arp");

  expect(s.errors).toEqual([]);
  expect(v.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
});

test("screens: Controls Output row, chip waiting/connected, visualizer following Arp", async ({ browser }) => {
  const s = await openSynth(browser);
  await s.setHands(LEFT, openRight(1));
  // Off: chip hidden, the Output row is the setting.
  await expect(s.page.locator("#outputChip")).toBeHidden();
  await s.page.locator("#controlsToggle").click();
  const row = s.page.locator('#controlsPanel [data-hook="output"]');
  await row.locator('[data-control="output"]').click();
  await expect(row.locator('[data-hook="output-code"]')).toHaveText(CODE_RE);
  await expect(row.locator('[data-hook="output-status"]')).toHaveText("Waiting for a visualizer");
  await s.page.locator("#controlsPanel").screenshot({ path: `${SCREENS}/m3-controls-output-row.png` });
  const code = (await row.locator('[data-hook="output-code"]').textContent()).trim();
  await s.page.locator("#controlsToggle").click();
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "waiting");
  const topRight = { x: 1280 - 520, y: 0, width: 520, height: 140 };
  await s.page.screenshot({ path: `${SCREENS}/m3-chip-waiting.png`, clip: topRight });

  const v = await openViz(browser, code);
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "connected", { timeout: 5000 });
  await expect(s.page.locator("#outputChip .label")).toHaveText(/^Direct, \d+ ms$/);
  await s.page.screenshot({ path: `${SCREENS}/m3-chip-connected.png`, clip: topRight });
  // Chip press -> Controls panel (Q4).
  await s.page.locator("#outputChip").click();
  await expect(s.page.locator("#controlsPanel")).toBeVisible();
  await expect(row.locator('[data-hook="output-status"]')).toHaveText(/^Direct · \d+ ms$/);
  await s.page.locator("#controlsPanel").screenshot({ path: `${SCREENS}/m3-controls-output-row-connected.png` });
  await s.page.locator("#controlsToggle").click();

  await switchMode(s.page, s.setHands, { dir: "right", expectId: "arp" });
  await s.setHands(leftHand(4), openRight(3, R0, { volume: 0.7 }));
  await expect(v.page.locator("#modeName")).toHaveText("Arp");
  await expect.poll(() => v.page.evaluate(() => window.__viz.notesShown.filter((n) => n.voice === "arp").length)).toBeGreaterThan(4);
  await expect.poll(() => v.page.locator("#beats .b.on").count()).toBe(1);
  await v.page.screenshot({ path: `${SCREENS}/m3-visualizer-arp.png` });
  await s.page.screenshot({ path: `${SCREENS}/m3-synth-arp.png` });
  expect(s.errors).toEqual([]);
  expect(v.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
});

test("video: switching to Arp with the fist menu while the visualizer follows (m3-visualizer.webm)", { tag: "@media" }, async ({ browser }) => {
  test.setTimeout(90_000);
  const rec = createScreencast();
  const s = await openSynth(browser);
  await s.setHands(LEFT, openRight(1));
  const code = await turnOnFromControls(s.page);
  const v = await openViz(browser, code);
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "connected", { timeout: 5000 });
  await rec.track(s.page, "synth");
  await rec.track(v.page, "viz");
  const hold = (ms) => s.page.waitForTimeout(ms); // real time: the video shows the gestures at their speed

  for (const [deg, q] of [[1, 1], [4, 2], [5, 3]]) {
    await s.setHands(leftHand(deg), openRight(q));
    await hold(600);
  }
  // Fist -> menu opens (visualizer ring), move onto Arp, hold, open the hand -> countdown -> Arp.
  const p = await fistSelect(s.page, s.setHands, { dir: "right", expectId: "arp" });
  await hold(500);
  await s.setHands(leftHand(5), openRight(3, p));
  await expect.poll(() => v.page.evaluate(() => window.__viz.state["/gs/mode"])).toBe("arp");
  for (const [deg, q, vol] of [[5, 3, 0.7], [6, 2, 0.5], [4, 4, 0.8], [1, 3, 0.6], [5, 2, 0.9]]) {
    await s.setHands(leftHand(deg, { minor: deg === 6 }), openRight(q, R0, { volume: vol }));
    await hold(900);
  }
  // Back to Chords (up). The shared clock keeps running (Arp never stops it), so the beat dots continue.
  await switchMode(s.page, s.setHands, { dir: "up", expectId: "chords" });
  await hold(1200);
  await expect(v.page.locator("#modeName")).toHaveText("Chords");
  await rec.untrack(v.page);
  await rec.untrack(s.page);
  expect(s.errors).toEqual([]);
  expect(v.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
  const out = await rec.save(browser, `${VIDEOS}/m3-visualizer.webm`, { layout: ["synth", "viz"] });
  report("video", out);
  expect(fs.statSync(out.file).size).toBeGreaterThan(50_000);
});
