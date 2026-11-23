// Milestone 3: WebRTC output to a remote visualizer.
// Two browser contexts: the synth (/?mockHands) and the demo visualizer (/labs/visualizer.html).
// The signaling server is started by playwright.config.js (webServer, port PW_SIGNAL_PORT).
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { results, leftHand, rightHand } from "./helpers/hands.js";
import { createScreencast } from "./helpers/screencast.js";

const SCREENS = "test-results/screens";
const VIDEOS = "test-results/videos";
const SIGNAL = `ws://localhost:${process.env.PW_SIGNAL_PORT}`;
const CODE_RE = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{2}$/;
// On-screen indicators (src/ui/indicators.js) are the one consumer that always exists.
// On-screen consumers: indicators.js (chord, chords/octave, filter, voicing, volume) and the modes UI
// (src/ui/mode-ui.js: `mode`, plus the right-track param, = volume in Chords). Everything else is read with bus.get().
const INDICATOR_SIGNALS = ["chord", "chords/octave", "filter", "mode", "voicing", "volume"];

// Headless Chrome hides local IPs behind mDNS names; resolve them as plain host candidates.
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

const metrics = {}; // collected numbers, printed at the end of each test for the report
function report(name, obj) {
  metrics[name] = obj;
  console.log(`[output metrics] ${name}: ${JSON.stringify(obj)}`);
}

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  return errors;
}

async function openSynth(browser, { relay = false } = {}) {
  const context = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(`/?mockHands&signal=${encodeURIComponent(SIGNAL)}${relay ? "&outputRelay" : ""}`);
  await page.locator("#startOverlay").click();
  await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0);
  const setHands = (...hands) => page.evaluate((r) => (window.__gsTest.results = r), results(...hands));
  return { context, page, errors, requests, setHands };
}

async function turnOn(page) {
  await page.evaluate(() => window.__gsTest.output.setOutput(true));
  await expect(page.locator("#outputChip")).toHaveAttribute("data-state", "waiting");
  await expect(page.locator("#outputChip .label")).toHaveText(/^Code /);
  const code = (await page.locator("#outputChip .label").textContent()).replace("Code ", "");
  expect(code).toMatch(CODE_RE);
  return code;
}

async function openViz(browser, code) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`/labs/visualizer.html?room=${code}&signal=${encodeURIComponent(SIGNAL)}`);
  return { context, page, errors };
}

const chipShot = (page, state) =>
  page.screenshot({ path: `${SCREENS}/output-chip-${state}.png`, clip: { x: 1280 - 420, y: 0, width: 420, height: 260 } });

/** Waits for the chip state and returns how long after the visualizer joined it changed (ms). */
async function chipLatency(synth, viz, state) {
  await expect(synth.locator("#outputChip")).toHaveAttribute("data-state", state, { timeout: 5000 });
  const changedAt = await synth.evaluate(() => window.__gsTest.output.stateChangedAt);
  const joinedAt = await viz.evaluate(() => window.__viz.joinedAt);
  return changedAt - joinedAt;
}

