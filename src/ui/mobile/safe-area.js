// Safe-area insets (notch / rounded corners) for canvas drawing. Canvas can't read CSS env(), so a hidden
// probe element carries `padding: env(safe-area-inset-*)` and we read its computed padding. Cached; re-read
// on resize / orientation change. All zeros on desktop and in browsers without insets.

const ZERO = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** @param {Document} [doc] @returns {{get():{top:number,right:number,bottom:number,left:number}, destroy():void}} */
export function createSafeArea(doc = document) {
  const win = doc.defaultView;
  if (!win || !doc.body) return { get: () => ZERO, destroy() {} };
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);";
  doc.body.append(probe);
  let cached = null;
  const read = () => {
    const cs = win.getComputedStyle(probe);
    const px = (v) => parseFloat(v) || 0;
    cached = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  };
  const invalidate = () => (cached = null);
  win.addEventListener("resize", invalidate);
  win.addEventListener("orientationchange", invalidate);
  return {
    get() {
      if (!cached) read();
      return cached;
    },
    destroy() {
      win.removeEventListener("resize", invalidate);
      win.removeEventListener("orientationchange", invalidate);
      probe.remove();
    },
  };
}
