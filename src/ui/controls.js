// Existing DOM controls: key select + gesture guide, tone select, guide toggle,
// help modal, start overlay. Moved unchanged from the old main.js.

import { GESTURE_GUIDE, MAJOR_SCALE } from "../services/harmony.js";
import { trackClarityEvent } from "../services/analytics.js";

export function mountControls({ harmony, audio, synth, canvasEl, doc = document }) {
  const gestureGuideEl = doc.getElementById("gestureGuide");
  const guideToggleEl = doc.getElementById("guideToggle");
  const startOverlayEl = doc.getElementById("startOverlay");
  const keySelectEl = doc.getElementById("keySelect");
  const toneSelectEl = doc.getElementById("toneSelect");
  const helpButton = doc.getElementById("helpButton");
  const helpModal = doc.getElementById("helpModal");
  const closeHelp = doc.getElementById("closeHelp");

  function updateGestureGuide() {
    if (!gestureGuideEl) return;

    const scale = MAJOR_SCALE[harmony.keyName];

    gestureGuideEl.innerHTML = GESTURE_GUIDE
      .map(({ degree, gesture }) => `
      <div class="gesture-guide-row">
        <span class="gesture-guide-note">
          ${scale[degree - 1]}
        </span>

        <span class="gesture-guide-gesture">
          ${gesture}
        </span>
      </div>
    `)
      .join("");
  }

  // ---- Key ----
  const readKey = () => harmony.setKey(Number(keySelectEl.value), keySelectEl.selectedOptions[0].dataset.note);
  readKey();
  updateGestureGuide();
  keySelectEl.addEventListener("change", () => {
    readKey();
    updateGestureGuide();
  });

  // ---- Tone ----
  synth.waveform = toneSelectEl.value;
  toneSelectEl.addEventListener("change", () => {
    audio.setWaveform(toneSelectEl.value); // forces sound refresh
  });

  // ---- Start overlay ----
  startOverlayEl.addEventListener("click", () => {
    synth.ensureContext();
    startOverlayEl.style.display = "none";
    canvasEl.classList.remove("dimmed");
  });

  // ---- Guide + help ----
  guideToggleEl.addEventListener("click", () => {
    const isHidden = gestureGuideEl.classList.toggle("hidden");

    if (!isHidden) {
      trackClarityEvent("guide_opened");
    }

    guideToggleEl.textContent = isHidden ? "Open Guide" : "Close Guide";
  });

  helpButton.addEventListener("click", () => {
    trackClarityEvent("help_opened");
    helpModal.classList.remove("hidden");
  });

  closeHelp.addEventListener("click", (e) => {
    e.stopPropagation();
    helpModal.classList.add("hidden");
  });

  // Optional: click outside the card to close
  helpModal.addEventListener("click", (e) => {
    if (e.target === helpModal) {
      helpModal.classList.add("hidden");
    }
  });
}
