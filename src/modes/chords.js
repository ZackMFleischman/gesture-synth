// Chords mode: today's right-hand behavior as a mode plugin.
//   right fingers (index..pinky) -> voicing 1-4, thumb -> octave down,
//   height -> volume, tilt -> lowpass filter, plus the energy wave drawing.
// The left-hand chord comes from the router via ctx.harmony.raw.
//
// Publishes: chord, voicing, chords/octave (state); volume, filter (continuous).

import { createChordStabilizer } from "../services/harmony.js";
import { trackClarityEvent } from "../services/analytics.js";

function drawEnergy(ctx, volume01, qualityIndex, tiltFactor, chordStr) {
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

// Published chord descriptor, memoized on (stable state identity, key).
let publishedFrom = undefined;
let publishedKeyVersion = -1;
let publishedChord = null;

// What draw() renders (set by update()).
const view = { volume: 0, qualityIndex: 0, tilt: 0, chord: null };

function ensureParams(ctx) {
  if (volumeParam) return;
  volumeParam = ctx.param("volume", { type: "continuous", min: 0, max: 1 });
  filterParam = ctx.param("filter", {
    type: "continuous",
    min: -1,
    max: 1,
    onChange: (tilt) => ctx.audio.setFilter(tilt),
  });
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
    { name: "volume", type: "continuous" },
    { name: "filter", type: "continuous" },
  ],

  enter(ctx) {
    ensureParams(ctx);
  },

  exit(ctx) {
    // Leaving Chords: stop the chord drone (other modes make their own sound).
    ctx.audio.setVolume(0);
  },

  update(right, ctx) {
    const { harmony, bus } = ctx;

    // ---- Raw musical state: left chord (from router) + right voicing ----
    const left = harmony.raw;
    let rawChordState = null;
    let rawQualityIndex = 0;
    let rawThumbDown = false;
    if (right) {
      rawQualityIndex = right.voicingCount;
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
    if (stable !== publishedFrom || harmony.keyVersion !== publishedKeyVersion) {
      publishedFrom = stable;
      publishedKeyVersion = harmony.keyVersion;
      publishedChord = stable ? harmony.describe(currentChord, isMajorMode) : null;
    }
    bus.set("voicing", qualityIndex);
    bus.set("chords/octave", thumbDown);
    bus.set("chord", publishedChord);

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

        ctx.audio.playChord(harmony.notes(currentChord, isMajorMode, qualityIndex, thumbDown));
        ctx.audio.setVolume(currentVolume);
      } else {
        ctx.audio.setVolume(0);
      }
    } else {
      ctx.audio.setVolume(0);
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
