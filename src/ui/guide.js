// Gesture guide extension + first-use labels (docs/ui-integration.md §4, §7).
//  - #gestureGuide keeps the 7 degree rows controls.js renders; we append a separator, a header with the
//    mode dot + name, and the active mode's right-hand rows (`mode.guide` or the defaults below).
//    controls.js re-renders the guide on key change; a MutationObserver re-appends our rows.
//  - First-use labels: plates at the right hand for ~3 s the first time a mode is used (counted from the
//    first frame the right hand is visible in that mode), and again whenever the guide is open.

import { COLORS, FONT, LAYOUT, MOTION, drawLabel } from "./theme.js";
import { trackX } from "./edge-tracks.js";

/** Right-hand guide rows per mode (spec table, ui-integration.md §7). A mode's own `guide` wins. */
export const DEFAULT_GUIDE = {
  chords: [["✊", "Menu"], ["↕", "Volume"], ["👍", "Octave down"]],
  arp: [["✊", "Menu"], ["↕", "Gate"], ["👍", "Double time"], ["🤏", "Tempo"]],
  lead: [["✊", "Menu"], ["↕", "Note"], ["🤏", "Play"], ["☝️", "Note set"]],
};

/** First-use labels per mode (≤ 2 words). Placement keys: track | arc | thumb | under. */
export const FIRST_USE = {
  arp: [["track", "Gate"], ["arc", "Filter"], ["thumb", "Thumb: x2"], ["under", "Pinch: tempo"]],
};
/** On phones only the labels at the edge / above the hand show: the others land on the player's torso. */
export const PHONE_FIRST_USE = new Set(["track", "arc"]);
const isPhone = (G) => G.W < 600 || G.H < 500;

export function createGuide({ S, doc }) {
  const guideEl = doc.getElementById("gestureGuide");
  let renderedFor = null;
  const seen = new Set();
  let firstUseUntil = 0;
  let visible = false;

  function rowsFor() {
    return (Array.isArray(S.mode?.guide) && S.mode.guide) || DEFAULT_GUIDE[S.modeId] || [];
  }

  function append() {
    if (!guideEl) return;
    guideEl.querySelectorAll(".gs-guide-ext").forEach((n) => n.remove());
    const rows = rowsFor();
    if (!rows.length) return;
    const frag = doc.createDocumentFragment();
    const sep = doc.createElement("div");
    sep.className = "gs-guide-sep gs-guide-ext";
    const head = doc.createElement("div");
    head.className = "gs-guide-head gs-guide-ext";
    head.textContent = S.name;
    frag.append(sep, head);
    for (const [emoji, label] of rows) {
      const row = doc.createElement("div");
      row.className = "gesture-guide-row gs-guide-mode gs-guide-ext";
      const e = doc.createElement("span");
      e.className = "gesture-guide-gesture";
      e.textContent = emoji;
      const l = doc.createElement("span");
      l.className = "gs-guide-label";
      l.textContent = label;
      row.append(e, l);
      frag.append(row);
    }
    guideEl.append(frag);
    renderedFor = S.modeId;
  }

  // controls.js replaces the guide's innerHTML on key change: put our rows back.
  const observer = new MutationObserver(() => {
    if (!guideEl.querySelector(".gs-guide-head")) append();
  });
  if (guideEl) observer.observe(guideEl, { childList: true });

  const isOpen = () => !!guideEl && !guideEl.classList.contains("hidden");

  function update() {
    if (S.modeId !== renderedFor) append();
    const labels = FIRST_USE[S.modeId];
    if (labels && !seen.has(S.modeId) && S.hands.right.pos) {
      seen.add(S.modeId);
      firstUseUntil = S.now + MOTION.firstUse;
    }
    if (!labels) firstUseUntil = 0;
    visible = !!labels && (S.now < firstUseUntil || S.guideOpen) && !!S.drawPos("right") && S.menu.state === "closed";
  }

  function draw(g, G) {
    if (!visible) return;
    const R = G.toPx(S.drawPos("right"));
    const exprSide = S.chordSide === "left" ? "right" : "left";
    const inw = exprSide === "left" ? 1 : -1; // from the right-hand edge towards the center
    const size = 12;
    const o = { size, plate: true, color: COLORS.ink };
    g.save();
    g.font = `400 ${size}px ${FONT.family}`;
    const placed = [];
    for (const [where, text] of FIRST_USE[S.modeId]) {
      if (isPhone(G) && !PHONE_FIRST_USE.has(where)) continue;
      let x, y, align;
      if (where === "track") {
        if (!S.rightTrack) continue;
        [x, y, align] = [trackX(exprSide, G) + inw * (LAYOUT.gutter + 2), R.y - 18, inw > 0 ? "left" : "right"];
      } else if (where === "arc") {
        [x, y, align] = [R.x, R.y - G.hs * 0.95 - 16, "center"];
      } else if (where === "thumb") {
        // Thumb side = towards the screen center.
        [x, y, align] = [R.x + inw * G.hs * 0.62, R.y + G.hs * 0.18, inw > 0 ? "left" : "right"];
      } else {
        [x, y, align] = [R.x, R.y + G.hs * 0.74, "center"];
      }
      // Same box drawLabel() will cover (plate padding 6/3): skip labels an open panel would cut.
      const w = g.measureText(text).width + 12;
      const h = size * 1.15 + 6;
      const left = align === "center" ? x - w / 2 : align === "right" ? x - w + 6 : x - 6;
      // Skip a label an open panel would cut.
      if (!S.covered({ x: left, y: y - h / 2, w, h })) placed.push({ where, text, x, y, align });
    }
    // A hand under an open panel gets no labels at all: orphaned labels read as noise.
    if (!S.palmCovered(R, G.hs))
      for (const p of placed) G.reg(`first-use-${p.where}`, "transient", drawLabel(g, p.text, p.x, p.y, { ...o, align: p.align }));
    g.restore();
  }

  return {
    update,
    draw,
    isOpen,
    firstUseVisible: () => visible,
    destroy() {
      observer.disconnect();
      guideEl?.querySelectorAll(".gs-guide-ext").forEach((n) => n.remove());
    },
  };
}
