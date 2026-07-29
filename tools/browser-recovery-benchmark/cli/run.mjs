import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import {
  parseOptions,
  summarize,
  summarizeRuns,
  validateRecoveryRun,
} from "../src/core.mjs";

const options = parseOptions(process.argv.slice(2));
const roomUrl = new URL(`/rooms/${options.publicSlug}`, options.webOrigin);
const roomDigest = createHash("sha256").update(options.publicSlug).digest("hex");
const browser = await chromium.launch({
  channel: options.channel === "chromium" ? undefined : options.channel,
  headless: options.headless,
});

async function waitForPaintedRecovery(page) {
  await page.waitForFunction(
    () => window.kogeBrowserRecoveryMetrics?.status === "painted",
    undefined,
    { timeout: options.timeoutMs },
  );
  const measured = await page.evaluate(() => {
    const metrics = window.kogeBrowserRecoveryMetrics;
    const navigation = performance.getEntriesByType("navigation")[0];
    const firstContentfulPaint = performance.getEntriesByName(
      "first-contentful-paint",
    )[0];
    return {
      ...metrics,
      ...(navigation
        ? {
            domContentLoadedMs: navigation.domContentLoadedEventEnd,
            loadEventMs: navigation.loadEventEnd,
          }
        : {}),
      ...(firstContentfulPaint
        ? { firstContentfulPaintMs: firstContentfulPaint.startTime }
        : {}),
    };
  });
  return validateRecoveryRun(measured);
}

async function calibrate(page) {
  const samples = [];
  for (let index = 0; index < options.calibrationRequests; index += 1) {
    // Sequential requests keep each calibration sample independent.
    // eslint-disable-next-line no-await-in-loop
    samples.push(await page.evaluate(async (sequence) => {
      const startedAt = performance.now();
      const response = await fetch(
        `/?koge-latency-probe=${Date.now()}-${sequence}`,
        { cache: "no-store" },
      );
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`latency probe failed: ${response.status}`);
      return performance.now() - startedAt;
    }, index));
  }
  return samples;
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript((slug) => {
    sessionStorage.setItem(`koge-room-role:${slug}`, "viewer");
  }, options.publicSlug);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");

  const setNetworkConditions = async (latencyMs) => {
    const conditions = {
      latency: latencyMs,
      downloadThroughput: options.downloadThroughput,
      uploadThroughput: options.uploadThroughput,
    };
    await cdp.send("Network.emulateNetworkConditionsByRule", {
      matchedNetworkConditions: [{ urlPattern: "", ...conditions }],
    });
    await cdp.send("Network.overrideNetworkState", {
      offline: false,
      ...conditions,
    });
  };

  await setNetworkConditions(0);
  await page.goto(roomUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });
  await waitForPaintedRecovery(page);

  const conditions = [];
  for (const latencyMs of options.latenciesMs) {
    process.stderr.write(`measuring configured latency ${latencyMs}ms\n`);
    // Conditions share one page and CDP session, so matrix entries are sequential.
    // eslint-disable-next-line no-await-in-loop
    await setNetworkConditions(latencyMs);
    // eslint-disable-next-line no-await-in-loop
    const calibrationMs = await calibrate(page);
    const runs = [];
    for (let index = 0; index < options.runs; index += 1) {
      const startedAt = performance.now();
      // Reusing one page isolates latency from browser-process variation.
      // eslint-disable-next-line no-await-in-loop
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs,
      });
      // eslint-disable-next-line no-await-in-loop
      const run = await waitForPaintedRecovery(page);
      runs.push({
        ...run,
        wallMs: performance.now() - startedAt,
      });
    }
    conditions.push({
      configuredMinimumRequestLatencyMs: latencyMs,
      calibrationMs,
      calibrationSummary: summarize(calibrationMs),
      runs,
      summary: summarizeRuns(runs),
    });
  }
  await setNetworkConditions(0);

  const report = {
    schema: "koge.browser-recovery-latency-suite.v1",
    recordedAt: new Date().toISOString(),
    target: {
      webOrigin: options.webOrigin,
      roomDigest,
    },
    browser: {
      engine: "chromium",
      channel: options.channel,
      headless: options.headless,
      viewport: { width: 1440, height: 900 },
    },
    network: {
      configuredLatencySemantics:
        "Chrome CDP minimum latency from request sent to response headers received",
      downloadThroughputBytesPerSecond: options.downloadThroughput,
      uploadThroughputBytesPerSecond: options.uploadThroughput,
      calibrationRequestsPerCondition: options.calibrationRequests,
    },
    runsPerCondition: options.runs,
    conditions,
    correctness: {
      recoveryRunCount: conditions.length * options.runs,
      snapshotSourceCount: conditions.reduce(
        (total, condition) =>
          total + condition.runs.filter((run) => run.source === "snapshot").length,
        0,
      ),
      timeoutCount: 0,
      tailEventCountMismatchCount: 0,
    },
    notes: [
      "The public room slug, guest cookies and room tickets are not written to the report.",
      "Configured CDP latency is a deterministic request-latency condition, not a claim about physical path RTT.",
      "Throughput is unlimited unless download-bps or upload-bps is explicitly set.",
      "All connections use the product viewer role and formal guest ticket endpoint.",
    ],
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolve(options.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
  await context.close();
} finally {
  await browser.close();
}
