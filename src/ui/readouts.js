// Existing right-hand readouts, extended for modes (docs/ui-integration.md D5, D6):
//  - #volumeMeter (8 bars) = the right-height expression meter: the active mode's right-track param
//    (Chords = volume, exactly as indicators.js renders it today; Arp = arp/gate), bars in the mode
//    color via CSS. Hidden when the mode has no right track (Lead alone). Under the Lead layer it shows the
//    base's HELD right-track value (S.meterTrack), dimmed and in the base color (modes.css `gs-layer`).
//  - #distortionDisplay "Filter: x%": same text; in modes that don't publish `filter` it follows
//    `right/tilt` (frozen while the right hand is held). Color + dim come from modes.css.
// indicators.js keeps rendering `volume`/`filter` as before; this module renders after it, so in
// Chords the result is identical and in other modes the mode's own value wins.

export function createReadouts({ S, bus, doc }) {
  const bars = Array.from(doc.querySelectorAll(".vol-bar"));
  const filterEl = doc.getElementById("distortionDisplay");
  let modeSeen = null;
  let filterSeenInMode = false;
  let lastFilterText = null;

  function renderMeter() {
    const p = S.meterTrack?.param;
    if (!p) return;
    const v = bus.get(p);
    if (typeof v !== "number") return;
    const lit = Math.round(Math.max(0, Math.min(1, v)) * bars.length);
    for (const bar of bars) bar.classList.toggle("lit", Number(bar.dataset.index) >= bars.length - lit);
  }

  function filterValue() {
    if (filterSeenInMode) return bus.get("filter");
    if (S.rightHeld || S.rightReturn) return S.filter; // frozen
    const t = S.hands.right.tilt;
    return typeof t === "number" ? t : S.filter;
  }

  function renderFilter() {
    const f = filterValue();
    if (typeof f !== "number") return;
    S.filter = f;
    if (!filterEl) return;
    const pct = Math.round(f * 100);
    const text = `Filter: ${pct > 0 ? "+" : ""}${pct}%`;
    if (text !== lastFilterText || filterEl.textContent !== text) {
      lastFilterText = text;
      filterEl.textContent = text;
    }
  }

  // Own subscription: `filter` + `volume` (indicators.js consumes them anyway) and the active mode's
  // right-track param, re-subscribed on mode change.
  let off = null;
  const consumer = {
    onSet(name) {
      if (name === "filter") filterSeenInMode = true;
      if (name === S.meterTrack?.param || name === "volume") renderMeter();
    },
  };
  function resubscribe() {
    off?.();
    off = bus.subscribe(consumer, ["filter", "volume", ...(S.meterTrack?.param ? [S.meterTrack.param] : [])]);
  }

  function update() {
    if (S.modeId !== modeSeen) {
      modeSeen = S.modeId;
      resubscribe();
      // Does this mode publish the shared `filter` signal? (Chords does; Arp, today, sets the filter directly.)
      filterSeenInMode = !!S.mode?.signals?.some((s) => s.name === "filter");
      renderMeter();
    }
    renderFilter();
  }

  return { update, destroy: () => off?.() };
}
