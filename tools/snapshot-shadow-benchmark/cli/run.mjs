import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { decodeSnapshot, encodeSnapshot } from "@koge/protocol";
import {
  RendererSession,
  instantiateRenderer,
} from "@koge/renderer-core";
import {
  generateEventLog,
  summarizeEventLog,
} from "../../event-log-benchmark/src/core.mjs";

const DEFAULT_FIXTURE =
  "tools/event-log-benchmark/fixtures/"
  + "echa-raw-strokes-2026-07-26T16-06-54-108Z.json";
const DEFAULT_VOLUMES = [10_000, 50_000, 100_000];
const DEFAULT_TAIL_EVENTS = 1_000;
const EVENT_CHUNK_SIZE = 500;
const RENDERER_VERSION = 1;

function parseArguments(argv) {
  const options = {
    input: DEFAULT_FIXTURE,
    output: null,
    volumes: DEFAULT_VOLUMES,
    runs: 3,
    tailEvents: DEFAULT_TAIL_EVENTS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--input" && value) {
      options.input = value;
      index += 1;
    } else if (argument === "--output" && value) {
      options.output = value;
      index += 1;
    } else if (argument === "--events" && value) {
      options.volumes = value.split(",").map((item) => Number.parseInt(item, 10));
      index += 1;
    } else if (argument === "--runs" && value) {
      options.runs = Number.parseInt(value, 10);
      index += 1;
    } else if (argument === "--tail-events" && value) {
      options.tailEvents = Number.parseInt(value, 10);
      index += 1;
    } else {
      throw new TypeError(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (
    options.volumes.length === 0
    || options.volumes.some((value) => !Number.isSafeInteger(value) || value < 3)
    || !Number.isSafeInteger(options.runs)
    || options.runs < 1
    || options.runs > 20
    || !Number.isSafeInteger(options.tailEvents)
    || options.tailEvents < 0
  ) {
    throw new RangeError("invalid benchmark arguments");
  }
  return options;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function completedBoundary(events, desiredIndex) {
  for (
    let index = Math.min(events.length, desiredIndex);
    index > 0;
    index -= 1
  ) {
    const operation = events[index - 1]?.op;
    if (operation === "stroke.end" || operation === "stroke.cancel") return index;
  }
  return 0;
}

function replayEvents(session, events) {
  const active = new Map();
  let completedStrokeCount = 0;
  let pointCount = 0;
  for (let offset = 0; offset < events.length; offset += EVENT_CHUNK_SIZE) {
    const completed = [];
    for (const event of events.slice(offset, offset + EVENT_CHUNK_SIZE)) {
      if (event.op === "stroke.begin") {
        if (active.has(event.id)) throw new Error("duplicate active stroke");
        active.set(event.id, {
          tool: event.tool,
          color: event.color,
          size: event.size,
          opacity: event.opacity,
          points: [{
            x: event.point[0],
            y: event.point[1],
            dt: event.point[2],
          }],
        });
        pointCount += 1;
      } else if (event.op === "stroke.append") {
        const stroke = active.get(event.id);
        if (!stroke) throw new Error("append without active stroke");
        stroke.points.push(
          ...event.points.map(([x, y, dt]) => ({ x, y, dt })),
        );
        pointCount += event.points.length;
      } else {
        const stroke = active.get(event.id);
        if (!stroke) throw new Error("terminal event without active stroke");
        active.delete(event.id);
        if (event.op === "stroke.end") {
          completed.push(stroke);
          completedStrokeCount += 1;
        }
      }
    }
    if (completed.length > 0) session.apply(completed);
  }
  if (active.size !== 0) throw new Error("replay ended inside an active stroke");
  return { completedStrokeCount, pointCount };
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  )];
}

function summarizeSamples(samples) {
  return {
    minimum: Math.min(...samples),
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    maximum: Math.max(...samples),
    average: samples.reduce((total, value) => total + value, 0) / samples.length,
  };
}

async function measureVolume(renderer, fixture, requestedEvents, options) {
  const log = generateEventLog(fixture, {
    targetEvents: requestedEvents,
    actors: 5,
    appendIntervalMs: 50,
    maxPointsPerAppend: 12,
  });
  const baseIndex = completedBoundary(
    log.events,
    Math.max(0, log.events.length - options.tailEvents),
  );
  const prefix = log.events.slice(0, baseIndex);
  const tail = log.events.slice(baseIndex);
  const timings = {
    fullReplayMs: [],
    snapshotRenderMs: [],
    snapshotEncodeMs: [],
    snapshotDecodeMs: [],
    snapshotLoadMs: [],
    tailReplayMs: [],
    snapshotRecoveryMs: [],
  };
  let fullHash = "";
  let recoveredHash = "";
  let snapshotBytes = 0;
  let replayStats;

  for (let run = 0; run < options.runs; run += 1) {
    const fullSession = new RendererSession(
      renderer,
      fixture.canvas.width,
      fixture.canvas.height,
    );
    const fullStartedAt = performance.now();
    replayStats = replayEvents(fullSession, log.events);
    const fullPixels = fullSession.pixels();
    timings.fullReplayMs.push(performance.now() - fullStartedAt);
    fullHash = hash(fullPixels);
    fullSession.dispose();

    const snapshotSession = new RendererSession(
      renderer,
      fixture.canvas.width,
      fixture.canvas.height,
    );
    const snapshotRenderStartedAt = performance.now();
    replayEvents(snapshotSession, prefix);
    const snapshotPixels = snapshotSession.pixels();
    timings.snapshotRenderMs.push(performance.now() - snapshotRenderStartedAt);
    const encodeStartedAt = performance.now();
    const encoded = await encodeSnapshot(
      snapshotPixels,
      fixture.canvas.width,
      fixture.canvas.height,
      RENDERER_VERSION,
    );
    timings.snapshotEncodeMs.push(performance.now() - encodeStartedAt);
    snapshotBytes = encoded.byteLength;
    snapshotSession.dispose();

    const recoveryStartedAt = performance.now();
    const decodeStartedAt = performance.now();
    const decoded = await decodeSnapshot(encoded);
    timings.snapshotDecodeMs.push(performance.now() - decodeStartedAt);
    const recoveredSession = new RendererSession(
      renderer,
      fixture.canvas.width,
      fixture.canvas.height,
    );
    const loadStartedAt = performance.now();
    recoveredSession.loadPixels(decoded.rgba);
    timings.snapshotLoadMs.push(performance.now() - loadStartedAt);
    const tailStartedAt = performance.now();
    replayEvents(recoveredSession, tail);
    timings.tailReplayMs.push(performance.now() - tailStartedAt);
    recoveredHash = hash(recoveredSession.pixels());
    timings.snapshotRecoveryMs.push(performance.now() - recoveryStartedAt);
    recoveredSession.dispose();

    if (recoveredHash !== fullHash) {
      throw new Error(
        `RGBA mismatch at ${requestedEvents} events on run ${run + 1}`,
      );
    }
  }

  return {
    requestedEvents,
    actualEvents: log.events.length,
    snapshotBaseRoomSeq: baseIndex,
    tailEvents: tail.length,
    eventSummary: summarizeEventLog(log),
    replayStats,
    snapshotBytes,
    snapshotCompressionRatio:
      snapshotBytes / (fixture.canvas.width * fixture.canvas.height * 4),
    fullRgbaHash: fullHash,
    recoveredRgbaHash: recoveredHash,
    hashMatch: fullHash === recoveredHash,
    timings: Object.fromEntries(
      Object.entries(timings).map(([name, samples]) => [
        name,
        summarizeSamples(samples),
      ]),
    ),
  };
}

const options = parseArguments(process.argv.slice(2));
const inputPath = resolve(options.input);
const wasmPath = resolve("packages/renderer-core/dist/koge-renderer.wasm");
const [fixtureText, wasm] = await Promise.all([
  readFile(inputPath, "utf8"),
  readFile(wasmPath),
]);
const fixture = JSON.parse(fixtureText);
const renderer = await instantiateRenderer(wasm);
const results = [];
for (const volume of options.volumes) {
  // Sequential execution avoids overlapping large RGBA buffers and makes wall
  // time samples easier to compare.
  // eslint-disable-next-line no-await-in-loop
  results.push(await measureVolume(renderer, fixture, volume, options));
}

const report = {
  schema: "koge.snapshot-shadow-benchmark.v1",
  measuredAt: new Date().toISOString(),
  runtime: `Node ${process.version}`,
  environment: "local",
  rendererVersion: renderer.exports.renderer_version(),
  fixture: {
    path: inputPath,
    sha256: hash(await readFile(inputPath)),
    canvas: fixture.canvas,
    rawStrokeCount: fixture.strokes.length,
  },
  conditions: {
    runs: options.runs,
    requestedVolumes: options.volumes,
    requestedTailEvents: options.tailEvents,
    eventChunkSize: EVENT_CHUNK_SIZE,
    actors: 5,
    appendIntervalMs: 50,
    maxPointsPerAppend: 12,
  },
  results,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  const outputPath = resolve(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized);
}
process.stdout.write(serialized);
