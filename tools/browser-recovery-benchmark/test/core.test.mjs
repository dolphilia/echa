import assert from "node:assert/strict";
import test from "node:test";
import {
  parseOptions,
  percentile,
  summarize,
  summarizeRuns,
  validateRecoveryRun,
} from "../src/core.mjs";

const slug = "a".repeat(32);

test("parses safe defaults and an exact latency matrix", () => {
  assert.deepEqual(parseOptions([
    "--public-slug",
    slug,
    "--latencies-ms",
    "50,200,500",
    "--output",
    "/tmp/result.json",
  ]), {
    webOrigin: "https://preview.koge.app",
    publicSlug: slug,
    latenciesMs: [50, 200, 500],
    runs: 3,
    calibrationRequests: 3,
    downloadThroughput: -1,
    uploadThroughput: -1,
    timeoutMs: 60_000,
    channel: "chrome",
    headless: true,
    output: "/tmp/result.json",
  });
});

test("rejects malformed and unsafe options", () => {
  assert.throws(() => parseOptions([]), /public-slug/);
  assert.throws(() => parseOptions([
    "--public-slug",
    slug,
    "--runs",
    "2",
  ]), /at least 3/);
  assert.throws(() => parseOptions([
    "--public-slug",
    slug,
    "--unknown",
    "value",
  ]), /unknown option/);
  assert.throws(() => parseOptions([
    "--public-slug",
    slug,
    "--latencies-ms",
    "50,50",
  ]), /unique/);
});

test("uses nearest-rank percentiles and stable summaries", () => {
  assert.equal(percentile([9, 1, 5], 0.5), 5);
  assert.equal(percentile([9, 1, 5], 0.95), 9);
  assert.deepEqual(summarize([9, 1, 5]), {
    count: 3,
    minimum: 1,
    median: 5,
    p95: 9,
    maximum: 9,
    average: 5,
  });
});

test("summarizes browser recovery runs", () => {
  const summary = summarizeRuns([
    { readyPaintMs: 300, tailApplyMs: 10 },
    { readyPaintMs: 100, tailApplyMs: 20 },
    { readyPaintMs: 200, tailApplyMs: 30 },
  ]);
  assert.equal(summary.readyPaintMs.median, 200);
  assert.equal(summary.tailApplyMs.p95, 30);
  assert.equal(summary.snapshotFetchMs.count, 0);
});

test("accepts only complete snapshot recovery", () => {
  const run = {
    schema: "koge.browser-recovery.v1",
    source: "snapshot",
    status: "painted",
    snapshotBaseRoomSeq: 100,
    readyRoomSeq: 103,
    tailEventCount: 3,
  };
  assert.equal(validateRecoveryRun(run), run);
  assert.throws(
    () => validateRecoveryRun({ ...run, tailEventCount: 2 }),
    /incomplete or inconsistent/,
  );
  assert.throws(
    () => validateRecoveryRun({ ...run, source: "event-log" }),
    /incomplete or inconsistent/,
  );
});
