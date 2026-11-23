// Helpers for tests/m1-ui.spec.js (modes UI in the real app, ?mockHands).

/**
 * Makes sure the Arp mode is available. If main.js does not register it yet (wiring lands in a
 * parallel workstream), register the real Arp mode + a real clock through the dev-only test hook.
 * The Arp mode's own minimal bottom bar (arp.draw) is superseded by the #transport plate, so it is
 * switched off only when this helper registers the mode itself.
 */
export async function ensureArp(page) {
  await page.evaluate(async () => {
    const t = window.__gsTest;
    if (!t.ctx.clock) {
      const { createClock } = await import("/src/services/clock.js");
      t.ctx.clock = createClock(t.ctx.audio.ac, { bus: t.bus });
    }
    const { registry } = await import("/src/core/registry.js");
    if (!registry.getMode("arp")) {
      const arp = (await import("/src/modes/arp.js")).default;
      arp.draw = () => {};
      registry.registerMode(arp);
    }
  });
}

/** Waits for n animation frames in the page. */
export async function frames(page, n = 3) {
  await page.evaluate(
    (n) => new Promise((res) => {
      let i = 0;
      const step = () => (++i >= n ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    }),
    n
  );
}

/** Layout data: existing controls, new DOM ([data-gs-kind]) and canvas regions from mountModeUI. */
export async function collectLayout(page, existingIds) {
  return page.evaluate((EXISTING) => {
    const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).display !== "none";
    const box = (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const existing = EXISTING.map((id) => document.getElementById(id))
      .filter(vis)
      .map((e) => ({ name: `#${e.id}`, rect: box(e) }));
    const newDom = [...document.querySelectorAll("[data-gs-kind]")]
      .filter(vis)
      .map((e) => {
        // Phones: a panel re-homed in the mobile sheet (docs/mobile-ui.md) scrolls inside it; the sheet is its box.
        const sheet = e.closest("#gsControlsSheet");
        return { name: `#${e.id}${sheet ? " (sheet)" : ""}`, kind: e.dataset.gsKind, rect: box(sheet || e) };
      });
    const ui = window.__gsTest.ui;
    return { existing, newDom, canvas: ui.regions, clear: ui.clearArea };
  }, existingIds);
}

/** Plugs the real radial menu into the router if main.js has not done it yet (wiring lands in parallel). */
export async function ensureMenu(page) {
  await page.evaluate(async () => {
    const t = window.__gsTest;
    if (t.router.menu) return;
    const { createRadialMenu } = await import("/src/menu/radial-menu.js");
    const { registry } = await import("/src/core/registry.js");
    t.router.setMenu(createRadialMenu({ items: () => registry.menuItems(t.router.modeId), currentId: () => t.router.modeId }));
  });
}

/** Registers the real Lead mode if main.js does not yet (integration lands in parallel). */
export async function ensureLead(page) {
  await page.evaluate(async () => {
    const { registry } = await import("/src/core/registry.js");
    if (!registry.getMode("lead")) registry.registerMode((await import("/src/modes/lead.js")).default);
  });
}
