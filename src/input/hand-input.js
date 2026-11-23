// Hand input: MediaPipe landmarks -> HandFrame (contract: docs/architecture.md "HandFrame").
// All gesture classification lives here. Pure logic (no DOM) so it can be unit-tested in Node.
//
// Landmark indices: 0 wrist, 1-4 thumb (cmc, mcp, ip, tip),
// 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky (mcp, pip, dip, tip).

import { bus as sharedBus } from "../core/bus.js";

// ---- Tunable thresholds (live-tuned on labs/gesture-test.html) ----
// `export let` = live bindings: setThresholds() changes what every importer sees.

/** Fist: every index..pinky tip must be closer to the wrist than this many hand sizes. */
export let FIST_TIP_RATIO = 1.5;
/** Pinch starts when thumb-tip <-> index-tip distance (in hand sizes) drops below this... */
export let PINCH_START = 0.3;
/** ...and ends only when it rises above this (hysteresis). */
export let PINCH_END = 0.45;
/**
 * Thumb hysteresis half-band, in hand sizes, on the thumb-tip vs thumb-IP x offset (outward = +).
 * Used only by stateful callers (createHandInput); a lone frame keeps the plain x compare.
 */
export let THUMB_BAND = 0.08;
/** On pinch start, voicingBeforePinch = the voicingCount this many ms before the start. */
export let PINCH_LOOKBACK_MS = 300;

export const DEFAULT_THRESHOLDS = Object.freeze({
  FIST_TIP_RATIO, PINCH_START, PINCH_END, THUMB_BAND, PINCH_LOOKBACK_MS,
});

/** Current threshold values (plain object copy). */
export function getThresholds() {
  return { FIST_TIP_RATIO, PINCH_START, PINCH_END, THUMB_BAND, PINCH_LOOKBACK_MS };
}

/**
 * Live-edit thresholds at runtime (gesture test page). Unknown keys / non-numbers are ignored;
 * PINCH_END is kept >= PINCH_START. setThresholds(DEFAULT_THRESHOLDS) resets.
 */
export function setThresholds(t = {}) {
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  if (num(t.FIST_TIP_RATIO)) FIST_TIP_RATIO = t.FIST_TIP_RATIO;
  if (num(t.PINCH_START)) PINCH_START = t.PINCH_START;
  if (num(t.PINCH_END)) PINCH_END = t.PINCH_END;
  if (num(t.THUMB_BAND)) THUMB_BAND = t.THUMB_BAND;
  if (num(t.PINCH_LOOKBACK_MS)) PINCH_LOOKBACK_MS = t.PINCH_LOOKBACK_MS;
  if (PINCH_END < PINCH_START) PINCH_END = PINCH_START;
  return getThresholds();
}

// ---- Existing gesture checks (moved unchanged from main.js) ----

export const FINGERS = {
  index:  { pip: 6, tip: 8 },
  middle: { pip: 10, tip: 12 },
  ring:   { pip: 14, tip: 16 },
  pinky:  { pip: 18, tip: 20 },
};

export function isFingerExtended(landmarks, name) {
  const { pip, tip } = FINGERS[name];
  return landmarks[tip].y < landmarks[pip].y;
}

export function isThumbExtended(landmarks, handedness) {
  const thumbTip = landmarks[4];
  const thumbIp = landmarks[3];

  if (handedness === "Right") {
    return thumbTip.x > thumbIp.x;
  } else {
    return thumbTip.x < thumbIp.x;
  }
}

export function getChordQuality(landmarks) {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9]; // middle finger MCP joint
  return middleMcp.x > wrist.x ? "minor" : "major";
}

/**
 * Left-hand finger shape -> roman numeral (case from getChordQuality), or null.
 * `fingers` (optional, e.g. HandFrame.fingers) supplies the finger states so the
 * stateful thumb hysteresis applies; without it they are recomputed from landmarks.
 */
export function classifyChord(landmarks, handedness, fingers = null) {
  const thumb = fingers ? fingers.thumb : isThumbExtended(landmarks, handedness);
  const index = fingers ? fingers.index : isFingerExtended(landmarks, "index");
  const middle = fingers ? fingers.middle : isFingerExtended(landmarks, "middle");
  const ring = fingers ? fingers.ring : isFingerExtended(landmarks, "ring");
  const pinky = fingers ? fingers.pinky : isFingerExtended(landmarks, "pinky");

  const quality = getChordQuality(landmarks);

  if (index && pinky && !middle && !ring && !thumb) {
    return quality === "major" ? "VI" : "vi";
  }

  if (index && pinky && !middle && !ring && thumb) {
    return quality === "major" ? "VII" : "vii";
  }

  const count = [thumb, index, middle, ring, pinky].filter(Boolean).length;
  const ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V" };
  const base = ROMAN[count];
  if (!base) return null;

  return quality === "major" ? base : base.toLowerCase();
}

