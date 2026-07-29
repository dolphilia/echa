import {
  instantiateRenderer,
  renderFixture,
  type RendererFixture,
} from "@koge/renderer-core";
import {
  SNAPSHOT_JOB_VERSION,
  type AcceptedStrokeEvent,
  type Point,
  type SnapshotJob,
  type SnapshotJobDisposition,
  type SnapshotRoomRpc,
} from "@koge/protocol";
import type { DurableObject as DurableObjectBase } from "cloudflare:workers";
import rendererModule from "../../../packages/renderer-core/dist/koge-renderer.wasm";
import canonicalFixture from "../../../tools/renderer-fixtures/v1/canonical-strokes.json";
import canonicalManifest from "../../../tools/renderer-fixtures/v1/manifest.json";
import { processSnapshotJob } from "./processor";

const renderer = await instantiateRenderer(rendererModule);
type SnapshotRoomTarget = DurableObjectBase<Env> & SnapshotRoomRpc & {
  snapshotJobDisposition(jobId: string): Promise<SnapshotJobDisposition>;
};

function isSnapshotJob(value: unknown): value is SnapshotJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.v === SNAPSHOT_JOB_VERSION
    && typeof record.jobId === "string"
    && typeof record.roomId === "string"
    && typeof record.targetRoomSeq === "number"
    && record.protocolVersion === 1
    && record.rendererVersion === 1
    && record.canvasGeneration === 1
    && typeof record.generation === "number"
    && typeof record.requestedAt === "number"
    && (
      record.sourceSnapshotJobId === undefined
      || typeof record.sourceSnapshotJobId === "string"
    )
    && (
      record.sourceBaseRoomSeq === undefined
      || typeof record.sourceBaseRoomSeq === "number"
    )
  );
}

function normalizePoint(value: readonly number[]): Point {
  if (
    value.length !== 3
    || value.some((item) => !Number.isFinite(item))
  ) {
    throw new TypeError("invalid point returned by snapshot RPC");
  }
  return [value[0]!, value[1]!, value[2]!];
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/health/renderer") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const startedAt = Date.now();
    const rgba = renderFixture(renderer, canonicalFixture as RendererFixture);
    const rgbaHash = await sha256(rgba);
    const ok = (
      renderer.exports.renderer_version() === canonicalManifest.rendererVersion
      && rgbaHash === canonicalManifest.rgbaHash
    );
    return Response.json({
      ok,
      service: "koge-snapshot",
      environment: env.APP_ENV,
      rendererVersion: renderer.exports.renderer_version(),
      rgbaBytes: rgba.byteLength,
      rgbaHash,
      renderWallMs: Date.now() - startedAt,
    }, { status: ok ? 200 : 500 });
  },
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const job: unknown = message.body;
        if (!isSnapshotJob(job)) {
          throw new TypeError("unsupported snapshot job version");
        }
        const rooms = env.DRAWING_ROOM as DurableObjectNamespace<SnapshotRoomTarget>;
        const stub = rooms.getByName(job.roomId);
        // oxlint-disable-next-line no-await-in-loop -- disposition must be fixed before processing each queued message.
        const disposition = await stub.snapshotJobDisposition(job.jobId);
        if (disposition === "discard") {
          message.ack();
          continue;
        }
        const room: SnapshotRoomRpc = {
          async snapshotSource(jobId) {
            const manifest = await stub.snapshotSource(jobId);
            return manifest ? { ...manifest } : undefined;
          },
          async snapshotEvents(jobId, afterRoomSeq, limit) {
            const chunk = await stub.snapshotEvents(jobId, afterRoomSeq, limit);
            const events: AcceptedStrokeEvent[] = chunk.events.map((accepted) => {
              const event = accepted.event;
              if (event.op === "stroke.begin") {
                return {
                  ...accepted,
                  event: { ...event, point: normalizePoint(event.point) },
                };
              }
              if (event.op === "stroke.append") {
                return {
                  ...accepted,
                  event: {
                    ...event,
                    points: event.points.map(normalizePoint),
                  },
                };
              }
              return { ...accepted, event: { ...event } };
            });
            return {
              job: { ...chunk.job },
              events,
              nextAfterRoomSeq: chunk.nextAfterRoomSeq,
              done: chunk.done,
            };
          },
          async commitSnapshot(manifest) {
            const result = await stub.commitSnapshot(manifest);
            return {
              status: result.status,
              ...(result.manifest
                ? { manifest: { ...result.manifest } }
                : {}),
            };
          },
        };
        const startedAt = Date.now();
        // oxlint-disable-next-line eslint/no-await-in-loop -- each message is acked after its side effects commit.
        const result = await processSnapshotJob(
          job,
          room,
          env.RUNTIME_SNAPSHOTS,
          renderer,
        );
        console.log(JSON.stringify({
          level: "info",
          message: "snapshot job completed",
          jobId: job.jobId,
          roomId: job.roomId,
          generation: job.generation,
          targetRoomSeq: job.targetRoomSeq,
          sourceBaseRoomSeq: result.metrics.sourceBaseRoomSeq,
          replayedEventCount: result.metrics.replayedEventCount,
          replayedPointCount: result.metrics.replayedPointCount,
          completedStrokeCount: result.metrics.completedStrokeCount,
          eventChunkCount: result.metrics.eventChunkCount,
          sourceObjectBytes: result.metrics.sourceObjectBytes,
          outputObjectBytes: result.manifest.objectBytes,
          commitStatus: result.commit.status,
          queueDelayMs: Math.max(0, startedAt - job.requestedAt),
          observedWallMs: Math.max(0, Date.now() - startedAt),
        }));
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "snapshot job failed",
          error: error instanceof Error ? error.message : String(error),
          messageId: message.id,
        }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
