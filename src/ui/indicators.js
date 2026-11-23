// On-screen indicators driven by the signal bus: chord display, quality display,
// right-hand volume meter, filter readout. They update synchronously inside bus.set(),
// i.e. in the same animation frame the value was produced (no visible delay).

import { MAJOR_LABELS, MINOR_LABELS } from "../services/harmony.js";

export function mountIndicators(bus, doc = document) {
  const chordDisplayEl = doc.getElementById("chordDisplay");
  const qualityDisplayEl = doc.getElementById("qualityDisplay");
  const volumeBarEls = Array.from(doc.querySelectorAll(".vol-bar"));
  const filterEl = doc.getElementById("distortionDisplay");

  function renderChord() {
    const chord = bus.get("chord");
    chordDisplayEl.textContent = chord ? `${chord.name}(${chord.roman})` : "--";
  }

  function renderQuality() {
    const chord = bus.get("chord");
    const qualityIndex = bus.get("voicing") || 0;
    const thumbDown = !!bus.get("chords/octave");
    const isMajorMode = chord ? chord.isMajor : true;
    const activeLabel = isMajorMode ? MAJOR_LABELS[qualityIndex] : MINOR_LABELS[qualityIndex];
    qualityDisplayEl.textContent = activeLabel ? `${activeLabel}${thumbDown ? " (-8ve)" : ""}` : "--";
  }

  function renderVolume(volume01) {
    const litCount = Math.round(volume01 * volumeBarEls.length);
    volumeBarEls.forEach((bar) => {
      const index = Number(bar.dataset.index);
      bar.classList.toggle("lit", index >= volumeBarEls.length - litCount);
    });
  }

  function renderFilter(tilt) {
    if (!filterEl) return;
    const tiltPercentage = Math.round(tilt * 100);
    filterEl.textContent = `Filter: ${tiltPercentage > 0 ? "+" : ""}${tiltPercentage}%`;
  }

  return bus.subscribe(
    {
      onSet(name, v) {
        switch (name) {
          case "chord":
            renderChord();
            renderQuality();
            break;
          case "voicing":
          case "chords/octave":
            renderQuality();
            break;
          case "volume":
            renderVolume(v);
            break;
          case "filter":
            renderFilter(v);
            break;
        }
      },
    },
    ["chord", "voicing", "chords/octave", "volume", "filter"]
  );
}
