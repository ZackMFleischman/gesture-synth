#!/usr/bin/env node
// Media capture for the summary page: one PNG (the key moment) + one short looping WebM per feature, driven
// through the real app with ?mockHands and smooth synthetic hand motion (~30 fps of interpolated input).
//
//   npm run capture                         # everything -> media-out/
//   npm run capture -- --only=arp,lead      # some features (names below; `--list` prints them)
//   npm run capture -- --no-video           # PNGs only (fast)
//   options: --out=DIR  --port=5232  --signal-port=5432  --base-url=http://localhost:5173 (reuse a running dev
//            server; then also pass --signal-port of a running `npm run signal`)  --bitrate=1500000  --headed
//            --green-camera (Chrome's default fake camera pattern instead of the generated dim-room still)
//
// Playwright as a library with the system Chrome (no browser download) + the fake camera of playwright.config.js.
// Video: tests/helpers/screencast.js (CDP frames -> MediaRecorder WebM, no ffmpeg); sound (where noted) is the
// master output (after the limiter/clipper) recorded in the page with MediaRecorder and muxed in.
// Starts its own vite (dev: test hooks on, Clarity never loads on localhost) + signaling server unless --base-url.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createScreencast } from "../tests/helpers/screencast.js";
import { AUDIO_TAP_SCRIPT } from "../tests/helpers/audio.js";
import { leftHand, rightHand, fist, pinch, results, setPlacementView, viewFor } from "../tests/helpers/hands.js";
import { PINCH_TEMPO } from "../src/modes/arp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------- options
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const OUT = path.resolve(ROOT, args.out || "media-out");
const PORT = Number(args.port) || 5232;
const SIGNAL_PORT = Number(args["signal-port"]) || 5432;
const BASE = args["base-url"] || `http://localhost:${PORT}`;
const SIGNAL = `ws://localhost:${SIGNAL_PORT}`;
const BITRATE = Number(args.bitrate) || 1_500_000;
const VIDEO = !args["no-video"];
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

// ---------------------------------------------------------------------------------------------- servers
const children = [];
function startServer(cmd, argv, env, url) {
  const child = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push(child);
  return (async () => {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode != null) throw new Error(`${cmd} ${argv.join(" ")} exited:\n${log}`);
      try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timeout waiting for ${url}\n${log}`);
  })();
}
function stopServers() { for (const c of children) if (c.exitCode == null) c.kill("SIGTERM"); }
process.on("SIGINT", () => { stopServers(); process.exit(130); });


// ---------------------------------------------------------------------------------------------- fake camera
// Chrome's default fake camera is a bright green test pattern (timecode + spinning wedge). For media, feed it a
// calm 640x480 still instead (same size as the default, so the app's view math is unchanged): a dim room with a
// soft lamp glow and a faint player silhouette, behind the hand landmarks. Y4M (I420), generated once.
function fakeCameraFile() {
  const file = path.join(ROOT, "node_modules/.cache/capture-media/camera-v1.y4m");
  if (fs.existsSync(file)) return file;
  const W = 640, H = 480;
  const rgb = new Float32Array(W * H * 3);
  const sm = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H;
    // base: cool charcoal, lighter towards the top
    let r = 0.075 + 0.05 * (1 - v), g = 0.085 + 0.055 * (1 - v), b = 0.11 + 0.07 * (1 - v);
    // warm lamp glow, upper left of the image
    const lamp = Math.exp(-(((u - 0.18) / 0.22) ** 2 + ((v - 0.22) / 0.3) ** 2));
    r += 0.13 * lamp; g += 0.085 * lamp; b += 0.04 * lamp;
    // cool screen light from the right
    const scr = Math.exp(-(((u - 0.92) / 0.25) ** 2 + ((v - 0.5) / 0.5) ** 2));
    r += 0.02 * scr; g += 0.04 * scr; b += 0.08 * scr;
    // player silhouette (head + shoulders), slightly lit by the screen, soft edges
    const head = 1 - sm(0.085, 0.105, Math.hypot((u - 0.5) * (W / H), v - 0.47));
    const sh = 1 - sm(0.92, 1.0, Math.hypot((u - 0.5) / 0.3, (v - 1.02) / 0.3));
    const neck = (1 - sm(0.035, 0.05, Math.abs((u - 0.5) * (W / H)))) * sm(0.52, 0.56, v) * (1 - sm(0.8, 0.84, v));
    const body = Math.max(head, sh, neck);
    r = r * (1 - 0.45 * body) + 0.045 * body; g = g * (1 - 0.45 * body) + 0.05 * body; b = b * (1 - 0.45 * body) + 0.065 * body;
    // vignette
    const vig = 1 - 0.45 * sm(0.35, 0.95, Math.hypot(u - 0.5, (v - 0.5) * 0.9));
    const i = (y * W + x) * 3;
    rgb[i] = r * vig; rgb[i + 1] = g * vig; rgb[i + 2] = b * vig;
  }
  const Y = Buffer.alloc(W * H), U = Buffer.alloc(W * H / 4), V = Buffer.alloc(W * H / 4);
  const dither = (x, y) => ((((x * 7) ^ (y * 13)) & 15) / 16 - 0.5);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    Y[y * W + x] = Math.round(16 + 65.481 * rgb[i] + 128.553 * rgb[i + 1] + 24.966 * rgb[i + 2] + dither(x, y));
  }
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    let r = 0, g = 0, b = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((y + dy) * W + x + dx) * 3; r += rgb[i] / 4; g += rgb[i + 1] / 4; b += rgb[i + 2] / 4; }
    const k = (y / 2) * (W / 2) + x / 2;
    U[k] = Math.round(128 - 37.797 * r - 74.203 * g + 112 * b);
    V[k] = Math.round(128 + 112 * r - 93.786 * g - 18.214 * b);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\nFRAME\n`), Y, U, V]));
  return file;
}

