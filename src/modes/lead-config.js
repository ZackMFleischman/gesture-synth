// Lead tunables that may be adjusted live (Tweaks panel, "Lead" group, once src/tweaks/ lands).
// Read every frame / every note: lead-notes.js (snap hysteresis, sweet band), lead.js (hand marker), lead-voice.js
// (release time). Pure (no DOM). Defaults stay here; setLeadConfig() mutates the live object.

export const DEFAULT_LEAD_CONFIG = Object.freeze({
  /** Release envelope after the pinch opens: time to silence (ms). Smooth (cubic) fade, exact zero at the end. */
  releaseMs: 250,
  /** Sweet spot around each note line: +-this fraction of the gap to the neighbour (0.35 = 35%). */
  sweetBand: 0.35,
  /** Snap hysteresis: to leave a note the hand must pass the midpoint to the neighbour by this fraction of the gap. */
  snapHysteresis: 0.3,
  /** Draw the continuous hand marker (exact, unsnapped hand height) beside the cursor. */
  showHandMarker: true,
});

export const leadConfig = { ...DEFAULT_LEAD_CONFIG };

/** Live-edit: setLeadConfig({releaseMs: 400}); setLeadConfig() resets to the defaults. */
export function setLeadConfig(patch) {
  if (!patch) return Object.assign(leadConfig, DEFAULT_LEAD_CONFIG);
  for (const k of Object.keys(patch)) if (k in DEFAULT_LEAD_CONFIG) leadConfig[k] = patch[k];
  return leadConfig;
}

/**
 * Tweak definitions for the Tweaks panel (bind with defineTweak in src/tweaks/ when it lands).
 * {key, label, type, min, max, step, info}
 */
export const LEAD_TWEAKS = Object.freeze([
  { key: "releaseMs", label: "Release time (ms)", type: "range", min: 20, max: 1500, step: 10,
    info: "How long the lead note takes to fade out after the pinch opens. Smooth fade to exact silence; a new pinch during the fade retriggers cleanly." },
  { key: "sweetBand", label: "Sweet-spot band width (%)", type: "range", min: 0.1, max: 0.5, step: 0.01,
    info: "Faint band around the current note line: +-this fraction of the gap to the neighbour. Outside it the cursor leans toward the neighbour you are approaching." },
  { key: "snapHysteresis", label: "Snap hysteresis (fraction of gap)", type: "range", min: 0, max: 0.45, step: 0.01,
    info: "To leave a note the hand must pass the midpoint to the neighbour by this fraction of the gap. Higher = less waffling between two notes, more travel to switch." },
  { key: "showHandMarker", label: "Show hand marker", type: "toggle",
    info: "A small tick at the hand's exact (unsnapped) height on the ladder, so you can see how close you are to the next note." },
]);
