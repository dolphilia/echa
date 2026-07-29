const SLUG_PATTERN = /^[a-f0-9]{32}$/;
const CHANNEL_PATTERN = /^[a-z0-9-]+$/;

function positiveInteger(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`${name} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function throughput(value, name) {
  const parsed = Number(value);
  if (parsed === -1) return parsed;
  return positiveInteger(value, name);
}

function boolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

export function parseOptions(argv) {
  if (argv.length % 2 !== 0) {
    throw new TypeError(`invalid argument near ${argv.at(-1) ?? "<end>"}`);
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new TypeError(`invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  const known = new Set([
    "web-origin",
    "public-slug",
    "latencies-ms",
    "runs",
    "calibration-requests",
    "download-bps",
    "upload-bps",
    "timeout-ms",
    "channel",
    "headless",
    "output",
  ]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new TypeError(`unknown option --${key}`);
  }

  const webOrigin = values.get("web-origin") ?? "https://preview.koge.app";
  let parsedOrigin;
  try {
    parsedOrigin = new URL(webOrigin);
  } catch {
    throw new TypeError("web-origin must be an absolute URL");
  }
  if (!["http:", "https:"].includes(parsedOrigin.protocol)) {
    throw new TypeError("web-origin must use http or https");
  }

  const publicSlug = values.get("public-slug");
  if (!publicSlug || !SLUG_PATTERN.test(publicSlug)) {
    throw new TypeError(
      "public-slug is required and must be 32 lowercase hexadecimal characters",
    );
  }

  const latenciesMs = (values.get("latencies-ms") ?? "50,200,500")
    .split(",")
    .map((value) => positiveInteger(value, "latencies-ms", 0));
  if (latenciesMs.length === 0 || new Set(latenciesMs).size !== latenciesMs.length) {
    throw new TypeError("latencies-ms must contain unique comma-separated integers");
  }

  const channel = values.get("channel") ?? "chrome";
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new TypeError("channel must contain lowercase letters, numbers or hyphens");
  }

  return {
    webOrigin: parsedOrigin.origin,
    publicSlug,
    latenciesMs,
    runs: positiveInteger(values.get("runs") ?? "3", "runs", 3),
    calibrationRequests: positiveInteger(
      values.get("calibration-requests") ?? "3",
      "calibration-requests",
    ),
    downloadThroughput: throughput(
      values.get("download-bps") ?? "-1",
      "download-bps",
    ),
    uploadThroughput: throughput(
      values.get("upload-bps") ?? "-1",
      "upload-bps",
    ),
    timeoutMs: positiveInteger(
      values.get("timeout-ms") ?? "60000",
      "timeout-ms",
      5_000,
    ),
    channel,
    headless: boolean(values.get("headless") ?? "true", "headless"),
    ...(values.has("output") ? { output: values.get("output") } : {}),
  };
}

export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

export function summarize(values) {
  if (values.length === 0) {
    return {
      count: 0,
      minimum: 0,
      median: 0,
      p95: 0,
      maximum: 0,
      average: 0,
    };
  }
  return {
    count: values.length,
    minimum: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    maximum: Math.max(...values),
    average: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

const RECOVERY_METRICS = [
  "socketOpenMs",
  "snapshotOfferMs",
  "snapshotFetchMs",
  "snapshotVerificationMs",
  "snapshotApplyMs",
  "firstTailFrameMs",
  "tailDecodeMs",
  "tailApplyMs",
  "readyMs",
  "readyPaintMs",
  "wallMs",
  "domContentLoadedMs",
  "loadEventMs",
  "firstContentfulPaintMs",
];

export function summarizeRuns(runs) {
  const result = {};
  for (const field of RECOVERY_METRICS) {
    const values = runs
      .map((run) => run[field])
      .filter((value) => Number.isFinite(value));
    result[field] = summarize(values);
  }
  return result;
}

export function validateRecoveryRun(run) {
  if (
    !run
    || run.schema !== "koge.browser-recovery.v1"
    || run.status !== "painted"
    || run.source !== "snapshot"
    || !Number.isSafeInteger(run.snapshotBaseRoomSeq)
    || !Number.isSafeInteger(run.readyRoomSeq)
    || !Number.isSafeInteger(run.tailEventCount)
    || run.tailEventCount !== run.readyRoomSeq - run.snapshotBaseRoomSeq
  ) {
    throw new Error("browser recovery result is incomplete or inconsistent");
  }
  return run;
}
