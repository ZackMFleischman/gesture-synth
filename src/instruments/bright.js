// Bright: the original sawtooth oscillator.
import { oscillatorInstrument } from "./oscillator-instrument.js";

export default oscillatorInstrument({
  id: "bright",
  label: "Bright",
  toneLabel: "Bright Synth",
  icon: "M3 16l6-8v8l6-8v8l6-8",
  wave: "sawtooth",
  level: 1, // same RMS as the triangle (both 1/sqrt 3)
});
