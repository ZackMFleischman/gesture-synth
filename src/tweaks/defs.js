// The app's tweak definitions (loaded with the panel, only with ?tweaks). Each one binds to the live config the
// code already reads every frame / note, so a change takes effect without a reload. Defaults are READ from the code
// (never duplicated here). Other modules may add their own groups with defineTweak (src/tweaks/tweaks.js).
import { defineTweak } from "./tweaks.js";
import { DEFAULT_THRESHOLDS, getThresholds, setThresholds } from "../input/hand-input.js";
import { VOICING_HOLD } from "../modes/arp.js";
import { MOTION, CONFIRM } from "../ui/theme.js";
import { MASTER_VOLUME } from "../router.js";
import { CHORD_LEVEL, LIMITER, setChordLevel, setLimiterThreshold } from "../services/audio.js";
import { DEFAULT_LEAD_CONFIG, LEAD_TWEAKS, setLeadConfig } from "../modes/lead-config.js";

// Radial menu config (src/menu/menu-config.js, from ws/menu-autoselect). import.meta.glob resolves to {} while the
// file is not merged, so this binds automatically once it lands, with no build error before.
const MENU_CONFIG_MODULE = Object.values(import.meta.glob("../menu/menu-config.js"))[0] ?? null;

/** Placeholder until menu-config.js exists: same API, values only stored (nothing reads them). */
function placeholderMenuConfig() {
  const MENU_CONFIG_DEFAULTS = Object.freeze({
    requireRelease: false, holdMs: 0, deadR: 0.22, innerR: 0.3, selectR: 0.6, deselectR: 0.44, cooldownMs: 2000, countdownMs: 400,
  });
  const menuConfig = { ...MENU_CONFIG_DEFAULTS };
  return { MENU_CONFIG_DEFAULTS, menuConfig, setMenuConfig: (p) => Object.assign(menuConfig, p), placeholder: true };
}

async function defineMenuTweaks() {
  let mod;
  try {
    mod = MENU_CONFIG_MODULE ? await MENU_CONFIG_MODULE() : placeholderMenuConfig();
  } catch (err) {
    console.error("[tweaks] menu-config.js failed to load", err);
    mod = placeholderMenuConfig();
  }
  const { MENU_CONFIG_DEFAULTS: D, setMenuConfig } = mod;
  const group = mod.placeholder ? "Radial menu (not wired: menu-config.js missing)" : "Radial menu";
  const set = (k) => (v) => setMenuConfig({ [k]: v });
  const hs = "× hand";
  defineTweak({
    group, key: "menu.requireRelease", label: "Require open hand to confirm", type: "toggle", default: D.requireRelease,
    info: "On: moving the fist past an arc only selects it; opening the hand confirms (open in the middle = cancel). " +
      "Off (default): crossing the select radius chooses the arc by itself (auto-select).",
    apply: set("requireRelease"),
  });
  defineTweak({
    group, key: "menu.holdMs", label: "Hold before activation", type: "slider", default: D.holdMs, min: 0, max: 600, step: 10, unit: "ms",
    info: "Auto-select only: how long the fist must stay past the select radius before the arc is chosen. 0 = at once. " +
      "Dropping back inside the radius restarts it.",
    apply: set("holdMs"),
  });
  defineTweak({
    group, key: "menu.deadR", label: "Inner radius (dead zone)", type: "slider", default: D.deadR, min: 0, max: 0.6, step: 0.01, unit: hs,
    info: "No arc lights up while the fist is closer than this to where the menu opened (in entry hand sizes, wrist to middle knuckle).",
    apply: set("deadR"),
  });
  defineTweak({
    group, key: "menu.innerR", label: "Drawn inner edge", type: "slider", default: D.innerR, min: 0.05, max: 0.8, step: 0.01, unit: hs,
    info: "Where the arcs' fill starts (drawing only), in entry hand sizes.",
    apply: set("innerR"),
  });
  defineTweak({
    group, key: "menu.selectR", label: "Select radius (outer)", type: "slider", default: D.selectR, min: 0.2, max: 1.5, step: 0.01, unit: hs,
    info: "Moving the fist this far from the menu center (entry hand sizes) selects the arc it points at. Also the arcs' drawn outer edge. Smaller = less arm travel.",
    apply: set("selectR"),
  });
  defineTweak({
    group, key: "menu.deselectR", label: "Deselect radius (hysteresis)", type: "slider", default: D.deselectR, min: 0.1, max: 1.2, step: 0.01, unit: hs,
    info: "Once selected, an arc stays selected until the fist comes back inside this radius. Keep it below the select radius.",
    apply: set("deselectR"),
  });
  defineTweak({
    group, key: "menu.cooldownMs", label: "Re-arm cooldown", type: "slider", default: D.cooldownMs, min: 0, max: 5000, step: 100, unit: "ms",
    info: "After the menu closes, a fist that never opened re-opens the menu only after this long.",
    apply: set("cooldownMs"),
  });
  defineTweak({
    group, key: "menu.countdownMs", label: "Selection fade time", type: "slider", default: D.countdownMs, min: 0, max: 1500, step: 25, unit: "ms",
    info: "After a mode is chosen, the chosen arc fades out over this long while the right hand stays held; the new mode gets the right hand at the end.",
    apply: set("countdownMs"),
  });
}

