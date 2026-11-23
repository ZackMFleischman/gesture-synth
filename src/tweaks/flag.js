// Tiny on purpose: main.js imports this statically; everything else in src/tweaks/ is a lazy chunk.

/** Is the Tweaks panel requested by this URL? `?tweaks`, `?tweaks=true` / `=1` (not `=false` / `=0` / `=off`). */
export function tweaksRequested(search) {
  try {
    const p = new URLSearchParams(search);
    if (!p.has("tweaks")) return false;
    const v = (p.get("tweaks") || "").toLowerCase();
    return v !== "false" && v !== "0" && v !== "off" && v !== "no";
  } catch {
    return false;
  }
}
