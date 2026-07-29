import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";

type ScenarioName = "2-active" | "10+10" | "20-active" | "20-cold";

type Options = {
  endpoint: string;
  origin: string;
  webOrigin?: string;
  publicSlug?: string;
  events: number[];
  scenarios: ScenarioName[];
  runs: number;
  rate: number;
  pointsPerAppend: number;
  recoveryMode: "event-log" | "snapshot-required";
  output: string;
};

type RunResult = {
  schema: "koge.realtime-benchmark.v2";
  input: {
    requestedEvents: number;
    connections: number;
    activeConnections: number;
    observerConnections: number;
    coldRecoveryConnections: number;
  };
  actualEventCount: number;
  roomSeqBefore: number;
  roomSeqAfter: number;
  effectiveEventsPerSecond: number;
  ackRttMs: { p50: number; p95: number; p99: number; maximum: number };
  broadcastDeliveries: { expected: number; observed: number; missing: number };
  replay: {
    connections: number;
    eventCountMismatch: number;
    sourceCounts: { snapshot: number; eventLog: number };
    snapshotBaseRoomSeq: { minimum: number; maximum: number };
    snapshotOfferMs: { p50: number; p95: number; maximum: number };
    snapshotFetchCompleteMs: { p50: number; p95: number; maximum: number };
    eventCountPerConnection: { minimum: number; maximum: number };
    firstFrameMs: { p50: number; p95: number; maximum: number };
    completeMs: { p50: number; p95: number; maximum: number };
  };
};

const SCENARIOS: Record<ScenarioName, {
  connections: number;
  activeConnections: number;
  coldRecoveryConnections: number;
}> = {
  "2-active": {
    connections: 2,
    activeConnections: 2,
    coldRecoveryConnections: 1,
  },
  "10+10": {
    connections: 20,
    activeConnections: 10,
    coldRecoveryConnections: 1,
  },
  "20-active": {
    connections: 20,
    activeConnections: 20,
    coldRecoveryConnections: 1,
  },
  "20-cold": {
    connections: 2,
    activeConnections: 2,
    coldRecoveryConnections: 20,
  },
};

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(arguments_: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new TypeError(`invalid argument near ${key ?? "<end>"}`);
    }
    values.set(key.slice(2), value);
  }
  const events = (values.get("events") ?? "10000").split(",").map(
    (value) => positiveInteger(value, "events"),
  );
  const scenarios = (values.get("scenarios") ?? "2-active,10+10,20-active,20-cold")
    .split(",") as ScenarioName[];
  if (scenarios.some((scenario) => !(scenario in SCENARIOS))) {
    throw new TypeError("scenarios contains an unknown scenario");
  }
  const runs = positiveInteger(values.get("runs") ?? "3", "runs");
  if (runs < 3) throw new RangeError("runs must be at least 3");
  const webOrigin = values.get("web-origin");
  const publicSlug = values.get("public-slug");
  if ((webOrigin === undefined) !== (publicSlug === undefined)) {
    throw new TypeError("web-origin and public-slug must be provided together");
  }
  const recoveryMode = values.get("recovery-mode") ?? "event-log";
  if (recoveryMode !== "event-log" && recoveryMode !== "snapshot-required") {
    throw new TypeError(
      "recovery-mode must be event-log or snapshot-required",
    );
  }
  return {
    endpoint: values.get("endpoint") ?? "ws://localhost:8787",
    origin: values.get("origin") ?? "http://localhost:3000",
    ...(webOrigin === undefined ? {} : { webOrigin }),
    ...(publicSlug === undefined ? {} : { publicSlug }),
    events,
    scenarios,
    runs,
    rate: positiveInteger(values.get("rate") ?? "20", "rate"),
    pointsPerAppend: positiveInteger(
      values.get("points-per-append") ?? "6",
      "points-per-append",
    ),
    recoveryMode,
    output: values.get("output")
      ?? "reports/performance/realtime-suite.json",
  };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  )]!;
}

function summarize(values: readonly number[]) {
  return {
    minimum: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    maximum: Math.max(...values),
  };
}

