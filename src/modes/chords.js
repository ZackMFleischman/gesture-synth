// Chords mode: today's right-hand behavior as a mode plugin.
//   right fingers (index..pinky) -> voicing 1-4, thumb -> octave down,
//   tilt -> lowpass filter, plus the energy wave drawing. Right height has no function in Chords (for now):
//   the volume is the left hand's height alone (the master `volume` the router publishes); the chord voice
//   plays at the fixed CHORDS_LEVEL.
// The left-hand chord comes from the router via ctx.harmony.raw.
//
// Publishes: chord, voicing, chords/octave (state); filter (continuous).
// hold(ctx) keeps the right-hand values while the radial menu holds the right hand.

import { createChordStabilizer } from "../services/harmony.js";
import { trackClarityEvent } from "../services/analytics.js";

/** The energy wave behind the chord display (shared by every mode; see docs/ui-integration.md §3). */
export function drawEnergy(ctx, volume01, qualityIndex, tiltFactor, chordStr) {
  if (!ctx) return;

  // 1. QUALITY determines the number of lines (1: Major, 2: Minor, 3: Dominant, 4: Diminished)
  if (qualityIndex === 0) return;
  const lineCount = qualityIndex; // 1 to 4 lines stacked or layered

  try {
    // Center alignment point behind your absolute bottom HTML #chordDisplay text
    const centerY = ctx.canvas.height - 56;
    const canvasWidth = ctx.canvas.width;

    // 2. VOLUME determines the thickness of the lines
    const maxThickness = 1 + (volume01 * 8); // Scaled from hairline to 9px thick

    // 3. TILT determines the "shakiness" (magnitude and speed of jagged distortion)
    // Convert tiltFactor (-1 to 1) linearly to a chaos scale (0 to 1)
    const chaosScale = (tiltFactor + 1) / 2;
    const shakinessAmp = chaosScale * 25;   // Micro-vibrations past the base wave path
    const shakinessFreq = 0.05 + (chaosScale * 0.15);

    // ---- 4. SCALE DEGREE determines the color hues ----
    let baseColorRGB = "150, 150, 150"; // Muted gray placeholder when no chord is playing
    let isChordActive = false;
    let isMajor = false;

    if (chordStr && chordStr !== "--") {
      isChordActive = true;
      const upperStr = chordStr.toUpperCase();
      isMajor = (chordStr === upperStr);

      const SCALE_COLORS = {
        "I":   "232, 161, 61",  // Tonic: Golden Sunset
        "II":  "210, 50, 120",  // 2nd: Purple-Red
        "III": "180, 40, 150",  // 3rd: Deep Violet/Magenta alternative
        "IV":  "240, 210, 40",  // 4th: Yellow
        "V":   "245, 120, 30",  // 5th: Orange
        "VI":  "230, 40, 40",    // 6th: Red
        "VII": "100, 200, 250"   // 7th: Cyan
      };
      baseColorRGB = SCALE_COLORS[upperStr] || "232, 161, 61";
    }


    // ---- 5. MAJOR / MINOR determines brightness ----
    // Major chords pop at 100% full opacity/glow. Minor chords damp down to a subtle 45% moody state.
    const brightnessAlpha = isChordActive ? (isMajor ? 1 : 0.70) : 0.3;

    ctx.save();

    // Time variable creates fluid left-to-right scrolling motion frame-by-frame
    const time = performance.now() * 0.004;

    // Parse base color strings safely for layout injection
    const colorChannels = baseColorRGB.split(",");
    const r = parseInt(colorChannels[0]);
    const g = parseInt(colorChannels[1]);
    const b = parseInt(colorChannels[2]);

    ctx.shadowBlur = 10 + (volume01 * 20);
    ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${0.5 * brightnessAlpha})`;

    // Draw individual lines stacked around the vertical text baseline
    for (let l = 0; l < lineCount; l++) {
      ctx.beginPath();

      // Separate each individual line layer vertically so they look like a wire ribbon
      const lineYOffset = centerY + (l - (lineCount - 1) / 2) * 12;

      for (let x = 0; x <= canvasWidth; x += 10) {
        // A standard flowing sine wave path
        const baseSine = Math.sin(x * 0.005 + time + l * 0.5) * 20;

        // Jitter math: Random noise scaled entirely by the right-hand tilt shakiness
        const jitter = (Math.random() - 0.5) * shakinessAmp * Math.sin(x * shakinessFreq + time);

        const y = lineYOffset + baseSine + jitter;

        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${brightnessAlpha})`;
      ctx.lineWidth = Math.max(1, maxThickness - (l * 0.5)); // Subtle thickness variation per line layer
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    ctx.restore();

  } catch (error) {
    console.error("Wave animation failed:", error);
  }
}

