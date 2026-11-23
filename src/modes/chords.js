// Chords mode: today's right-hand behavior as a mode plugin.
//   right fingers (index..pinky) -> voicing 1-4, thumb -> octave down,
//   height -> volume, tilt -> lowpass filter, plus the energy wave drawing.
// The left-hand chord comes from the router via ctx.harmony.raw.
//
// Publishes: chord, voicing, chords/octave (state); chords/volume (right-height chord-voice volume,
// multiplied with the master `volume` the router publishes from the left height), filter (continuous).
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

// ---- Mode state ----
const stabilizeChordState = createChordStabilizer();
let lastTrackedChord = null;
let volumeParam = null;
let filterParam = null;

// Right-hand values as last applied: what hold() keeps playing while the menu holds the right hand.
const held = { quality: 0, thumb: false, volume: 0 };

// Published chord descriptor, memoized on (stable state identity, key).
let publishedFrom = undefined;
let publishedKeyVersion = -1;
let publishedChord = null;

// What draw() renders (set by update()).
const view = { volume: 0, qualityIndex: 0, tilt: 0, chord: null };

/** Chord-release fade when leaving Chords: long enough to overlap the next mode's first notes. */
export const CHORDS_EXIT_FADE = 0.4;

function ensureParams(ctx) {
  if (volumeParam) return;
  // Right height = chord-voice volume (multiplied with the master volume from the left height).
  volumeParam = ctx.param("chords/volume", { type: "continuous", min: 0, max: 1 });
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

function sound(ctx, stable, volume) {
  if (stable && stable.qualityIndex >= 1 && volume > 0) {
    ctx.audio.playChord(ctx.harmony.notes(stable.chord, stable.isMajorMode, stable.qualityIndex, stable.thumbDown));
    ctx.audio.setVolume(volume);
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
    { name: "chords/volume", type: "continuous" },
    { name: "filter", type: "continuous" },
  ],
  guide: [["✊", "Menu"], ["↕", "Volume"], ["👍", "Octave down"]],
  rightTrack: { param: "chords/volume", label: "Volume" },

  enter(ctx) {
    ensureParams(ctx);
    // Coming back from another mode: start from the shared voicing and the locked right hand
    // (ctx.rightLocked), so the pad starts at once (no stabilizer wait) and nothing jumps.
    const locked = ctx.rightLocked;
    held.quality = Math.max(1, Math.min(4, ctx.harmony.voicing || 1));
    held.thumb = false;
    held.volume = locked ? Math.max(0, Math.min(1, locked.height)) : held.volume;
    view.volume = held.volume;
    if (locked) volumeParam.value = held.volume;
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

  /** Menu holds the right hand: keep voicing/volume/filter, follow the left-hand chord. */
  hold(ctx) {
    const c = ctx.harmony.chord;
    const state = c ? { chord: c.roman, isMajorMode: c.isMajor, qualityIndex: held.quality, thumbDown: held.thumb } : null;
    const stable = stabilizeChordState.prime(state, ctx.now);
    if (stable && stable.qualityIndex >= 1) ctx.harmony.voicing = stable.qualityIndex;
    publish(ctx, stable);
    sound(ctx, stable, held.volume);
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
      const currentVolume = right.height;
      volumeParam.value = currentVolume; // meter
      filterParam.value = right.tilt; // filter sweep + readout

      if (currentChord && qualityIndex >= 1) {
        const chordTrackingKey =
          `${currentChord}-${isMajorMode ? "major" : "minor"}-${qualityIndex}-${thumbDown ? "low" : "normal"}`;

        if (chordTrackingKey !== lastTrackedChord) {
          lastTrackedChord = chordTrackingKey;
          trackClarityEvent("chord_changed");
        }
      }
      sound(ctx, stable, currentVolume);
      held.volume = qualityIndex >= 1 ? currentVolume : 0;
      if (qualityIndex >= 1) {
        held.quality = qualityIndex;
        held.thumb = thumbDown;
      }
    } else {
      // Right hand out of frame = rest.
      ctx.audio.setVolume(0);
      held.volume = 0;
    }

    // ---- Visual energy state ----
    view.volume = right ? right.height : 0;
    view.tilt = right ? right.tilt : 0;
    view.qualityIndex = qualityIndex;
    view.chord = currentChord;
  },

  draw(g) {
    drawEnergy(g, view.volume, view.qualityIndex, view.tilt, view.chord);
  },

  controls() {
    return () => {};
  },

  menuItems: [],
};
