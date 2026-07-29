import {
  type ModerationEvidenceDeleteJob,
  MODERATION_EVIDENCE_JOB_VERSION,
  ROOM_MAX_DURATION_MS,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_PROVISIONING_VERSION,
  ROOM_REPORT_VERSION,
  ROOM_VIEWER_LIMIT,
  encodeRoomEvent,
  type ModerationEvidenceJob,
  type RoomProvisioningRequest,
  type RoomReportRequest,
} from "@koge/protocol";
import {
  applyD1Migrations,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, inject, it, vi } from "vitest";
import { DrawingRoom } from "../src/drawing-room";
import { processModerationEvidenceJob } from "../src/moderation-evidence";
import {
  enqueueExpiredModerationEvidence,
  processModerationEvidenceDeleteJob,
} from "../src/moderation-evidence-retention";
import {
  RoomReportNotAvailableError,
  createRoomReport,
} from "../src/room-report";

it("accepts a member report and commits a fixed evidence bundle", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const ownerId = "owner-evidence-integration";
  const roomId = "room-evidence-integration";
  const publicSlug = "abcdef0123456789abcdef0123456789";
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt
    ) VALUES (?, ?, ?, 1, ?, ?)`,
  ).bind(
    ownerId,
    "Evidence owner",
    "evidence-integration@example.invalid",
    now,
    now,
  ).run();
  await env.DB.prepare(
    `INSERT INTO rooms (
      id, public_slug, owner_user_id, name, theme, visibility, status,
      participant_limit, viewer_limit, viewer_chat_enabled,
      viewer_stamp_enabled, created_at, max_ends_at, updated_at,
      provisioning_status
    ) VALUES (?, ?, ?, ?, ?, 'public', 'active', ?, ?, 0, 0, ?, ?, ?,
              'ready')`,
  ).bind(
    roomId,
    publicSlug,
    ownerId,
    "Evidence integration",
    "Safety",
    ROOM_PARTICIPANT_LIMIT,
    ROOM_VIEWER_LIMIT,
    now,
    now + ROOM_MAX_DURATION_MS,
    now,
  ).run();
  await env.DB.prepare(
    `INSERT INTO room_memberships (
      room_id, subject_kind, subject_id, actor_id, role, created_at,
      last_seen_at
    ) VALUES (?, 'user', ?, ?, 'host', ?, ?)`,
  ).bind(roomId, ownerId, "actor-evidence-integration", now, now).run();

  const room = env.DRAWING_ROOM.getByName(roomId);
  const provisioning = {
    v: ROOM_PROVISIONING_VERSION,
    roomId,
    publicSlug,
    ownerUserId: ownerId,
    name: "Evidence integration",
    theme: "Safety",
    visibility: "public",
    participantLimit: ROOM_PARTICIPANT_LIMIT,
    viewerLimit: ROOM_VIEWER_LIMIT,
    viewerChatEnabled: false,
    viewerStampEnabled: false,
    createdAt: now,
    maxEndsAt: now + ROOM_MAX_DURATION_MS,
  } as const satisfies RoomProvisioningRequest;
  await room.initializeRoom(provisioning);
  await runInDurableObject(room, async (
    _instance: DrawingRoom,
    state,
  ) => {
    state.storage.sql.exec(
      `UPDATE room_lifecycle
       SET status = 'active', status_changed_at = ?, last_activity_at = ?
       WHERE singleton = 1`,
      now,
      now,
    );
    const begin = encodeRoomEvent({
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke-evidence-integration",
      tool: "brush",
      color: "#112233",
      size: 8,
      opacity: 1,
      point: [10, 20, 0],
    });
    const end = encodeRoomEvent({
      v: 1,
      op: "stroke.end",
      clientSeq: 2,
      id: "stroke-evidence-integration",
    });
    state.storage.sql.exec(
      `INSERT INTO stroke_events (
        actor, connection_id, client_seq, stroke_id, op, payload,
        accepted_at, payload_bytes
      ) VALUES (?, ?, 1, ?, 'stroke.begin', ?, ?, ?)`,
      "actor-evidence-integration",
      "connection-evidence-integration",
      "stroke-evidence-integration",
      begin,
      now,
      begin.byteLength,
    );
    state.storage.sql.exec(
      `INSERT INTO stroke_events (
        actor, connection_id, client_seq, stroke_id, op, payload,
        accepted_at, payload_bytes
      ) VALUES (?, ?, 2, ?, 'stroke.end', ?, ?, ?)`,
      "actor-evidence-integration",
      "connection-evidence-integration",
      "stroke-evidence-integration",
      end,
      now + 1,
      end.byteLength,
    );
    state.storage.sql.exec(
      `INSERT INTO chat_messages (
        message_id, actor, role, text, created_at
      ) VALUES (?, ?, 'host', ?, ?)`,
      "chat-evidence-integration",
      "actor-evidence-integration",
      "evidence fixture message",
      now,
    );
  });

  const request = {
    v: ROOM_REPORT_VERSION,
    reportId: "report_evidence_integration",
    evidenceId: "evidence_integration_bundle",
    publicSlug,
    reporterSubjectKind: "user",
    reporterSubjectId: ownerId,
    category: "other",
    description: "integration fixture",
    requestedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
  } as const satisfies RoomReportRequest;
  const reportEnv = {
    DB: env.DB,
    MODERATION_EVIDENCE_QUEUE: {
      send: vi.fn(async () => undefined),
    },
  } as unknown as Env;
  await expect(createRoomReport(request, reportEnv)).resolves.toEqual({
    status: "created",
    reportId: request.reportId,
    evidenceId: request.evidenceId,
    evidenceStatus: "pending",
  });
  await expect(createRoomReport({
    ...request,
    reportId: "report_evidence_duplicate",
    evidenceId: "evidence_duplicate_bundle",
  }, reportEnv)).resolves.toEqual({
    status: "already_created",
    reportId: request.reportId,
    evidenceId: request.evidenceId,
    evidenceStatus: "pending",
  });
  await expect(createRoomReport({
    ...request,
    reportId: "report_nonmember_integration",
    evidenceId: "evidence_nonmember_bundle",
    reporterSubjectId: "user-evidence-nonmember",
  }, reportEnv)).rejects.toBeInstanceOf(RoomReportNotAvailableError);

  const job = {
    v: MODERATION_EVIDENCE_JOB_VERSION,
    kind: "moderation.evidence",
    jobId: request.evidenceId,
    reportId: request.reportId,
    evidenceId: request.evidenceId,
    roomId,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
  } as const satisfies ModerationEvidenceJob;
  const result = await processModerationEvidenceJob(job, env);
  expect(result).toMatchObject({
    status: "committed",
    componentCount: 1,
  });
  const manifestObject = await env.RUNTIME_SNAPSHOTS.get(
    result.manifestObjectKey,
  );
  expect(manifestObject).not.toBeNull();
  const manifest = await manifestObject!.json<{
    schema: string;
    capture: {
      targetRoomSeq: number;
      chatMessages: unknown[];
    };
    components: Array<{
      kind: string;
      objectKey: string;
      eventCount?: number;
    }>;
  }>();
  expect(manifest).toMatchObject({
    schema: "koge.moderation-evidence.v1",
    capture: {
      targetRoomSeq: 2,
      chatMessages: [{ text: "evidence fixture message" }],
    },
    components: [{
      kind: "events",
      eventCount: 2,
    }],
  });
  await expect(env.RUNTIME_SNAPSHOTS.head(
    manifest.components[0]!.objectKey,
  )).resolves.not.toBeNull();
  await expect(env.DB.prepare(
    `SELECT evidence.status AS evidence_status, report.status AS report_status
     FROM evidence_manifests evidence
     JOIN reports report ON report.evidence_manifest_id = evidence.id
     WHERE evidence.id = ?`,
  ).bind(request.evidenceId).first()).resolves.toEqual({
    evidence_status: "committed",
    report_status: "under_review",
  });
  await expect(processModerationEvidenceJob(job, env)).resolves.toMatchObject({
    status: "already_committed",
    manifestObjectKey: result.manifestObjectKey,
  });

  const deletionNow = request.expiresAt + 1;
  const sendDeletion = vi.fn(
    async (_job: ModerationEvidenceDeleteJob) => undefined,
  );
  await expect(enqueueExpiredModerationEvidence({
    DB: env.DB,
    MODERATION_EVIDENCE_QUEUE: { send: sendDeletion },
  } as unknown as Env, deletionNow)).resolves.toBe(1);
  const deleteJob = sendDeletion.mock.calls[0]![0];
  await expect(processModerationEvidenceDeleteJob(
    deleteJob,
    env,
    deletionNow,
  )).resolves.toEqual({
    status: "deleted",
    deletedObjectCount: 2,
  });
  await expect(env.RUNTIME_SNAPSHOTS.head(
    result.manifestObjectKey,
  )).resolves.toBeNull();
  await expect(env.RUNTIME_SNAPSHOTS.head(
    manifest.components[0]!.objectKey,
  )).resolves.toBeNull();
  await expect(env.DB.prepare(
    `SELECT status, object_key, deleted_at
     FROM evidence_manifests WHERE id = ?`,
  ).bind(request.evidenceId).first()).resolves.toEqual({
    status: "deleted",
    object_key: null,
    deleted_at: deletionNow,
  });
  await expect(processModerationEvidenceDeleteJob(
    deleteJob,
    env,
    deletionNow,
  )).resolves.toEqual({
    status: "already_deleted",
    deletedObjectCount: 0,
  });
});
