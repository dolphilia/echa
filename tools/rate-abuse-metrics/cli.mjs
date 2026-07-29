#!/usr/bin/env node

import { chmod, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareRateAbuseCaptures } from "./compare.mjs";

const defaultEndpoint = "http://127.0.0.1:8793";

function usage() {
  throw new TypeError(
    "usage: cli.mjs capture --out <capture.json> "
      + "| compare --baseline <capture.json> --current <capture.json>",
  );
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) usage();
  return process.argv[index + 1];
}

function endpoint() {
  const value = process.env.KOGE_RATE_ABUSE_METRICS_ENDPOINT ?? defaultEndpoint;
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  ) {
    throw new TypeError("metrics endpoint must be localhost HTTP");
  }
  return url.origin;
}

async function capture() {
  const outputPath = resolve(option("--out"));
  const response = await fetch(`${endpoint()}/capture`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(`metrics capture failed (${response.status})`);
  }
  const file = await open(outputPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
  } finally {
    await file.close();
  }
  await chmod(outputPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    status: "captured",
    output: outputPath,
    environment: result.environment,
    capturedAt: result.capturedAt,
    liveRoomCount: result.liveRooms.length,
    completedOutcomeCount: result.outcomes.length,
  }, null, 2)}\n`);
}

async function compare() {
  const baseline = JSON.parse(
    await readFile(resolve(option("--baseline")), "utf8"),
  );
  const current = JSON.parse(
    await readFile(resolve(option("--current")), "utf8"),
  );
  process.stdout.write(
    `${JSON.stringify(compareRateAbuseCaptures(baseline, current), null, 2)}\n`,
  );
}

if (process.argv[2] === "capture") {
  await capture();
} else if (process.argv[2] === "compare") {
  await compare();
} else {
  usage();
}