test("chip: off → waiting → connected (< 1 s) → waiting on disconnect → reconnect", async ({ browser }) => {
  const s = await openSynth(browser);
  await s.setHands(leftHand(1), rightHand(1, { volume: 0.5 }));
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "off");
  await expect(s.page.locator("#outputChip .label")).toHaveText("Output off");
  await chipShot(s.page, "off");

  const code = await turnOn(s.page);
  await chipShot(s.page, "waiting");

  // Connect
  const v1 = await openViz(browser, code);
  const connectMs = await chipLatency(s.page, v1.page, "connected");
  expect(connectMs).toBeLessThan(1000);
  await expect(s.page.locator("#outputChip .label")).toHaveText(/^Direct, \d+ ms$/);
  await expect(v1.page.locator("#conn")).toHaveAttribute("data-state", "direct");
  await chipShot(s.page, "connected");

  // The delay number moves at most once a second.
  const samples = [];
  for (let i = 0; i < 25; i++) {
    samples.push(await s.page.locator("#outputChip .label").textContent());
    await s.page.waitForTimeout(100);
  }
  const changes = samples.filter((x, i) => i && x !== samples[i - 1]).length;
  expect(changes).toBeLessThanOrEqual(3);

  // Disconnect the visualizer -> back to Waiting (room code shown again); the music keeps going.
  const t0 = Date.now();
  await v1.context.close();
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "waiting", { timeout: 5000 });
  const disconnectMs = Date.now() - t0;
  await expect(s.page.locator("#outputChip .label")).toHaveText(`Code ${code}`);
  expect(await s.page.evaluate(() => window.__gsTest.output.output.attached)).toBe(false);
  expect(await s.page.evaluate(() => window.__gsTest.synth.ctx.state)).toBe("running");
  expect(await s.page.evaluate(() => window.__gsTest.synth.oscillators.length)).toBeGreaterThan(0);

  // Reconnect with the same code.
  const v2 = await openViz(browser, code);
  const reconnectMs = await chipLatency(s.page, v2.page, "connected");
  expect(reconnectMs).toBeLessThan(1000);
  await expect.poll(() => v2.page.evaluate(() => window.__viz.manifest.length)).toBeGreaterThan(0);

  // Popover: output on/off + room code
  await s.page.locator("#outputChip").click();
  await expect(s.page.locator("#outputPopover")).toBeVisible();
  await expect(s.page.locator("#outputRoomCode")).toHaveText(code);
  await expect(s.page.locator("#outputToggle")).toBeChecked();
  await s.page.screenshot({ path: `${SCREENS}/output-chip-popover.png`, clip: { x: 1280 - 420, y: 0, width: 420, height: 420 } });
  // Turning it off from the popover: chip off, visualizer drops to waiting.
  await s.page.locator("#outputToggle").uncheck();
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "off");
  await expect(v2.page.locator("#conn")).not.toHaveAttribute("data-state", "direct", { timeout: 5000 });

  report("chip-latency", { connectMs, disconnectMs, reconnectMs, delayLabelChangesIn2_5s: changes });
  expect(s.errors).toEqual([]);
  expect(v2.errors).toEqual([]);
  await v2.context.close();
  await s.context.close();
});

