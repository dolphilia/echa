import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  SNAPSHOT_CANVAS_GENERATION,
  SNAPSHOT_CODEC,
  SNAPSHOT_EVENT_CHUNK_LIMIT,
  SNAPSHOT_JOB_VERSION,
  SNAPSHOT_RENDERER_VERSION,
  decodeSnapshot,
  encodeSnapshot,
  type AcceptedStrokeEvent,
  type SnapshotCommitResult,
  type SnapshotJob,
  type SnapshotManifest,
  type SnapshotRoomRpc,
} from "@koge/protocol";
import {
  RendererSession,
  type RendererFixture,
  type RendererInstance,
} from "@koge/renderer-core";

type MutableRendererStroke = {
  tool: "brush" | "eraser";
  color: string;
  size: number;
  opacity: number;
  points: Array<{ x: number; y: number; dt: number }>;
};

export type SnapshotProcessResult = {
  readonly commit: SnapshotCommitResult;
  readonly manifest: SnapshotManifest;
  readonly metrics: {
    readonly sourceBaseRoomSeq: number;
    readonly sourceObjectBytes: number;
    readonly replayedEventCount: number;
    readonly replayedPointCount: number;
    readonly completedStrokeCount: number;
    readonly eventChunkCount: number;
  };
};

export type SnapshotCommittedRgbaHook = (input: {
  readonly job: SnapshotJob;
  readonly manifest: SnapshotManifest;
  readonly commit: Exclude<
    SnapshotCommitResult,
    { readonly status: "superseded" }
  >;
  readonly rgba: Uint8Array;
}) => Promise<void>;

const SNAPSHOT_RGBA_BYTES =
  PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4;
const MAX_SNAPSHOT_OBJECT_BYTES = SNAPSHOT_RGBA_BYTES + 65_536;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function sourceBaseRoomSeq(job: SnapshotJob): number {
  return job.sourceBaseRoomSeq ?? 0;
}

function validateJob(job: SnapshotJob): void {
  const sourceBase = sourceBaseRoomSeq(job);
  if (
    job.v !== SNAPSHOT_JOB_VERSION
    || !IDENTIFIER_PATTERN.test(job.jobId)
    || !IDENTIFIER_PATTERN.test(job.roomId)
    || !Number.isSafeInteger(job.targetRoomSeq)
    || job.targetRoomSeq < 0
    || job.protocolVersion !== PROTOCOL_VERSION
    || job.rendererVersion !== SNAPSHOT_RENDERER_VERSION
    || job.canvasGeneration !== SNAPSHOT_CANVAS_GENERATION
    || !Number.isSafeInteger(job.generation)
    || job.generation < 1
    || !Number.isSafeInteger(job.requestedAt)
    || job.requestedAt <= 0
    || !Number.isSafeInteger(sourceBase)
    || sourceBase < 0
    || sourceBase > job.targetRoomSeq
    || (
      job.sourceSnapshotJobId !== undefined
      && (
        !IDENTIFIER_PATTERN.test(job.sourceSnapshotJobId)
        || sourceBase >= job.targetRoomSeq
      )
    )
    || (job.sourceSnapshotJobId === undefined && sourceBase !== 0)
  ) {
    throw new TypeError("invalid snapshot job");
  }
}

function applyEvents(
  events: readonly AcceptedStrokeEvent[],
  active: Map<string, MutableRendererStroke>,
  session: RendererSession,
): void {
  const completed: RendererFixture["strokes"][number][] = [];
  for (const accepted of events) {
    const event = accepted.event;
    if (event.op === "stroke.begin") {
      if (active.has(event.id)) throw new Error("duplicate active snapshot stroke");
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
      continue;
    }
    const stroke = active.get(event.id);
    if (!stroke) throw new Error("snapshot stroke lifecycle is incomplete");
    if (event.op === "stroke.append") {
      stroke.points.push(...event.points.map(([x, y, dt]) => ({ x, y, dt })));
      continue;
    }
    active.delete(event.id);
    if (event.op === "stroke.end") completed.push(stroke);
  }
  if (completed.length > 0) session.apply(completed);
}

async function sha256(bytes: Uint8Array): Promise<{
  digest: ArrayBuffer;
  hex: string;
}> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    digest,
    hex: Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0")
    ).join(""),
  };
}

