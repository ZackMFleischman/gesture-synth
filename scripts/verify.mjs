#!/usr/bin/env node
// Merge gate (docs/testing.md): every test layer, one after another, then a summary with wall time per layer
// and the slowest tests.
//   PW_PORT=52xx npm run verify            (extra args are passed to every playwright run, e.g. --workers=4)
// Layers: unit (Node) -> integration (labs) -> e2e (app) -> build (vite build + preview smoke).
// Exit code 0 only if every layer passed. All layers run even if one fails, so one run shows everything.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const LAYERS = ["unit", "integration", "e2e", "build"];
const extra = process.argv.slice(2);
// Outside test-results/: every playwright run wipes that folder, so the layers' reports would be lost.
const outDir = path.resolve("playwright-report/verify");
fs.mkdirSync(outDir, { recursive: true });

const rows = [];
const all = [];
for (const layer of LAYERS) {
  const json = path.join(outDir, `${layer}.json`);
  console.log(`\n=== ${layer} ===`);
  const t0 = Date.now();
  const r = spawnSync("npx", ["playwright", "test", `--project=${layer}`, "--reporter=dot,json", ...extra], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: json },
  });
  const wall = (Date.now() - t0) / 1000;
  const tests = [];
  try {
    const walk = (suite, file) => {
      for (const s of suite.suites || []) walk(s, s.file || file);
      for (const spec of suite.specs || [])
        for (const t of spec.tests)
          for (const res of t.results) tests.push({ title: `${spec.file || file} › ${spec.title}`, ms: res.duration, status: res.status, expected: t.expectedStatus });
    };
    walk(JSON.parse(fs.readFileSync(json, "utf8")));
  } catch {}
  const failed = tests.filter((t) => t.status !== t.expected && t.status !== "skipped").length;
  all.push(...tests.map((t) => ({ ...t, layer })));
  rows.push({ layer, ok: r.status === 0, wall, count: tests.length, failed, slowest: tests.sort((a, b) => b.ms - a.ms).slice(0, 3) });
}

console.log("\n=== verify summary ===");
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.layer.padEnd(12)} ${String(r.count).padStart(4)} tests  ${r.wall.toFixed(1).padStart(6)} s${r.failed ? `  (${r.failed} failed)` : ""}`);
  for (const t of r.slowest) console.log(`        ${(t.ms / 1000).toFixed(1).padStart(5)} s  ${t.title}`);
}
console.log("\n25 slowest tests:");
for (const t of [...all].sort((a, b) => b.ms - a.ms).slice(0, 25))
  console.log(`  ${(t.ms / 1000).toFixed(1).padStart(5)} s  [${t.layer}] ${t.title}`);
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ rows, tests: all }, null, 1));
const total = rows.reduce((s, r) => s + r.wall, 0);
const ok = rows.every((r) => r.ok);
console.log(`${ok ? "PASS" : "FAIL"}  total ${total.toFixed(1)} s`);
process.exit(ok ? 0 : 1);
