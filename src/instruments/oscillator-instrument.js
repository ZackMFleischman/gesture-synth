// Factory for the original single-oscillator instruments (Warm / Bright / Retro). Their source IS the OscillatorNode
// (bit-identical to the app before instruments existed), with the Source methods added.
import { stepParam } from "./shared.js";

/**
 * @param {{ id, label, icon, wave: OscillatorType, level?: number, toneLabel?: string }} o
 */
export function oscillatorInstrument({ id, label, icon, wave, level = 1, toneLabel }) {
  return {
    id,
    label,
    icon,
    level,
    tone: wave, // the tone select's historical values: triangle / sawtooth / square
    toneLabel,
    traits: { releaseTailS: null, leadToneHz: 3200 }, // stop at once on a chord change (original behavior)
    createSource(ac, freq, t0) {
      const osc = ac.createOscillator();
      osc.type = wave;
      osc.frequency.value = freq;
      osc.start(t0);
      osc.instrument = id;
      osc.release = () => {};
      osc.excite = () => {};
      osc.setFreq = (f, t, ramp = 0) => stepParam(osc.frequency, f, t, ramp);
      return osc;
    },
  };
}
