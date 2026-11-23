// Builds synthetic MediaPipe HandLandmarker results so tests can "perform" gestures.
// Coordinates are normalized image space (x right, y down), same as MediaPipe.
//
// Landmark indices: 0 wrist, 1-4 thumb (cmc, mcp, ip, tip),
// 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky (mcp, pip, dip, tip).

import { makeView, toDisplay, displayDistance } from "../../src/input/hand-input.js";
import { MASTER_VOLUME } from "../../src/router.js";
import { DEFAULT_RANGE, handExtents, zoneFor, yForHeight, xForValue } from "../../src/input/reach-zones.js";

/** Master volume the router maps a left hand at `volume` (= height) to; the default leftHand() is at 0.5. */
export const masterAt = (volume = 0.5) =>
  Math.max(0, Math.min(1, (volume - MASTER_VOLUME.LOW) / (MASTER_VOLUME.HIGH - MASTER_VOLUME.LOW)));
/**
 * Left-hand height (leftHand `volume`) that gives master volume `m` (inverse of masterAt). The router's dead zone makes
 * the anchor trail a MOVING hand by DEAD_ZONE: pass dir +1 when the hand comes from below, -1 from above, 0 for the
 * first left frame (anchor = height).
 */
export const heightForMaster = (m, dir = 0) =>
  MASTER_VOLUME.LOW + m * (MASTER_VOLUME.HIGH - MASTER_VOLUME.LOW) + dir * MASTER_VOLUME.DEAD_ZONE;

const FINGER_ORDER = ["index", "middle", "ring", "pinky"];
const MCP_X_OFFSET = { index: -0.06, middle: -0.02, ring: 0.02, pinky: 0.06 };
const TILT_TRAVEL = 0.12; // must match MAX_TRAVEL in getHandHorizontalTilt
const PALM = [0, 5, 9, 13, 17]; // palm-center landmarks (must match hand-input.js)

/**
 * The view the app uses in the default Playwright setup: the fake camera is 640x480,
 * the canvas 1280x800 (cover crop). Pass `view` to `hand()` when `pos` must land exactly.
 */
export const DESKTOP_VIEW = makeView(640, 480, 1280, 800);
export const IDENTITY_VIEW = makeView();

// View used to place a hand at a given `volume` (= HandFrame.height over the reach zone) or `x` when no `view` is
// passed. Node tests (buildHandFrame's default) use the identity view; tests/fixtures.js sets the page's view
// (fake camera 640x480 cover-cropped into the viewport) so `volume` means the same height in the app.
let placeView = IDENTITY_VIEW;
export function setPlacementView(v) { placeView = v || IDENTITY_VIEW; }
export const getPlacementView = () => placeView;
/** The app's view for a viewport (fake camera 640x480). */
export const viewFor = (w, h) => makeView(640, 480, w, h);

/**
 * Display-space geometry of landmarks under a view: palm, handSize, reach zone (same math as hand-input.js).
 * side = screen half for the horizontal band (default: guessed from the palm).
 */
export function handGeometry(lm, view = placeView, { side, range = DEFAULT_RANGE } = {}) {
  const pts = lm.map((p) => toDisplay(p, view));
  let x = 0, y = 0;
  for (const i of PALM) { x += pts[i].x; y += pts[i].y; }
  const pos = { x: x / PALM.length, y: y / PALM.length };
  const handSize = displayDistance(lm[0], lm[9], view);
  const ext = handExtents(pts, pos, handSize, view.dstW / view.dstH);
  const zone = zoneFor(ext, side || (pos.x < 0.5 ? "left" : "right"), range);
  return { pts, pos, handSize, ext, zone };
}

