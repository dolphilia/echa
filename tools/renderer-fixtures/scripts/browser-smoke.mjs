import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

const port = 4174;
const server = spawn("node", ["tools/event-log-benchmark/server.mjs"], {
  cwd: new URL("../../..", import.meta.url),
  env: {
    ...process.env,
    ECHA_BENCHMARK_PORT: String(port)
  },
  stdio: ["ignore", "pipe", "inherit"]
});

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("renderer fixture server did not start")),
      10_000
    );
    server.once("error", reject);
    server.stdout.on("data", (chunk) => {
      if (!chunk.toString().includes(`http://127.0.0.1:${port}/`)) return;
      clearTimeout(timeout);
      resolve();
    });
  });

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${port}/tools/renderer-fixtures/web/`,
      { waitUntil: "networkidle" }
    );
    await page.waitForFunction(
      () => window.__kogeRendererResult || window.__kogeRendererError,
      undefined,
      { timeout: 30_000 }
    );
    const state = await page.evaluate(() => ({
      result: window.__kogeRendererResult,
      error: window.__kogeRendererError
    }));
    assert.equal(state.error, undefined);
    assert.equal(state.result?.ok, true);
    process.stdout.write(`${JSON.stringify(state.result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
}

