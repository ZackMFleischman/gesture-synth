// Radial menu: pure state machine (no DOM, no canvas). Unit-testable in Node.
//
// Coordinates: HandFrame.pos is display-normalized (0..1 of the canvas in x and in y).
// All distances here are measured in "width units" (1 = canvas width), so the geometry is
// isotropic: dy is divided by the canvas aspect (width / height). handSize is assumed to be in
// the same width units. Every radius is a multiple of the hand size captured at entry, so the
// menu behaves the same at any distance from the camera.

/** Timings in ms. */
export const MENU_TIMING = Object.freeze({
  ENTER_STABLE_MS: 100, // fist must be held this long (continuously) before the menu opens
  OPEN_DEBOUNCE_MS: 30, // hand must read "not fist" this long before it counts as opened (~2 frames)
  GROW_MS: 150, // ring grows from the fist
  FLASH_MS: 150, // confirmed arc flashes
  COUNTDOWN_MS: 400, // "get ready" ring closes around the hand (after the flash)
  CANCEL_FADE_MS: 100, // ring fades on cancel
  LOST_GRACE_MS: 300, // tracking lost while open: keep the menu this long, then cancel
});

/** Radii as multiples of the entry hand size (wrist -> middle MCP). */
export const MENU_GEOMETRY = Object.freeze({
  // Pulled in ~30% after real-camera use (2026-11-22): selecting needed too much arm travel.
  DEAD_R: 0.22, // center dead zone: no arc lit inside this radius
  INNER_R: 0.3, // drawn inner edge of the arcs (fill starts here)
  SELECT_R: 0.6, // select radius ~ 0.6 hand width; drawn outer edge of the arcs
  DESELECT_R: 0.44, // hysteresis: once selected, stays selected until the fist is back inside this
  SECTOR_HYST_DEG: 10, // angular hysteresis between neighbouring directions
});

/** Direction -> angle in degrees, canvas convention (y down, so up = -90). */
export const DIRECTIONS = Object.freeze({ right: 0, down: 90, left: 180, up: -90 });
const DIR_NAMES = Object.keys(DIRECTIONS);

/**
 * Item types. Only "mode" is implemented; submenu/setting/action/custom plug in here later.
 * confirm() decides what opening the hand on a selected item does:
 *   "countdown" -> confirmed, flash + get-ready countdown, then closed
 *   "same"      -> no change (closes like a cancel)
 */
const ITEM_TYPES = new Map([
  [
    "mode",
    {
      selectable: true,
      confirm: (item, { currentId }) => (item.id === currentId ? "same" : "countdown"),
    },
  ],
]);

/** Register a new menu item type (future: submenu, setting, action, custom). */
export function registerMenuItemType(type, handler) {
  ITEM_TYPES.set(type, { selectable: true, ...handler });
}

export function getMenuItemType(type) {
  return ITEM_TYPES.get(type ?? "mode");
}

const angDist = (a, b) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
};

/** Pick the direction whose 90° sector contains `angle`, sticking to `prev` within the hysteresis band. */
export function pickDirection(angle, prev = null, hystDeg = MENU_GEOMETRY.SECTOR_HYST_DEG) {
  if (prev && angDist(angle, DIRECTIONS[prev]) <= 45 + hystDeg) return prev;
  let best = DIR_NAMES[0];
  for (const name of DIR_NAMES) {
    if (angDist(angle, DIRECTIONS[name]) < angDist(angle, DIRECTIONS[best])) best = name;
  }
  return best;
}

/**
 * @param {{
 *   items: () => object[],
 *   currentId: () => string,
 *   onTick?: () => void,
 *   aspect?: number | (() => number),   // canvas width / height; default 1 (radial-menu.js sets it from draw())
 *   timing?: Partial<typeof MENU_TIMING>,
 *   geometry?: Partial<typeof MENU_GEOMETRY>,
 * }} opts
 */