export function getHandHorizontalTilt(landmarks, handedness) {
  // Safe structure guardrails to prevent engine freezing
  if (!landmarks || typeof landmarks.length === "undefined" || landmarks.length < 18) {
    return 0;
  }

  try {
    const wrist = landmarks[0];     // Wrist Base
    const middleMcp = landmarks[9];  // Middle Knuckle (Left pillar)
    const ringMcp = landmarks[13];  // Ring Knuckle (Right pillar)

    if (!wrist || !middleMcp || !ringMcp) return 0;

    // Determine the left boundary and right boundary in coordinate space
    const minX = Math.min(middleMcp.x, ringMcp.x);
    const maxX = Math.max(middleMcp.x, ringMcp.x);

    let tiltFactor = 0;
    // Max travel distance past the boundaries before hitting 100%
    const MAX_TRAVEL = 0.12;

    if (wrist.x < minX) {
      // Wrist has slipped out to the left of the hand structure
      tiltFactor = (wrist.x - minX) / MAX_TRAVEL;
    } else if (wrist.x > maxX) {
      // Wrist has slipped out to the right of the hand structure
      tiltFactor = (wrist.x - maxX) / MAX_TRAVEL;
    } else {
      // Wrist is safely between the knuckles -> Dead-zone active!
      tiltFactor = 0;
    }

    // Clamp value safely between -1.0 and 1.0
    tiltFactor = Math.max(-1, Math.min(1, tiltFactor));

    // Keep your working structural layout rule for right-hand inversion
    if (handedness === "Right") {
      tiltFactor = -tiltFactor;
    }

    return tiltFactor;

  } catch (error) {
    console.error("Buffered tilt calculation failed:", error);
    return 0;
  }
}

/** Wrist height: 0 bottom .. 1 top. */
export function getVolumeFromHeight(landmarks) {
  const wrist = landmarks[0];
  const TOP = 0.05;
  const BOTTOM = 0.95;

  const clamped = Math.max(TOP, Math.min(BOTTOM, wrist.y));
  const t = (clamped - TOP) / (BOTTOM - TOP);
  return 1 - t;
}

/** Right hand: number of extended index..pinky fingers (voicing 0-4). */
export function getRightHandQualityIndex(landmarks) {
  const index = isFingerExtended(landmarks, "index");
  const middle = isFingerExtended(landmarks, "middle");
  const ring = isFingerExtended(landmarks, "ring");
  const pinky = isFingerExtended(landmarks, "pinky");

  return [index, middle, ring, pinky].filter(Boolean).length;
}

// ---- Display geometry (mirrored, cover-cropped video) ----

// Computes a "cover" crop rect in source-video pixel space: the largest
// centered rectangle matching the destination's aspect ratio, so the
// video fills the screen (height fit, width cropped) with zero stretch.
export function computeCoverRect(srcW, srcH, dstW, dstH) {
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;

  if (srcRatio > dstRatio) {
    const sHeight = srcH;
    const sWidth = srcH * dstRatio;
    return { sx: (srcW - sWidth) / 2, sy: 0, sWidth, sHeight };
  } else {
    const sWidth = srcW;
    const sHeight = srcW / dstRatio;
    return { sx: 0, sy: (srcH - sHeight) / 2, sWidth, sHeight };
  }
}

/**
 * View = how image-space landmarks map onto the canvas. Defaults to an identity
 * (square video filling a square canvas), which keeps Node tests simple.
 */
export function makeView(srcW = 1, srcH = 1, dstW = 1, dstH = 1) {
  return { srcW, srcH, dstW, dstH, ...computeCoverRect(srcW, srcH, dstW, dstH) };
}

const IDENTITY_VIEW = makeView();

/** Image-space landmark -> display space (0..1 of the canvas, mirrored like the video). */
export function toDisplay(pt, view = IDENTITY_VIEW) {
  const px = pt.x * view.srcW;
  const py = pt.y * view.srcH;
  return { x: 1 - (px - view.sx) / view.sWidth, y: (py - view.sy) / view.sHeight };
}

