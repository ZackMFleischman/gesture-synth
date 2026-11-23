import { test, expect } from "@playwright/test";
import { drawPlate } from "../src/ui/theme.js";

// Minimal 2D context stub: arcTo throws on a negative radius, like the real canvas does.
function stubContext() {
  const noop = () => {};
  return new Proxy({}, {
    get(_, key) {
      if (key === "arcTo") return (x1, y1, x2, y2, r) => { if (r < 0) throw new RangeError("negative radius"); };
      return noop;
    },
    set: () => true,
  });
}

test("drawPlate tolerates zero and negative sizes (edge track at value 0)", () => {
  const g = stubContext();
  for (const [w, h] of [[8, 0], [0, 8], [0, 0], [8, -3]]) {
    expect(() => drawPlate(g, 10, 10, w, h, { radius: 4, fill: "#000" })).not.toThrow();
  }
});
