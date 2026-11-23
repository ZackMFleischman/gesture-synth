// Warm: the original triangle oscillator.
import { oscillatorInstrument } from "./oscillator-instrument.js";

export default oscillatorInstrument({
  id: "warm",
  label: "Warm",
  toneLabel: "Warm Synth",
  icon: "M3 15l4.5-6 4.5 6 4.5-6 4.5 6",
  wave: "triangle",
  level: 1,
});
