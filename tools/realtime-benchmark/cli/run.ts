import {
  decodeServerMessage,
  encodeEvent,
  SNAPSHOT_RENDERER_VERSION,
  type ClientStrokeEvent,
  type ServerMessage,
  type SnapshotOfferMessage,
} from "@koge/protocol";
import { fetchVerifiedSnapshot } from "../../../apps/web/app/snapshot-recovery";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket, { type RawData } from "ws";

type Options = {
  endpoint: string;
  origin: string;
  webOrigin?: string;
  publicSlug?: string;
  events: number;
  connections: number;
  activeConnections: number;
  coldRecoveryConnections: number;
  rate: number;
  pointsPerAppend: number;
  ackTimeoutMs: number;
  pipeline: boolean;
  replay: boolean;
  recoveryMode: "event-log" | "snapshot-required";
  room?: string;
  output?: string;
};

type Summary = {
  count: number;
  minimum: number;
  p50: number;
  p95: number;
  p99: number;
  maximum: number;
  average: number;
};

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
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
  const endpoint = values.get("endpoint") ?? "ws://localhost:8787";
  const origin = values.get("origin") ?? "http://localhost:3000";
  const webOrigin = values.get("web-origin");
  const publicSlug = values.get("public-slug");
  const events = parsePositiveInteger(values.get("events") ?? "900", "events");
  const connections = parsePositiveInteger(
    values.get("connections") ?? "3",
    "connections",
  );
  const activeConnections = parsePositiveInteger(
    values.get("active-connections") ?? String(connections),
    "active-connections",
  );
  const coldRecoveryConnections = parsePositiveInteger(
    values.get("cold-recovery-connections") ?? "1",
    "cold-recovery-connections",
  );
  const rate = parsePositiveInteger(values.get("rate") ?? "40", "rate");
  const pointsPerAppend = parsePositiveInteger(
    values.get("points-per-append") ?? "1",
    "points-per-append",
  );
  const ackTimeoutMs = parsePositiveInteger(
    values.get("ack-timeout-ms") ?? "120000",
    "ack-timeout-ms",
  );
  if (connections > 20) throw new RangeError("connections must be at most 20");
  if ((webOrigin === undefined) !== (publicSlug === undefined)) {
    throw new TypeError("web-origin and public-slug must be provided together");
  }
  if (publicSlug !== undefined && !/^[a-f0-9]{32}$/.test(publicSlug)) {
    throw new TypeError("public-slug must be a 32-character lowercase hex slug");
  }
  if (activeConnections > connections) {
    throw new RangeError("active-connections must not exceed connections");
  }
  if (coldRecoveryConnections > 20) {
    throw new RangeError("cold-recovery-connections must be at most 20");
  }
  if (rate > 80) {
    throw new RangeError("rate must be at most the current 80 events/s safety limit");
  }
  if (pointsPerAppend > 12) {
    throw new RangeError("points-per-append must be at most 12");
  }
  const room = values.get("room");
  if (room !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(room)) {
    throw new TypeError("room must be a valid room identifier");
  }
  return {
    endpoint,
    origin,
    ...(webOrigin === undefined ? {} : { webOrigin }),
    ...(publicSlug === undefined ? {} : { publicSlug }),
    events,
    connections,
    activeConnections,
    coldRecoveryConnections,
    rate,
    pointsPerAppend,
    ackTimeoutMs,
    pipeline: parseBoolean(values.get("pipeline") ?? "false", "pipeline"),
    replay: parseBoolean(values.get("replay") ?? "true", "replay"),
    recoveryMode: (() => {
      const mode = values.get("recovery-mode") ?? "event-log";
      if (mode !== "event-log" && mode !== "snapshot-required") {
        throw new TypeError(
          "recovery-mode must be event-log or snapshot-required",
        );
      }
      return mode;
    })(),
    ...(room === undefined ? {} : { room }),
    ...(values.has("output") ? { output: values.get("output")! } : {}),
  };
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index]!;
}

