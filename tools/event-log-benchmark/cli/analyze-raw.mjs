#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  analyzeRawFixture,
  formatBytes,
  rawFixtureToEventLog
} from "../src/core.mjs";

function parsePositiveInteger(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    input: null,
    outputEventLog: null,
    appendIntervalMs: 50,
    maxPointsPerAppend: 12
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    if (argument === "--append-interval-ms") {
      options.appendIntervalMs = parsePositiveInteger(next(), argument);
    } else if (argument === "--max-points-per-append") {
      options.maxPointsPerAppend = parsePositiveInteger(next(), argument);
    } else if (argument === "--output-event-log") {
      options.outputEventLog = next();
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else if (options.input === null) {
      options.input = argument;
    } else {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Usage:
  npm run analyze-raw -- <raw-strokes.json> [options]

Options:
  --append-interval-ms <ms>        Append batching interval (default: 50)
  --max-points-per-append <count>  Append point cap (default: 12)
  --output-event-log <path>        Also write the single-pass event log
`);
}

function withReadableValues(analysis) {
  return {
    ...analysis,
    recordedDurationSeconds:
      analysis.recordedDurationMs === null
        ? null
        : analysis.recordedDurationMs / 1000,
    activeDrawingDurationSeconds: analysis.activeDrawingDurationMs / 1000,
    activeDrawingPercent:
      analysis.activeDrawingRatio === null
        ? null
        : analysis.activeDrawingRatio * 100,
    jsonSize: formatBytes(analysis.jsonBytes),
    estimatedMessagePackSize: formatBytes(
      analysis.estimatedMessagePackBytes
    ),
    estimatedMessagePackPerRecordedMinute:
      analysis.estimatedMessagePackBytesPerRecordedMinute === null
        ? null
        : formatBytes(analysis.estimatedMessagePackBytesPerRecordedMinute),
    estimatedMessagePackPerActiveMinute:
      analysis.estimatedMessagePackBytesPerActiveMinute === null
        ? null
        : formatBytes(analysis.estimatedMessagePackBytesPerActiveMinute)
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.input) {
    printHelp();
    throw new Error("raw fixture path is required");
  }

  const inputPath = path.resolve(options.input);
  const fixture = JSON.parse(await readFile(inputPath, "utf8"));
  const batching = {
    appendIntervalMs: options.appendIntervalMs,
    maxPointsPerAppend: options.maxPointsPerAppend
  };
  const analysis = analyzeRawFixture(fixture, batching);

  if (options.outputEventLog) {
    const outputPath = path.resolve(options.outputEventLog);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      JSON.stringify(rawFixtureToEventLog(fixture, batching))
    );
    analysis.outputEventLog = outputPath;
  }

  process.stdout.write(
    `${JSON.stringify({
      input: inputPath,
      ...withReadableValues(analysis)
    }, null, 2)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
