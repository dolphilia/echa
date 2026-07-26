#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  formatBytes,
  summarizeEventLog,
  validateEventLog
} from "../src/core.mjs";

const input = process.argv[2];
if (!input || input === "--help" || input === "-h") {
  process.stdout.write("Usage: npm run summarize -- <event-log.json>\n");
  process.exit(input ? 0 : 1);
}

try {
  const log = JSON.parse(await readFile(path.resolve(input), "utf8"));
  const errors = validateEventLog(log);
  if (errors.length > 0) {
    throw new Error(`Invalid event log:\n- ${errors.join("\n- ")}`);
  }
  const summary = summarizeEventLog(log);
  process.stdout.write(`${JSON.stringify({
    ...summary,
    jsonSize: formatBytes(summary.jsonBytes),
    estimatedMessagePackSize: formatBytes(summary.estimatedMessagePackBytes)
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
