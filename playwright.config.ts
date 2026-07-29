import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://localhost:3417",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      name: "realtime",
      command: "npm run dev --workspace @koge/realtime -- --port 8878 --var APP_ORIGIN:http://localhost:3417",
      url: "http://localhost:8878/health",
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      name: "web",
      command: "npm run dev --workspace @koge/web -- --host 127.0.0.1 --port 3417",
      url: "http://localhost:3417",
      env: {
        NEXT_PUBLIC_REALTIME_WS_ORIGIN: "ws://localhost:8878",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