function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    minimum: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    maximum: sorted.at(-1) ?? 0,
    average: sorted.length === 0 ? 0 : sum / sorted.length,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class BenchmarkClient {
  readonly ackRttMs: number[] = [];
  readonly acceptedToArrivalMs: number[] = [];
  replayEventCount = 0;
  replayFirstMs: number | undefined;
  replayCompleteMs = 0;
  recoverySource: "event-log" | "snapshot" = "event-log";
  snapshotOfferMs: number | undefined;
  snapshotFetchCompleteMs: number | undefined;
  snapshotBaseRoomSeq: number | undefined;
  snapshotObjectBytes: number | undefined;
  readyRoomSeq = 0;
  encodedBytes = 0;
  readonly ackTimeline: Array<{ at: number; rttMs: number }> = [];

  readonly #socket: WebSocket;
  readonly #connectionId: string;
  readonly #messages: ServerMessage[] = [];
  readonly #waiters: Array<(message: ServerMessage) => void> = [];
  readonly #connectedAt = performance.now();
  readonly #pipelinePending = new Map<
    number,
    { startedAt: number }
  >();
  #pipelineError: Error | undefined;
  #pipelineMode = false;

  private constructor(socket: WebSocket, connectionId: string) {
    this.#socket = socket;
    this.#connectionId = connectionId;
    socket.on("message", (data) => {
      const arrivedAt = performance.now();
      const message = decodeServerMessage(rawDataToBytes(data));
      if (message.type === "accepted") {
        this.acceptedToArrivalMs.push(Date.now() - message.acceptedAt);
        if (
          message.connectionId === this.#connectionId
          && "clientSeq" in message.event
        ) {
          const pending = this.#pipelinePending.get(message.event.clientSeq);
          if (pending) {
            const rttMs = performance.now() - pending.startedAt;
            this.ackRttMs.push(rttMs);
            this.ackTimeline.push({ at: Date.now(), rttMs });
            this.#pipelinePending.delete(message.event.clientSeq);
          }
        }
      } else if (message.type === "replay") {
        this.replayFirstMs ??= arrivedAt - this.#connectedAt;
        this.replayEventCount += message.events.length;
      }
      if (
        message.type === "reject"
        && message.clientSeq !== undefined
        && this.#pipelinePending.has(message.clientSeq)
      ) {
        this.#pipelineError = new Error(
          `event ${message.clientSeq} rejected: ${message.code} ${message.message}`,
        );
        this.#pipelinePending.delete(message.clientSeq);
      }
      if (
        this.#pipelineMode
        && (message.type === "accepted" || message.type === "reject")
      ) {
        return;
      }
      const waiter = this.#waiters.shift();
      if (waiter) waiter(message);
      else this.#messages.push(message);
    });
  }

  static async connect(
    url: URL,
    origin: string,
    ticketConnectionId?: string,
    recoveryMode: Options["recoveryMode"] = "event-log",
  ): Promise<BenchmarkClient> {
    const connectionId = ticketConnectionId
      ?? url.searchParams.get("connection")
      ?? `ticket_${crypto.randomUUID()}`;
    const socket = new WebSocket(url, { origin, perMessageDeflate: false });
    const client = new BenchmarkClient(socket, connectionId);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("error", rejectOpen);
    });
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- protocol order is sequential.
      const message = await client.nextMessage();
      if (message.type === "reject") {
        throw new Error(`connection rejected: ${message.code} ${message.message}`);
      }
      if (message.type === "snapshot") {
        if (recoveryMode !== "snapshot-required") {
          throw new Error("unexpected snapshot offer in event-log mode");
        }
        client.recoverySource = "snapshot";
        client.snapshotOfferMs = performance.now() - client.#connectedAt;
        client.snapshotObjectBytes = message.manifest.objectBytes;
        const fetchWithOrigin: typeof fetch = (input, init = {}) => {
          const headers = new Headers(init.headers);
          headers.set("Origin", origin);
          return fetch(input, { ...init, headers });
        };
        // oxlint-disable-next-line no-await-in-loop -- protocol order requires snapshot verification before tail/ready.
        const verified = await fetchVerifiedSnapshot(
          message as SnapshotOfferMessage,
          url.origin,
          fetchWithOrigin,
        );
        client.snapshotBaseRoomSeq = verified.baseRoomSeq;
        client.snapshotFetchCompleteMs =
          performance.now() - client.#connectedAt;
      }
      if (message.type === "ready") {
        if (
          recoveryMode === "snapshot-required"
          && client.recoverySource !== "snapshot"
        ) {
          throw new Error("snapshot-required connection received no snapshot");
        }
        client.readyRoomSeq = message.roomSeq;
        client.replayCompleteMs = performance.now() - client.#connectedAt;
        return client;
      }
    }
  }

  async sendAndWaitForAck(event: ClientStrokeEvent): Promise<void> {
    const frame = encodeEvent(event, "messagepack");
    this.encodedBytes += frame.byteLength;
    const startedAt = performance.now();
    this.#socket.send(frame);
    while (true) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- ack order is sequential.
      const message = await this.nextMessage();
      if (
        message.type === "reject"
        && message.clientSeq === event.clientSeq
      ) {
        throw new Error(
          `event ${event.clientSeq} rejected: ${message.code} ${message.message}`,
        );
      }
      if (
        message.type === "accepted"
        && message.connectionId === this.#connectionId
        && "clientSeq" in message.event
        && message.event.clientSeq === event.clientSeq
      ) {
        this.ackRttMs.push(performance.now() - startedAt);
        this.ackTimeline.push({
          at: Date.now(),
          rttMs: this.ackRttMs.at(-1)!,
        });
        return;
      }
    }
  }

  sendPipelined(event: ClientStrokeEvent): void {
    if (this.#pipelineError) throw this.#pipelineError;
    this.#pipelineMode = true;
    const frame = encodeEvent(event, "messagepack");
    this.encodedBytes += frame.byteLength;
    this.#pipelinePending.set(event.clientSeq, {
      startedAt: performance.now(),
    });
    this.#socket.send(frame);
  }

  async waitForPipelineAcks(timeoutMs = 30_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (this.#pipelinePending.size > 0) {
      if (this.#pipelineError) throw this.#pipelineError;
      if (performance.now() >= deadline) {
        throw new Error(
          `timed out waiting for ${this.#pipelinePending.size} acknowledgements`,
        );
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- polling is bounded by timeout.
      await wait(10);
    }
    if (this.#pipelineError) throw this.#pipelineError;
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolveClose) => {
      const timeout = setTimeout(() => {
        this.#socket.terminate();
        resolveClose();
      }, 1_000);
      this.#socket.once("close", () => {
        clearTimeout(timeout);
        resolveClose();
      });
      this.#socket.close(1000, "benchmark complete");
    });
  }

  private nextMessage(): Promise<ServerMessage> {
    const message = this.#messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolveMessage) => this.#waiters.push(resolveMessage));
  }
}