/** Distance between two landmarks in display-height units (isotropic, crop-aware). */
export function displayDistance(a, b, view = IDENTITY_VIEW) {
  const dx = (a.x - b.x) * view.srcW;
  const dy = (a.y - b.y) * view.srcH;
  return Math.hypot(dx, dy) / view.sHeight;
}

// ---- Frame construction ----

const PALM = [0, 5, 9, 13, 17];

function isFist(landmarks, fingers, handSize, view) {
  if (fingers.index || fingers.middle || fingers.ring || fingers.pinky) return false;
  const wrist = landmarks[0];
  const limit = FIST_TIP_RATIO * handSize;
  for (const name of ["index", "middle", "ring", "pinky"]) {
    if (displayDistance(landmarks[FINGERS[name].tip], wrist, view) > limit) return false;
  }
  return true;
}

/**
 * Thumb tip vs thumb IP x offset in hand sizes, positive = outward (away from the palm),
 * i.e. > 0 exactly when isThumbExtended() is true.
 */
export function thumbOffset(landmarks, handedness, handSize, view = IDENTITY_VIEW) {
  const outward = handedness === "Right" ? 1 : -1;
  const dx = ((landmarks[4].x - landmarks[3].x) * view.srcW) / view.sHeight;
  return handSize > 0 ? (outward * dx) / handSize : outward * dx;
}

/**
 * Builds a HandFrame.
 *  - `wasPinching` carries the pinch hysteresis state for this hand.
 *  - `wasThumb` (optional) carries the thumb hysteresis state; omitted = plain x compare.
 *  - `voicingBeforePinch` (optional) is filled in by createHandInput; omitted = voicingCount while pinching.
 *
 * Order matters: the pinch is decided BEFORE the finger count, because a pinch curls the
 * index onto the thumb and the count then reads 3 (middle+ring+pinky). While `pinch` is
 * true, consumers should use `voicingBeforePinch`, not `voicingCount`.
 * @returns HandFrame (see docs/architecture.md)
 */
export function buildHandFrame(landmarks, handedness, {
  t = 0, view = IDENTITY_VIEW, wasPinching = false, wasThumb, voicingBeforePinch,
} = {}) {
  // 1. Pinch first: thumb-index distance in hand sizes, two thresholds, needs the middle finger up.
  const handSize = displayDistance(landmarks[0], landmarks[9], view);
  const pinchDistance = handSize > 0 ? displayDistance(landmarks[4], landmarks[8], view) / handSize : Infinity;
  const middle = isFingerExtended(landmarks, "middle");
  let pinch = false;
  if (middle) {
    pinch = wasPinching ? pinchDistance <= PINCH_END : pinchDistance < PINCH_START;
  }

  // 2. Finger states and counts.
  let thumb;
  if (wasThumb === undefined) {
    thumb = isThumbExtended(landmarks, handedness);
  } else {
    const off = thumbOffset(landmarks, handedness, handSize, view);
    thumb = wasThumb ? off > -THUMB_BAND : off > THUMB_BAND;
  }
  const fingers = {
    thumb,
    index: isFingerExtended(landmarks, "index"),
    middle,
    ring: isFingerExtended(landmarks, "ring"),
    pinky: isFingerExtended(landmarks, "pinky"),
  };
  const voicingCount = (fingers.index ? 1 : 0) + (fingers.middle ? 1 : 0) + (fingers.ring ? 1 : 0) + (fingers.pinky ? 1 : 0);
  const fingerCount = voicingCount + (fingers.thumb ? 1 : 0);

  let cx = 0, cy = 0;
  for (const i of PALM) { cx += landmarks[i].x; cy += landmarks[i].y; }
  const pos = toDisplay({ x: cx / PALM.length, y: cy / PALM.length }, view);

  return {
    handedness,
    landmarks,
    fingers,
    fingerCount,
    voicingCount,
    fist: isFist(landmarks, fingers, handSize, view),
    pinch,
    pinchDistance,
    voicingBeforePinch: pinch ? (voicingBeforePinch ?? voicingCount) : null,
    height: getVolumeFromHeight(landmarks),
    tilt: getHandHorizontalTilt(landmarks, handedness),
    pos,
    handSize,
    t,
  };
}