function defineHandTweaks() {
  const group = "Hand tracking";
  const T = DEFAULT_THRESHOLDS;
  const thr = (k) => (v) => setThresholds({ [k]: v });
  defineTweak({
    group, key: "hand.pinchStart", label: "Pinch start", type: "slider", default: T.PINCH_START, min: 0.1, max: 0.8, step: 0.01, unit: "× hand",
    info: "Thumb tip to index tip distance (hand sizes) below which a pinch starts. Lower = harder to pinch by accident.",
    apply: (v) => {
      setThresholds({ PINCH_START: v });
      // setThresholds keeps PINCH_END >= PINCH_START; nothing else to do here.
    },
  });
  defineTweak({
    group, key: "hand.pinchEnd", label: "Pinch end", type: "slider", default: T.PINCH_END, min: 0.1, max: 1, step: 0.01, unit: "× hand",
    info: "A pinch ends once the distance is above this (hysteresis; kept ≥ pinch start).",
    apply: (v) => setThresholds({ PINCH_END: Math.max(v, getThresholds().PINCH_START) }),
  });
  defineTweak({
    group, key: "hand.fistRatio", label: "Fist ratio", type: "slider", default: T.FIST_TIP_RATIO, min: 0.8, max: 2.5, step: 0.05, unit: "× hand",
    info: "A hand counts as a fist when every fingertip is within this many hand sizes of the wrist. Higher = fists are detected more easily (and loose hands may read as fists).",
    apply: thr("FIST_TIP_RATIO"),
  });
  defineTweak({
    group, key: "hand.thumbBand", label: "Thumb band", type: "slider", default: T.THUMB_BAND, min: 0, max: 0.3, step: 0.005, unit: "× hand",
    info: "Hysteresis band for 'thumb out' (Arp double time, Chords octave): the thumb must move this far past the line to flip.",
    apply: thr("THUMB_BAND"),
  });
  defineTweak({
    group, key: "hand.pinchLookbackMs", label: "Pinch lookback", type: "slider", default: T.PINCH_LOOKBACK_MS, min: 0, max: 800, step: 10, unit: "ms",
    info: "While pinching, the voicing used is the finger count from this long before the pinch started (forming a pinch changes the count for a few frames).",
    apply: thr("PINCH_LOOKBACK_MS"),
  });
  defineTweak({
    group, key: "hand.voicingHoldMs", label: "Voicing hold (Arp)", type: "slider", default: VOICING_HOLD.MS, min: 0, max: 500, step: 10, unit: "ms",
    info: "Arp: a new right-hand finger count must be stable this long before it changes which chord notes play.",
    apply: (v) => (VOICING_HOLD.MS = v),
  });
}

