// Music-theory reference values computed independently of the app code (for expected values in tests).
import { KEY_PC, mod12 } from "../../src/modes/lead-notes.js";

export const KEYS = Object.keys(KEY_PC);
const DEG_SEMI = [0, 0, 2, 4, 5, 7, 9, -1];

/** Independent chord triad (pitch classes) for key + degree + quality. */
export function triad(key, degree, major) {
  const r = mod12(KEY_PC[key] + DEG_SEMI[degree]);
  return [r, mod12(r + (major ? 4 : 3)), mod12(r + 7)].sort((a, b) => a - b);
}

/** Seeded PRNG (mulberry32). */
export function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