// Bus names published by hand input (precomputed: no string building per frame).
const SIDE_SIGNALS = {
  Left: { height: "left/height", tilt: "left/tilt", pos: "left/pos", fist: "left/fist", pinch: "left/pinch", size: "left/size" },
  Right: { height: "right/height", tilt: "right/tilt", pos: "right/pos", fist: "right/fist", pinch: "right/pinch", size: "right/size" },
};

const HISTORY_MS = 1000; // voicing history kept per hand (must exceed PINCH_LOOKBACK_MS)

/** Per-hand state carried between frames. Reset when the hand is lost. */
function newHandState() {
  return { pinch: false, thumb: undefined, latched: null, history: [] };
}

/** voicing at (t - PINCH_LOOKBACK_MS): latest sample at/before then, else the oldest, else null. */
function voicingAt(history, t) {
  const target = t - PINCH_LOOKBACK_MS;
  let found = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= target) { found = history[i]; break; }
  }
  if (!found && history.length) found = history[0];
  return found ? found.v : null;
}

/**
 * Stateful hand input: keeps pinch + thumb hysteresis and a short voicing history per hand,
 * and publishes hand values. On a pinch start it latches `voicingBeforePinch` from
 * PINCH_LOOKBACK_MS earlier (history stores the latched value during pinches, so a quick
 * re-pinch restores the pre-pinch voicing too).
 * process() returns { frames, left, right } (left/right = last frame with that label, like the old code).
 */
export function createHandInput({ bus = sharedBus } = {}) {
  for (const side of Object.values(SIDE_SIGNALS)) {
    bus.declare(side.height, { type: "continuous", owner: "hand-input" });
    bus.declare(side.tilt, { type: "continuous", owner: "hand-input" });
    bus.declare(side.pos, { type: "continuous", owner: "hand-input" });
    bus.declare(side.fist, { type: "state", owner: "hand-input" });
    bus.declare(side.pinch, { type: "state", owner: "hand-input" });
    bus.declare(side.size, { type: "continuous", owner: "hand-input" }); // handSize, display-height units
  }
  // `/gs/pinch` event: 1 when the right (mode) hand starts a pinch, 0 at release (or when the pinching
  // hand is lost). Shared here so every mode gets it with no code.
  bus.declare("pinch", { type: "event", owner: "hand-input" });

  const state = { Left: newHandState(), Right: newHandState() };
  let view = IDENTITY_VIEW;

  function frameFor(landmarks, handedness, t) {
    const s = state[handedness];
    if (!s) return buildHandFrame(landmarks, handedness, { t, view });
    // Pinch decided first (no latched voicing yet), then latch on the rising edge.
    const f = buildHandFrame(landmarks, handedness, { t, view, wasPinching: s.pinch, wasThumb: s.thumb });
    if (f.pinch) {
      if (!s.pinch || s.latched === null) s.latched = voicingAt(s.history, t) ?? f.voicingCount;
      f.voicingBeforePinch = s.latched;
    } else {
      s.latched = null;
    }
    const h = s.history;
    h.push({ t, v: f.pinch ? s.latched : f.voicingCount });
    while (h.length > 1 && h[0].t < t - HISTORY_MS) h.shift();
    return f;
  }

  function publish(side, f) {
    const s = SIDE_SIGNALS[side];
    bus.set(s.height, f ? f.height : null);
    bus.set(s.tilt, f ? f.tilt : null);
    bus.set(s.pos, f ? f.pos : null);
    bus.set(s.fist, f ? f.fist : false);
    bus.set(s.pinch, f ? f.pinch : false);
    bus.set(s.size, f ? f.handSize : null);
  }

  return {
    get view() { return view; },
    setView(v) { view = v; },

    /** @param results HandLandmarker.detectForVideo() output */
    process(results, t) {
      const frames = [];
      const wasRightPinch = state.Right.pinch;
      let left = null;
      let right = null;
      results.landmarks.forEach((landmarks, i) => {
        const handedness = results.handedness[i][0].categoryName;
        const f = frameFor(landmarks, handedness, t);
        frames.push(f);
        if (handedness === "Left") left = f;
        if (handedness === "Right") right = f;
      });
      for (const [side, f] of [["Left", left], ["Right", right]]) {
        if (f) { state[side].pinch = f.pinch; state[side].thumb = f.fingers.thumb; }
        else state[side] = newHandState();
      }
      publish("Left", left);
      publish("Right", right);
      const rightPinch = !!(right && right.pinch);
      if (rightPinch !== wasRightPinch) bus.emit("pinch", rightPinch ? 1 : 0);
      return { frames, left, right };
    },
  };
}