function defineDisplayTweaks() {
  const group = "Display";
  defineTweak({
    group, key: "display.lostHoldMs", label: "Hand lost: hold", type: "slider", default: MOTION.lostHold, min: 0, max: 5000, step: 100, unit: "ms",
    info: "When a hand disappears, its 'Hand lost' ring and label stay fully visible this long...",
    apply: (v) => (MOTION.lostHold = v),
  });
  defineTweak({
    group, key: "display.lostFadeMs", label: "Hand lost: fade", type: "slider", default: MOTION.lostFade, min: 0, max: 3000, step: 50, unit: "ms",
    info: "...then fade out over this long.",
    apply: (v) => (MOTION.lostFade = v),
  });
  defineTweak({
    group, key: "display.confirmHoldMs", label: "Setting confirm: linger", type: "slider", default: CONFIRM.holdMs, min: 0, max: 4000, step: 50, unit: "ms",
    info: "A confirmed setting (note set, octave, …) stays fully visible this long after the confirm.",
    apply: (v) => (CONFIRM.holdMs = v),
  });
  defineTweak({
    group, key: "display.confirmFadeMs", label: "Setting confirm: fade", type: "slider", default: CONFIRM.fadeMs, min: 0, max: 2000, step: 50, unit: "ms",
    info: "Then it fades out over this long.",
    apply: (v) => (CONFIRM.fadeMs = v),
  });
  defineTweak({
    group, key: "display.firstUseMs", label: "First-use labels", type: "slider", default: MOTION.firstUse, min: 0, max: 10000, step: 250, unit: "ms",
    info: "How long the small labels at the hand (Gate, Filter, Thumb: x2 …) show when a mode is first entered.",
    apply: (v) => (MOTION.firstUse = v),
  });
}

function defineAudioTweaks(synth) {
  const group = "Audio";
  defineTweak({
    group, key: "audio.masterLow", label: "Master volume: low", type: "slider", default: MASTER_VOLUME.LOW, min: 0, max: 0.6, step: 0.01, unit: "height",
    info: "Left-hand height (0 = bottom, 1 = top of the band) at or below which the master volume is 0.",
    apply: (v) => (MASTER_VOLUME.LOW = v),
  });
  defineTweak({
    group, key: "audio.masterHigh", label: "Master volume: high", type: "slider", default: MASTER_VOLUME.HIGH, min: 0.3, max: 1, step: 0.01, unit: "height",
    info: "Left-hand height at or above which the master volume is full. Keep it above 'low'.",
    apply: (v) => (MASTER_VOLUME.HIGH = v),
  });
  defineTweak({
    group, key: "audio.chordLevel", label: "Chord level", type: "slider", default: CHORD_LEVEL, min: 0, max: 0.3, step: 0.005,
    info: "Level of each of the 4 chord oscillators (Chords mode). The default keeps the loudest chord 1.5 dB under the limiter; higher values will hit it.",
    apply: (v) => setChordLevel(v, synth),
  });
  defineTweak({
    group, key: "audio.limiterThreshold", label: "Limiter threshold", type: "slider", default: LIMITER.threshold, min: -24, max: 0, step: 0.5, unit: "dB",
    info: "Master limiter threshold (dBFS). It is a safety net: normal playing should stay under it.",
    apply: (v) => setLimiterThreshold(v, synth),
  });
}

function defineLeadTweaks() {
  const group = "Lead";
  for (const t of LEAD_TWEAKS) {
    defineTweak({ group, ...t, key: `lead.${t.key}`, default: DEFAULT_LEAD_CONFIG[t.key], apply: (v) => setLeadConfig({ [t.key]: v }) });
  }
}

/** Define every app tweak. The menu group is async (its config module is a lazy import). */
export async function defineAppTweaks({ synth = null } = {}) {
  const menu = defineMenuTweaks(); // first group in the panel (registered before the sync groups below)
  // The menu group must come first: wait for its (tiny) module before the others so the panel order is stable.
  await menu;
  defineHandTweaks();
  defineDisplayTweaks();
  defineAudioTweaks(synth);
  defineLeadTweaks();
}
