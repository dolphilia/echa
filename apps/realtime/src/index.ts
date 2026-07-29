import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  validateActiveRoomMembersRequest,
  validateRoomTicketRegistrationRequest,
  validateRoomProvisioningRequest,
  type ActiveRoomMembersResult,
  type RoomTicketRegistrationResult,
} from "@koge/protocol";
import { DrawingRoom } from "./drawing-room";
import { processModerationEvidenceJob } from "./moderation-evidence";
import {
  enqueueExpiredModerationEvidence,
  processModerationEvidenceDeleteJob,
} from "./moderation-evidence-retention";
import {
  collectRateAbuseMetrics,
  deleteExpiredRateAbuseOutcomes,
  type RateAbuseMetricsCapture,
} from "./rate-abuse-metrics";
import { processRoomCleanupJob } from "./room-cleanup";
import {
  createRoomReport,
  RoomReportNotAvailableError,
} from "./room-report";
import {
  applyRoomModerationAction,
  RoomModerationConflictError,
  RoomModerationNotAvailableError,
  RoomModerationTargetForbiddenError,
} from "./room-moderation";
import {
  createSnapshotOrphanDeletionPlan,
  deleteSnapshotOrphans,
  scanSnapshotOrphans,
  type SnapshotOrphanDeletionPlan,
  type SnapshotOrphanDeletionResult,
  type SnapshotOrphanScanResult,
} from "./snapshot-orphan-inventory";
import { deleteExpiredServiceBanAudits } from "./service-ban-retention";

type HealthStatus = {
  ok: true;
  service: "koge-realtime";
  environment: string;
  bindings: {
    d1: true;
    durableObjects: true;
    queue: true;
    r2: true;
  };
};

type SnapshotOrphanHealthRow = {
  status: "running" | "completed" | "failed";
  started_at: number;
  completed_at: number | null;
  object_count: number;
  object_bytes: number;
  orphan_count: number;
  orphan_bytes: number;
  error: string | null;
};

const app = new Hono<{ Bindings: Env }>();
const cleanupStuckAfterMs = 5 * 60 * 1_000;
const identifierPattern = /^[A-Za-z0-9_-]{8,128}$/;
const snapshotTokenPattern = /^[a-f0-9]{64}$/;
const maxExcludedSnapshotJobs = 2;
const publicRoomSlugPattern = /^[a-f0-9]{32}$/;
const roomTicketPattern = /^[a-f0-9]{64}$/;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function snapshotCorsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
}

app.get("/health", async (context) => {
  const result = await context.env.DB.prepare("SELECT 1 AS healthy").first<{
    healthy: number;
  }>();

  if (result?.healthy !== 1) {
    return context.json({ ok: false, error: "D1_UNAVAILABLE" }, 503);
  }

  const status: HealthStatus = {
    ok: true,
    service: "koge-realtime",
    environment: context.env.APP_ENV,
    bindings: {
      d1: true,
      durableObjects: true,
      queue: true,
      r2: true,
    },
  };

  return context.json(status);
});