async function benchmarkConnection(
  options: Options,
  input: {
    roomId: string;
    actor: string;
    connectionId: string;
    lastRoomSeq: number;
    role: "participant" | "viewer";
  },
): Promise<BenchmarkClient> {
  if (options.publicSlug && options.webOrigin) {
    const response = await fetch(
      `${options.webOrigin}/api/rooms/${options.publicSlug}/tickets`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: options.webOrigin,
        },
        body: JSON.stringify({ role: input.role }),
      },
    );
    if (!response.ok) {
      throw new Error(`room ticket request failed: ${response.status}`);
    }
    const ticket: unknown = await response.json();
    if (
      typeof ticket !== "object"
      || ticket === null
      || !("ticket" in ticket)
      || typeof ticket.ticket !== "string"
      || !/^[a-f0-9]{64}$/.test(ticket.ticket)
      || !("connectionId" in ticket)
      || typeof ticket.connectionId !== "string"
      || !/^[A-Za-z0-9_-]{8,128}$/.test(ticket.connectionId)
    ) {
      throw new TypeError("room ticket response is invalid");
    }
    const url = new URL(`/rooms/${options.publicSlug}/connect`, options.endpoint);
    url.searchParams.set("ticket", ticket.ticket);
    url.searchParams.set("lastRoomSeq", String(input.lastRoomSeq));
    if (options.recoveryMode === "snapshot-required") {
      url.searchParams.set(
        "rendererVersion",
        String(SNAPSHOT_RENDERER_VERSION),
      );
      url.searchParams.set("snapshot", "1");
    }
    return BenchmarkClient.connect(
      url,
      options.origin,
      ticket.connectionId,
      options.recoveryMode,
    );
  }
  const url = new URL(`/rooms/${input.roomId}/connect`, options.endpoint);
  url.searchParams.set("actor", input.actor);
  url.searchParams.set("connection", input.connectionId);
  url.searchParams.set("lastRoomSeq", String(input.lastRoomSeq));
  url.searchParams.set("role", input.role);
  if (options.recoveryMode === "snapshot-required") {
    url.searchParams.set("rendererVersion", String(SNAPSHOT_RENDERER_VERSION));
    url.searchParams.set("snapshot", "1");
  }
  return BenchmarkClient.connect(
    url,
    options.origin,
    undefined,
    options.recoveryMode,
  );
}

