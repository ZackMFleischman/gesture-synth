// Builds synthetic MediaPipe HandLandmarker results so tests can "perform" gestures.
// Coordinates are normalized image space (x right, y down), same as MediaPipe.
//
// Landmark indices: 0 wrist, 1-4 thumb (cmc, mcp, ip, tip),
// 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky (mcp, pip, dip, tip).

const FINGER_ORDER = ["index", "middle", "ring", "pinky"];
const MCP_X_OFFSET = { index: -0.06, middle: -0.02, ring: 0.02, pinky: 0.06 };
const TILT_TRAVEL = 0.12; // must match MAX_TRAVEL in getHandHorizontalTilt

/**
 * @param {object} opts
 * @param {"Left"|"Right"} opts.handedness  MediaPipe handedness label
 * @param {string[]} opts.fingers  extended fingers, any of index/middle/ring/pinky
 * @param {boolean} opts.thumb  thumb extended
 * @param {number} opts.tilt  desired output of getHandHorizontalTilt, -1..1
 * @param {number} opts.volume  desired output of getVolumeFromHeight, 0..1
 */
export function hand({
  handedness = "Left",
  fingers = [],
  thumb = false,
  tilt = 0,
  volume = 0.5,
} = {}) {
  const cx = handedness === "Left" ? 0.3 : 0.7;
  const wristY = 0.95 - volume * 0.9;
  const mcpY = wristY - 0.15;

  // getHandHorizontalTilt flips the sign for right hands.
  const rawTilt = handedness === "Right" ? -tilt : tilt;
  const minX = cx + MCP_X_OFFSET.middle;
  const maxX = cx + MCP_X_OFFSET.ring;
  let wristX = cx;
  if (rawTilt > 0) wristX = maxX + rawTilt * TILT_TRAVEL;
  if (rawTilt < 0) wristX = minX + rawTilt * TILT_TRAVEL;

  const pt = (x, y) => ({ x, y, z: 0 });
  const lm = [pt(wristX, wristY)];

  // Thumb: "extended" means tip is outward of the IP joint (direction depends on hand).
  const ipX = cx - 0.09;
  const outward = handedness === "Right" ? 1 : -1;
  const tipX = thumb ? ipX + outward * 0.04 : ipX - outward * 0.03;
  lm.push(pt(cx - 0.05, wristY - 0.03), pt(cx - 0.07, wristY - 0.06), pt(ipX, wristY - 0.09), pt(tipX, wristY - 0.11));

  for (const name of FINGER_ORDER) {
    const x = cx + MCP_X_OFFSET[name];
    const extended = fingers.includes(name);
    const pipY = mcpY - 0.06;
    const tipY = extended ? mcpY - 0.12 : mcpY - 0.03; // curled tip sits below the pip
    lm.push(pt(x, mcpY), pt(x, pipY), pt(x, (pipY + tipY) / 2), pt(x, tipY));
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

export function leftHand(degree, { minor = false, tilt } = {}) {
  return hand({
    handedness: "Left",
    ...DEGREE_SHAPES[degree],
    tilt: tilt ?? (minor ? -0.6 : 0.6),
  });
}

export function rightHand(quality, { volume = 0.8, tilt = 0, thumb = false } = {}) {
  return hand({ handedness: "Right", fingers: QUALITY_SHAPES[quality], volume, tilt, thumb });
}