app.get("/health/cleanup", async (context) => {
  const [cleanupQueue, cleanupDlq] = await Promise.all([
    context.env.ROOM_CLEANUP_QUEUE.metrics(),
    context.env.ROOM_CLEANUP_DLQ.metrics(),
  ]);
  let projection = {
    pendingCount: 0,
    oldestRequestedAt: null as number | null,
  };
  try {
    const row = await context.env.DB.prepare(
      `SELECT COUNT(*) AS pending_count,
              MIN(cleanup_requested_at) AS oldest_requested_at
       FROM rooms
       WHERE status = 'closing' AND cleanup_job_id IS NOT NULL`,
    ).first<{
      pending_count: number;
      oldest_requested_at: number | null;
    }>();
    projection = {
      pendingCount: row?.pending_count ?? 0,
      oldestRequestedAt: row?.oldest_requested_at ?? null,
    };
  } catch (error) {
    if (context.env.APP_ENV !== "local") throw error;
  }
  const now = Date.now();
  const stuckProjectionCount = (
    projection.oldestRequestedAt !== null
    && projection.oldestRequestedAt <= now - cleanupStuckAfterMs
  )
    ? projection.pendingCount
    : 0;
  const needsAttention = cleanupDlq.backlogCount > 0
    || stuckProjectionCount > 0;
  context.header("Cache-Control", "no-store");
  return context.json({
    ok: !needsAttention,
    service: "koge-realtime-cleanup",
    environment: context.env.APP_ENV,
    approximate: true,
    queue: {
      backlogCount: cleanupQueue.backlogCount,
      backlogBytes: cleanupQueue.backlogBytes,
      oldestMessageAt:
        cleanupQueue.oldestMessageTimestamp?.toISOString() ?? null,
    },
    dlq: {
      backlogCount: cleanupDlq.backlogCount,
      backlogBytes: cleanupDlq.backlogBytes,
      oldestMessageAt:
        cleanupDlq.oldestMessageTimestamp?.toISOString() ?? null,
    },
    projection: {
      ...projection,
      stuckAfterMs: cleanupStuckAfterMs,
      stuckCount: stuckProjectionCount,
    },
  }, needsAttention ? 503 : 200);
});

app.get("/health/evidence", async (context) => {
  const [evidenceQueue, evidenceDlq] = await Promise.all([
    context.env.MODERATION_EVIDENCE_QUEUE.metrics(),
    context.env.MODERATION_EVIDENCE_DLQ.metrics(),
  ]);
  let projection = {
    pending_count: 0,
    oldest_created_at: null as number | null,
    deletion_count: 0,
    oldest_deletion_requested_at: null as number | null,
  };
  try {
    const row = await context.env.DB.prepare(
      `SELECT COUNT(CASE
                WHEN status IN ('pending', 'failed') THEN 1
              END) AS pending_count,
              MIN(CASE
                WHEN status IN ('pending', 'failed') THEN created_at
              END) AS oldest_created_at,
              COUNT(CASE
                WHEN status = 'committed' AND deletion_job_id IS NOT NULL
                THEN 1
              END) AS deletion_count,
              MIN(CASE
                WHEN status = 'committed' AND deletion_job_id IS NOT NULL
                THEN deletion_requested_at
              END) AS oldest_deletion_requested_at
       FROM evidence_manifests
       WHERE status IN ('pending', 'failed')
          OR (status = 'committed' AND deletion_job_id IS NOT NULL)`,
    ).first<{
      pending_count: number;
      oldest_created_at: number | null;
      deletion_count: number;
      oldest_deletion_requested_at: number | null;
    }>();
    projection = {
      pending_count: row?.pending_count ?? 0,
      oldest_created_at: row?.oldest_created_at ?? null,
      deletion_count: row?.deletion_count ?? 0,
      oldest_deletion_requested_at:
        row?.oldest_deletion_requested_at ?? null,
    };
  } catch (error) {
    if (context.env.APP_ENV !== "local") throw error;
  }
  const oldestCreatedAt = projection?.oldest_created_at ?? null;
  const pendingCount = projection?.pending_count ?? 0;
  const deletionCount = projection?.deletion_count ?? 0;
  const oldestDeletionRequestedAt =
    projection?.oldest_deletion_requested_at ?? null;
  const stuckCount = (
    oldestCreatedAt !== null
    && oldestCreatedAt <= Date.now() - cleanupStuckAfterMs
  )
    ? pendingCount
    : 0;
  const stuckDeletionCount = (
    oldestDeletionRequestedAt !== null
    && oldestDeletionRequestedAt <= Date.now() - cleanupStuckAfterMs
  )
    ? deletionCount
    : 0;
  const needsAttention = evidenceDlq.backlogCount > 0
    || stuckCount > 0
    || stuckDeletionCount > 0;
  context.header("Cache-Control", "no-store");
  return context.json({
    ok: !needsAttention,
    service: "koge-realtime-evidence",
    environment: context.env.APP_ENV,
    approximate: true,
    queue: {
      backlogCount: evidenceQueue.backlogCount,
      backlogBytes: evidenceQueue.backlogBytes,
      oldestMessageAt:
        evidenceQueue.oldestMessageTimestamp?.toISOString() ?? null,
    },
    dlq: {
      backlogCount: evidenceDlq.backlogCount,
      backlogBytes: evidenceDlq.backlogBytes,
      oldestMessageAt:
        evidenceDlq.oldestMessageTimestamp?.toISOString() ?? null,
    },
    projection: {
      pendingCount,
      oldestCreatedAt,
      stuckAfterMs: cleanupStuckAfterMs,
      stuckCount,
      deletionCount,
      oldestDeletionRequestedAt,
      stuckDeletionCount,
    },
  }, needsAttention ? 503 : 200);
});