function createEvents(
  runId: string,
  actorIndex: number,
  count: number,
  pointsPerAppend: number,
): ClientStrokeEvent[] {
  const events: ClientStrokeEvent[] = [];
  let clientSeq = 1;
  const strokeCount = Math.floor(count / 3);
  for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
    const id = `stroke_bench_${runId}_${String(actorIndex).padStart(3, "0")}_${String(
      strokeIndex,
    ).padStart(12, "0")}`;
    const x = 20 + (strokeIndex % 90) * 10;
    const y = 20 + ((strokeIndex * 7) % 60) * 10;
    events.push({
      v: 1,
      op: "stroke.begin",
      clientSeq: clientSeq++,
      id,
      tool: "brush",
      color: "#336699",
      size: 8,
      opacity: 0.7,
      point: [x, y, 0],
    });
    events.push({
      v: 1,
      op: "stroke.append",
      clientSeq: clientSeq++,
      id,
      points: Array.from({ length: pointsPerAppend }, (_, pointIndex) => [
        Math.min(960, x + pointIndex + 1),
        Math.min(640, y + pointIndex + 1),
        (pointIndex + 1) * 4,
      ]),
    });
    events.push({
      v: 1,
      op: "stroke.end",
      clientSeq: clientSeq++,
      id,
    });
  }
  return events;
}

function summarizeTimeline(
  samples: readonly { at: number; rttMs: number }[],
): Array<{ startedAt: number; ackRttMs: Summary }> {
  const buckets = new Map<number, number[]>();
  for (const sample of samples) {
    const startedAt = Math.floor(sample.at / 1_000) * 1_000;
    const values = buckets.get(startedAt) ?? [];
    values.push(sample.rttMs);
    buckets.set(startedAt, values);
  }
  return Array.from(buckets, ([startedAt, values]) => ({
    startedAt,
    ackRttMs: summarize(values),
  })).sort((left, right) => left.startedAt - right.startedAt);
}