// ---------------------------------------------------------------------------------------------- browser
let browser;
const clarityHits = [];
const pageErrors = [];

async function newPage({ viewport = DESKTOP, mobile = false, audioTap = false } = {}) {
  const context = await browser.newContext({
    viewport, permissions: ["camera"], deviceScaleFactor: 1,
    ...(mobile ? { hasTouch: true, isMobile: true } : {}),
  });
  // Analytics must never load (dev server on localhost never loads it; this also blocks + reports any attempt).
  await context.route(/clarity\.ms|vercel-insights|_vercel\/(insights|speed-insights)/, (route) => {
    clarityHits.push(route.request().url());
    route.abort();
  });
  const page = await context.newPage();
  if (audioTap) await page.addInitScript(AUDIO_TAP_SCRIPT);
  await page.addInitScript(() => {
    try { localStorage.setItem("gs.mobile.seen", "1"); } catch { /* ignore */ }
  });
  page.on("pageerror", (e) => pageErrors.push(`${page.url()}: ${e.message}`));
  return { context, page };
}

/** The app with ?mockHands, start overlay dismissed, render loop running. */
async function openApp({ viewport = DESKTOP, mobile = false, query = "" } = {}) {
  const { context, page } = await newPage({ viewport, mobile });
  await page.goto(`${BASE}/?mockHands${query}`);
  await page.locator("#startOverlay").click();
  await page.locator("#startOverlay").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.getElementById("webcam").videoWidth > 0 && window.__gsTest?.ctx?.audio?.ac);
  return { context, page, stage: new Stage(page, viewport) };
}

/** A visible pointer (headless screencasts have no cursor): follows the mouse, rings on press; touch = a dot. */
async function addPointer(page, { dot = true } = {}) {
  await page.evaluate((dot) => {
    if (document.getElementById("__capPointer")) return;
    const st = document.createElement("style");
    st.textContent = `#__capPointer{position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
      background:rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.4);pointer-events:none;z-index:2147483647;
      transition:transform .12s,opacity .3s;opacity:0}
      #__capPointer.down{transform:scale(.7);background:rgba(255,214,102,.95)}
      .__capRipple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:2px solid rgba(255,214,102,.9);
      pointer-events:none;z-index:2147483646;animation:__capR .45s ease-out forwards}
      @keyframes __capR{from{transform:scale(.4);opacity:1}to{transform:scale(1.4);opacity:0}}`;
    document.head.append(st);
    const p = document.createElement("div");
    p.id = "__capPointer";
    document.body.append(p);
    const at = (x, y) => { p.style.left = `${x}px`; p.style.top = `${y}px`; p.style.opacity = "1"; };
    addEventListener("pointermove", (e) => at(e.clientX, e.clientY), true);
    addEventListener("pointerdown", (e) => {
      at(e.clientX, e.clientY);
      p.classList.add("down");
      const r = document.createElement("div");
      r.className = "__capRipple";
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      document.body.append(r);
      setTimeout(() => r.remove(), 500);
    }, true);
    addEventListener("pointerup", () => p.classList.remove("down"), true);
    if (!dot) p.style.display = "none"; // touch: ripples only
  }, dot);
}

