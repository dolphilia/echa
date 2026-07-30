import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  SNAPSHOT_JOB_VERSION,
  SNAPSHOT_CANVAS_GENERATION,
  SNAPSHOT_RENDERER_VERSION,
  type AcceptedStrokeEvent,
  type SnapshotCommitResult,
  type SnapshotEventChunk,
  type SnapshotJob,
  type SnapshotManifest,
  type SnapshotRoomRpc,
} from "@koge/protocol";
import {
  instantiateRenderer,
  renderFixture,
  type RendererFixture,
} from "@koge/renderer-core";
import { env, exports } from "cloudflare:workers";
import rendererModule from "../../../packages/renderer-core/dist/koge-renderer.wasm";
import { processSnapshotJob } from "../src/processor";
import { decodeSnapshot } from "../src/snapshot-codec";
import { describe, expect, it } from "vitest";

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

function emptySnapshotJob(suffix: string): SnapshotJob {
  return {
    v: SNAPSHOT_JOB_VERSION,
    jobId: `snapshot-job-${suffix}`,
    roomId: `room-snapshot-${suffix}`,
    targetRoomSeq: 0,
    protocolVersion: PROTOCOL_VERSION,
    rendererVersion: SNAPSHOT_RENDERER_VERSION,
    canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
    generation: 1,
    requestedAt: Date.now(),
  };
}

