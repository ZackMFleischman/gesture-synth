// Helpers for tests/mobile-ui.spec.js: collect what UI is on screen (DOM boxes + lab canvas regions).
import fs from "node:fs";
import path from "node:path";

/** Existing controls from index.html. */
export const EXISTING = [
  "keySelect",
  "toneSelect",
  "guideToggle",
  "gestureGuide",
  "volumeMeter",
  "distortionDisplay",
  "chordDisplay",
  "qualityDisplay",
  "helpButton",
];

/** Elements a user opens on purpose (exempt from coverage/clear-area while open; must be closable). */
export const PANELS = ["gestureGuide", "gsGuideClose", "controlsPanel", "helpModal", "gsControlsSheet"];

/**
 * Visible UI on the page.
 * @returns {Promise<{items:{name,rect,dom,kind}[], panels:{name,rect}[], W:number, H:number}>}
 */
export async function collectUI(page) {
  return page.evaluate(
    ({ EXISTING, PANELS }) => {
      const vis = (e) => {
        if (!e || !e.getClientRects().length) return false;
        for (let n = e; n && n !== document.body; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
        }
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const seen = new Set();
      const items = [];
      const panels = [];
      const add = (e, kind) => {
        if (!e || seen.has(e) || !vis(e)) return;
        seen.add(e);
        const name = `#${e.id || e.className}`;
        // A panel re-homed inside another open panel (e.g. #controlsPanel in the scrolling sheet) is part of it.
        const host = PANELS.map((id) => document.getElementById(id)).find((p) => p && p !== e && p.contains(e) && vis(p));
        if (PANELS.includes(e.id)) host || panels.push({ name, rect: box(e) });
        else items.push({ name, rect: box(e), dom: true, kind });
      };
      // Panels first so their children (e.g. selects inside the open tray) count as part of the panel.
      for (const id of PANELS) add(document.getElementById(id), "panel");
      const inPanel = (e) => PANELS.some((id) => document.getElementById(id)?.contains(e) && document.getElementById(id) !== e);
      for (const id of EXISTING) {
        const e = document.getElementById(id);
        if (e && !inPanel(e)) add(e, "existing");
      }
      for (const e of document.querySelectorAll("[data-gs-kind]")) if (!inPanel(e)) add(e, e.dataset.gsKind);
      for (const e of document.querySelectorAll("[data-gs-mobile]")) if (!inPanel(e)) add(e, "mobile");
      for (const r of window.__uiLab?.regions || [])
        if (r.kind === "edge" || r.kind === "status") items.push({ name: `canvas:${r.name}`, rect: r.rect, dom: false, kind: r.kind });
      return { items, panels, W: innerWidth, H: innerHeight };
    },
    { EXISTING, PANELS },
  );
}

/** Appends one audit row to test-results/mobile-audit/<file>.json (one file per test; merged by the doc). */
export function writeAudit(name, row) {
  const dir = "test-results/mobile-audit";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(row, null, 1));
}