/**
 * Chord-voice gain (synth.chordGain) while a chord plays. Fixed: Chords' volume is the left hand only (master).
 * 1 = the "right = 1" level of the gain staging (src/services/audio.js header; tests/gain-staging.e2e.spec.js):
 * every chord at master 1, sawtooth, filter fully open still peaks >= 1 dB under the limiter threshold.
 */
export const CHORDS_LEVEL = 1;

// ---- Mode state ----
const stabilizeChordState = createChordStabilizer();
let lastTrackedChord = null;
let filterParam = null;

// Right-hand values as last applied: what hold() keeps playing while the menu holds the right hand.
// `on` = a chord was sounding (right hand visible with a voicing): the pad keeps playing while held.
const held = { quality: 0, thumb: false, on: false };

// Published chord descriptor, memoized on (stable state identity, key).
let publishedFrom = undefined;
let publishedKeyVersion = -1;
let publishedChord = null;

// What draw() renders (set by update()). volume = the master (left height): the wave's thickness.
const view = { volume: 0, qualityIndex: 0, tilt: 0, chord: null };

/** Chord-release fade when leaving Chords: long enough to overlap the next mode's first notes. */
export const CHORDS_EXIT_FADE = 0.4;

function ensureParams(ctx) {
  if (filterParam) return;
  filterParam = ctx.param("filter", {
    type: "continuous",
    min: -1,
    max: 1,
    onChange: (tilt) => ctx.audio.setFilter(tilt),
  });
}

function publish(ctx, stable) {
  const { harmony, bus } = ctx;
  if (stable !== publishedFrom || harmony.keyVersion !== publishedKeyVersion) {
    publishedFrom = stable;
    publishedKeyVersion = harmony.keyVersion;
    publishedChord = stable ? harmony.describe(stable.chord, stable.isMajorMode) : null;
  }
  bus.set("voicing", stable ? stable.qualityIndex : 0);
  bus.set("chords/octave", stable ? stable.thumbDown : false);
  bus.set("chord", publishedChord);
}

function sound(ctx, stable, on) {
  if (on && stable && stable.qualityIndex >= 1) {
    ctx.audio.playChord(ctx.harmony.notes(stable.chord, stable.isMajorMode, stable.qualityIndex, stable.thumbDown));
    ctx.audio.setVolume(CHORDS_LEVEL);
    return true;
  }
  ctx.audio.setVolume(0);
  return false;
}