/**
 * @param {object} opts
 * @param {"Left"|"Right"} opts.handedness  MediaPipe handedness label
 * @param {string[]} opts.fingers  extended fingers, any of index/middle/ring/pinky
 * @param {boolean} opts.thumb  thumb extended
 * @param {number} opts.tilt  desired output of getHandHorizontalTilt, -1..1
 * @param {number} opts.volume  desired HandFrame.height, 0..1 over the reach zone (the palm is placed at that height of
 *   the zone for the placement view: `view` if given, else setPlacementView()'s). Ignored if `pos` is given.
 * @param {number} opts.x  desired HandFrame.x (0 inner .. 0.5 neutral .. 1 outer of the horizontal band; `side`
 *   = screen half, default guessed from the palm). Omitted = the default x (0.3 / 0.7 of the image). Ignored with `pos`.
 * @param {string} opts.range  reach-zone preset for `volume` / `x` (default comfort)
 * @param {boolean} opts.fist  tightly closed hand (index..pinky curled into the palm); thumb still follows `thumb`
 * @param {boolean|number} opts.pinch  thumb tip on the index tip; a number = desired pinchDistance
 *   (thumb-index distance / hand size), `true` = 0.1. Fingers default to middle+ring+pinky (an "OK" sign).
 * @param {{x:number,y:number}} opts.pos  palm center in DISPLAY space (0..1 of the canvas, mirrored)
 * @param {object} opts.view  display mapping for `pos` (default IDENTITY_VIEW: x mirrored, y unchanged)
 * @param {number} opts.scale  hand size multiplier (1 = default, ~0.15 wrist->middle MCP)
 */
export function hand({
  handedness = "Left",
  fingers,
  thumb = false,
  tilt = 0,
  volume = 0.5,
  fist = false,
  pinch = false,
  pos,
  view,
  scale = 1,
  x,
  side,
  range = DEFAULT_RANGE,
} = {}) {
  const pv = view || placeView; // placement view for volume / x
  view = view || IDENTITY_VIEW;
  if (fingers === undefined) fingers = pinch ? ["middle", "ring", "pinky"] : [];
  if (fist) fingers = [];

  const cx = handedness === "Left" ? 0.3 : 0.7;
  const wristY = 0.95 - volume * 0.9;
  const s = scale;
  const mcpY = wristY - 0.15 * s;

  // getHandHorizontalTilt flips the sign for right hands.
  const rawTilt = handedness === "Right" ? -tilt : tilt;
  const minX = cx + MCP_X_OFFSET.middle * s;
  const maxX = cx + MCP_X_OFFSET.ring * s;
  let wristX = cx;
  if (rawTilt > 0) wristX = maxX + rawTilt * TILT_TRAVEL;
  if (rawTilt < 0) wristX = minX + rawTilt * TILT_TRAVEL;

  const pt = (x, y) => ({ x, y, z: 0 });
  const lm = [pt(wristX, wristY)];

  // Thumb: "extended" means tip is outward of the IP joint (direction depends on hand).
  const ipX = cx - 0.09 * s;
  const outward = handedness === "Right" ? 1 : -1;
  const tipX = thumb ? ipX + outward * 0.04 * s : ipX - outward * 0.03 * s;
  lm.push(
    pt(cx - 0.05 * s, wristY - 0.03 * s),
    pt(cx - 0.07 * s, wristY - 0.06 * s),
    pt(ipX, wristY - 0.09 * s),
    pt(tipX, wristY - 0.11 * s)
  );

  for (const name of FINGER_ORDER) {
    const x = cx + MCP_X_OFFSET[name] * s;
    const extended = fingers.includes(name);
    const pipY = mcpY - 0.06 * s;
    // curled tip sits below the pip; in a fist it is tucked down by the knuckles
    const tipY = extended ? mcpY - 0.12 * s : fist ? mcpY + 0.01 * s : mcpY - 0.03 * s;
    lm.push(pt(x, mcpY), pt(x, pipY), pt(x, (pipY + tipY) / 2), pt(x, tipY));
  }

  if (pinch) {
    // Thumb tip sits `d` hand sizes below the index tip.
    const d = pinch === true ? 0.1 : pinch;
    const handSize = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y);
    lm[4] = pt(lm[8].x, lm[8].y + d * handSize);
  }

  if (!pos) {
    // Palm to `volume` (height) over the reach zone, and to `x` across the horizontal band, in the placement view.
    // Without `x`, the palm keeps the untilted hand's x (the wrist shift that fakes a tilt moves the palm center, and
    // HandFrame.x would follow it: a tilted test hand must not also turn Drive / Space up).
    if (x == null) {
      const shift = (wristX - cx) / PALM.length;
      for (const p of lm) p.x -= shift;
    }
    const geo = handGeometry(lm, pv, { side, range });
    const dy = (yForHeight(geo.zone, volume) - geo.pos.y) * pv.sHeight / pv.srcH;
    const dx = x == null ? 0 : -(xForValue(geo.zone, x) - geo.pos.x) * pv.sWidth / pv.srcW; // display x is mirrored
    for (const p of lm) { p.x += dx; p.y += dy; }
  } else {
    // Move the whole hand so its palm center lands on `pos` (display space -> image space).
    const px = 1 - pos.x; // un-mirror
    const ix = (view.sx + px * view.sWidth) / view.srcW;
    const iy = (view.sy + pos.y * view.sHeight) / view.srcH;
    let mx = 0, my = 0;
    for (const i of PALM) { mx += lm[i].x; my += lm[i].y; }
    mx /= PALM.length;
    my /= PALM.length;
    for (const p of lm) { p.x += ix - mx; p.y += iy - my; }
  }

  return { handedness, landmarks: lm };
}

