// Radial menu: pure state machine (no DOM, no canvas). Unit-testable in Node.
//
// Coordinates: HandFrame.pos is display-normalized (0..1 of the canvas in x and in y).
// All distances here are measured in "width units" (1 = canvas width), so the geometry is
// isotropic: dy is divided by the canvas aspect (width / height). handSize is assumed to be in
// the same width units. Every radius is a multiple of the hand size captured at entry, so the
// menu behaves the same at any distance from the camera.
//
// The menu is a tree of items, at most 2 levels (docs/spec/requirements.md "Menu as a tree of items"):
//   level 0 = the main ring: 4 fixed 90° slots (up/right/down/left), items: mode | submenu | custom types
//   level 1 = a sub-ring, opened by moving the fist THROUGH a submenu arc. Its children (setting items)
//             are spread as a fan over everything except a narrow "back" sector that points toward the
//             parent ring. Moving into the back sector goes back one level.
// Nothing changes until the hand opens: open on a selected item = confirm, anywhere else = cancel all levels.

/** Timings in ms. */
export const MENU_TIMING = Object.freeze({
  ENTER_STABLE_MS: 100, // fist must be held this long (continuously) before the menu opens
  OPEN_DEBOUNCE_MS: 30, // hand must read "not fist" this long before it counts as opened (~2 frames)
  GROW_MS: 150, // ring grows from the fist (also: sub-ring grows, parent shrinks to the breadcrumb)
  FLASH_MS: 150, // confirmed arc flashes (a setting confirm is only this flash: nothing about the right hand changes)
  COUNTDOWN_MS: 400, // "get ready" ring closes around the hand (after the flash; mode items only)
  CANCEL_FADE_MS: 100, // ring fades on cancel
  LOST_GRACE_MS: 300, // tracking lost while open: keep the menu this long, then cancel
  SUB_OPEN_MS: 150, // fist past the outer edge of a submenu arc this long -> the sub-ring opens
});

/** Radii as multiples of the entry hand size (wrist -> middle MCP). The sub-ring uses the same radii. */
export const MENU_GEOMETRY = Object.freeze({
  // Pulled in ~30% after real-camera use (2026-11-22): selecting needed too much arm travel.
  DEAD_R: 0.22, // center dead zone: no arc lit inside this radius
  INNER_R: 0.3, // drawn inner edge of the arcs (fill starts here)
  SELECT_R: 0.6, // select radius ~ 0.6 hand width; drawn outer edge of the arcs
  DESELECT_R: 0.44, // hysteresis: once selected, stays selected until the fist is back inside this
  SECTOR_HYST_DEG: 10, // angular hysteresis between neighbouring directions (capped at 20% of a sector)
  BACK_SPAN_DEG: 60, // sub-ring: width of the "back" sector (toward the parent ring)
  BACK_R: 0.6, // sub-ring: fist this far into the back sector -> back to the parent ring
  MAX_SUB_ITEMS: 8, // sub-ring children beyond this are dropped (6 -> 50° sectors)
});

/** Direction -> angle in degrees, canvas convention (y down, so up = -90). Main-ring slots. */
export const DIRECTIONS = Object.freeze({ right: 0, down: 90, left: 180, up: -90 });
const DIR_NAMES = Object.keys(DIRECTIONS);
export const BACK_ID = "__back";

/**
 * Item types. confirm() decides what opening the hand on a selected item does:
 *   "countdown" -> confirmed (mode change): flash + get-ready countdown, then closed     result.confirmed
 *   "flash"     -> value picked (setting): flash only, then closed                       result.setting
 *   "same"      -> no change (closes like a cancel, reason "same-item")
 *   "cancel"    -> no change (reason "submenu": a submenu arc only opens by moving through it)
 * `submenu: true` marks a type whose `items` open as a sub-ring.
 * "layer" = a mode that plays on top of the current one (Lead): same rule as "mode".
 * Generic item metadata (all optional): `secondary: true` = also running, under the current item (hollow
 * marker; choosing it IS a change), `confirmHint` = the hint under the ring while it is selected.
 */
const sameIfCurrent = (item, { currentId }) => (item.id === currentId ? "same" : "countdown");
const ITEM_TYPES = new Map([
  ["mode", { selectable: true, confirm: sameIfCurrent }],
  ["layer", { selectable: true, confirm: sameIfCurrent }],
  ["submenu", { selectable: true, submenu: true, confirm: () => "cancel" }],
  ["setting", { selectable: true, confirm: (item, { currentId }) => (item.id === currentId ? "same" : "flash") }],
]);

