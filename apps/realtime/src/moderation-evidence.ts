import {
  validateModerationEvidenceJob,
  type ModerationEvidenceJob,
  type ModerationEvidencePlan,
  type ModerationEvidenceRoomRpc,
  type AcceptedStrokeEvent,
  type Point,
} from "@koge/protocol";
import type { DurableObject as DurableObjectBase } from "cloudflare:workers";

type EvidenceRoomTarget =
  & DurableObjectBase<Env>
  & ModerationEvidenceRoomRpc;

type EvidenceProjectionRow = {
  evidence_status: "pending" | "committed" | "failed" | "deleted";
  evidence_object_key: string | null;
  evidence_expires_at: number;
  report_status:
    | "open"
    | "evidence_pending"
    | "under_review"
    | "resolved"
    | "dismissed";
  reporter_subject_kind: "user" | "guest";
  reporter_subject_id: string;
  category: string;
  description: string | null;
  room_name_snapshot: string;
  report_created_at: number;
};

type EvidenceMembershipRow = {
  subject_kind: "user" | "guest";
  subject_id: string;
  actor_id: string;
  role: "host" | "participant" | "viewer";
};

type EvidenceComponent = {
  kind: "snapshot" | "events";
  objectKey: string;
  objectBytes: number;
  objectHash: string;
  contentType: string;
  firstRoomSeq?: number;
  lastRoomSeq?: number;
  eventCount?: number;
};

export type ModerationEvidenceResult = {
  readonly status: "committed" | "already_committed";
  readonly manifestObjectKey: string;
  readonly componentCount: number;
};

const MAX_SNAPSHOT_OBJECT_BYTES = 16 * 1024 * 1024;
const EVENT_CHUNK_LIMIT = 50;