app.get("/health/orphan-snapshots", async (context) => {
  let latest: SnapshotOrphanHealthRow | null = null;
  let inventory = {
    count: 0,
    bytes: 0,
    room_missing_count: 0,
    unreferenced_count: 0,
  };
  try {
    latest = await context.env.DB.prepare(
      `SELECT status, started_at, completed_at, object_count, object_bytes,
              orphan_count, orphan_bytes, error
       FROM snapshot_orphan_scans
       ORDER BY started_at DESC
       LIMIT 1`,
    ).first<SnapshotOrphanHealthRow>();
    const row = await context.env.DB.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(object_bytes), 0) AS bytes,
              COUNT(CASE WHEN reason = 'room_missing' THEN 1 END)
                AS room_missing_count,
              COUNT(CASE WHEN reason = 'unreferenced' THEN 1 END)
                AS unreferenced_count
       FROM snapshot_orphans`,
    ).first<typeof inventory>();
    if (row) inventory = row;
  } catch (error) {
    if (context.env.APP_ENV !== "local") throw error;
  }
  const needsAttention = latest?.status === "failed"
    || latest?.status === "running"
    || inventory.count > 0;
  context.header("Cache-Control", "no-store");
  return context.json({
    ok: !needsAttention,
    service: "koge-realtime-orphan-snapshots",
    environment: context.env.APP_ENV,
    automaticDeletion: false,
    latest: latest
      ? {
          status: latest.status,
          startedAt: latest.started_at,
          completedAt: latest.completed_at,
          objectCount: latest.object_count,
          objectBytes: latest.object_bytes,
          orphanCount: latest.orphan_count,
          orphanBytes: latest.orphan_bytes,
          error: latest.error,
        }
      : null,
    inventory: {
      count: inventory.count,
      bytes: inventory.bytes,
      roomMissingCount: inventory.room_missing_count,
      unreferencedCount: inventory.unreferenced_count,
    },
  }, needsAttention ? 503 : 200);
});

app.get("/health/room/:name", async (context) => {
  const room = context.env.DRAWING_ROOM.getByName(context.req.param("name"));
  return context.json(await room.health());
});

app.options("/rooms/:roomId/snapshots/:jobId", (context) => {
  if (context.req.header("origin") !== context.env.APP_ORIGIN) {
    return context.json({ error: "ORIGIN_FORBIDDEN" }, 403);
  }
  return new Response(null, {
    status: 204,
    headers: snapshotCorsHeaders(context.env.APP_ORIGIN),
  });
});

app.get("/rooms/:roomId/snapshots/:jobId", async (context) => {
  const corsHeaders = snapshotCorsHeaders(context.env.APP_ORIGIN);
  if (context.req.header("origin") !== context.env.APP_ORIGIN) {
    return context.json({ error: "ORIGIN_FORBIDDEN" }, 403);
  }
  const roomId = context.req.param("roomId");
  const jobId = context.req.param("jobId");
  const authorization = context.req.header("authorization") ?? "";
  const [scheme, readToken, ...extra] = authorization.split(" ");
  if (
    !identifierPattern.test(roomId)
    || !identifierPattern.test(jobId)
    || scheme !== "KogeSnapshot"
    || !readToken
    || !snapshotTokenPattern.test(readToken)
    || extra.length !== 0
  ) {
    return Response.json(
      { error: "INVALID_SNAPSHOT_READ" },
      { status: 400, headers: corsHeaders },
    );
  }

  const room = context.env.DRAWING_ROOM.getByName(roomId, {
    locationHint: "apac-ne",
  });
  const grant = await room.consumeSnapshotReadTicket(roomId, jobId, readToken);
  if (!grant) {
    return Response.json(
      { error: "SNAPSHOT_READ_FORBIDDEN" },
      { status: 403, headers: corsHeaders },
    );
  }
  const object = await context.env.RUNTIME_SNAPSHOTS.get(
    grant.manifest.objectKey,
  );
  if (!object) {
    return Response.json(
      { error: "SNAPSHOT_NOT_FOUND" },
      { status: 404, headers: corsHeaders },
    );
  }
  const metadata = object.customMetadata;
  if (
    object.size !== grant.manifest.objectBytes
    || metadata?.jobId !== grant.manifest.jobId
    || metadata.roomId !== grant.manifest.roomId
    || metadata.baseRoomSeq !== String(grant.manifest.baseRoomSeq)
    || metadata.objectHash !== grant.manifest.objectHash
    || metadata.rgbaHash !== grant.manifest.rgbaHash
  ) {
    console.error(JSON.stringify({
      level: "error",
      message: "snapshot object metadata mismatch",
      roomId,
      jobId,
    }));
    return Response.json(
      { error: "SNAPSHOT_INTEGRITY_ERROR" },
      { status: 502, headers: corsHeaders },
    );
  }
  corsHeaders.set("Cache-Control", "private, no-store");
  corsHeaders.set("Content-Type", "application/vnd.koge.snapshot");
  corsHeaders.set("Content-Length", String(object.size));
  corsHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers: corsHeaders });
});

app.get("/rooms/:roomId/connect", async (context) => {
  if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return context.json({ error: "WEBSOCKET_REQUIRED" }, 426);
  }
  if (context.req.header("origin") !== context.env.APP_ORIGIN) {
    return context.json({ error: "ORIGIN_FORBIDDEN" }, 403);
  }

  const routeRoomId = context.req.param("roomId");
  const ticket = context.req.query("ticket");
  let roomId = routeRoomId;
  let actor: string | undefined;
  let connectionId: string | undefined;
  if (ticket) {
    if (
      !roomTicketPattern.test(ticket)
      || !publicRoomSlugPattern.test(routeRoomId)
    ) {
      return context.json({ error: "INVALID_ROOM_TICKET" }, 401);
    }
    const room = await context.env.DB.prepare(
      `SELECT id
       FROM rooms
       WHERE public_slug = ?
         AND provisioning_status = 'ready'
         AND status IN ('waiting', 'active', 'idle')`,
    ).bind(routeRoomId).first<{ id: string }>();
    if (!room) return context.json({ error: "ROOM_NOT_AVAILABLE" }, 404);
    roomId = room.id;
  } else {
    if (context.env.APP_ENV !== "local") {
      return context.json({ error: "ROOM_TICKET_REQUIRED" }, 401);
    }
    actor = context.req.query("actor");
    connectionId = context.req.query("connection");
  }
  const role = context.req.query("role") ?? "participant";
  const lastRoomSeqValue = context.req.query("lastRoomSeq") ?? "0";
  const lastRoomSeq = Number(lastRoomSeqValue);
  const rendererVersionValue = context.req.query("rendererVersion") ?? "0";
  const rendererVersion = Number(rendererVersionValue);
  const snapshotRecovery = context.req.query("snapshot") ?? "1";
  const excludedSnapshotJobsValue =
    context.req.query("snapshotExcludeJobs") ?? "";
  const excludedSnapshotJobs = excludedSnapshotJobsValue === ""
    ? []
    : excludedSnapshotJobsValue.split(",");
  if (
    !identifierPattern.test(roomId)
    || (
      !ticket
      && (
        !actor
        || !identifierPattern.test(actor)
        || !connectionId
        || !identifierPattern.test(connectionId)
      )
    )
    || !Number.isSafeInteger(lastRoomSeq)
    || lastRoomSeq < 0
    || !Number.isSafeInteger(rendererVersion)
    || rendererVersion < 0
    || (snapshotRecovery !== "0" && snapshotRecovery !== "1")
    || excludedSnapshotJobs.length > maxExcludedSnapshotJobs
    || excludedSnapshotJobs.some((jobId) => !identifierPattern.test(jobId))
    || new Set(excludedSnapshotJobs).size !== excludedSnapshotJobs.length
    || (role !== "participant" && role !== "viewer")
  ) {
    return context.json({ error: "INVALID_CONNECTION_PARAMETERS" }, 400);
  }

  const stub = context.env.DRAWING_ROOM.getByName(roomId, {
    locationHint: "apac-ne",
  });
  return stub.fetch(new Request("https://drawing-room.internal/connect", {
    headers: {
      Upgrade: "websocket",
      ...(ticket
        ? { "x-koge-room-ticket": ticket }
        : {
            "x-koge-actor": actor!,
            "x-koge-connection": connectionId!,
            "x-koge-role": role,
          }),
      "x-koge-last-room-seq": String(lastRoomSeq),
      "x-koge-room-id": roomId,
      "x-koge-renderer-version": String(rendererVersion),
      "x-koge-snapshot-recovery": snapshotRecovery,
      "x-koge-snapshot-exclude-jobs": excludedSnapshotJobs.join(","),
    },
  }));
});

app.notFound((context) => context.json({ error: "NOT_FOUND" }, 404));

app.onError((error, context) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "request failed",
      error: error.message,
      requestId: context.req.header("cf-ray") ?? crypto.randomUUID(),
      path: new URL(context.req.url).pathname,
    }),
  );

  return context.json({ error: "INTERNAL_SERVER_ERROR" }, 500);
});

const handler = {
  fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Response | Promise<Response> {
    return app.fetch(request, env, executionContext);
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const kind = (
          typeof message.body === "object"
          && message.body !== null
          && "kind" in message.body
        ) ? message.body.kind : undefined;
        const isEvidence = kind === "moderation.evidence";
        const isEvidenceDelete = kind === "moderation.evidence.delete";
        // Each durable job must finish before its message is acknowledged.
        const result = isEvidenceDelete
          // oxlint-disable-next-line no-await-in-loop
          ? await processModerationEvidenceDeleteJob(message.body, env)
          : isEvidence
          // oxlint-disable-next-line no-await-in-loop
          ? await processModerationEvidenceJob(message.body, env)
          // oxlint-disable-next-line no-await-in-loop
          : await processRoomCleanupJob(message.body, env);
        console.log(JSON.stringify({
          level: "info",
          message: isEvidence
            ? "moderation evidence completed"
            : isEvidenceDelete
            ? "moderation evidence deletion completed"
            : "room cleanup completed",
          messageId: message.id,
          result,
        }));
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "durable queue job failed",
          queue: batch.queue,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        }));
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<void> {
    executionContext.waitUntil((async () => {
      const [
        enqueued,
        orphanScan,
        deletedRateAbuseOutcomes,
        deletedServiceBanAudits,
      ] = await Promise.all([
        enqueueExpiredModerationEvidence(env),
        scanSnapshotOrphans(env),
        deleteExpiredRateAbuseOutcomes(env.DB),
        deleteExpiredServiceBanAudits(env.DB),
      ]);
      console.log(JSON.stringify({
        level: "info",
        message: "scheduled maintenance scan completed",
        enqueued,
        orphanScan,
        deletedRateAbuseOutcomes,
        deletedServiceBanAudits,
      }));
    })());
  },
} satisfies ExportedHandler<Env>;

export default handler;

export class RoomProvisioningService extends WorkerEntrypoint<Env> {
  async scanRuntimeSnapshotOrphans(): Promise<SnapshotOrphanScanResult> {
    return scanSnapshotOrphans(this.env);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const path = new URL(request.url).pathname;
    try {
      if (path === "/rooms/initialize") {
        const input: unknown = await request.json();
        validateRoomProvisioningRequest(input);
        const room = this.env.DRAWING_ROOM.getByName(input.roomId, {
          locationHint: "apac-ne",
        });
        return Response.json(await room.initializeRoom(input));
      }
      if (path === "/rooms/tickets/register") {
        const input: unknown = await request.json();
        validateRoomTicketRegistrationRequest(input);
        const ticket = randomHex(32);
        const room = this.env.DRAWING_ROOM.getByName(input.roomId, {
          locationHint: "apac-ne",
        });
        await room.registerRoomTicket(input, await sha256Hex(ticket));
        return Response.json({
          ticket,
          actorId: input.actorId,
          connectionId: input.connectionId,
          role: input.role,
          expiresAt: input.expiresAt,
        } satisfies RoomTicketRegistrationResult);
      }
      if (path === "/rooms/reports") {
        const input: unknown = await request.json();
        return Response.json(await createRoomReport(input, this.env));
      }
      if (path === "/rooms/moderation") {
        const input: unknown = await request.json();
        return Response.json(await applyRoomModerationAction(input, this.env));
      }
      if (path === "/rooms/members") {
        const input: unknown = await request.json();
        validateActiveRoomMembersRequest(input);
        const room = this.env.DRAWING_ROOM.getByName(input.roomId, {
          locationHint: "apac-ne",
        });
        return Response.json({
          members: await room.activeRoomMembers(),
        } satisfies ActiveRoomMembersResult);
      }
      if (path === "/operations/snapshot-orphans/scan") {
        return Response.json(await scanSnapshotOrphans(this.env));
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    } catch (error) {
      if (error instanceof RoomReportNotAvailableError) {
        return Response.json(
          { error: "ROOM_REPORT_NOT_AVAILABLE" },
          { status: 404 },
        );
      }
      if (error instanceof RoomModerationNotAvailableError) {
        return Response.json(
          { error: "ROOM_MODERATION_NOT_AVAILABLE" },
          { status: 404 },
        );
      }
      if (error instanceof RoomModerationConflictError) {
        return Response.json(
          { error: "ROOM_MODERATION_CONFLICT" },
          { status: 409 },
        );
      }
      if (error instanceof RoomModerationTargetForbiddenError) {
        return Response.json(
          { error: "ROOM_MODERATION_TARGET_FORBIDDEN" },
          { status: 403 },
        );
      }
      console.error(JSON.stringify({
        level: "error",
        message: "room control service request failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      return Response.json(
        { error: "ROOM_INITIALIZATION_FAILED" },
        { status: error instanceof TypeError ? 400 : 503 },
      );
    }
  }
}

export class SnapshotOrphanOperatorService extends WorkerEntrypoint<Env> {
  async scanRuntimeSnapshotOrphans(): Promise<SnapshotOrphanScanResult> {
    return scanSnapshotOrphans(this.env);
  }

  async createDeletionPlan(): Promise<SnapshotOrphanDeletionPlan> {
    return createSnapshotOrphanDeletionPlan(this.env);
  }

  async deleteApprovedPlan(input: {
    readonly plan: unknown;
    readonly confirmation: unknown;
  }): Promise<SnapshotOrphanDeletionResult> {
    return deleteSnapshotOrphans(this.env, input);
  }
}

export class RateAbuseMetricsService extends WorkerEntrypoint<Env> {
  async capture(): Promise<RateAbuseMetricsCapture> {
    return collectRateAbuseMetrics(this.env);
  }
}

export { DrawingRoom };