function sameJob(actual: SnapshotJob, expected: SnapshotJob): boolean {
  return (
    actual.jobId === expected.jobId
    && actual.roomId === expected.roomId
    && actual.targetRoomSeq === expected.targetRoomSeq
    && actual.protocolVersion === expected.protocolVersion
    && actual.rendererVersion === expected.rendererVersion
    && actual.canvasGeneration === expected.canvasGeneration
    && actual.generation === expected.generation
    && actual.sourceSnapshotJobId === expected.sourceSnapshotJobId
    && sourceBaseRoomSeq(actual) === sourceBaseRoomSeq(expected)
  );
}

function validateSourceManifest(
  manifest: SnapshotManifest,
  job: SnapshotJob,
): void {
  if (
    manifest.v !== SNAPSHOT_JOB_VERSION
    || manifest.jobId !== job.sourceSnapshotJobId
    || manifest.roomId !== job.roomId
    || manifest.baseRoomSeq !== sourceBaseRoomSeq(job)
    || manifest.protocolVersion !== job.protocolVersion
    || manifest.rendererVersion !== job.rendererVersion
    || manifest.canvasGeneration !== job.canvasGeneration
    || !Number.isSafeInteger(manifest.generation)
    || manifest.generation < 1
    || manifest.codec !== SNAPSHOT_CODEC
    || manifest.width !== PROTOCOL_LIMITS.canvasWidth
    || manifest.height !== PROTOCOL_LIMITS.canvasHeight
    || !Number.isSafeInteger(manifest.objectBytes)
    || manifest.objectBytes <= 0
    || manifest.objectBytes > MAX_SNAPSHOT_OBJECT_BYTES
    || !manifest.objectKey.startsWith(
      `rooms/${job.roomId}/snapshots/staging/`,
    )
    || !HASH_PATTERN.test(manifest.objectHash)
    || !HASH_PATTERN.test(manifest.rgbaHash)
    || !Number.isSafeInteger(manifest.createdAt)
    || manifest.createdAt <= 0
  ) {
    throw new Error("snapshot source manifest does not match its job");
  }
}

async function loadSnapshotSource(
  job: SnapshotJob,
  room: SnapshotRoomRpc,
  bucket: R2Bucket,
  session: RendererSession,
): Promise<{ baseRoomSeq: number; objectBytes: number }> {
  const source = await room.snapshotSource(job.jobId);
  if (job.sourceSnapshotJobId === undefined) {
    if (source !== undefined) {
      throw new Error("full snapshot job unexpectedly has a source");
    }
    return { baseRoomSeq: 0, objectBytes: 0 };
  }
  if (!source) throw new Error("incremental snapshot source is unavailable");
  validateSourceManifest(source, job);

  const object = await bucket.get(source.objectKey);
  const metadata = object?.customMetadata;
  if (
    !object
    || object.size !== source.objectBytes
    || object.size > MAX_SNAPSHOT_OBJECT_BYTES
    || !metadata
    || metadata.jobId !== source.jobId
    || metadata.roomId !== source.roomId
    || metadata.baseRoomSeq !== String(source.baseRoomSeq)
    || metadata.protocolVersion !== String(source.protocolVersion)
    || metadata.rendererVersion !== String(source.rendererVersion)
    || metadata.canvasGeneration
      !== String(source.canvasGeneration)
    || metadata.generation !== String(source.generation)
    || metadata.codec !== source.codec
    || metadata.objectHash !== source.objectHash
    || metadata.rgbaHash !== source.rgbaHash
  ) {
    throw new Error("incremental snapshot source object is unavailable or inconsistent");
  }
  const objectBytes = await object.bytes();
  if ((await sha256(objectBytes)).hex !== source.objectHash) {
    throw new Error("incremental snapshot source object hash mismatch");
  }
  const decoded = await decodeSnapshot(objectBytes);
  if (
    decoded.rendererVersion !== source.rendererVersion
    || decoded.width !== source.width
    || decoded.height !== source.height
    || (await sha256(decoded.rgba)).hex !== source.rgbaHash
  ) {
    throw new Error("incremental snapshot source pixels are inconsistent");
  }
  session.loadPixels(decoded.rgba);
  return {
    baseRoomSeq: source.baseRoomSeq,
    objectBytes: source.objectBytes,
  };
}

