// Guards the test-layer convention (docs/testing.md): every spec file belongs to exactly one layer, and unit
// files stay pure (no browser, no dev server).
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { LAYER_PATTERNS, LEGACY } from "../playwright.config.js";

const TESTS = path.resolve("tests");
const specs = fs.readdirSync(TESTS, { recursive: true })
  .filter((f) => f.endsWith(".spec.js"))
  .map((f) => path.join(TESTS, f));

function layersOf(file) {
  const base = path.basename(file);
  return Object.keys(LAYER_PATTERNS).filter(
    (layer) => LAYER_PATTERNS[layer].test(file) || (LEGACY[layer] || []).includes(base)
  );
}

test("every spec file is in exactly one layer (name it *.unit / *.int / *.e2e / *.build .spec.js)", () => {
  const bad = specs
    .map((f) => ({ file: path.relative(TESTS, f), layers: layersOf(f) }))
    .filter((x) => x.layers.length !== 1);
  expect(bad, "spec files with no layer (or more than one)").toEqual([]);
});

test("LEGACY lists only files that still exist", () => {
  const names = new Set(specs.map((f) => path.basename(f)));
  const stale = Object.values(LEGACY).flat().filter((f) => !names.has(f));
  expect(stale, "remove these from LEGACY in playwright.config.js").toEqual([]);
});

test("unit specs are pure: no browser fixtures, no page helpers", () => {
  const offenders = [];
  for (const f of specs.filter((f) => layersOf(f)[0] === "unit")) {
    const src = fs.readFileSync(f, "utf8");
    const why = [
      [/from "\.\/fixtures\.js"/, "imports ./fixtures.js (browser fixtures)"],
      [/from "\.\/helpers\/(lead-lab|screencast|arp-analysis)\.js"/, "imports a browser helper"],
      [/\(\s*\{[^)]*\b(page|browser|context|synthPage|lab)\b[^)]*\}\s*(,[^)]*)?\)\s*=>/, "uses a browser fixture"],
      [/\.goto\(/, "navigates a page"],
    ].filter(([re]) => re.test(src)).map(([, msg]) => msg);
    if (why.length) offenders.push(`${path.relative(TESTS, f)}: ${why.join(", ")}`);
  }
  expect(offenders).toEqual([]);
});