function emptySnapshotRoom(
  job: SnapshotJob,
  commitSnapshot: SnapshotRoomRpc["commitSnapshot"],
): SnapshotRoomRpc {
  return {
    snapshotSource(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
    snapshotEvents(
      _jobId: string,
      afterRoomSeq: number,
    ): Promise<SnapshotEventChunk> {
      return Promise.resolve({
        job,
        events: [],
        nextAfterRoomSeq: afterRoomSeq,
        done: true,
      });
    },
    commitSnapshot,
  };
}

describe("snapshot Worker canonical renderer", () => {
  it("matches the native/Node canonical RGBA hash", async () => {
    const response = await exports.default.fetch(
      "http://example.test/health/renderer",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "koge-snapshot",
      environment: "local",
      rendererVersion: 1,
      rgbaBytes: PROTOCOL_LIMITS.canvasWidth
        * PROTOCOL_LIMITS.canvasHeight
        * 4,
      rgbaHash: "5417cae6587907b72b02cd21756bdee55d96124452d705107767bd14fccbc31b",
    });
  });

  it("renders event chunks, stores a lossless object, and commits idempotently", async () => {
    const job = {
      v: SNAPSHOT_JOB_VERSION,
      jobId: "snapshot-job-test-00000001",
      roomId: "room-snapshot-test-00000001",
      targetRoomSeq: 3,
      protocolVersion: PROTOCOL_VERSION,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: 1,
      requestedAt: Date.now(),
    } as const satisfies SnapshotJob;
    const events: AcceptedStrokeEvent[] = [
      {
        type: "accepted",
        roomSeq: 1,
        actor: "actor-snapshot-test",
        connectionId: "connection-snapshot-test",
        acceptedAt: 1,
        event: {
          v: PROTOCOL_VERSION,
          op: "stroke.begin",
          clientSeq: 1,
          id: "stroke_snapshot_test_0001",
          tool: "brush",
          color: "#336699",
          size: 12,
          opacity: 0.35,
          point: [10, 20, 0],
        },
      },
      {
        type: "accepted",
        roomSeq: 2,
        actor: "actor-snapshot-test",
        connectionId: "connection-snapshot-test",
        acceptedAt: 2,
        event: {
          v: PROTOCOL_VERSION,
          op: "stroke.append",
          clientSeq: 2,
          id: "stroke_snapshot_test_0001",
          points: [[20, 30, 50], [30, 40, 100]],
        },
      },
      {
        type: "accepted",
        roomSeq: 3,
        actor: "actor-snapshot-test",
        connectionId: "connection-snapshot-test",
        acceptedAt: 3,
        event: {
          v: PROTOCOL_VERSION,
          op: "stroke.end",
          clientSeq: 3,
          id: "stroke_snapshot_test_0001",
        },
      },
    ];
    let committed: SnapshotManifest | undefined;
    const room: SnapshotRoomRpc = {
      async snapshotSource() {
        return undefined;
      },
      async snapshotEvents(
        _jobId: string,
        afterRoomSeq: number,
        limit = 500,
      ): Promise<SnapshotEventChunk> {
        const chunkEvents = events
          .filter((event) => event.roomSeq > afterRoomSeq)
          .slice(0, limit);
        const nextAfterRoomSeq =
          chunkEvents.at(-1)?.roomSeq ?? afterRoomSeq;
        return {
          job,
          events: chunkEvents,
          nextAfterRoomSeq,
          done: nextAfterRoomSeq === job.targetRoomSeq,
        };
      },
      async commitSnapshot(
        manifest: SnapshotManifest,
      ): Promise<SnapshotCommitResult> {
        if (committed) {
          return { status: "already_committed", manifest: committed };
        }
        committed = manifest;
        return { status: "committed", manifest };
      },
    };
    const renderer = await instantiateRenderer(rendererModule);
    const first = await processSnapshotJob(
      job,
      room,
      env.RUNTIME_SNAPSHOTS,
      renderer,
    );
    expect(first.commit.status).toBe("committed");
    expect(first.manifest.objectBytes).toBeLessThan(
      PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4,
    );

    const object = await env.RUNTIME_SNAPSHOTS.get(first.manifest.objectKey);
    expect(object).not.toBeNull();
    const decoded = await decodeSnapshot(
      new Uint8Array(await object!.arrayBuffer()),
    );
    expect(decoded).toMatchObject({
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
    });
    const fixture = {
      canvas: {
        width: PROTOCOL_LIMITS.canvasWidth,
        height: PROTOCOL_LIMITS.canvasHeight,
      },
      strokes: [{
        tool: "brush",
        color: "#336699",
        size: 12,
        opacity: 0.35,
        points: [
          { x: 10, y: 20, dt: 0 },
          { x: 20, y: 30, dt: 50 },
          { x: 30, y: 40, dt: 100 },
        ],
      }],
    } as const satisfies RendererFixture;
    expect(await hash(decoded.rgba)).toBe(
      await hash(renderFixture(renderer, fixture)),
    );
    expect(await hash(decoded.rgba)).toBe(first.manifest.rgbaHash);

    const duplicate = await processSnapshotJob(
      job,
      room,
      env.RUNTIME_SNAPSHOTS,
      renderer,
    );
    expect(duplicate.commit.status).toBe("already_committed");
    expect(duplicate.manifest.objectHash).toBe(first.manifest.objectHash);

    const incrementalJob = {
      ...job,
      jobId: "snapshot-job-test-00000002",
      targetRoomSeq: 6,
      generation: 2,
      requestedAt: Date.now() + 1,
      sourceSnapshotJobId: first.manifest.jobId,
      sourceBaseRoomSeq: first.manifest.baseRoomSeq,
    } as const satisfies SnapshotJob;
    const tailEvents: AcceptedStrokeEvent[] = [
      {
        type: "accepted",
        roomSeq: 4,
        actor: "actor-snapshot-test",
        connectionId: "connection-snapshot-test",
        acceptedAt: 4,
        event: {
          v: PROTOCOL_VERSION,
          op: "stroke.begin",
          clientSeq: 4,
          id: "stroke_snapshot_test_0002",
          tool: "eraser",
          color: "#000000",
          size: 8,
          opacity: 0.75,
          point: [25, 35, 0],
        },
      },
      {
        type: "accepted",
        roomSeq: 5,
        actor: "actor-snapshot-test",
        connectionId: "connection-snapshot-test",
        acceptedAt: 5,
        event: {
          v: PROTOCOL_VERSION,
          op: "stroke.append",
          clientSeq: 5,
          id: "stroke_snapshot_test_0002",
          points: [[35, 45, 50]],
        },
      },
      {
        type: "accepted",
        roomSeq: 6,
        actor: "actor-snapshot-test",
        connectionId: "connection-snapshot-test",
        acceptedAt: 6,
        event: {
          v: PROTOCOL_VERSION,
          op: "stroke.end",
          clientSeq: 6,
          id: "stroke_snapshot_test_0002",
        },
      },
    ];
    const requestedCursors: number[] = [];
    const incrementalRoom: SnapshotRoomRpc = {
      async snapshotSource() {
        return first.manifest;
      },
      async snapshotEvents(_jobId, afterRoomSeq, limit = 500) {
        requestedCursors.push(afterRoomSeq);
        const chunkEvents = tailEvents
          .filter((event) => event.roomSeq > afterRoomSeq)
          .slice(0, limit);
        const nextAfterRoomSeq =
          chunkEvents.at(-1)?.roomSeq ?? afterRoomSeq;
        return {
          job: incrementalJob,
          events: chunkEvents,
          nextAfterRoomSeq,
          done: nextAfterRoomSeq === incrementalJob.targetRoomSeq,
        };
      },
      async commitSnapshot(manifest) {
        return { status: "committed", manifest };
      },
    };
    const incremental = await processSnapshotJob(
      incrementalJob,
      incrementalRoom,
      env.RUNTIME_SNAPSHOTS,
      renderer,
    );
    expect(requestedCursors[0]).toBe(3);
    const incrementalObject = await env.RUNTIME_SNAPSHOTS.get(
      incremental.manifest.objectKey,
    );
    const incrementalDecoded = await decodeSnapshot(
      await incrementalObject!.bytes(),
    );
    const fullFixture = {
      canvas: fixture.canvas,
      strokes: [
        ...fixture.strokes,
        {
          tool: "eraser",
          color: "#000000",
          size: 8,
          opacity: 0.75,
          points: [
            { x: 25, y: 35, dt: 0 },
            { x: 35, y: 45, dt: 50 },
          ],
        },
      ],
    } as const satisfies RendererFixture;
    expect(await hash(incrementalDecoded.rgba)).toBe(
      await hash(renderFixture(renderer, fullFixture)),
    );
    expect(await hash(incrementalDecoded.rgba)).toBe(
      incremental.manifest.rgbaHash,
    );
  });

  it("resumes the same job after manifest commit fails", async () => {
    const job = emptySnapshotJob("commit-retry-0001");
    let commitAttempts = 0;
    const room = emptySnapshotRoom(job, async (manifest) => {
      commitAttempts += 1;
      if (commitAttempts === 1) {
        throw new Error("injected manifest commit failure");
      }
      return { status: "committed", manifest };
    });
    const renderer = await instantiateRenderer(rendererModule);

    await expect(processSnapshotJob(
      job,
      room,
      env.RUNTIME_SNAPSHOTS,
      renderer,
    )).rejects.toThrow("injected manifest commit failure");
    const objectKey =
      `rooms/${job.roomId}/snapshots/staging/${job.jobId}.kgs`;
    expect(await env.RUNTIME_SNAPSHOTS.head(objectKey)).not.toBeNull();

    const retried = await processSnapshotJob(
      job,
      room,
      env.RUNTIME_SNAPSHOTS,
      renderer,
    );
    expect(retried.commit.status).toBe("committed");
    expect(commitAttempts).toBe(2);
    expect(await env.RUNTIME_SNAPSHOTS.head(objectKey)).not.toBeNull();
  });

  it("rejects a missing incremental source before reading tail events", async () => {
    const job = {
      ...emptySnapshotJob("missing-source-0001"),
      targetRoomSeq: 1,
      generation: 2,
      sourceSnapshotJobId: "snapshot-job-missing-source",
      sourceBaseRoomSeq: 0,
    } satisfies SnapshotJob;
    const source = {
      v: SNAPSHOT_JOB_VERSION,
      jobId: job.sourceSnapshotJobId,
      roomId: job.roomId,
      baseRoomSeq: 0,
      protocolVersion: PROTOCOL_VERSION,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: 1,
      codec: "koge-rgba-deflate-v1",
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectKey: `rooms/${job.roomId}/snapshots/staging/${job.sourceSnapshotJobId}.kgs`,
      objectBytes: 24,
      objectHash: "1".repeat(64),
      rgbaHash: "2".repeat(64),
      createdAt: Date.now(),
    } as const satisfies SnapshotManifest;
    let eventsCalled = false;
    let commitCalled = false;
    const room: SnapshotRoomRpc = {
      async snapshotSource() {
        return source;
      },
      async snapshotEvents() {
        eventsCalled = true;
        throw new Error("tail events should not be read");
      },
      async commitSnapshot() {
        commitCalled = true;
        throw new Error("manifest should not be committed");
      },
    };
    const renderer = await instantiateRenderer(rendererModule);

    await expect(processSnapshotJob(
      job,
      room,
      env.RUNTIME_SNAPSHOTS,
      renderer,
    )).rejects.toThrow(
      "incremental snapshot source object is unavailable or inconsistent",
    );
    expect(eventsCalled).toBe(false);
    expect(commitCalled).toBe(false);
  });

  it("deletes a staging object when a newer snapshot supersedes the job", async () => {
    const job = emptySnapshotJob("superseded-0001");
    const room = emptySnapshotRoom(
      job,
      async () => ({ status: "superseded" }),
    );
    const renderer = await instantiateRenderer(rendererModule);

    const result = await processSnapshotJob(
      job,
      room,
      env.RUNTIME_SNAPSHOTS,
      renderer,
    );

    expect(result.commit.status).toBe("superseded");
    expect(await env.RUNTIME_SNAPSHOTS.head(
      result.manifest.objectKey,
    )).toBeNull();
  });

  it("rejects a conflicting R2 staging object before manifest commit", async () => {
    const job = emptySnapshotJob("r2-conflict-0001");
    const objectKey =
      `rooms/${job.roomId}/snapshots/staging/${job.jobId}.kgs`;
    await env.RUNTIME_SNAPSHOTS.put(objectKey, new Uint8Array([1, 2, 3]), {
      customMetadata: {
        objectHash: "conflicting",
        rgbaHash: "conflicting",
      },
    });
    let commitCalled = false;
    const room = emptySnapshotRoom(job, async (manifest) => {
      commitCalled = true;
      return { status: "committed", manifest };
    });
    const renderer = await instantiateRenderer(rendererModule);

    await expect(processSnapshotJob(
      job,
      room,
      env.RUNTIME_SNAPSHOTS,
      renderer,
    )).rejects.toThrow(
      "snapshot staging object conflicts with existing data",
    );
    expect(commitCalled).toBe(false);
  });
});