function evidencePrefix(evidenceId: string): string {
  return `moderation-evidence/${evidenceId}/`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function normalizePoint(value: readonly number[]): Point {
  if (
    value.length !== 3
    || value.some((item) => !Number.isFinite(item))
  ) {
    throw new TypeError("invalid point returned by moderation evidence RPC");
  }
  return [value[0]!, value[1]!, value[2]!];
}

function ensurePlanMatchesJob(
  plan: ModerationEvidencePlan,
  job: ModerationEvidenceJob,
): void {
  if (
    plan.evidenceId !== job.evidenceId
    || plan.reportId !== job.reportId
    || plan.roomId !== job.roomId
    || !Number.isSafeInteger(plan.targetRoomSeq)
    || plan.targetRoomSeq < 0
    || (
      plan.sourceSnapshot !== undefined
      && (
        plan.sourceSnapshot.roomId !== job.roomId
        || plan.sourceSnapshot.baseRoomSeq > plan.targetRoomSeq
      )
    )
  ) {
    throw new Error("moderation evidence plan does not match its job");
  }
}

async function copySnapshotComponent(
  bucket: R2Bucket,
  job: ModerationEvidenceJob,
  plan: ModerationEvidencePlan,
): Promise<EvidenceComponent | undefined> {
  const snapshot = plan.sourceSnapshot;
  if (!snapshot) return undefined;
  if (
    snapshot.objectBytes <= 0
    || snapshot.objectBytes > MAX_SNAPSHOT_OBJECT_BYTES
  ) {
    throw new Error("moderation evidence snapshot exceeds its size limit");
  }
  const source = await bucket.get(snapshot.objectKey);
  if (!source) throw new Error("moderation evidence snapshot is unavailable");
  if (source.size !== snapshot.objectBytes) {
    throw new Error("moderation evidence snapshot size mismatch");
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  const objectHash = await sha256(bytes);
  if (objectHash !== snapshot.objectHash) {
    throw new Error("moderation evidence snapshot hash mismatch");
  }
  const objectKey = `${evidencePrefix(job.evidenceId)}snapshot.kgs`;
  await bucket.put(objectKey, bytes, {
    httpMetadata: {
      contentType: "application/vnd.koge.snapshot",
      cacheControl: "private, no-store",
    },
    customMetadata: {
      evidenceId: job.evidenceId,
      reportId: job.reportId,
      roomId: job.roomId,
      sourceJobId: snapshot.jobId,
      objectHash,
    },
  });
  return {
    kind: "snapshot",
    objectKey,
    objectBytes: bytes.byteLength,
    objectHash,
    contentType: "application/vnd.koge.snapshot",
    firstRoomSeq: 0,
    lastRoomSeq: snapshot.baseRoomSeq,
  };
}

async function writeEventComponents(
  bucket: R2Bucket,
  room: ModerationEvidenceRoomRpc,
  job: ModerationEvidenceJob,
  plan: ModerationEvidencePlan,
): Promise<EvidenceComponent[]> {
  const components: EvidenceComponent[] = [];
  let cursor = plan.sourceSnapshot?.baseRoomSeq ?? 0;
  while (cursor < plan.targetRoomSeq) {
    // Evidence chunks must preserve room sequence order.
    // oxlint-disable-next-line no-await-in-loop
    const chunk = await room.moderationEvidenceEvents(
      job.evidenceId,
      cursor,
      EVENT_CHUNK_LIMIT,
    );
    if (
      chunk.events.length === 0
      || chunk.nextAfterRoomSeq <= cursor
      || chunk.nextAfterRoomSeq > plan.targetRoomSeq
    ) {
      throw new Error("moderation evidence event chunk did not advance");
    }
    const firstRoomSeq = chunk.events[0]!.roomSeq;
    const lastRoomSeq = chunk.events.at(-1)!.roomSeq;
    if (
      firstRoomSeq !== cursor + 1
      || lastRoomSeq !== chunk.nextAfterRoomSeq
    ) {
      throw new Error("moderation evidence event chunk has a sequence gap");
    }
    const bytes = jsonBytes({
      schema: "koge.moderation-evidence-events.v1",
      evidenceId: job.evidenceId,
      roomId: job.roomId,
      firstRoomSeq,
      lastRoomSeq,
      events: chunk.events,
    });
    // Chunks are hashed and committed in room sequence order.
    // oxlint-disable-next-line no-await-in-loop
    const objectHash = await sha256(bytes);
    const objectKey = `${evidencePrefix(job.evidenceId)}events/`
      + `${firstRoomSeq}-${lastRoomSeq}.json`;
    // Deterministic keys make Queue retries overwrite only the same component.
    // oxlint-disable-next-line no-await-in-loop
    await bucket.put(objectKey, bytes, {
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "private, no-store",
      },
      customMetadata: {
        evidenceId: job.evidenceId,
        reportId: job.reportId,
        roomId: job.roomId,
        objectHash,
      },
    });
    components.push({
      kind: "events",
      objectKey,
      objectBytes: bytes.byteLength,
      objectHash,
      contentType: "application/json",
      firstRoomSeq,
      lastRoomSeq,
      eventCount: chunk.events.length,
    });
    cursor = chunk.nextAfterRoomSeq;
    if (chunk.done !== (cursor === plan.targetRoomSeq)) {
      throw new Error("moderation evidence event completion is inconsistent");
    }
  }
  return components;
}

async function processEvidence(
  job: ModerationEvidenceJob,
  env: Env,
): Promise<ModerationEvidenceResult> {
  const rooms = env.DRAWING_ROOM as DurableObjectNamespace<EvidenceRoomTarget>;
  const stub = rooms.getByName(job.roomId, { locationHint: "apac-ne" });
  const projection = await env.DB.prepare(
    `SELECT evidence.status AS evidence_status,
            evidence.object_key AS evidence_object_key,
            evidence.expires_at AS evidence_expires_at,
            report.status AS report_status,
            report.reporter_subject_kind,
            report.reporter_subject_id,
            report.category,
            report.description,
            report.room_name_snapshot,
            report.created_at AS report_created_at
     FROM evidence_manifests evidence
     JOIN reports report ON report.evidence_manifest_id = evidence.id
     WHERE evidence.id = ?
       AND evidence.source_room_id = ?
       AND report.id = ?
       AND report.source_room_id = ?`,
  ).bind(
    job.evidenceId,
    job.roomId,
    job.reportId,
    job.roomId,
  ).first<EvidenceProjectionRow>();
  if (!projection) throw new Error("moderation evidence projection is missing");
  if (projection.evidence_expires_at !== job.expiresAt) {
    throw new Error("moderation evidence expiry fence mismatch");
  }
  if (projection.evidence_status === "deleted") {
    throw new Error("moderation evidence was already deleted");
  }
  if (
    projection.evidence_status === "committed"
    && projection.evidence_object_key
  ) {
    const object = await env.RUNTIME_SNAPSHOTS.head(
      projection.evidence_object_key,
    );
    if (!object) {
      throw new Error("committed moderation evidence manifest is missing");
    }
    await stub.resumeRoomCleanupAfterEvidence(job.roomId);
    return {
      status: "already_committed",
      manifestObjectKey: projection.evidence_object_key,
      componentCount: 0,
    };
  }

  const room: ModerationEvidenceRoomRpc = {
    async createModerationEvidencePlan(evidenceJob) {
      return stub.createModerationEvidencePlan(evidenceJob);
    },
    async moderationEvidenceEvents(evidenceId, afterRoomSeq, limit) {
      const chunk = await stub.moderationEvidenceEvents(
        evidenceId,
        afterRoomSeq,
        limit,
      );
      return {
        events: chunk.events.map((accepted): AcceptedStrokeEvent => {
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
        }),
        nextAfterRoomSeq: chunk.nextAfterRoomSeq,
        done: chunk.done,
      };
    },
    async resumeRoomCleanupAfterEvidence(roomId) {
      return stub.resumeRoomCleanupAfterEvidence(roomId);
    },
  };
  const plan = await room.createModerationEvidencePlan(job);
  ensurePlanMatchesJob(plan, job);
  const components: EvidenceComponent[] = [];
  const snapshot = await copySnapshotComponent(
    env.RUNTIME_SNAPSHOTS,
    job,
    plan,
  );
  if (snapshot) components.push(snapshot);
  components.push(...await writeEventComponents(
    env.RUNTIME_SNAPSHOTS,
    room,
    job,
    plan,
  ));
  const memberships = await env.DB.prepare(
    `SELECT subject_kind, subject_id, actor_id, role
     FROM room_memberships
     WHERE room_id = ?
     ORDER BY created_at, actor_id`,
  ).bind(job.roomId).all<EvidenceMembershipRow>();
  const manifest = {
    schema: "koge.moderation-evidence.v1",
    evidenceId: job.evidenceId,
    reportId: job.reportId,
    roomId: job.roomId,
    requestedAt: job.requestedAt,
    expiresAt: job.expiresAt,
    report: {
      category: projection.category,
      description: projection.description,
      roomName: projection.room_name_snapshot,
      createdAt: projection.report_created_at,
      reporter: {
        kind: projection.reporter_subject_kind,
        id: projection.reporter_subject_id,
      },
    },
    capture: plan,
    memberships: memberships.results,
    components,
  };
  const manifestBytes = jsonBytes(manifest);
  const manifestHash = await sha256(manifestBytes);
  const manifestObjectKey = `${evidencePrefix(job.evidenceId)}manifest.json`;
  await env.RUNTIME_SNAPSHOTS.put(manifestObjectKey, manifestBytes, {
    httpMetadata: {
      contentType: "application/json",
      cacheControl: "private, no-store",
    },
    customMetadata: {
      evidenceId: job.evidenceId,
      reportId: job.reportId,
      roomId: job.roomId,
      objectHash: manifestHash,
    },
  });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE evidence_manifests
       SET status = 'committed',
           object_key = ?,
           object_bytes = ?,
           object_hash = ?,
           committed_at = ?,
           deleted_at = NULL
       WHERE id = ?
         AND source_room_id = ?
         AND status IN ('pending', 'failed')`,
    ).bind(
      manifestObjectKey,
      manifestBytes.byteLength,
      manifestHash,
      Date.now(),
      job.evidenceId,
      job.roomId,
    ),
    env.DB.prepare(
      `UPDATE reports
       SET status = 'under_review', updated_at = ?
       WHERE id = ?
         AND source_room_id = ?
         AND evidence_manifest_id = ?
         AND status IN ('open', 'evidence_pending', 'under_review')`,
    ).bind(Date.now(), job.reportId, job.roomId, job.evidenceId),
  ]);
  const committed = await env.DB.prepare(
    `SELECT 1 AS present
     FROM evidence_manifests
     WHERE id = ? AND status = 'committed' AND object_key = ?`,
  ).bind(job.evidenceId, manifestObjectKey).first<{ present: number }>();
  if (!committed) {
    throw new Error("moderation evidence projection commit failed");
  }
  await room.resumeRoomCleanupAfterEvidence(job.roomId);
  return {
    status: "committed",
    manifestObjectKey,
    componentCount: components.length,
  };
}

export async function processModerationEvidenceJob(
  input: unknown,
  env: Env,
): Promise<ModerationEvidenceResult> {
  validateModerationEvidenceJob(input);
  try {
    return await processEvidence(input, env);
  } catch (error) {
    try {
      await env.DB.prepare(
        `UPDATE evidence_manifests
         SET status = 'failed'
         WHERE id = ? AND status = 'pending'`,
      ).bind(input.evidenceId).run();
    } catch (projectionError) {
      console.error(JSON.stringify({
        level: "error",
        message: "moderation evidence failure projection update failed",
        evidenceId: input.evidenceId,
        error: projectionError instanceof Error
          ? projectionError.message
          : String(projectionError),
      }));
    }
    throw error;
  }
}
