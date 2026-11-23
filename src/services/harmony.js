// Harmony service: key, scale degrees, chord tones, voicings, names, and the chord
// stabilizer. The music theory is moved unchanged from the old main.js.
// Pure logic (no DOM).

// ---- Gesture guide (left-hand degree shapes) ----
export const GESTURE_GUIDE = [
  { degree: 1, gesture: "1️⃣" },
  { degree: 2, gesture: "2️⃣" },
  { degree: 3, gesture: "3️⃣" },
  { degree: 4, gesture: "4️⃣" },
  { degree: 5, gesture: "5️⃣" },
  { degree: 6, gesture: "🤘" },
  { degree: 7, gesture: "🤟" }
];

export const MAJOR_SCALE = {
  A:  ["A","B","C#","D","E","F#","G#"],
  Bb: ["Bb","C","D","Eb","F","G","A"],
  B:  ["B","C#","D#","E","F#","G#","A#"],
  C:  ["C","D","E","F","G","A","B"],
  Db: ["Db","Eb","F","Gb","Ab","Bb","C"],
  D:  ["D","E","F#","G","A","B","C#"],
  Eb: ["Eb","F","G","Ab","Bb","C","D"],
  E:  ["E","F#","G#","A","B","C#","D#"],
  F:  ["F","G","A","Bb","C","D","E"],
  Gb: ["Gb","Ab","Bb","Cb","Db","Eb","F"],
  G:  ["G","A","B","C","D","E","F#"],
  Ab: ["Ab","Bb","C","Db","Eb","F","G"]
};

// Semitone offset of each scale degree from the tonic, in a major scale.
// This stays fixed -- what changes is which frequency counts as "0".
export const DEGREE_SEMITONES = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9 ,7: -1};

export const NUMERAL_TO_DEGREE = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7
};

/** Right-hand voicing labels (1-4) shown in the quality display. */
export const MAJOR_LABELS = {
  1: "Major",
  2: "Major 1st Inv",
  3: "Major 7th",
  4: "Dominant 7th"
};

export const MINOR_LABELS = {
  1: "Minor",
  2: "Minor 1st Inv",
  3: "Minor 7th",
  4: "Diminished 7th"
};

// Map the 4 right-hand finger variations depending entirely on the left-hand tilt mode
export function getSolidNotes(tones, rightHandCount, isMajorMode) {
  if (!tones) return [];

  const {
    root, third, fifth, octaveRoot, octaveThird,
    maj7Tone, dom7Tone, dim7Tone, dim5Tone
  } = tones;

  if (isMajorMode) {
    switch (rightHandCount) {
      case 1: // Major chord (root, fifth, octave, octave third)
        return [root, fifth, octaveRoot, octaveThird];
      case 2: // 1st inversion (third, fifth, octave, octave third)
        return [third, fifth, octaveRoot, octaveThird];
      case 3: // Major 7th (root, third, fifth, maj7)
        return [root, third, fifth, maj7Tone];
      case 4: // Dominant 7th (root, third, fifth, dom7)
        return [root, third, fifth, dom7Tone];
      default:
        return [root, fifth, octaveRoot, octaveThird];
    }
  } else {
    // Minor Mode Routing
    switch (rightHandCount) {
      case 1: // Minor chord (root, fifth, octave, octave minor third)
        return [root, fifth, octaveRoot, octaveThird];
      case 2: // 1st inversion (minor third, fifth, octave, octave minor third)
        return [third, fifth, octaveRoot, octaveThird];
      case 3: // Minor 7th (root, third, fifth, dom7)
        return [root, third, fifth, dom7Tone];
      case 4: // Diminished 7th (root, minor third, diminished fifth, dim7)
        return [root, third, dim5Tone, dim7Tone];
      default:
        return [root, fifth, octaveRoot, octaveThird];
    }
  }
}

// ---- Chord state stabilizer ----

// Musical state: needs confidence before changing
export const CHORD_HOLD_TIME_MS = 100;

// Expression controls: should feel immediate
export const VIBE_NULL_WINDOW_MS = 50;

export function sameChordState(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  return (
    a.chord === b.chord &&
    a.isMajorMode === b.isMajorMode &&
    a.qualityIndex === b.qualityIndex &&
    a.thumbDown === b.thumbDown
  );
}

/**
 * Returns stabilize(rawState, now) -> stableState. States are
 * { chord, isMajorMode, qualityIndex?, thumbDown? } or null. The returned object
 * keeps its identity while it stays stable (consumers can compare by reference).
 */
export function createChordStabilizer() {
  let stableChordState = null;
  let candidateChordState = null;
  let candidateChordSince = 0;
  let lastChordSeenValidTime = 0;

  return function stabilizeChordState(rawState, now) {
    if (rawState !== null) {
      lastChordSeenValidTime = now;
    }

    let effectiveState = rawState;

    // prevent MediaPipe flicker
    if (rawState === null && now - lastChordSeenValidTime < VIBE_NULL_WINDOW_MS) {
      effectiveState = candidateChordState;
    }

    if (!sameChordState(effectiveState, candidateChordState)) {
      candidateChordState = effectiveState;
      candidateChordSince = now;
    }

    if (now - candidateChordSince >= CHORD_HOLD_TIME_MS) {
      stableChordState = candidateChordState;
    }

    return stableChordState;
  };
}

