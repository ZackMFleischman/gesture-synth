import { defineConfig } from "@playwright/test";

// Parallel agents/worktrees must each use their own port: PW_PORT=52xx npm test
const PORT = Number(process.env.PW_PORT) || 5199;

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
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Never reuse: a server on this port may be serving a different worktree.
    reuseExistingServer: false,
  },
});