/** Register a new menu item type (future: action, custom). */
export function registerMenuItemType(type, handler) {
  ITEM_TYPES.set(type, { selectable: true, ...handler });
}

export function getMenuItemType(type) {
  return ITEM_TYPES.get(type ?? "mode");
}

export const angDist = (a, b) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
};
const norm180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

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
 * Generic sector pick: slots = [{key, angle, span}] (non-overlapping). Returns the slot containing
 * `angle`, sticking to `prev` (a key) while within its sector widened by the hysteresis band
 * (min(hystDeg, 20% of its span)). Null if the angle is in no slot.
 */
export function pickSlot(angle, slots, prev = null, hystDeg = MENU_GEOMETRY.SECTOR_HYST_DEG) {
  if (prev != null) {
    const p = slots.find((s) => s.key === prev);
    if (p && angDist(angle, p.angle) <= p.span / 2 + Math.min(hystDeg, p.span * 0.2)) return p;
  }
  let best = null;
  for (const s of slots) {
    const d = angDist(angle, s.angle);
    if (d <= s.span / 2 && (!best || d < angDist(angle, best.angle))) best = s;
  }
  return best;
}

/**
 * Sub-ring layout: `n` children spread evenly over 360° minus the back sector, ordered starting next to
 * the back sector and going counter-clockwise on screen (back = up -> left side, bottom, right side).
 * @returns {{back:{angle,span}, angles:number[], span:number}}
 */