export function createMenuState(opts) {
  const T = { ...MENU_TIMING, ...opts.timing };
  const G = { ...MENU_GEOMETRY, ...opts.geometry };
  let aspectOpt = opts.aspect ?? 1;
  const getAspect = () => (typeof aspectOpt === "function" ? aspectOpt() : aspectOpt) || 1;

  // phase: "idle" (closed) | "open" | "confirm" (flash + countdown; reported as "countdown")
  let phase = "idle";
  let now = 0;
  let armed = true; // a fist only opens the menu after the hand was seen open since the last close
  let fistSince = null;
  let entrySizeSum = 0;
  let entrySizeN = 0;

  // Session (valid while open/confirm, kept after close for the fade-out)
  let center = null; // entry point, display-normalized
  let handSize = 0.1;
  let items = []; // resolved [{...item, direction}] frozen at entry
  let byDir = {};
  let currentId = null;
  let openedAt = 0;
  let offset = { x: 0, y: 0 }; // fist - center, width units
  let handPos = null; // last tracked palm position, display-normalized
  let dist = 0; // in hand sizes
  let angle = 0;
  let hoverDir = null;
  let hoverId = null;
  let progress = 0;
  let selectedId = null;
  let selectedAt = 0;
  let lostSince = null;
  let openSince = null;
  let confirmedId = null;
  let confirmedAt = 0;
  let closedAt = -Infinity;
  let closeReason = null;

  function resolveItems() {
    const list = (opts.items?.() ?? []).filter(Boolean);
    const dirs = {};
    const out = [];
    for (const it of list) {
      const type = getMenuItemType(it.type);
      if (!type || !DIRECTIONS.hasOwnProperty(it.direction) || dirs[it.direction]) continue;
      const r = { ...it, type: it.type ?? "mode" };
      dirs[it.direction] = r;
      out.push(r);
    }
    return { out, dirs };
  }

  function openMenu(right) {
    phase = "open";
    openedAt = now;
    center = { x: right.pos.x, y: right.pos.y };
    handPos = { ...center };
    handSize = entrySizeN ? entrySizeSum / entrySizeN : right.handSize || 0.1;
    const { out, dirs } = resolveItems();
    items = out;
    byDir = dirs;
    currentId = opts.currentId?.() ?? null;
    offset = { x: 0, y: 0 };
    dist = 0;
    angle = 0;
    hoverDir = null;
    hoverId = null;
    progress = 0;
    selectedId = null;
    lostSince = null;
    openSince = null;
    confirmedId = null;
    closeReason = null;
  }

  function close(reason) {
    phase = "idle";
    closedAt = now;
    closeReason = reason;
    fistSince = null;
    entrySizeSum = entrySizeN = 0;
    if (reason === "tracking-lost") armed = false;
  }

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    if (id) {
      selectedAt = now;
      try {
        opts.onTick?.();
      } catch (e) {
        console.error(e);
      }
    }
  }

  function track(right) {
    handPos = { x: right.pos.x, y: right.pos.y };
    const dx = right.pos.x - center.x;
    const dy = (right.pos.y - center.y) / getAspect();
    offset = { x: dx, y: dy };
    dist = Math.hypot(dx, dy) / handSize;
    angle = (Math.atan2(dy, dx) * 180) / Math.PI;

    if (dist < G.DEAD_R) {
      hoverDir = null;
    } else {
      hoverDir = pickDirection(angle, hoverDir, G.SECTOR_HYST_DEG);
    }
    const item = hoverDir ? byDir[hoverDir] : null;
    const selectable = item && getMenuItemType(item.type)?.selectable !== false;
    hoverId = item ? item.id : null;
    progress = item ? Math.min(1, Math.max(0, (dist - G.DEAD_R) / (G.SELECT_R - G.DEAD_R))) : 0;

    if (selectedId) {
      if (dist < G.DESELECT_R) select(null);
      else if (hoverId !== selectedId) select(selectable && dist >= G.SELECT_R ? hoverId : null);
    } else if (selectable && dist >= G.SELECT_R) {
      select(hoverId);
    }
  }

  function release() {
    if (!selectedId) {
      close("empty");
      return { cancelled: true, reason: "empty" };
    }
    const item = items.find((i) => i.id === selectedId);
    const result = getMenuItemType(item.type).confirm(item, { currentId });
    if (result === "countdown") {
      phase = "confirm";
      confirmedId = selectedId;
      confirmedAt = now;
      armed = false; // re-armed once the hand is seen open during/after the countdown
      return { confirmed: selectedId };
    }
    close("same-item");
    return { cancelled: true, reason: "same-item" };
  }

  function result(extra) {
    const st = phase === "idle" ? "closed" : phase === "open" ? "open" : "countdown";
    const live = phase === "open";
    return {
      state: st,
      hoverId: live ? hoverId : null,
      progress: live ? progress : 0,
      selectedId: phase === "idle" ? null : selectedId,
      ...extra,
    };
  }

  return {
    /** @param {object|null} right HandFrame of the right hand (or null) @param {number} t ms */
    update(right, t) {
      now = t;
      const hand = right && right.pos ? right : null;

      if (phase === "idle") {
        if (hand && hand.fist) {
          if (!armed) return result();
          if (fistSince === null) {
            fistSince = now;
            entrySizeSum = entrySizeN = 0;
          }
          if (hand.handSize > 0) {
            entrySizeSum += hand.handSize;
            entrySizeN++;
          }
          if (now - fistSince >= T.ENTER_STABLE_MS) {
            openMenu(hand);
            return result({ opened: true });
          }
        } else {
          fistSince = null;
          if (hand) armed = true;
        }
        return result();
      }

      if (phase === "open") {
        if (!hand) {
          if (lostSince === null) lostSince = now;
          if (now - lostSince >= T.LOST_GRACE_MS) {
            close("tracking-lost");
            return result({ cancelled: true, reason: "tracking-lost" });
          }
          return result();
        }
        lostSince = null;
        if (hand.fist) {
          openSince = null;
          track(hand);
          return result();
        }
        // Opening: freeze position while debouncing so the opening motion can't change the selection.
        if (openSince === null) openSince = now;
        if (now - openSince >= T.OPEN_DEBOUNCE_MS) return result(release());
        return result();
      }

      // phase === "confirm"
      if (hand) {
        handPos = { x: hand.pos.x, y: hand.pos.y };
        if (!hand.fist) armed = true;
      }
      if (now - confirmedAt >= T.FLASH_MS + T.COUNTDOWN_MS) {
        close("done");
        return result({ finished: confirmedId });
      }
      return result();
    },

    isHoldingRight: () => phase !== "idle",

    setAspect(a) {
      if (typeof aspectOpt !== "function" && a > 0) aspectOpt = a;
    },

    /** Everything the renderer needs. Plain data; safe to read every frame. */
    snapshot() {
      return {
        phase,
        now,
        timing: T,
        geometry: G,
        center,
        handPos,
        handSize,
        offset,
        dist,
        angle,
        items,
        currentId,
        hoverId: phase === "open" ? hoverId : null,
        hoverDir: phase === "open" ? hoverDir : null,
        progress: phase === "open" ? progress : 0,
        selectedId,
        selectedAt,
        openedAt,
        tracking: lostSince === null,
        lostSince,
        confirmedId,
        confirmedAt,
        closedAt,
        closeReason,
        aspect: getAspect(),
      };
    },

    reset() {
      phase = "idle";
      armed = true;
      fistSince = null;
      closedAt = -Infinity;
      closeReason = null;
    },
  };
}
