// Retro: the original square oscillator, trimmed to the loudness of the others (a square has +4.8 dB more RMS).
import { oscillatorInstrument } from "./oscillator-instrument.js";

export default oscillatorInstrument({
  id: "retro",
  label: "Retro",
  toneLabel: "Retro Synth",
  icon: "M3 16V8h4.5v8H12V8h4.5v8H21",
  wave: "square",
  level: 0.6,
});