export function fanLayout(n, backAngle, backSpan = MENU_GEOMETRY.BACK_SPAN_DEG) {
  const span = n > 0 ? (360 - backSpan) / n : 0;
  const angles = [];
  for (let i = 0; i < n; i++) angles.push(norm180(backAngle - backSpan / 2 - span / 2 - i * span));
  return { back: { angle: norm180(backAngle), span: backSpan }, angles, span };
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

  // phase: "idle" (closed) | "open" | "confirm" (flash [+ countdown]; reported as "countdown" or "flash")
  let phase = "idle";
  let now = 0;
  let armed = true; // a fist only opens the menu after the hand was seen open since the last close
  let fistSince = null;
  let entrySizeSum = 0;
  let entrySizeN = 0;

  // Session (valid while open/confirm, kept after close for the fade-out)
  let handSize = 0.1;
  let openedAt = 0;
  let handPos = null; // last tracked palm position, display-normalized
  let lostSince = null;
  let openSince = null;
  let confirmedId = null;
  let confirmedItem = null;
  let confirmedAt = 0;
  let confirmKind = null; // "mode" | "setting"
  let closedAt = -Infinity;
  let closeReason = null;
  let main = null; // level-0 ring
  let sub = null; // level-1 ring (null at level 0)
  let levelAt = 0; // when the current level started (open / sub-open / back)
  let levelFrom = null; // "sub" | "back" | null
  let passSince = null; // fist beyond the outer edge of a selected submenu arc since

  // Ring: { center, items, slots, currentId, host, back, offset, dist, angle, hoverKey, hoverId, progress, selectedId, selectedAt }
  function makeRing(center, items, slots, currentId, host = null, back = null) {
    return {
      center,
      items,
      slots,
      currentId,
      host,
      back,
      offset: { x: 0, y: 0 },
      dist: 0,
      angle: 0,
      hoverKey: null,
      hoverId: null,
      progress: 0,
      selectedId: null,
      selectedAt: 0,
    };
  }
  const ring = () => sub || main;

  function resolveMain() {
    const list = (opts.items?.() ?? []).filter(Boolean);
    const dirs = {};
    const out = [];
    for (const it of list) {
      const type = getMenuItemType(it.type);
      if (!type || !DIRECTIONS.hasOwnProperty(it.direction) || dirs[it.direction]) continue;
      const r = { ...it, type: it.type ?? "mode", angle: DIRECTIONS[it.direction], span: 90 };
      dirs[it.direction] = r;
      out.push(r);
    }
    const slots = DIR_NAMES.map((d) => ({ key: d, angle: DIRECTIONS[d], span: 90, item: dirs[d] ?? null }));
    return { out, slots };
  }

  function resolveSub(host) {
    const raw = typeof host.items === "function" ? host.items() : host.items;
    // Max 2 levels: a submenu inside a submenu is dropped.
    const list = (raw ?? [])
      .filter((it) => it && getMenuItemType(it.type ?? "setting") && !getMenuItemType(it.type ?? "setting").submenu)
      .slice(0, G.MAX_SUB_ITEMS);
    const backAngle = host.angle + 180;
    const fan = fanLayout(list.length, backAngle, G.BACK_SPAN_DEG);
    const items = list.map((it, i) => ({
      ...it,
      type: it.type ?? "setting",
      color: it.color ?? host.color,
      angle: fan.angles[i],
      span: fan.span,
    }));
    const slots = [
      { key: BACK_ID, angle: fan.back.angle, span: fan.back.span, item: null, back: true },
      ...items.map((it) => ({ key: it.id, angle: it.angle, span: it.span, item: it })),
    ];
    const currentId = typeof host.current === "function" ? host.current() : (host.currentId ?? null);
    return { items, slots, currentId, back: fan.back };
  }

  function openMenu(right) {
    phase = "open";
    openedAt = levelAt = now;
    levelFrom = null;
    handPos = { x: right.pos.x, y: right.pos.y };
    handSize = entrySizeN ? entrySizeSum / entrySizeN : right.handSize || 0.1;
    const { out, slots } = resolveMain();
    main = makeRing({ ...handPos }, out, slots, opts.currentId?.() ?? null);
    sub = null;
    passSince = null;
    lostSince = null;
    openSince = null;
    confirmedId = null;
    confirmedItem = null;
    confirmKind = null;
    closeReason = null;
  }

  function openSub(host) {
    const { items, slots, currentId, back } = resolveSub(host);
    sub = makeRing({ ...handPos }, items, slots, currentId, host, back);
    levelAt = now;
    levelFrom = "sub";
    passSince = null;
  }

  function goBack() {
    sub = null;
    levelAt = now;
    levelFrom = "back";
    passSince = null;
    // The main ring starts fresh from where the fist is now (selection needs SELECT_R again).
    main.selectedId = null;
    main.hoverKey = null;
  }

  function close(reason) {
    phase = "idle";
    closedAt = now;
    closeReason = reason;
    fistSince = null;
    passSince = null;
    entrySizeSum = entrySizeN = 0;
    if (reason === "tracking-lost") armed = false;
  }

  function select(rg, id) {
    if (rg.selectedId === id) return;
    rg.selectedId = id;
    if (id) {
      rg.selectedAt = now;
      try {
        opts.onTick?.();
      } catch (e) {
        console.error(e);
      }
    }
  }

  function measure(rg) {
    const dx = handPos.x - rg.center.x;
    const dy = (handPos.y - rg.center.y) / getAspect();
    rg.offset = { x: dx, y: dy };
    rg.dist = Math.hypot(dx, dy) / handSize;
    rg.angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  }

  function trackRing(rg) {
    measure(rg);
    let slot = null;
    if (rg.dist >= G.DEAD_R) {
      if (rg === main) {
        rg.hoverKey = pickDirection(rg.angle, rg.hoverKey, G.SECTOR_HYST_DEG);
        slot = rg.slots.find((s) => s.key === rg.hoverKey);
      } else {
        slot = pickSlot(rg.angle, rg.slots, rg.hoverKey, G.SECTOR_HYST_DEG);
        rg.hoverKey = slot ? slot.key : null;
      }
    } else rg.hoverKey = null;

    const item = slot?.item ?? null;
    const selectable = item && getMenuItemType(item.type)?.selectable !== false;
    rg.hoverId = item ? item.id : null;
    rg.progress = item ? Math.min(1, Math.max(0, (rg.dist - G.DEAD_R) / (G.SELECT_R - G.DEAD_R))) : 0;

    if (rg.selectedId) {
      if (rg.dist < G.DESELECT_R) select(rg, null);
      else if (rg.hoverId !== rg.selectedId) select(rg, selectable && rg.dist >= G.SELECT_R ? rg.hoverId : null);
    } else if (selectable && rg.dist >= G.SELECT_R) {
      select(rg, rg.hoverId);
    }
    return slot;
  }

  function track(right) {
    handPos = { x: right.pos.x, y: right.pos.y };
    if (sub) {
      const slot = trackRing(sub);
      measure(main); // keep the fist offset relative to the parent too (breadcrumb line)
      if (slot?.back && sub.dist >= G.BACK_R) {
        goBack();
        trackRing(main);
        return { back: true };
      }
      return null;
    }
    trackRing(main);
    // Pass-through: a selected submenu arc opens its sub-ring once the fist stays past its outer edge.
    const selItem = main.selectedId ? main.items.find((i) => i.id === main.selectedId) : null;
    if (selItem && getMenuItemType(selItem.type)?.submenu && main.dist >= G.SELECT_R && main.hoverId === selItem.id) {
      if (passSince === null) passSince = now;
      if (now - passSince >= T.SUB_OPEN_MS) {
        openSub(selItem);
        return { entered: selItem.id };
      }
    } else passSince = null;
    return null;
  }

  function release() {
    const rg = ring();
    if (!rg.selectedId) {
      close("empty");
      return { cancelled: true, reason: "empty" };
    }
    const item = rg.items.find((i) => i.id === rg.selectedId);
    const result = getMenuItemType(item.type).confirm(item, { currentId: rg.currentId, parent: rg.host });
    if (result === "countdown" || result === "flash") {
      phase = "confirm";
      confirmedId = rg.selectedId;
      confirmedItem = item;
      confirmedAt = now;
      confirmKind = result === "flash" ? "setting" : "mode";
      armed = false; // re-armed once the hand is seen open during/after the countdown
      if (result === "countdown") return { confirmed: confirmedId };
      const host = rg.host;
      return {
        setting: {
          key: host?.setting ?? host?.id ?? null, // what is being set (e.g. "sound/lead")
          submenu: host?.id ?? null,
          id: item.id,
          value: item.value ?? item.id,
        },
      };
    }
    if (result === "cancel") {
      close("submenu");
      return { cancelled: true, reason: "submenu" };
    }
    close("same-item");
    return { cancelled: true, reason: "same-item" };
  }

  function result(extra) {
    const st = phase === "idle" ? "closed" : phase === "open" ? "open" : confirmKind === "setting" ? "flash" : "countdown";
    const live = phase === "open";
    const rg = main ? ring() : null;
    return {
      state: st,
      level: phase === "idle" || !rg ? 0 : sub ? 1 : 0,
      path: phase !== "idle" && sub ? [sub.host.id] : [],
      hoverId: live && rg ? rg.hoverId : null,
      progress: live && rg ? rg.progress : 0,
      selectedId: phase === "idle" || !rg ? null : rg.selectedId,
      ...extra,
    };
  }

  const confirmMs = () => (confirmKind === "setting" ? T.FLASH_MS : T.FLASH_MS + T.COUNTDOWN_MS);

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
          const ev = track(hand);
          return result(ev || undefined);
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
      if (now - confirmedAt >= confirmMs()) {
        close("done");
        return result({ finished: confirmedId });
      }
      return result();
    },

    isHoldingRight: () => phase !== "idle",

    setAspect(a) {
      if (typeof aspectOpt !== "function" && a > 0) aspectOpt = a;
    },

    /**
     * Everything the renderer needs. Plain data; safe to read every frame.
     * Top-level ring fields (center, items, offset, dist, hoverId, selectedId, ...) describe the ACTIVE ring
     * (the sub-ring at level 1); `parent` is the main ring while a sub-ring is open.
     */
    snapshot() {
      const rg = main ? ring() : null;
      const live = phase === "open";
      const ringView = (r) => ({
        center: r.center,
        items: r.items,
        slots: r.slots,
        currentId: r.currentId,
        hostId: r.host ? r.host.id : null,
        back: r.back,
        offset: r.offset,
        dist: r.dist,
        angle: r.angle,
        hoverId: r.hoverId,
        hoverKey: r.hoverKey,
        selectedId: r.selectedId,
      });
      return {
        phase,
        now,
        timing: T,
        geometry: G,
        level: sub ? 1 : 0,
        center: rg ? rg.center : null,
        handPos,
        handSize,
        offset: rg ? rg.offset : { x: 0, y: 0 },
        dist: rg ? rg.dist : 0,
        angle: rg ? rg.angle : 0,
        items: rg ? rg.items : [],
        slots: rg ? rg.slots : [],
        back: rg ? rg.back : null,
        host: sub ? sub.host : null,
        currentId: rg ? rg.currentId : null,
        hoverId: live && rg ? rg.hoverId : null,
        hoverDir: live && rg ? rg.hoverKey : null,
        hoverBack: live && !!sub && sub.hoverKey === BACK_ID,
        progress: live && rg ? rg.progress : 0,
        selectedId: rg ? rg.selectedId : null,
        selectedAt: rg ? rg.selectedAt : 0,
        subPending: live && !sub && passSince !== null ? Math.min(1, (now - passSince) / T.SUB_OPEN_MS) : 0,
        parent: sub ? { ...ringView(main), hostId: sub.host.id } : null,
        levelAt,
        levelFrom,
        openedAt,
        tracking: lostSince === null,
        lostSince,
        confirmedId,
        confirmedItem,
        confirmedAt,
        confirmKind,
        closedAt,
        closeReason,
        aspect: getAspect(),
      };
    },

    reset() {
      phase = "idle";
      armed = true;
      fistSince = null;
      passSince = null;
      sub = null;
      closedAt = -Infinity;
      closeReason = null;
    },
  };
}