/** Moves the (visible) mouse smoothly to an element's center and clicks it. */
async function clickSmooth(page, locator, { ms = 450, pause = 120 } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${locator}`);
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const from = page.__mouse || { x: page.viewportSize().width * 0.62, y: page.viewportSize().height * 0.62 };
  const n = Math.max(2, Math.round(ms / 33));
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    await page.mouse.move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
    await sleep(33);
  }
  page.__mouse = to;
  await sleep(pause);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}

/** Touch tap with a visible ripple (mobile pages). */
async function tap(page, locator) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.evaluate(({ x, y }) => {
    const r = document.createElement("div");
    r.className = "__capRipple";
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    document.body.append(r);
    setTimeout(() => r.remove(), 500);
  }, { x, y });
  await page.touchscreen.tap(x, y);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
const bus = (page, name) => page.evaluate((n) => window.__gsTest.bus.get(n), name);
async function waitFor(page, fn, arg, timeout = 5000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 50 });
}

// ---------------------------------------------------------------------------------------------- hand motion
// A hand is a plain spec: { hand: "L"|"R", shape: "open"|"fist"|"pinch", n (degree / finger count), pos {x,y}
// (display space) OR volume/x (reach band), tilt, minor, thumb, distance, fingers }. Numeric fields are
// interpolated (eased) between keyframes at ~30 fps; shape/n switch at the start of a move (like a real hand
// that changes shape, then travels). A slow sub-pixel sway keeps held hands alive.
const NUM = ["tilt", "volume", "x", "distance", "scale"];

function buildHand(spec, view) {
  const o = {};
  for (const k of NUM) if (spec[k] != null) o[k] = spec[k];
  if (spec.pos) { o.pos = spec.pos; o.view = view; }
  if (spec.thumb != null) o.thumb = spec.thumb;
  if (spec.hand === "L") {
    if (spec.shape === "fist") return fist({ handedness: "Left", ...o });
    return leftHand(spec.n ?? 1, { minor: !!spec.minor, ...o });
  }
  if (spec.shape === "fist") return fist({ handedness: "Right", ...o });
  if (spec.shape === "pinch") return pinch({ handedness: "Right", distance: spec.distance ?? 0.1, fingers: spec.fingers, tilt: spec.tilt, ...o });
  return rightHand(spec.n ?? 1, o);
}

function lerpSpec(a, b, k) {
  if (!a || !b) return b;
  const out = { ...b };
  for (const key of NUM) if (a[key] != null && b[key] != null) out[key] = a[key] + (b[key] - a[key]) * k;
  if (a.pos && b.pos) out.pos = { x: a.pos.x + (b.pos.x - a.pos.x) * k, y: a.pos.y + (b.pos.y - a.pos.y) * k };
  return out;
}

class Stage {
  constructor(page, viewport) {
    this.page = page;
    this.view = viewFor(viewport.width, viewport.height);
    this.hands = { L: null, R: null };
    this.sway = 0.0018;
    this.t0 = Date.now();
  }
  _swayed(spec, phase) {
    if (!spec || !this.sway) return spec;
    const t = (Date.now() - this.t0) / 1000;
    const s = { ...spec };
    if (s.pos) s.pos = { x: s.pos.x + this.sway * Math.sin(t * 1.3 + phase), y: s.pos.y + this.sway * Math.sin(t * 0.9 + phase * 2) };
    else if (s.volume != null) s.volume += this.sway * 2 * Math.sin(t * 0.9 + phase);
    return s;
  }
  async send(L = this.hands.L, R = this.hands.R) {
    setPlacementView(this.view);
    const hs = [this._swayed(L, 0), this._swayed(R, 1.7)].filter(Boolean).map((s) => buildHand(s, this.view));
    await this.page.evaluate((r) => (window.__gsTest.results = r), results(...hs));
  }
  /** Set hands instantly (null = hand out of frame; undefined = keep). */
  async set({ L, R } = {}) {
    if (L !== undefined) this.hands.L = L;
    if (R !== undefined) this.hands.R = R;
    await this.send();
  }
  /** Eased move of either hand to a target spec (partial specs merge into the current one). */
  async move({ L, R } = {}, ms = 600) {
    const from = { ...this.hands };
    const to = {
      L: L === undefined ? from.L : L && { ...from.L, ...L, pos: L.pos ?? (L.volume != null ? undefined : from.L?.pos) },
      R: R === undefined ? from.R : R && { ...from.R, ...R, pos: R.pos ?? (R.volume != null ? undefined : from.R?.pos) },
    };
    const start = Date.now();
    for (;;) {
      const k = ease((Date.now() - start) / ms);
      this.hands = { L: lerpSpec(from.L, to.L, k), R: lerpSpec(from.R, to.R, k) };
      await this.send();
      if (k >= 1) break;
      await sleep(33);
    }
    this.hands = to;
  }
  /** Keep sending the current pose (with sway) for `ms`, or until `until()` resolves truthy. */
  async hold(ms, until) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.send();
      if (until && (await until())) return true;
      await sleep(33);
    }
    return false;
  }
  /** Hold until a page condition is true (bounded); throws if it never happens. */
  async holdUntil(fn, arg, max = 4000) {
    const ok = await this.hold(max, () => this.page.evaluate(fn, arg));
    if (!ok) throw new Error(`condition never true: ${fn}`);
  }
}

// ---------------------------------------------------------------------------------------------- recording
/** Starts the screencast (+ optional sound) for the given pages; returns finish(name, opts). */
async function startClip(pages, { audioPage = null } = {}) {
  if (!VIDEO) return async () => null;
  const rec = createScreencast();
  for (const [slot, page] of pages) await rec.track(page, slot);
  if (audioPage) {
    await audioPage.evaluate(() => {
      const s = window.__gsTest.synth;
      const dest = s.ctx.createMediaStreamDestination();
      s.clipper.connect(dest);
      const mr = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 96000 });
      const chunks = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      window.__snd = { mr, chunks, done: new Promise((r) => (mr.onstop = r)), startMs: 0, dest };
      mr.onstart = () => (window.__snd.startMs = Date.now());
      mr.start(250);
    });
  }
  return async (name, { cellW = 1280, cellH = 800 } = {}) => {
    let audio = null;
    if (audioPage) {
      audio = await audioPage.evaluate(async () => {
        const s = window.__snd;
        s.mr.stop();
        await s.done;
        try { window.__gsTest.synth.clipper.disconnect(s.dest); } catch { /* ignore */ }
        const buf = new Uint8Array(await new Blob(s.chunks, { type: "audio/webm" }).arrayBuffer());
        let b = "";
        for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { b64: btoa(b), startMs: s.startMs };
      });
    }
    for (const [, page] of pages) await rec.untrack(page);
    const file = path.join(OUT, `${name}.webm`);
    const r = await rec.save(browser, file, { layout: pages.map(([s]) => s), cellW, cellH, fps: 25, audio, videoBitsPerSecond: BITRATE });
    return { ...r, audio: !!audio };
  };
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  // Stills never show the capture pointer (it is only there so clips read like a screen recording).
  const hide = (v) => page.evaluate((v) => { const p = document.getElementById("__capPointer"); if (p) p.style.visibility = v; }, v);
  await hide("hidden");
  await page.screenshot({ path: file });
  await hide("");
  return file;
}

/** Composites two PNGs side by side on a 1280x800 frame with captions (for the visualizer). */
async function composeSideBySide(files, labels, outName) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const srcs = files.map((f) => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`);
  await page.setContent(`<html><body style="margin:0;background:#0b0b0c;width:1280px;height:800px;display:flex;align-items:center;
    justify-content:center;gap:16px;font:600 15px system-ui,sans-serif;color:#cfcfd4">
    ${srcs.map((s, i) => `<figure style="margin:0;width:624px"><figcaption style="margin:0 0 8px 2px;letter-spacing:.04em">${labels[i]}</figcaption>
    <img src="${s}" style="width:624px;display:block;border-radius:8px;box-shadow:0 0 0 1px #2a2a30"></figure>`).join("")}</body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const file = path.join(OUT, `${outName}.png`);
  await page.screenshot({ path: file });
  await ctx.close();
  return file;
}

// ---------------------------------------------------------------------------------------------- scenes
// Display-space positions on 1280x800. The video is mirrored (selfie view), so as in real use the chord ("Left")
// hand is on the screen LEFT and the right hand on the screen RIGHT.
const R0 = { x: 0.7, y: 0.42 }; // right hand home for the menu (m1-integration)
const L0 = { x: 0.28, y: 0.5 }; // left (chord) hand
const LEFT = (n = 1, o = {}) => ({ hand: "L", n, pos: L0, ...o });
const OPEN = (n = 1, o = {}) => ({ hand: "R", shape: "open", n, pos: R0, ...o });
const FIRST_USE_MS = 3300; // first-use labels (theme.js MOTION.firstUse = 3000) fade out

async function enterArp(page, stage, { bpm = 112 } = {}) {
  await page.evaluate((bpm) => {
    const t = window.__gsTest;
    t.router.setMode("arp");
    t.registry.getMode("arp").set({ bpm });
  }, bpm);
  await stage.hold(FIRST_USE_MS);
}

const SCENES = {};

SCENES["mode-menu"] = async () => {
  const { context, page, stage } = await openApp();
  await stage.set({ L: LEFT(1), R: OPEN(1) });
  await stage.hold(1500);
  const finish = await startClip([["app", page]]);
  await stage.hold(700);
  await stage.set({ R: { hand: "R", shape: "fist", pos: R0 } }); // close the hand
  await stage.holdUntil(() => window.__gsTest.bus.get("menu")?.state === "open");
  await stage.hold(450); // ring grows
  await stage.move({ R: { pos: { x: R0.x + 0.15, y: R0.y } } }, 800);
  await stage.holdUntil(() => window.__gsTest.bus.get("menu")?.selectedId === "arp");
  await stage.hold(500);
  const png = await shot(page, "mode-menu");
  await stage.hold(250);
  await stage.set({ R: OPEN(1, { pos: stage.hands.R.pos }) }); // open the hand -> countdown
  await stage.holdUntil(() => window.__gsTest.bus.get("menu")?.state === "countdown");
  await stage.holdUntil(() => window.__gsTest.bus.get("menu") == null, null, 4000);
  await stage.move({ R: { pos: { x: R0.x + 0.02, y: 0.5 } } }, 700); // settle back while Arp plays
  await stage.hold(1500);
  const clip = await finish("mode-menu");
  await context.close();
  return { png, clip };
};

SCENES.arp = async () => {
  const { context, page, stage } = await openApp();
  const P = { x: 0.7, y: 0.62 };
  await stage.set({ L: LEFT(4), R: OPEN(3, { pos: P }) });
  await enterArp(page, stage);
  const finish = await startClip([["app", page]], { audioPage: page });
  await stage.hold(900);
  await stage.move({ R: { pos: { x: 0.7, y: 0.38 } } }, 1500); // up = longer gate
  await stage.hold(500);
  await stage.move({ R: { tilt: -0.9 } }, 900); // lean -> filter arc dot follows
  await stage.move({ R: { tilt: 0.9 } }, 1500);
  await stage.hold(400);
  const png = await shot(page, "arp");
  await stage.move({ R: { tilt: 0, pos: P } }, 1300);
  await stage.hold(700);
  const clip = await finish("arp");
  await context.close();
  return { png, clip };
};

SCENES["pinch-tempo"] = async () => {
  const { context, page, stage } = await openApp();
  const P = { x: 0.7, y: 0.55 };
  await stage.set({ L: LEFT(1), R: OPEN(2, { pos: P }) });
  await enterArp(page, stage, { bpm: 110 });
  stage.sway = 0; // the tempo follows every pixel of a pinch: keep it still
  const size = await bus(page, "right/size");
  const yAt = (k) => P.y - (k * size) / PINCH_TEMPO.BPM_PER_HAND;
  const finish = await startClip([["app", page]]);
  await stage.hold(800);
  await stage.set({ R: { hand: "R", shape: "pinch", pos: P } });
  await stage.hold(500);
  await stage.move({ R: { pos: { x: P.x, y: yAt(12) } } }, 1700);
  await stage.holdUntil(() => window.__gsTest.ctx.clock.bpm === 122);
  await stage.hold(500);
  const png = await shot(page, "pinch-tempo");
  await stage.hold(400);
  await stage.set({ R: OPEN(2, { pos: { x: P.x, y: yAt(12) } }) }); // release: tempo kept
  await stage.hold(600);
  await stage.move({ R: { pos: P } }, 900); // back home: gate control resumes
  await stage.hold(900);
  const clip = await finish("pinch-tempo");
  await context.close();
  return { png, clip };
};

SCENES.lead = async () => {
  const { context, page, stage } = await openApp();
  const LL = { hand: "L", n: 1, pos: L0 };
  const claw = (y, o = {}) => ({ hand: "R", shape: "pinch", distance: 0.55, fingers: ["index", "middle", "ring", "pinky"], pos: { x: R0.x, y }, ...o });
  const play = (y) => claw(y, { distance: 0.1 });
  await stage.set({ L: LL, R: OPEN(2) });
  await stage.hold(1500);
  const finish = await startClip([["app", page]], { audioPage: page });
  await stage.hold(300);
  await stage.set({ R: { hand: "R", shape: "fist", pos: R0 } });
  await stage.holdUntil(() => window.__gsTest.bus.get("menu")?.state === "open");
  await stage.hold(300);
  await stage.move({ R: { pos: { x: R0.x - 0.15, y: R0.y } } }, 700);
  await stage.holdUntil(() => window.__gsTest.bus.get("menu")?.selectedId === "lead");
  await stage.hold(300);
  await stage.set({ R: claw(R0.y, { pos: { x: R0.x - 0.15, y: R0.y } }) });
  await stage.holdUntil(() => window.__gsTest.bus.get("menu") == null && window.__gsTest.bus.get("mode") === "lead", null, 4000);
  await stage.move({ R: { pos: { x: R0.x, y: R0.y } } }, 500);
  const yFor = async (i) => page.evaluate((i) => {
    const lead = window.__gsTest.registry.getMode("lead");
    return lead._yForMidi(lead._controller.state.ladder.notes[i].midi);
  }, i);
  let png = null;
  const n = await page.evaluate(() => window.__gsTest.registry.getMode("lead")._controller.state.ladder.notes.length);
  const a = Math.max(0, Math.floor(n / 2) - 2);
  const seq = [[a, 1], [a + 1, 1], [a + 2, 1], [a + 3, 4], [a + 4, 4], [a + 3, 4]].map(([i, d]) => [Math.min(n - 1, i), d]);
  for (let j = 0; j < seq.length; j++) {
    const [i, deg] = seq[j];
    const y = await yFor(i);
    await stage.move({ L: { n: deg }, R: claw(y) }, 260); // glide up the ladder (preview)
    await stage.set({ R: play(y) }); // pinch = play
    await stage.hold(j === seq.length - 1 ? 600 : 300);
    if (j === 4) png = await shot(page, "lead");
    await stage.set({ R: claw(y) });
    await stage.hold(80);
  }
  await stage.hold(600);
  const clip = await finish("lead");
  await context.close();
  return { png, clip };
};

SCENES["master-volume"] = async () => {
  const { context, page, stage } = await openApp();
  await stage.set({ L: { hand: "L", n: 1, volume: 0.5 }, R: OPEN(2, { pos: { x: 0.7, y: 0.45 } }) });
  await stage.hold(1500);
  const finish = await startClip([["app", page]]);
  await stage.hold(600);
  await stage.move({ L: { volume: 0.95 } }, 1300);
  await stage.hold(450);
  const png = await shot(page, "master-volume");
  await stage.move({ L: { volume: 0.12 } }, 1900);
  await stage.hold(400);
  await stage.move({ L: { volume: 0.5 } }, 1100);
  await stage.hold(700);
  const clip = await finish("master-volume");
  await context.close();
  return { png, clip };
};

SCENES["drive-space"] = async () => {
  const { context, page, stage } = await openApp();
  await stage.set({ L: { hand: "L", n: 4, volume: 0.6, x: 0.5 }, R: { hand: "R", shape: "open", n: 3, volume: 0.5, x: 0.5, tilt: 0.3 } });
  await stage.hold(1500);
  const finish = await startClip([["app", page]], { audioPage: page });
  await stage.hold(600);
  await stage.move({ R: { x: 1 } }, 1000); // right hand out -> Drive
  await stage.hold(400);
  await stage.move({ R: { x: 0.5 } }, 800);
  await stage.move({ L: { x: 1 } }, 1000); // left hand out -> Space
  await stage.hold(300);
  await stage.move({ R: { x: 1 } }, 800); // both out for the still
  await stage.hold(400);
  const png = await shot(page, "drive-space");
  await stage.move({ L: { x: 0.5 }, R: { x: 0.5 } }, 1000);
  await stage.hold(600);
  const clip = await finish("drive-space");
  await context.close();
  return { png, clip };
};

SCENES["controls-panel"] = async () => {
  const { context, page, stage } = await openApp();
  await stage.set({ L: LEFT(4), R: OPEN(3, { pos: { x: 0.7, y: 0.55 }, tilt: 0.2 }) }); // clear of the panel (left column)
  await enterArp(page, stage);
  await addPointer(page);
  await page.mouse.move(820, 520);
  page.__mouse = { x: 820, y: 520 };
  const finish = await startClip([["app", page]]);
  await stage.hold(300);
  await clickSmooth(page, page.locator("#controlsToggle"), { ms: 550 });
  await page.locator("#controlsPanel").waitFor({ state: "visible" });
  await stage.hold(450);
  await clickSmooth(page, page.locator('#controlsPanel [data-control="pattern"] [data-value="updown"]'));
  await stage.hold(600);
  await clickSmooth(page, page.locator('#controlsPanel [data-control="octaves"] [data-value="2"]'), { ms: 350 });
  await stage.hold(300);
  await page.mouse.move(760, 610, { steps: 8 }); // pointer off the panel (and the hand) for the still
  page.__mouse = { x: 760, y: 610 };
  await stage.hold(300);
  const png = await shot(page, "controls-panel");
  await clickSmooth(page, page.locator("#controlsToggle"), { ms: 500 });
  await page.mouse.move(820, 520, { steps: 10 });
  await stage.hold(600);
  const clip = await finish("controls-panel");
  await context.close();
  return { png, clip };
};

SCENES.mobile = async () => {
  const { context, page, stage } = await openApp({ viewport: PHONE, mobile: true });
  await page.evaluate(() => window.__gsTest.router.setMode("arp"));
  // Portrait cover-crops the 640x480 camera to its middle: place smaller hands inside the visible strip.
  await stage.set({ L: { hand: "L", n: 4, pos: { x: 0.31, y: 0.5 }, scale: 0.5 }, R: { hand: "R", shape: "open", n: 3, pos: { x: 0.73, y: 0.42 }, tilt: 0.3, scale: 0.5 } });
  await stage.holdUntil(() => document.body.classList.contains("gs-playing"));
  await addPointer(page, { dot: false });
  await stage.hold(FIRST_USE_MS);
  const collapsed = await shot(page, "mobile-collapsed");
  const finish = await startClip([["phone", page]]);
  await stage.hold(800);
  await tap(page, page.locator("#gsPill"));
  await stage.holdUntil(() => document.getElementById("gsBar").classList.contains("open"));
  await stage.hold(900);
  const tray = await shot(page, "mobile-tray");
  await tap(page, page.locator("#controlsToggle"));
  await stage.holdUntil(() => getComputedStyle(document.getElementById("gsControlsSheet")).display !== "none");
  await stage.hold(1300);
  const png = await shot(page, "mobile-controls-sheet");
  await tap(page, page.locator("#gsControlsSheet .gs-close"));
  await stage.hold(400);
  // hands keep playing -> the bar folds itself away
  await stage.holdUntil(() => !document.getElementById("gsBar").classList.contains("open"), null, 6000);
  await stage.hold(900);
  const clip = await finish("mobile", { cellW: 390, cellH: 844 });
  await context.close();
  return { png: collapsed, extra: [tray, png], clip };
};

SCENES.visualizer = async () => {
  const s = await openApp({ query: `&signal=${encodeURIComponent(SIGNAL)}` });
  await s.stage.set({ L: LEFT(1), R: OPEN(1, { pos: { x: 0.62, y: 0.55 } }) }); // clear of the panel (left column) while it is open
  // Output on through Controls -> Output row.
  await s.page.locator("#controlsToggle").click();
  const row = s.page.locator('#controlsPanel [data-hook="output"]');
  await row.locator('[data-control="output"]').click();
  await s.page.waitForFunction(() => /^[2-9A-Z]{4}-[2-9A-Z]{2}$/.test(document.querySelector('#controlsPanel [data-hook="output-code"]')?.textContent.trim() || ""));
  const code = (await row.locator('[data-hook="output-code"]').textContent()).trim();
  await s.page.mouse.move(900, 600);
  await s.stage.hold(300);
  const outputRow = path.join(OUT, "visualizer-output-row.png");
  await s.page.screenshot({ path: outputRow });
  const { context: vctx, page: viz } = await newPage({ viewport: DESKTOP });
  await viz.goto(`${BASE}/labs/visualizer.html?room=${code}&signal=${encodeURIComponent(SIGNAL)}`);
  await s.page.waitForFunction(() => document.getElementById("outputChip")?.dataset.state === "connected", null, { timeout: 8000 });
  await s.page.locator("#controlsToggle").click();
  await s.page.mouse.move(900, 600);
  await s.stage.move({ R: { pos: R0 } }, 500);
  // The visualizer's notes/beat panel sits just below 800 px: zoom out a little so it is in the frame.
  await viz.evaluate(() => (document.documentElement.style.zoom = "0.82"));
  await s.stage.hold(800);
  const finish = await startClip([["synth", s.page], ["viz", viz]]);
  await s.stage.hold(300);
  // Fist menu -> Arp (the visualizer shows the ring), then chord changes while notes + beats arrive.
  await s.stage.set({ R: { hand: "R", shape: "fist", pos: R0 } });
  await s.stage.holdUntil(() => window.__gsTest.bus.get("menu")?.state === "open");
  await s.stage.hold(300);
  await s.stage.move({ R: { pos: { x: R0.x + 0.15, y: R0.y } } }, 700);
  await s.stage.holdUntil(() => window.__gsTest.bus.get("menu")?.selectedId === "arp");
  await s.stage.hold(300);
  await s.stage.set({ R: OPEN(3, { pos: stage2pos(s.stage) }) });
  await s.stage.holdUntil(() => window.__gsTest.bus.get("menu") == null, null, 4000);
  await s.stage.move({ R: { pos: { x: 0.7, y: 0.45 } } }, 500);
  let png = null;
  for (const [deg, minor] of [[1, false], [4, false], [6, true], [5, false]]) {
    await s.stage.set({ L: LEFT(deg, { minor }) });
    await s.stage.hold(750);
    if (deg === 6) {
      const a = path.join(OUT, "visualizer-synth.png");
      const b = path.join(OUT, "visualizer-viz.png");
      await Promise.all([s.page.screenshot({ path: a }), viz.screenshot({ path: b })]);
      png = await composeSideBySide([a, b], ["Gesture Synth (Arp)", "Visualizer (labs/visualizer.html)"], "visualizer");
    }
  }
  const clip = await finish("visualizer", { cellW: 640, cellH: 400 });
  await vctx.close();
  await s.context.close();
  return { png, extra: [outputRow, path.join(OUT, "visualizer-synth.png"), path.join(OUT, "visualizer-viz.png")], clip };
};
const stage2pos = (stage) => stage.hands.R.pos;

SCENES["gesture-test"] = async () => {
  const { context, page } = await newPage({ viewport: DESKTOP });
  await page.goto(`${BASE}/labs/gesture-test.html?mockHands`);
  await page.waitForFunction(() => !!window.__gsTest);
  const stage = new Stage(page, DESKTOP);
  stage.view = viewFor(640, 480); // the test page has no cover-cropped canvas: place hands in image space
  await stage.set({ L: { hand: "L", n: 3, volume: 0.5, tilt: 0.4 }, R: { hand: "R", shape: "open", n: 4, volume: 0.6, tilt: -0.3 } });
  await stage.hold(800);
  const finish = await startClip([["page", page]]);
  await stage.hold(600);
  await stage.move({ R: { volume: 0.75, tilt: 0.2 } }, 700);
  await stage.set({ R: { hand: "R", shape: "pinch", distance: 0.12, volume: 0.75, tilt: 0.2 } });
  await stage.hold(700);
  const png = await shot(page, "gesture-test");
  await stage.set({ R: { hand: "R", shape: "open", n: 4, volume: 0.75, tilt: 0.2 } });
  await stage.move({ L: { n: 5 }, R: { volume: 0.55 } }, 700);
  await stage.set({ R: { hand: "R", shape: "pinch", distance: 0.12, volume: 0.55, tilt: 0.2 } });
  await stage.hold(600);
  await stage.set({ R: { hand: "R", shape: "fist", volume: 0.55 } });
  await stage.hold(700);
  await stage.set({ R: { hand: "R", shape: "open", n: 4, volume: 0.6, tilt: -0.3 }, L: { hand: "L", n: 3, volume: 0.5, tilt: 0.4 } });
  await stage.hold(900);
  const clip = await finish("gesture-test");
  await context.close();
  return { png, clip };
};

SCENES["filter-arc"] = async () => {
  const { context, page, stage } = await openApp();
  await stage.set({ L: LEFT(1), R: OPEN(4, { pos: { x: 0.7, y: 0.56 }, tilt: 0 }) });
  await stage.hold(FIRST_USE_MS);
  const finish = await startClip([["app", page]]);
  await stage.hold(600);
  await stage.move({ R: { tilt: -1 } }, 1100);
  await stage.hold(300);
  await stage.move({ R: { tilt: 1 } }, 1800);
  await stage.hold(400);
  const png = await shot(page, "filter-arc");
  await stage.move({ R: { tilt: 0 } }, 1000);
  await stage.hold(700);
  const clip = await finish("filter-arc");
  await context.close();
  return { png, clip };
};

SCENES.overview = async () => {
  const { context, page, stage } = await openApp();
  await stage.set({ L: LEFT(4), R: OPEN(3, { pos: { x: 0.7, y: 0.4 }, tilt: 0.45 }) });
  await enterArp(page, stage, { bpm: 116 });
  await stage.move({ L: { n: 6, minor: true } }, 300);
  await stage.hold(1200);
  const png = await shot(page, "overview");
  await context.close();
  return { png };
};

// ---------------------------------------------------------------------------------------------- main
const ORDER = ["overview", "mode-menu", "arp", "pinch-tempo", "lead", "master-volume", "drive-space", "controls-panel",
  "mobile", "visualizer", "gesture-test", "filter-arc"];

if (args.list) {
  console.log(ORDER.join("\n"));
  process.exit(0);
}
const only = typeof args.only === "string" ? args.only.split(",").map((s) => s.trim()) : ORDER;
for (const n of only) if (!SCENES[n]) { console.error(`unknown feature "${n}" (see --list)`); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const report = [];
try {
  if (!args["base-url"]) {
    await Promise.all([
      startServer("npx", ["vite", "--port", String(PORT), "--strictPort"], { CHOKIDAR_USEPOLLING: "1" }, BASE),
      startServer("node", ["server/signal.js"], { SIGNAL_PORT: String(SIGNAL_PORT) }, `http://localhost:${SIGNAL_PORT}/health`),
    ]);
  }
  browser = await chromium.launch({
    channel: "chrome",
    headless: !args.headed,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      ...(args["green-camera"] ? [] : [`--use-file-for-fake-video-capture=${fakeCameraFile()}`]),
    ],
  });
  for (const name of only) {
    const t0 = Date.now();
    process.stdout.write(`- ${name} ... `);
    try {
      const r = await SCENES[name]();
      const files = [r.png, ...(r.extra || []), r.clip?.file].filter(Boolean);
      report.push({ name, files, clip: r.clip });
      console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      report.push({ name, error: e.message.split("\n")[0] });
      console.log(`FAILED: ${e.message.split("\n")[0]}`);
    }
  }
} finally {
  await browser?.close();
  stopServers();
}

const kb = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
console.log(`\nOutput: ${OUT}`);
for (const r of report) {
  if (r.error) { console.log(`  ${r.name}: FAILED (${r.error})`); continue; }
  for (const f of r.files) {
    const extra = f.endsWith(".webm") && r.clip ? ` ${(r.clip.durationMs / 1000).toFixed(1)} s${r.clip.audio ? ", with audio" : ""}` : "";
    console.log(`  ${path.relative(ROOT, f)}  ${kb(f)}${extra}`);
  }
}
if (clarityHits.length) console.log(`\nWARNING: analytics requests attempted (blocked): ${[...new Set(clarityHits)].join(", ")}`);
if (pageErrors.length) console.log(`\nPage errors:\n  ${[...new Set(pageErrors)].join("\n  ")}`);
process.exit(report.some((r) => r.error) ? 1 : 0);