async function childOutput(command: string, arguments_: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runScript = resolvePath(
    "tools/realtime-benchmark/cli/run.ts",
  );
  const commitSha = (await childOutput("git", ["rev-parse", "HEAD"])).trim();
  const workingTreeDirty = (
    await childOutput("git", ["status", "--short"])
  ).trim().length > 0;
  const fixtureDefinitionSha256 = createHash("sha256")
    .update(await readFile(runScript))
    .digest("hex");
  const results: Array<{
    scenario: ScenarioName;
    requestedEvents: number;
    run: number;
    result: RunResult;
  }> = [];

  for (const requestedEvents of options.events) {
    for (const scenarioName of options.scenarios) {
      const scenario = SCENARIOS[scenarioName];
      for (let run = 1; run <= options.runs; run += 1) {
        // Runs stay isolated so one room's load cannot skew another scenario.
        // oxlint-disable-next-line no-await-in-loop
        const output = await childOutput(process.execPath, [
          "--import",
          "tsx",
          runScript,
          "--endpoint",
          options.endpoint,
          "--origin",
          options.origin,
          ...(options.webOrigin && options.publicSlug
            ? [
                "--web-origin",
                options.webOrigin,
                "--public-slug",
                options.publicSlug,
              ]
            : []),
          "--events",
          String(requestedEvents),
          "--connections",
          String(scenario.connections),
          "--active-connections",
          String(scenario.activeConnections),
          "--cold-recovery-connections",
          String(scenario.coldRecoveryConnections),
          "--rate",
          String(options.rate),
          "--points-per-append",
          String(options.pointsPerAppend),
          "--pipeline",
          "true",
          "--replay",
          "true",
          "--recovery-mode",
          options.recoveryMode,
        ]);
        const result = JSON.parse(output) as RunResult;
        if (result.schema !== "koge.realtime-benchmark.v2") {
          throw new TypeError("benchmark returned an unsupported schema");
        }
        results.push({ scenario: scenarioName, requestedEvents, run, result });
      }
    }
  }

  const groups = options.events.flatMap((requestedEvents) =>
    options.scenarios.map((scenario) => {
      const runs = results.filter((item) => (
        item.requestedEvents === requestedEvents
        && item.scenario === scenario
      )).map((item) => item.result);
      return {
        scenario,
        requestedEvents,
        runCount: runs.length,
        actualEventCount: summarize(runs.map((run) => run.actualEventCount)),
        effectiveEventsPerSecond: summarize(
          runs.map((run) => run.effectiveEventsPerSecond),
        ),
        ackP95Ms: summarize(runs.map((run) => run.ackRttMs.p95)),
        ackMaximumMs: summarize(runs.map((run) => run.ackRttMs.maximum)),
        replayFirstP95Ms: summarize(
          runs.map((run) => run.replay.firstFrameMs.p95),
        ),
        replayCompleteP95Ms: summarize(
          runs.map((run) => run.replay.completeMs.p95),
        ),
        snapshotOfferP95Ms: summarize(
          runs.map((run) => run.replay.snapshotOfferMs.p95),
        ),
        snapshotFetchCompleteP95Ms: summarize(
          runs.map((run) => run.replay.snapshotFetchCompleteMs.p95),
        ),
        snapshotRecoveryConnections: runs.reduce(
          (total, run) => total + run.replay.sourceCounts.snapshot,
          0,
        ),
        broadcastMissing: runs.reduce(
          (total, run) => total + run.broadcastDeliveries.missing,
          0,
        ),
        recoveryEventCountMismatch: runs.filter((run) => (
          run.replay.eventCountMismatch > 0
        )).length,
      };
    })
  );
  const result = {
    schema: "koge.realtime-benchmark-suite.v1",
    recordedAt: new Date().toISOString(),
    commitSha,
    workingTreeDirty,
    runtime: process.version,
    environment: {
      endpoint: options.endpoint,
      origin: options.origin,
      ...(options.webOrigin ? { webOrigin: options.webOrigin } : {}),
      ...(options.publicSlug ? { publicSlug: options.publicSlug } : {}),
    },
    protocol: "v1 MessagePack",
    fixture: {
      kind: "deterministic synthetic complete strokes",
      definitionSha256: fixtureDefinitionSha256,
      pointsPerAppend: options.pointsPerAppend,
    },
    input: {
      events: options.events,
      scenarios: options.scenarios,
      runs: options.runs,
      targetEventsPerSecondPerActiveConnection: options.rate,
      recoveryMode: options.recoveryMode,
    },
    groups,
    runs: results,
    notes: [
      "Each scenario is repeated at least three times.",
      "10+10 uses 10 participant connections and 10 broadcast-only viewers.",
      "20-cold starts 20 viewer full-replay connections concurrently.",
      "RTT and browser rasterization are outside this Node WebSocket suite.",
    ],
  };
  const outputPath = resolvePath(options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: outputPath, groups }, null, 2)}\n`);
}

await main();
