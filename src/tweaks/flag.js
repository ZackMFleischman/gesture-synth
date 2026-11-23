// Tiny on purpose: main.js imports this statically; everything else in src/tweaks/ is a lazy chunk.

/** Temporary (user, 2026-11-22): the Tweaks panel is on for everyone while we iterate. Set to false to go back to
 *  opt-in via `?tweaks`. `?tweaks=false` still turns it off for one page load. */
export const TWEAKS_ALWAYS_ON = true;

/** Is the Tweaks panel requested by this URL? `?tweaks`, `?tweaks=true` / `=1` (not `=false` / `=0` / `=off`). */
export function tweaksRequested(search) {
  try {
    if (TWEAKS_ALWAYS_ON) {
      const v = (new URLSearchParams(search).get("tweaks") || "").toLowerCase();
      return !["false", "0", "off", "no"].includes(v);
    }
    const p = new URLSearchParams(search);
    if (!p.has("tweaks")) return false;
    const v = (p.get("tweaks") || "").toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
  } catch {
    return false;
  }
}
