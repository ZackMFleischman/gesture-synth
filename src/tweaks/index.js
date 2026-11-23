// Tweaks entry: dynamic-imported by main.js only when the URL has `?tweaks` (src/tweaks/flag.js). Turns the shared
// store on (stored values apply), defines the app's tweaks, mounts the panel. Tweaks defined later by any module
// still apply and appear (the panel rebuilds on every new definition).
import { sharedTweaks, enableTweaks } from "./tweaks.js";
import { defineAppTweaks } from "./defs.js";
import { mountTweaksPanel } from "./panel.js";

export async function mountTweaks({ synth = null, doc = document } = {}) {
  const tweaks = sharedTweaks();
  enableTweaks();
  await defineAppTweaks({ synth });
  const panel = mountTweaksPanel({ tweaks, doc });
  let pending = false;
  tweaks.onDefine(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      panel.rebuild();
    });
  });
  return { tweaks, panel };
}