export default {
  id: "chords",
  name: "Chords",
  icon: "🎹",
  color: "#e8a13d",
  direction: "up",
  signals: [
    { name: "chord", type: "state" },
    { name: "voicing", type: "state" },
    { name: "chords/octave", type: "state" },
    { name: "filter", type: "continuous" },
  ],
  guide: [["✊", "Menu"], ["👍", "Octave down"]],
  // Right height does nothing in Chords: no right edge track. The 8-bar meter shows the master (left height).
  rightTrack: null,
  meter: "volume",
  rightLost: true, // still show "Hand lost" for the right hand (it silences the pad)

  enter(ctx) {
    ensureParams(ctx);
    // Coming back from another mode: start from the shared voicing and the locked right hand
    // (ctx.rightLocked), so the pad starts at once (no stabilizer wait) and nothing jumps.
    const locked = ctx.rightLocked;
    held.quality = Math.max(1, Math.min(4, ctx.harmony.voicing || 1));
    held.thumb = false;
    if (locked) held.on = true;
    view.volume = ctx.masterVolume ?? view.volume;
    // Start the pad right now (same call as the previous mode's exit), not on the next frame:
    // a slow frame must not open a gap in the sound.
    if (ctx.rightLocked) this.hold(ctx);
  },

  exit(ctx) {
    // Leaving Chords: fade the pad out (click-free, overlapping the next mode's first notes).
    // The chord-voice gain itself is left alone; the master volume is the router's.
    ctx.audio.releaseChord?.(CHORDS_EXIT_FADE);
    stabilizeChordState.prime(null, ctx.now);
    publishedFrom = undefined;
  },

  /** Menu holds the right hand: keep voicing/filter (and the pad on/off), follow the left-hand chord. */
  hold(ctx) {
    const c = ctx.harmony.chord;
    const state = c ? { chord: c.roman, isMajorMode: c.isMajor, qualityIndex: held.quality, thumbDown: held.thumb } : null;
    const stable = stabilizeChordState.prime(state, ctx.now);
    if (stable && stable.qualityIndex >= 1) ctx.harmony.voicing = stable.qualityIndex;
    publish(ctx, stable);
    sound(ctx, stable, held.on);
    view.volume = ctx.masterVolume ?? view.volume;
    view.qualityIndex = stable ? stable.qualityIndex : 0;
    view.chord = stable ? stable.chord : null;
  },

  update(right, ctx) {
    const { harmony } = ctx;

    // ---- Raw musical state: left chord (from router) + right voicing ----
    const left = harmony.raw;
    let rawChordState = null;
    let rawQualityIndex = 0;
    let rawThumbDown = false;
    if (right) {
      rawQualityIndex = right.pinch && right.voicingBeforePinch != null ? right.voicingBeforePinch : right.voicingCount;
      rawThumbDown = right.fingers.thumb;
    }
    if (left && left.chord) {
      rawChordState = {
        chord: left.chord,
        isMajorMode: left.isMajorMode,
        qualityIndex: rawQualityIndex,
        thumbDown: rawThumbDown,
      };
    }

    // ---- Stabilize ----
    const stable = stabilizeChordState(rawChordState, ctx.now);
    let currentChord = null;
    let isMajorMode = true;
    let qualityIndex = 0;
    let thumbDown = false;
    if (stable) {
      currentChord = stable.chord;
      isMajorMode = stable.isMajorMode;
      qualityIndex = stable.qualityIndex;
      thumbDown = stable.thumbDown;
    }
    if (qualityIndex >= 1) harmony.voicing = qualityIndex;

    // ---- Publish state (the on-screen indicators read these) ----
    publish(ctx, stable);

    // ---- Sound ----
    if (right) {
      filterParam.value = right.tilt; // filter sweep + readout

      if (currentChord && qualityIndex >= 1) {
        const chordTrackingKey =
          `${currentChord}-${isMajorMode ? "major" : "minor"}-${qualityIndex}-${thumbDown ? "low" : "normal"}`;

        if (chordTrackingKey !== lastTrackedChord) {
          lastTrackedChord = chordTrackingKey;
          trackClarityEvent("chord_changed");
        }
      }
      sound(ctx, stable, true);
      held.on = qualityIndex >= 1;
      if (qualityIndex >= 1) {
        held.quality = qualityIndex;
        held.thumb = thumbDown;
      }
    } else {
      // Right hand out of frame = rest.
      ctx.audio.setVolume(0);
      held.on = false;
    }

    // ---- Visual energy state (thickness = the volume you hear: the master) ----
    view.volume = right ? ctx.masterVolume ?? 1 : 0;
    view.tilt = right ? right.tilt : 0;
    view.qualityIndex = qualityIndex;
    view.chord = currentChord;
  },

  draw(g) {
    drawEnergy(g, view.volume, view.qualityIndex, view.tilt, view.chord);
  },

  /**
   * No screen rows: Chords' only right-hand values are the voicing and the thumb octave (gestures). Its volume is the
   * master (left height, Controls "Master vol"), also under the Lead layer.
   */
  controls() {
    return () => {};
  },

  menuItems: [],
};
