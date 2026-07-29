import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new TypeError(`invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  const realtime = values.get("realtime");
  const tail = values.get("tail");
  if (!realtime || !tail) {
    throw new TypeError("--realtime and --tail are required");
  }
  return {
    realtime,
    tail,
    output: values.get("output"),
  };
}

function extractJsonObjects(text) {
  const values = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Wrangler may print non-JSON notices containing braces.
        }
        start = -1;
      }
    }
  }
  return values;
}

function parseStructuredLog(event) {
  for (const log of event.logs ?? []) {
    const candidates = Array.isArray(log.message) ? log.message : [log.message];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      try {
        const value = JSON.parse(candidate);
        if (value?.message === "snapshot job completed") return value;
      } catch {
        // Ignore non-JSON custom logs.
      }
    }
  }
  return undefined;
}

function summarizeBuckets(buckets) {
  const count = buckets.reduce(
    (total, bucket) => total + bucket.ackRttMs.count,
    0,
  );
  if (count === 0) return { count: 0 };
  return {
    count,
    weightedAverage: buckets.reduce(
      (total, bucket) =>
        total + bucket.ackRttMs.average * bucket.ackRttMs.count,
      0,
    ) / count,
    maximumBucketP50: Math.max(...buckets.map((bucket) => bucket.ackRttMs.p50)),
    maximumBucketP95: Math.max(...buckets.map((bucket) => bucket.ackRttMs.p95)),
    maximum: Math.max(...buckets.map((bucket) => bucket.ackRttMs.maximum)),
  };
}

const options = parseArguments(process.argv.slice(2));
const [realtimeText, tailText] = await Promise.all([
  readFile(resolve(options.realtime), "utf8"),
  readFile(resolve(options.tail), "utf8"),
]);
const realtime = JSON.parse(realtimeText);
const invocations = extractJsonObjects(tailText)
  .filter((event) => (
    event.scriptName === "koge-snapshot-preview"
    && event.event?.queue === "koge-snapshot-preview"
  ))
  .map((event) => {
    const snapshot = parseStructuredLog(event);
    // Queue tail timestamps identify invocation start. The completion log
    // timestamp is close to the end, but tail wall time is authoritative.
    const startedAt = event.eventTimestamp;
    const endedAt = startedAt + event.wallTime;
    const duringBuckets = realtime.ackTimeline.filter((bucket) => (
      bucket.startedAt + 1_000 > startedAt
      && bucket.startedAt < endedAt
    ));
    const beforeBuckets = realtime.ackTimeline.filter((bucket) => (
      bucket.startedAt >= startedAt - 10_000
      && bucket.startedAt < startedAt
    ));
    return {
      scriptVersion: event.scriptVersion?.id,
      outcome: event.outcome,
      cpuTimeMs: event.cpuTime,
      wallTimeMs: event.wallTime,
      startedAt,
      endedAt,
      snapshot,
      ackBefore: summarizeBuckets(beforeBuckets),
      ackDuring: summarizeBuckets(duringBuckets),
    };
  })
  .filter((invocation) => invocation.snapshot?.roomId === realtime.roomId);

const report = {
  schema: "koge.snapshot-preview-benchmark.v1",
  measuredAt: new Date().toISOString(),
  roomId: realtime.roomId,
  realtime: {
    input: realtime.input,
    actualEventCount: realtime.actualEventCount,
    sendDurationMs: realtime.sendDurationMs,
    effectiveEventsPerSecond: realtime.effectiveEventsPerSecond,
    ackRttMs: realtime.ackRttMs,
    broadcastDeliveries: realtime.broadcastDeliveries,
  },
  snapshotInvocations: invocations,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) {
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized);
}
process.stdout.write(serialized);