/** Packs hands into the shape returned by HandLandmarker.detectForVideo. */
export function results(...hands) {
  return {
    landmarks: hands.map((h) => h.landmarks),
    handedness: hands.map((h) => [
      { categoryName: h.handedness, displayName: h.handedness, score: 1, index: 0 },
    ]),
  };
}

// Left-hand finger shapes for each scale degree (see help modal).
export const DEGREE_SHAPES = {
  1: { fingers: ["index"] },
  2: { fingers: ["index", "middle"] },
  3: { fingers: ["index", "middle", "ring"] },
  4: { fingers: ["index", "middle", "ring", "pinky"] },
  5: { fingers: ["index", "middle", "ring", "pinky"], thumb: true },
  6: { fingers: ["index", "pinky"] },
  7: { fingers: ["index", "pinky"], thumb: true },
};

// Right-hand finger shapes for chord quality 1-4.
export const QUALITY_SHAPES = {
  0: [],
  1: ["index"],
  2: ["index", "middle"],
  3: ["index", "middle", "ring"],
  4: ["index", "middle", "ring", "pinky"],
};

/** Extra options (pos, view, scale) pass through to hand(). */
export function leftHand(degree, { minor = false, tilt, ...rest } = {}) {
  return hand({
    handedness: "Left",
    ...DEGREE_SHAPES[degree],
    tilt: tilt ?? (minor ? -0.6 : 0.6),
    ...rest,
  });
}

/** Extra options (pos, view, scale, pinch) pass through to hand(). */
export function rightHand(quality, { volume = 0.8, tilt = 0, thumb = false, ...rest } = {}) {
  return hand({ handedness: "Right", fingers: QUALITY_SHAPES[quality], volume, tilt, thumb, ...rest });
}

/** A closed fist (the menu gesture). Default right hand; `thumb` may be either way. */
export function fist({ handedness = "Right", ...rest } = {}) {
  return hand({ handedness, fist: true, ...rest });
}

/**
 * A pinch: thumb tip on the index tip with the middle finger extended.
 * `distance` = pinchDistance in hand sizes (default 0.1). `fingers` defaults to middle+ring+pinky.
 */
export function pinch({ handedness = "Right", distance = 0.1, ...rest } = {}) {
  return hand({ handedness, pinch: distance, ...rest });
}
