// Builds the shared services + the `ctx` handed to modes. main.js and the labs both use it, so a
// mode in a lab runs against exactly the app's wiring (docs/architecture.md "ctx" + amendments).

import { createParam } from "./bus.js";
import { createHandInput } from "../input/hand-input.js";
import { createRouter } from "../router.js";
import { SynthEngine, createAudioFacade } from "../services/audio.js";
import { createHarmony } from "../services/harmony.js";
import { createClock } from "../services/clock.js";

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

  // One shared tempo clock for every mode, created with the AudioContext (first user gesture).
  // Arp's enter() starts it; leaving Arp leaves it running.
  let clock = null;
  bus.declare("bpm", { type: "state", owner: "clock" });
  bus.declare("beat", { type: "event", owner: "clock" });
  const getClock = () => {
    if (!clock && synth.ctx) {
      clock = createClock(synth.ctx, { bus });
      bus.set("bpm", clock.bpm); // the clock publishes changes only
    }
    return clock;
  };

  let router = null;
  const ctx = {
    audio,
    get clock() { return getClock(); },
    harmony,
    bus,
    param: (name, opts) => createParam(bus, name, { owner: router?.modeId ?? undefined, ...opts }),
    toCanvas: (p) => ({ x: p.x * canvasEl.width, y: p.y * canvasEl.height }),
    now: 0,
    masterVolume: 1, // router: left height -> master volume (1.3); 1 until a left hand is seen
    rightLocked: null, // router: the right HandFrame locked when the menu opened
  };
  router = createRouter({
    bus, registry, harmony, ctx, controlsContainer,
    aspect: () => (canvasEl.width && canvasEl.height ? canvasEl.width / canvasEl.height : 1),
  });
  return { synth, audio, harmony, handInput, ctx, router };
}