test("visualizer gets manifest, full state, fast frames, timed events, periodic state, clock sync", async ({ browser }) => {
  const s = await openSynth(browser);
  // Chord set BEFORE the visualizer connects: must show up from the connect snapshot.
  await s.setHands(leftHand(4), rightHand(3, { volume: 0.75, tilt: 0.5 }));
  await expect(s.page.locator("#chordDisplay")).toHaveText("D(IV)");
  const code = await turnOn(s.page);
  const v = await openViz(browser, code);
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "connected");

  // Manifest + snapshot
  await expect.poll(() => v.page.evaluate(() => window.__viz.snapshots)).toBeGreaterThanOrEqual(1);
  const first = await v.page.evaluate(() => ({
    hello: window.__viz.hello,
    manifest: window.__viz.manifest,
    chord: window.__viz.state["/gs/chord"],
    voicing: window.__viz.state["/gs/voicing"],
    mode: window.__viz.state["/gs/mode"],
    channelOfState: window.__viz.channelOf["/gs/sys/state"],
  }));
  expect(first.hello).toMatchObject({ app: "gesture-synth", transport: "direct" });
  const byAddr = Object.fromEntries(first.manifest.map((m) => [m.address, m]));
  expect(byAddr["/gs/chord"]).toMatchObject({ name: "chord", type: "state" });
  expect(byAddr["/gs/volume"]).toMatchObject({ name: "volume", type: "continuous" });
  expect(byAddr["/gs/right/pos"]).toMatchObject({ type: "continuous", owner: "hand-input" });
  expect(byAddr["/gs/note/on"]).toMatchObject({ type: "event", owner: "audio" });
  expect(first.chord).toMatchObject({ name: "D", degree: 4, major: true, roman: "IV" });
  expect(typeof first.chord.root).toBe("number");
  expect(first.voicing).toBe(3);
  expect(first.mode).toBe("chords");
  expect(first.channelOfState).toBe("reliable");

  // Continuous values on the fast channel, one batched message per frame.
  await s.setHands(leftHand(4), rightHand(3, { volume: 0.4, tilt: -0.5 }));
  await expect.poll(() => v.page.evaluate(() => window.__viz.frames), { timeout: 3000 }).toBeGreaterThan(10);
  const cont = await v.page.evaluate(() => ({
    ch: window.__viz.channelOf["/gs/sys/frame"],
    pos: window.__viz.cont["/gs/right/pos"],
    volume: window.__viz.cont["/gs/volume"],
    filter: window.__viz.cont["/gs/filter"],
    maxKeys: window.__viz.maxFrameKeys,
  }));
  expect(cont.ch).toBe("fast");
  expect(Array.isArray(cont.pos) && cont.pos.length === 2).toBe(true);
  expect(cont.volume).toBeCloseTo(0.4, 1);
  expect(cont.filter).toBeCloseTo(-0.5, 1);
  expect(cont.maxKeys).toBeGreaterThanOrEqual(3); // several values batched in one message

  // Hand movement -> visualizer: measure input-to-visualizer delay for live values.
  const liveDelay = await (async () => {
    const out = [];
    for (const vol of [0.2, 0.9, 0.3, 0.8, 0.5]) {
      const t0 = await s.page.evaluate((r) => { window.__gsTest.results = r; return Date.now(); }, results(leftHand(4), rightHand(3, { volume: vol })));
      await v.page.waitForFunction((vol) => Math.abs((window.__viz.cont["/gs/volume"] ?? -1) - vol) < 0.02, vol);
      out.push(Date.now() - t0);
    }
    return out;
  })();

  // State change -> reliable channel, events with playTime.
  await v.page.evaluate(() => (window.__viz.events.length = 0));
  await s.setHands(leftHand(5), rightHand(1, { volume: 0.6 }));
  await expect.poll(() => v.page.evaluate(() => window.__viz.state["/gs/chord"]?.name)).toBe("E");
  const expectedMidi = await s.page.evaluate(() =>
    window.__gsTest.synth.oscillators.map((o) => Math.round(69 + 12 * Math.log2(o.frequency.value / 440))));
  await expect.poll(() => v.page.evaluate(() => window.__viz.events.filter((e) => e.a === "/gs/note/on").length))
    .toBeGreaterThanOrEqual(expectedMidi.length);
  const evs = await v.page.evaluate((n) => window.__viz.events.filter((e) => e.a === "/gs/note/on").slice(-n), expectedMidi.length);
  expect(evs.map((e) => e.v.note).sort()).toEqual([...expectedMidi].sort());
  for (const e of evs) {
    expect(e.ch).toBe("reliable");
    expect(e.v.voice).toBe("chords");
    expect(typeof e.t).toBe("number");
    expect(Math.abs(e.t - e.at)).toBeLessThan(200); // playTime on the shared clock, near "now" for live chords
  }

  // Scheduled note (like the Arp: sent ~100 ms before it plays) is shown at its play time.
  await v.page.evaluate(() => (window.__viz.notesShown.length = 0));
  await s.page.evaluate(() => {
    const ac = window.__gsTest.synth.ctx;
    window.__gsTest.synth.noteOn(880, ac.currentTime + 0.1, 0.08, { voice: "arp" });
  });
  await expect.poll(() => v.page.evaluate(() => window.__viz.notesShown.filter((n) => n.voice === "arp").length)).toBe(1);
  const arp = await v.page.evaluate(() => window.__viz.notesShown.find((n) => n.voice === "arp"));
  expect(arp.note).toBe(81);
  const earlyMs = arp.playLocal - arp.recvLocal; // how early it arrived
  const showErrMs = arp.shownLocal - arp.playLocal; // shown vs scheduled (render frame granularity)
  expect(earlyMs).toBeGreaterThan(50);
  expect(showErrMs).toBeGreaterThanOrEqual(0);
  expect(showErrMs).toBeLessThan(40);

  // Periodic state every 2 s.
  const snaps0 = await v.page.evaluate(() => window.__viz.snapshots);
  await v.page.waitForTimeout(4300);
  const snaps1 = await v.page.evaluate(() => window.__viz.snapshots);
  expect(snaps1 - snaps0).toBeGreaterThanOrEqual(2);

  // Clock sync (same machine: offset ~0, RTT small).
  const vs = await v.page.evaluate(() => window.__viz.status);
  const hs = await s.page.evaluate(() => window.__gsTest.output.output.stats());
  expect(vs.synced).toBe(true);
  expect(Math.abs(vs.offsetMs)).toBeLessThan(5);
  expect(vs.rttMs).toBeLessThan(30);
  const frames = await v.page.evaluate(() => ({ frames: window.__viz.frames, missed: window.__viz.framesMissed }));

  await v.page.screenshot({ path: `${SCREENS}/visualizer.png` });
  report("sync", {
    viewerRttMs: +vs.rttMs.toFixed(2), viewerOffsetMs: +vs.offsetMs.toFixed(2),
    hostRttMs: +hs.peers[0].rttMs.toFixed(2), hostOffsetMs: +hs.peers[0].offsetMs.toFixed(2),
    liveInputToVisualizerMs: liveDelay,
    scheduledNoteArrivedEarlyMs: +earlyMs.toFixed(1), scheduledNoteShownLateMs: +showErrMs.toFixed(1),
    frames: frames.frames, framesDropped: frames.missed,
    snapshotsIn4_3s: snaps1 - snaps0,
  });
  expect(s.errors).toEqual([]);
  expect(v.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
});

