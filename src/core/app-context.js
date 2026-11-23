// Builds the shared services + the `ctx` handed to modes, exactly the way main.js wires them.
// Labs use it today so a mode runs against the real app context; main.js can adopt it later
// (it is a straight extraction of main.js's "Services" block).

import { createParam } from "./bus.js";
import { createHandInput } from "../input/hand-input.js";
import { createRouter } from "../router.js";
import { SynthEngine, createAudioFacade } from "../services/audio.js";
import { createHarmony } from "../services/harmony.js";

/**
 * @param {{ bus, registry, canvasEl: HTMLCanvasElement, controlsContainer?: HTMLElement|null,
 *           onFirstSound?: () => void }} o
 * @returns {{ synth, audio, harmony, handInput, ctx, router }}
 */
export function createAppContext({ bus, registry, canvasEl, controlsContainer = null, onFirstSound = null }) {
  const synth = new SynthEngine({ bus, onFirstSound });
  const audio = createAudioFacade(synth);
  const harmony = createHarmony();
  const handInput = createHandInput({ bus });

  let router = null;
  const ctx = {
    audio,
    clock: null,
    harmony,
    bus,
    param: (name, opts) => createParam(bus, name, { owner: router?.modeId ?? undefined, ...opts }),
    toCanvas: (p) => ({ x: p.x * canvasEl.width, y: p.y * canvasEl.height }),
    now: 0,
    masterVolume: 1,
  };
  router = createRouter({ bus, registry, harmony, ctx, controlsContainer });
  return { synth, audio, harmony, handInput, ctx, router };
}
