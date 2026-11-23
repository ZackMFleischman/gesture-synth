import { defineConfig } from "@playwright/test";

// Test layers (docs/testing.md). A spec file's layer comes from its name:
//   *.unit.spec.js   -> unit         Node only: pure src/ modules, no page, no server
//   *.int.spec.js    -> integration  browser, one subsystem through its lab page or real module
//   *.e2e.spec.js    -> e2e          browser, the real app (index.html) via ?mockHands / ?replay=
//   mN-*.spec.js     -> e2e          milestone acceptance specs (m1-integration, m1-ui, ...) drive the real app
//   *.build.spec.js  -> build        production build (vite build + vite preview)
// Files from before the convention are classified in place below (LEGACY); some are edited by in-flight
// branches, so they keep their names. tests/suite-layout.unit.spec.js fails on any spec file that matches
// none of these, so a new file can't silently land in the wrong layer.
export const LAYER_PATTERNS = {
  unit: /\.unit\.spec\.js$/,
  integration: /\.int\.spec\.js$/,
  e2e: /(\.e2e\.spec\.js|\/m\d+-[^/]*\.spec\.js)$/,
  build: /\.build\.spec\.js$/,
};
export const LEGACY = {
  unit: ["arp-patterns.spec.js", "output-protocol.spec.js"],
  integration: ["arp.spec.js", "lead.spec.js", "lead-demo.spec.js", "radial-menu-video.spec.js", "ui-lab.spec.js"],
  e2e: ["analytics.spec.js", "audio.spec.js", "bus.spec.js", "gestures.spec.js", "output.spec.js", "smoke.spec.js", "ui.spec.js"],
};
const legacy = (layer) => LEGACY[layer].map((f) => `**/tests/${f}`);

// Parallel agents/worktrees must each use their own port: PW_PORT=52xx npm test
const PORT = Number(process.env.PW_PORT) || 5199;
// Signaling server for the output tests (tests/output.spec.js): PW_SIGNAL_PORT or PORT + 200.
export const SIGNAL_PORT = Number(process.env.PW_SIGNAL_PORT) || PORT + 200;
process.env.PW_SIGNAL_PORT = String(SIGNAL_PORT); // visible to the test workers
// `vite preview` of the production build (tests/*.build.spec.js): PW_PREVIEW_PORT or PORT + 100.
export const PREVIEW_PORT = Number(process.env.PW_PREVIEW_PORT) || PORT + 100;
process.env.PW_PREVIEW_PORT = String(PREVIEW_PORT);

// The dev + signaling servers are only needed by the browser layers. Skip them when every requested project
// is given as --project=unit / --project=build (the npm scripts do this), so `npm run test:unit` starts nothing.
function needsDevServers(argv) {
  if (argv.includes("--project")) return true; // space-separated form: don't guess
  const projects = argv.filter((a) => a.startsWith("--project=")).map((a) => a.slice("--project=".length));
  return projects.length === 0 || projects.some((p) => p !== "unit" && p !== "build");
}

export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  // Visual baselines (tests/visual.e2e.spec.js): one PNG per platform, committed under tests/__screenshots__/.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}-{platform}{ext}",
  expect: {
    toHaveScreenshot: {
      // Same machine + system Chrome renders DOM pixel-identically; allow a few anti-aliasing pixels only.
      maxDiffPixelRatio: 0.002,
      threshold: 0.2,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Use the system Chrome so no Playwright browser download is needed.
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
    permissions: ["camera"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    { name: "unit", testMatch: [LAYER_PATTERNS.unit, ...legacy("unit")] },
    { name: "integration", testMatch: [LAYER_PATTERNS.integration, ...legacy("integration")] },
    { name: "e2e", testMatch: [LAYER_PATTERNS.e2e, ...legacy("e2e")] },
    // Builds dist/ and serves it with `vite preview` itself (see tests/production.build.spec.js).
    { name: "build", testMatch: [LAYER_PATTERNS.build], timeout: 90_000 },
  ],
  webServer: needsDevServers(process.argv)
    ? [
        {
          command: `npx vite --port ${PORT} --strictPort`,
          url: `http://localhost:${PORT}`,
          // Never reuse: a server on this port may be serving a different worktree.
          reuseExistingServer: false,
        },
        {
          command: `node server/signal.js`,
          env: { SIGNAL_PORT: String(SIGNAL_PORT) },
          url: `http://localhost:${SIGNAL_PORT}/health`,
          reuseExistingServer: false,
        },
      ]
    : [],
});