test("beat grid lights up when ctx.clock exists; visualizer beats follow the synth clock", async ({ browser }) => {
  const s = await openSynth(browser);
  await s.setHands(leftHand(1), rightHand(1, { volume: 0.5 }));
  const code = await turnOn(s.page);
  const v = await openViz(browser, code);
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "connected");
  await expect.poll(() => v.page.evaluate(() => window.__viz.snapshots)).toBeGreaterThanOrEqual(1);
  expect(await v.page.evaluate(() => window.__viz.beatgrid)).toBeNull(); // no clock yet (ctx.clock === null)

  // Stand-in for the Arp clock (milestone 1): 120 BPM on the AudioContext timeline.
  await s.page.evaluate(() => {
    const ac = window.__gsTest.synth.ctx;
    const period = 0.5;
    window.__gsTest.ctx.clock = {
      bpm: 120,
      beatsPerBar: 4,
      nextBeatTime: () => Math.ceil(ac.currentTime / period) * period,
      beatAt: (t) => Math.round(t / period),
    };
    window.__gsTest.bus.declare("bpm", { type: "state", owner: "clock" });
    window.__gsTest.bus.set("bpm", 120);
  });
  await expect.poll(() => v.page.evaluate(() => window.__viz.beatgrid?.bpm)).toBe(120);
  expect(await v.page.evaluate(() => window.__viz.state["/gs/bpm"])).toBe(120);
  await v.page.evaluate(() => (window.__viz.beatsShown.length = 0));
  await v.page.waitForTimeout(2600);
  const beats = await v.page.evaluate(() => window.__viz.beatsShown.filter((b) => !b.event));
  expect(beats.length).toBeGreaterThanOrEqual(4);
  const intervals = beats.slice(1).map((b, i) => b.local - beats[i].local);
  // Beats are drawn on render frames: allow ~3 frames of jitter (CI machines run many pages at once).
  for (const d of intervals) expect(Math.abs(d - 500)).toBeLessThan(60);
  const lateness = beats.map((b) => b.local - b.expected);
  for (const l of lateness) expect(l).toBeLessThan(60);
  // Beat index cycles through the bar.
  const idx = beats.map((b) => b.beat);
  for (let i = 1; i < idx.length; i++) expect(idx[i]).toBe((idx[i - 1] + 1) % 4);

  // The grid matches the synth's AudioContext beats (converted to wall clock on both sides).
  // Best of a few samples: each side's read is itself delayed by test-harness scheduling.
  let phaseErrMs = Infinity;
  for (let k = 0; k < 5; k++) {
    const vizBeatEpoch = await v.page.evaluate(() => {
      const bg = window.__viz.beatgrid;
      return window.__viz.client.toLocal(bg.beatTime) + performance.timeOrigin;
    });
    const synthBeatEpoch = await s.page.evaluate(() => {
      const ac = window.__gsTest.synth.ctx;
      const ts = ac.getOutputTimestamp();
      const next = Math.ceil(ac.currentTime / 0.5) * 0.5;
      return performance.timeOrigin + ts.performanceTime + (next - ts.contextTime) * 1000;
    });
    const phaseErr = (((synthBeatEpoch - vizBeatEpoch) % 500) + 500) % 500;
    phaseErrMs = Math.min(phaseErrMs, phaseErr, 500 - phaseErr);
    await v.page.waitForTimeout(150);
  }
  expect(phaseErrMs).toBeLessThan(15);

  report("beat-grid", {
    beatIntervalsMs: intervals.map((d) => +d.toFixed(1)),
    beatShownLateMs: lateness.map((d) => +d.toFixed(1)),
    gridPhaseErrorVsSynthMs: +phaseErrMs.toFixed(2),
  });
  expect(s.errors).toEqual([]);
  expect(v.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
});

