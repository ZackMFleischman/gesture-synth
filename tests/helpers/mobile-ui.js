// Helpers for tests/mobile-ui.spec.js: collect what UI is on screen (DOM boxes + lab canvas regions).
import fs from "node:fs";
import { expect } from "@playwright/test";
import { MOBILE_SIZES, summarize, coverage, offscreen } from "../../src/ui/mobile/layout-metrics.js";
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

// ---- shared by tests/mobile-ui.int.spec.js + tests/mobile-ui.e2e.spec.js ----
export const PHONES = Object.fromEntries(Object.entries(MOBILE_SIZES).filter(([k]) => k !== "768x1024"));
export const device = (vp) => ({ viewport: vp, hasTouch: true, isMobile: true });

/** Persistent chrome for the coverage budget: edge tracks count by their drawn body (6 px + halo), the Lead
 *  ladder is the instrument surface (reported separately, see docs/mobile-ui.md §6). */
export function chrome(items) {
  return items
    .filter((i) => i.name !== "canvas:lead-ladder")
    .map((i) =>
      /track$/.test(i.name) ? { ...i, rect: { ...i.rect, x: i.rect.x + i.rect.w / 2 - 5, w: 10 } } : i,
    );
}

export async function audit(page, label, size, { budget = false } = {}) {
  const ui = await collectUI(page);
  const items = budget ? chrome(ui.items) : ui.items;
  const s = summarize(items, ui.W, ui.H);
  s.withPanels = coverage([...items, ...ui.panels].map((i) => i.rect), ui.W, ui.H);
  s.items = items.map((i) => ({ name: i.name, rect: Object.fromEntries(Object.entries(i.rect).map(([k, v]) => [k, Math.round(v)])) }));
  s.panels = ui.panels.map((i) => i.name);
  writeAudit(`${label}-${size}`, { label, size, ...s });
  return { ui, s, items };
}

export const labUrl = (m, extra = "") => `/labs/mobile-lab.html?m=${m}&clean${extra}`;
export async function openLab(page, m, extra) {
  await page.goto(labUrl(m, extra));
  await page.waitForFunction(() => window.__mobileLab?.ready);
}

/** Center of a visible element, asserting it is on screen and not covered (a tap there reaches it). */
export async function tapTarget(page, sel) {
  const loc = page.locator(sel);
  await expect(loc, `${sel} visible`).toBeVisible();
  const hit = await loc.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, r: { x: r.x, y: r.y, w: r.width, h: r.height }, ok: !!top && (top === e || e.contains(top)) };
  });
  expect(hit.ok, `${sel} is not covered at its center`).toBe(true);
  expect(Object.values(offscreen(hit.r, page.viewportSize().width, page.viewportSize().height)).every((v) => v < 0.5), `${sel} on screen`).toBe(true);
  return hit;
}