function freqToMidi(f) {
  return Math.round(69 + 12 * Math.log2(f / 440));
}

/**
 * The harmony service (ctx.harmony). Holds the key and the current left-hand chord.
 *  - raw:   this frame's unstabilized left-hand chord { chord: roman|null, isMajorMode } | null
 *  - chord: stabilized left-hand chord { roman, degree, isMajor, name, rootMidi, tones } | null
 *  - voicing: 1..4 (set by the active mode; Chords sets it from the right hand)
 */
export function createHarmony({ tonicFreq = 220, keyName = "A" } = {}) {
  const stabilizeLeft = createChordStabilizer();
  let lastStable = null;
  let lastKeyVersion = -1;

  const h = {
    tonicFreq,
    keyName,
    keyVersion: 0,
    raw: null,
    chord: null,
    voicing: 1,

    setKey(freq, name) {
      h.tonicFreq = freq;
      h.keyName = name;
      h.keyVersion++;
    },

    scale() {
      return MAJOR_SCALE[h.keyName];
    },

    getDegreeFreq(degree) {
      const semitones = DEGREE_SEMITONES[degree];

      let tonic = h.tonicFreq;

      // Drop these keys one octave
      if (
        tonic === 369.99 || // Gb/F#
        tonic === 392.00 || // G
        tonic === 415.30    // Ab/G#
      ) {
        tonic /= 2;
      }

      return tonic * Math.pow(2, semitones / 12);
    },

    getChordName(roman, isMajorMode) {
      if (!roman || roman === "--") {
        return "";
      }

      const degree = NUMERAL_TO_DEGREE[roman.toUpperCase()];

      if (!degree) {
        return "";
      }

      const root = MAJOR_SCALE[h.keyName][degree - 1];

      return isMajorMode ? root : root + "m";
    },

    // Generate all fundamental raw intervals relative to the degree root
    getChordTones(numeralStr, isMajorMode) {
      if (!numeralStr || numeralStr === "--") return null;

      const degree = NUMERAL_TO_DEGREE[numeralStr.toUpperCase()];
      if (!degree) return null;

      const root = h.getDegreeFreq(degree);

      // Define scale intervals using precise semitone adjustments
      const thirdSemitones = isMajorMode ? 4 : 3;
      const fifthSemitones = 7; // Fixed perfect 5th for modes 1, 2, 3

      // Extension semitones (11 for Major 7th, 10 for Dominant 7, 9 for Diminished 7)
      const maj7Semitones = 11;
      const dom7Semitones = 10;
      const dim7Semitones = 9;

      // Build the tone collection
      const third = root * Math.pow(2, thirdSemitones / 12);
      const fifth = root * Math.pow(2, fifthSemitones / 12);

      const octaveRoot = root * 2;
      const octaveThird = third * 2;

      // Special extension notes
      const maj7Tone = root * Math.pow(2, maj7Semitones / 12);
      const dom7Tone = root * Math.pow(2, dom7Semitones / 12);
      const dim7Tone = root * Math.pow(2, dim7Semitones / 12);

      // If left hand mode is minor, case 4 needs a diminished 5th (tritone) for the Diminished 7th chord
      const dim5Tone = root * Math.pow(2, 6 / 12);

      return {
        root, third, fifth, octaveRoot, octaveThird,
        maj7Tone, dom7Tone, dim7Tone, dim5Tone
      };
    },

    getSolidNotes,

    /** The 4 voiced frequencies Chords plays for this chord/voicing (thumb = octave down). */
    notes(roman, isMajorMode, voicing, octaveDown = false) {
      let notes = getSolidNotes(h.getChordTones(roman, isMajorMode), voicing, isMajorMode);
      if (octaveDown) notes = notes.map((freq) => freq / 2);
      return notes;
    },

    /** Chord descriptor (contract shape). `tones` = voiced notes for the current h.voicing. */
    describe(roman, isMajorMode) {
      if (!roman) return null;
      const degree = NUMERAL_TO_DEGREE[roman.toUpperCase()];
      if (!degree) return null;
      return {
        roman,
        degree,
        isMajor: isMajorMode,
        name: h.getChordName(roman, isMajorMode),
        rootMidi: freqToMidi(h.getDegreeFreq(degree)),
        get tones() {
          return h.notes(roman, isMajorMode, h.voicing || 1);
        },
      };
    },

    /** Router feeds the left hand here every frame. */
    updateLeft(raw, now) {
      h.raw = raw;
      const stable = stabilizeLeft(raw && raw.chord ? raw : null, now);
      if (stable !== lastStable || h.keyVersion !== lastKeyVersion) {
        lastStable = stable;
        lastKeyVersion = h.keyVersion;
        h.chord = stable ? h.describe(stable.chord, stable.isMajorMode) : null;
      }
      return h.chord;
    },
  };
  return h;
}