test("relay fallback: forced relay connects, chip shows Relayed (amber), data flows", async ({ browser }) => {
  const s = await openSynth(browser, { relay: true });
  await s.setHands(leftHand(6, { minor: true }), rightHand(2, { volume: 0.6 }));
  await expect(s.page.locator("#chordDisplay")).toHaveText("F#m(vi)");
  const code = await turnOn(s.page);
  const v = await openViz(browser, code);
  const connectMs = await chipLatency(s.page, v.page, "relayed");
  expect(connectMs).toBeLessThan(1000);
  await expect(s.page.locator("#outputChip .label")).toHaveText(/^Relayed, \d+ ms$/);
  const color = await s.page.locator("#outputChip .dot").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(color).toBe("rgb(232, 161, 61)"); // amber
  await expect(v.page.locator("#conn")).toHaveAttribute("data-state", "relay");
  await chipShot(s.page, "relayed");

  await expect.poll(() => v.page.evaluate(() => window.__viz.state["/gs/chord"]?.name)).toBe("F#m");
  await expect.poll(() => v.page.evaluate(() => window.__viz.frames)).toBeGreaterThan(10);
  expect(await v.page.evaluate(() => window.__viz.hello.transport)).toBe("relay");
  expect(await v.page.evaluate(() => window.__viz.channelOf["/gs/sys/frame"])).toBe("fast");
  await s.setHands(leftHand(2), rightHand(2, { volume: 0.6 }));
  await expect.poll(() => v.page.evaluate(() => window.__viz.events.filter((e) => e.a === "/gs/note/on").length)).toBeGreaterThan(0);
  await expect.poll(() => v.page.evaluate(() => window.__viz.status.synced)).toBe(true);
  const st = await v.page.evaluate(() => window.__viz.status);

  // Disconnect -> waiting; reconnect -> relayed again.
  await v.context.close();
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "waiting", { timeout: 5000 });
  const v2 = await openViz(browser, code);
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "relayed", { timeout: 5000 });
  report("relay", { connectMs, rttMs: +st.rttMs.toFixed(2), offsetMs: +st.offsetMs.toFixed(2) });
  expect(s.errors).toEqual([]);
  await v2.context.close();
  await s.context.close();
});

test("output off: no module load, no bus subscription, no extra frame cost", async ({ browser }) => {
  const s = await openSynth(browser);
  await s.setHands(leftHand(3), rightHand(2, { volume: 0.6, tilt: 0.3 }));
  await expect(s.page.locator("#chordDisplay")).toHaveText("C#(III)");
  await s.page.waitForTimeout(500);

  // The chip is loaded (so the check below is meaningful), the output module is not.
  expect(s.requests.some((u) => u.includes("/src/output/status-chip.js"))).toBe(true);
  expect(s.requests.some((u) => u.includes("webrtc-output"))).toBe(false);
  expect(await s.page.evaluate(() => window.__gsTest.output.output)).toBeNull();

  const wanted = () =>
    s.page.evaluate(() => {
      const bus = window.__gsTest.bus;
      return bus.manifest().map((m) => m.name).filter((n) => bus.wants(n)).sort();
    });
  // Only the on-screen indicators consume the bus; nothing else (wants() false for every other name).
  const allNames = await s.page.evaluate(() => window.__gsTest.bus.manifest().map((m) => m.name));
  expect(allNames.length).toBeGreaterThan(10);
  expect(await wanted()).toEqual(INDICATOR_SIGNALS);

  // Frame cost of the real per-frame pipeline (hand input -> router -> mode -> bus), off.
  const measure = () =>
    s.page.evaluate(() => {
      const { handInput, router, results } = window.__gsTest;
      const batch = () => {
        const t0 = performance.now();
        for (let i = 0; i < 400; i++) {
          const { left, right } = handInput.process(results, t0 + i);
          router.update(left, right, t0 + i);
        }
        return (performance.now() - t0) / 400;
      };
      for (let i = 0; i < 3; i++) batch(); // warm up
      const runs = Array.from({ length: 9 }, batch).sort((a, b) => a - b);
      return runs[0]; // best-of-9 ms per frame (least disturbed by other processes)
    });
  const rafInterval = () =>
    s.page.evaluate(() => new Promise((res) => {
      const ts = [];
      const f = (t) => { ts.push(t); if (ts.length < 61) requestAnimationFrame(f); else res((ts[60] - ts[0]) / 60); };
      requestAnimationFrame(f);
    }));
  const offNever = await measure();
  const rafOff = await rafInterval();

  // On (waiting, nobody connected): still no subscription — the output attaches only on connection.
  const code = await turnOn(s.page);
  expect(s.requests.some((u) => u.includes("webrtc-output"))).toBe(true); // lazy-loaded now
  expect(await wanted()).toEqual(INDICATOR_SIGNALS);
  const waiting = await measure();

  // Connected: every signal is consumed.
  const v = await openViz(browser, code);
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "connected");
  expect((await wanted()).length).toBe(allNames.length);
  const connected = await measure();

  // Off again: back to exactly the baseline.
  await s.page.evaluate(() => window.__gsTest.output.setOutput(false));
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "off");
  expect(await wanted()).toEqual(INDICATOR_SIGNALS);
  const offAfter = await measure();
  const rafOffAfter = await rafInterval();

  report("frame-cost-ms", {
    offNeverLoaded: +offNever.toFixed(4), onWaiting: +waiting.toFixed(4), connected: +connected.toFixed(4),
    offAfterOn: +offAfter.toFixed(4), rafIntervalOff: +rafOff.toFixed(2), rafIntervalOffAfterOn: +rafOffAfter.toFixed(2),
  });
  // "Unchanged within noise": off-after-on and waiting cost the same as never-loaded. The whole
  // pipeline is ~0.01 ms of a 16.7 ms frame; 0.05 ms (0.3 % of a frame) is the noise floor
  // when many test pages share the CPU. rAF intervals are reported, not asserted (load-dependent).
  const tol = Math.max(0.05, offNever * 0.5);
  expect(Math.abs(offAfter - offNever)).toBeLessThan(tol);
  expect(Math.abs(waiting - offNever)).toBeLessThan(tol);
  expect(s.errors).toEqual([]);
  await v.context.close();
  await s.context.close();
});