async function waitForBroadcastDeliveries(
  clients: readonly BenchmarkClient[],
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (
    clients.reduce(
      (total, client) => total + client.acceptedToArrivalMs.length,
      0,
    ) < expected
  ) {
    if (performance.now() >= deadline) return;
    // oxlint-disable-next-line no-await-in-loop -- bounded delivery polling.
    await wait(10);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const roomId = options.room ?? `room_benchmark_${Date.now()}`;
  const runId = Date.now().toString(36);
  const perConnection =
    Math.floor(options.events / options.activeConnections / 3) * 3;
  if (perConnection < 3) {
    throw new RangeError("events must provide at least one complete stroke per connection");
  }
  const actualEventCount = perConnection * options.activeConnections;
  const clients = await Promise.all(
    Array.from({ length: options.connections }, (_, index) =>
      benchmarkConnection(options, {
        roomId,
        actor: `actor_benchmark_${String(index).padStart(3, "0")}`,
        connectionId:
          `connection_benchmark_${String(index).padStart(3, "0")}_${Date.now()}`,
        lastRoomSeq: 0,
        role: index < options.activeConnections ? "participant" : "viewer",
      })
    ),
  );
  const roomSeqBefore = Math.max(
    ...clients.map((client) => client.readyRoomSeq),
  );

  const startedAt = performance.now();
  const startedEpochMs = Date.now();
  await Promise.all(clients.slice(0, options.activeConnections).map(
    async (client, index) => {
    const events = createEvents(
      runId,
      index,
      perConnection,
      options.pointsPerAppend,
    );
    const intervalMs = 1_000 / options.rate;
    let nextSendAt = performance.now();
    for (const event of events) {
      const remaining = nextSendAt - performance.now();
      // oxlint-disable-next-line eslint/no-await-in-loop -- pacing is intentional.
      if (remaining > 0) await wait(remaining);
      if (options.pipeline) {
        client.sendPipelined(event);
      } else {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each client preserves clientSeq.
        await client.sendAndWaitForAck(event);
      }
      nextSendAt += intervalMs;
    }
    if (options.pipeline) {
      await client.waitForPipelineAcks(options.ackTimeoutMs);
    }
    },
  ));
  const sendDurationMs = performance.now() - startedAt;
  const completedEpochMs = Date.now();
  const ackRttMs = clients.flatMap((client) => client.ackRttMs);
  const encodedBytes = clients.reduce(
    (total, client) => total + client.encodedBytes,
    0,
  );
  const expectedBroadcastDeliveries = actualEventCount * options.connections;
  await waitForBroadcastDeliveries(
    clients,
    expectedBroadcastDeliveries,
    options.ackTimeoutMs,
  );
  const acceptedToArrivalMs = clients.flatMap(
    (client) => client.acceptedToArrivalMs,
  );
  const ackTimeline = summarizeTimeline(
    clients.flatMap((client) => client.ackTimeline),
  );
  await Promise.all(clients.map((client) => client.close()));

  const recoveryClients = options.replay
    ? await Promise.all(Array.from(
        { length: options.coldRecoveryConnections },
        (_, index) => benchmarkConnection(options, {
          roomId,
          actor: `actor_benchmark_replay_${String(index).padStart(3, "0")}`,
          connectionId:
            `connection_benchmark_replay_${String(index).padStart(3, "0")}_${Date.now()}`,
          lastRoomSeq: 0,
          role: "viewer",
        }),
      ))
    : [];
  await Promise.all(recoveryClients.map((client) => client.close()));

  const result = {
    schema: "koge.realtime-benchmark.v2",
    recordedAt: new Date().toISOString(),
    input: {
      endpoint: options.endpoint,
      origin: options.origin,
      ...(options.webOrigin ? { webOrigin: options.webOrigin } : {}),
      ...(options.publicSlug ? { publicSlug: options.publicSlug } : {}),
      requestedEvents: options.events,
      connections: options.connections,
      activeConnections: options.activeConnections,
      observerConnections: options.connections - options.activeConnections,
      coldRecoveryConnections: options.replay
        ? options.coldRecoveryConnections
        : 0,
      targetEventsPerSecondPerConnection: options.rate,
      pointsPerAppend: options.pointsPerAppend,
      ackTimeoutMs: options.ackTimeoutMs,
      pipeline: options.pipeline,
      replay: options.replay,
      recoveryMode: options.recoveryMode,
    },
    roomId,
    startedEpochMs,
    completedEpochMs,
    actualEventCount,
    roomSeqBefore,
    roomSeqAfter: roomSeqBefore + actualEventCount,
    encodedBytes,
    sendDurationMs,
    effectiveEventsPerSecond: actualEventCount / (sendDurationMs / 1_000),
    ackRttMs: summarize(ackRttMs),
    ackTimeline,
    acceptedToArrivalMs: summarize(acceptedToArrivalMs),
    broadcastDeliveries: {
      expected: expectedBroadcastDeliveries,
      observed: acceptedToArrivalMs.length,
      missing: expectedBroadcastDeliveries - acceptedToArrivalMs.length,
    },
    replay: {
      connections: recoveryClients.length,
      eventCountMismatch: recoveryClients.filter((client) => (
        client.replayEventCount !== (
          roomSeqBefore
          + actualEventCount
          - (client.snapshotBaseRoomSeq ?? 0)
        )
      )).length,
      connectionResults: recoveryClients.map((client) => ({
        source: client.recoverySource,
        snapshotBaseRoomSeq: client.snapshotBaseRoomSeq ?? 0,
        replayEventCount: client.replayEventCount,
        expectedReplayEventCount:
          roomSeqBefore
          + actualEventCount
          - (client.snapshotBaseRoomSeq ?? 0),
        snapshotOfferMs: client.snapshotOfferMs ?? 0,
        snapshotFetchCompleteMs: client.snapshotFetchCompleteMs ?? 0,
        replayFirstMs: client.replayFirstMs ?? 0,
        readyMs: client.replayCompleteMs,
      })),
      sourceCounts: {
        snapshot: recoveryClients.filter(
          (client) => client.recoverySource === "snapshot",
        ).length,
        eventLog: recoveryClients.filter(
          (client) => client.recoverySource === "event-log",
        ).length,
      },
      snapshotBaseRoomSeq: summarize(
        recoveryClients.flatMap((client) => (
          client.snapshotBaseRoomSeq === undefined
            ? []
            : [client.snapshotBaseRoomSeq]
        )),
      ),
      snapshotObjectBytes: summarize(
        recoveryClients.flatMap((client) => (
          client.snapshotObjectBytes === undefined
            ? []
            : [client.snapshotObjectBytes]
        )),
      ),
      snapshotOfferMs: summarize(
        recoveryClients.flatMap((client) => (
          client.snapshotOfferMs === undefined ? [] : [client.snapshotOfferMs]
        )),
      ),
      snapshotFetchCompleteMs: summarize(
        recoveryClients.flatMap((client) => (
          client.snapshotFetchCompleteMs === undefined
            ? []
            : [client.snapshotFetchCompleteMs]
        )),
      ),
      eventCountPerConnection: summarize(
        recoveryClients.map((client) => client.replayEventCount),
      ),
      firstFrameMs: summarize(
        recoveryClients.map((client) => client.replayFirstMs ?? 0),
      ),
      completeMs: summarize(
        recoveryClients.map((client) => client.replayCompleteMs),
      ),
    },
    notes: [
      "acceptedToArrivalMs includes server/client wall-clock skew",
      "events are complete begin/append/end strokes",
      "observer connections receive broadcasts but do not send drawing events",
      "cold recovery connections start concurrently after active clients close",
      "ackTimeline uses one-second client wall-clock buckets",
    ],
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    const output = resolvePath(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

await main();
