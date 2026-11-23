import { defineConfig } from "@playwright/test";

// Parallel agents/worktrees must each use their own port: PW_PORT=52xx npm test
const PORT = Number(process.env.PW_PORT) || 5199;
// Signaling server for the output tests (tests/output.spec.js): PW_SIGNAL_PORT or PORT + 200.
export const SIGNAL_PORT = Number(process.env.PW_SIGNAL_PORT) || PORT + 200;
process.env.PW_SIGNAL_PORT = String(SIGNAL_PORT); // visible to the test workers

export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
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
  webServer: [
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
  ],
});