test("demo video: connect → playing → disconnect → reconnect", async ({ browser }) => {
  test.setTimeout(90_000);
  const rec = createScreencast();
  const s = await openSynth(browser);
  await rec.track(s.page, "synth");
  const play = async (steps) => {
    for (const [deg, q, vol, tilt] of steps) {
      await s.setHands(leftHand(deg), rightHand(q, { volume: vol, tilt }));
      await s.page.waitForTimeout(450);
    }
  };
  const openTrackedViz = async () => {
    const v = await openViz(browser, code);
    await rec.track(v.page, "viz");
    return v;
  };
  await play([[1, 1, 0.5, 0]]);
  await s.page.locator("#outputChip").click(); // open settings
  await s.page.waitForTimeout(400);
  await s.page.locator("#outputToggle").check();
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "waiting");
  await expect(s.page.locator("#outputRoomCode")).toHaveText(CODE_RE);
  const code = (await s.page.locator("#outputRoomCode").textContent()).trim();
  await s.page.waitForTimeout(800);
  await s.page.mouse.click(640, 400); // close popover
  const v = await openTrackedViz();
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "connected");
  await play([[1, 1, 0.5, 0], [4, 2, 0.7, 0.3], [5, 3, 0.8, 0.6], [6, 1, 0.6, -0.4], [2, 4, 0.5, 0], [5, 3, 0.75, 0.2]]);
  await v.context.close();
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "waiting");
  await play([[1, 1, 0.5, 0], [4, 1, 0.6, 0]]);
  const v2 = await openTrackedViz();
  await expect(s.page.locator("#outputChip")).toHaveAttribute("data-state", "connected");
  await play([[5, 2, 0.7, 0.4], [1, 3, 0.6, 0], [4, 1, 0.8, -0.2]]);
  await rec.untrack(v2.page);
  await rec.untrack(s.page);
  expect(s.errors).toEqual([]);
  await v2.context.close();
  await s.context.close();
  const out = await rec.save(browser, `${VIDEOS}/output-connect-reconnect.webm`, { layout: ["synth", "viz"] });
  report("video", out);
  expect(fs.statSync(out.file).size).toBeGreaterThan(50_000);
});

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("chip stays on-screen and clear of the existing controls", async ({ page }) => {
    await page.goto(`/?mockHands&signal=${encodeURIComponent(SIGNAL)}`);
    await page.locator("#startOverlay").click();
    await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0);
    await page.locator("#guideToggle").click();
    const chip = await page.locator("#outputChip").boundingBox();
    expect(chip.x).toBeGreaterThanOrEqual(0);
    expect(chip.x + chip.width).toBeLessThanOrEqual(390);
    const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const id of ["keySelect", "toneSelect", "guideToggle", "gestureGuide", "volumeMeter", "distortionDisplay",
      "chordDisplay", "qualityDisplay", "helpButton"]) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(overlaps(chip, box), `#outputChip overlaps #${id}`).toBe(false);
    }
  });
});
