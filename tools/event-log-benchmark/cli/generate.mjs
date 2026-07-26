#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  formatBytes,
  generateEventLog,
  summarizeEventLog
} from "../src/core.mjs";

function parsePositiveInteger(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function parseByteSize(value) {
  if (value === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kib|mib)?$/i.exec(value);
  if (!match) throw new Error("--target-bytes must look like 65536, 256KiB, or 4MiB");
  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "mib" ? 1024 ** 2 : unit === "kib" ? 1024 : 1;
  return Math.round(amount * multiplier);
}

function parseArguments(argv) {
  const options = {
    input: new URL("../fixtures/sample-raw-strokes.json", import.meta.url).pathname,
    output: "tmp/event-log-10000.json",
    targetEvents: 10_000,
    targetBytes: null,
    actors: 3,
    appendIntervalMs: 50,
    maxPointsPerAppend: 12,
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    if (argument === "--input") options.input = next();
    else if (argument === "--output") options.output = next();
    else if (argument === "--target-events") {
      options.targetEvents = parsePositiveInteger(next(), argument);
    } else if (argument === "--target-bytes") {
      options.targetBytes = parseByteSize(next());
    } else if (argument === "--actors") {
      options.actors = parsePositiveInteger(next(), argument);
    } else if (argument === "--append-interval-ms") {
      options.appendIntervalMs = parsePositiveInteger(next(), argument);
    } else if (argument === "--max-points-per-append") {
      options.maxPointsPerAppend = parsePositiveInteger(next(), argument);
    } else if (argument === "--pretty") options.pretty = true;
    else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Usage:
  npm run generate -- [options]

Options:
  --input <path>                   Raw stroke fixture JSON
  --output <path>                  Generated event log JSON
  --target-events <count>          Minimum event count (default: 10000)
  --target-bytes <size>            Minimum estimated MessagePack size, e.g. 4MiB
  --actors <count>                 Simulated actors (default: 3)
  --append-interval-ms <ms>        Append batching interval (default: 50)
  --max-points-per-append <count>  Append point cap (default: 12)
  --pretty                         Pretty-print the output JSON
`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const fixture = JSON.parse(await readFile(path.resolve(options.input), "utf8"));
  const log = generateEventLog(fixture, options);
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(log, null, options.pretty ? 2 : 0)
  );

  const summary = summarizeEventLog(log);
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    ...summary,
    jsonSize: formatBytes(summary.jsonBytes),
    estimatedMessagePackSize: formatBytes(summary.estimatedMessagePackBytes)
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