export async function processSnapshotJob(
  job: SnapshotJob,
  room: SnapshotRoomRpc,
  bucket: R2Bucket,
  renderer: RendererInstance,
  onCommittedRgba?: SnapshotCommittedRgbaHook,
): Promise<SnapshotProcessResult> {
  validateJob(job);
  const session = new RendererSession(
    renderer,
    PROTOCOL_LIMITS.canvasWidth,
    PROTOCOL_LIMITS.canvasHeight,
  );
  try {
    const active = new Map<string, MutableRendererStroke>();
    const source = await loadSnapshotSource(job, room, bucket, session);
    let cursor = source.baseRoomSeq;
    let replayedEventCount = 0;
    let replayedPointCount = 0;
    let completedStrokeCount = 0;
    let eventChunkCount = 0;
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- ordered chunks bound memory.
      const chunk = await room.snapshotEvents(
        job.jobId,
        cursor,
        SNAPSHOT_EVENT_CHUNK_LIMIT,
      );
      if (!sameJob(chunk.job, job)) throw new Error("snapshot chunk job mismatch");
      eventChunkCount += 1;
      replayedEventCount += chunk.events.length;
      let expectedRoomSeq = cursor + 1;
      for (const event of chunk.events) {
        if (event.roomSeq !== expectedRoomSeq) {
          throw new Error("snapshot chunk room sequence gap");
        }
        expectedRoomSeq += 1;
        if (event.event.op === "stroke.begin") replayedPointCount += 1;
        if (event.event.op === "stroke.append") {
          replayedPointCount += event.event.points.length;
        }
        if (event.event.op === "stroke.end") completedStrokeCount += 1;
      }
      applyEvents(chunk.events, active, session);
      if (chunk.nextAfterRoomSeq < cursor) {
        throw new Error("snapshot cursor moved backwards");
      }
      cursor = chunk.nextAfterRoomSeq;
      if (chunk.done) break;
      if (chunk.events.length === 0) throw new Error("empty non-final snapshot chunk");
    }
    if (cursor !== job.targetRoomSeq || active.size !== 0) {
      throw new Error("snapshot target is not a completed-stroke boundary");
    }

    const rgba = session.pixels();
    const rgbaDigest = await sha256(rgba);
    const objectBytes = await encodeSnapshot(
      rgba,
      PROTOCOL_LIMITS.canvasWidth,
      PROTOCOL_LIMITS.canvasHeight,
      job.rendererVersion,
    );
    const objectDigest = await sha256(objectBytes);
    const objectKey =
      `rooms/${job.roomId}/snapshots/staging/${job.jobId}.kgs`;
    const metadata = {
      jobId: job.jobId,
      roomId: job.roomId,
      baseRoomSeq: String(job.targetRoomSeq),
      protocolVersion: String(job.protocolVersion),
      rendererVersion: String(job.rendererVersion),
      canvasGeneration: String(job.canvasGeneration),
      generation: String(job.generation),
      codec: SNAPSHOT_CODEC,
      objectHash: objectDigest.hex,
      rgbaHash: rgbaDigest.hex,
    };
    const stored = await bucket.put(objectKey, objectBytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: objectDigest.digest,
      httpMetadata: { contentType: "application/vnd.koge.snapshot" },
      customMetadata: metadata,
    });
    if (!stored) {
      const existing = await bucket.head(objectKey);
      if (
        !existing
        || existing.size !== objectBytes.byteLength
        || existing.customMetadata?.objectHash !== objectDigest.hex
        || existing.customMetadata?.rgbaHash !== rgbaDigest.hex
      ) {
        throw new Error("snapshot staging object conflicts with existing data");
      }
    }

    const manifest = {
      v: SNAPSHOT_JOB_VERSION,
      jobId: job.jobId,
      roomId: job.roomId,
      baseRoomSeq: job.targetRoomSeq,
      protocolVersion: job.protocolVersion,
      rendererVersion: job.rendererVersion,
      canvasGeneration: job.canvasGeneration,
      generation: job.generation,
      codec: SNAPSHOT_CODEC,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectKey,
      objectBytes: objectBytes.byteLength,
      objectHash: objectDigest.hex,
      rgbaHash: rgbaDigest.hex,
      createdAt: Date.now(),
    } as const satisfies SnapshotManifest;
    const commit = await room.commitSnapshot(manifest);
    if (commit.status === "superseded") {
      await bucket.delete(objectKey);
    } else if (onCommittedRgba) {
      await onCommittedRgba({ job, manifest, commit, rgba });
    }
    return {
      commit,
      manifest,
      metrics: {
        sourceBaseRoomSeq: source.baseRoomSeq,
        sourceObjectBytes: source.objectBytes,
        replayedEventCount,
        replayedPointCount,
        completedStrokeCount,
        eventChunkCount,
      },
    };
  } finally {
    session.dispose();
  }
}
