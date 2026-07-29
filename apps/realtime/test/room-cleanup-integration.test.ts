import {
  ROOM_CLEANUP_JOB_VERSION,
  ROOM_MAX_DURATION_MS,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_PROVISIONING_VERSION,
  ROOM_VIEWER_LIMIT,
  type RoomCleanupJob,
  type RoomProvisioningRequest,
} from "@koge/protocol";
import {
  applyD1Migrations,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, inject, it } from "vitest";
import { DrawingRoom } from "../src/drawing-room";
import { processRoomCleanupJob } from "../src/room-cleanup";

it("physically removes a room across R2, DO SQLite, and D1", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const ownerId = "owner-cleanup-integration";
  const roomId = "room-cleanup-integration";
  const publicSlug = "0123456789abcdef0123456789abcdef";
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt
    ) VALUES (?, ?, ?, 1, ?, ?)`,
  ).bind(
    ownerId,
    "Cleanup owner",
    "cleanup-integration@example.invalid",
    now,
    now,
  ).run();
  await env.DB.prepare(
    `INSERT INTO rooms (
      id, public_slug, owner_user_id, name, theme, visibility, status,
      participant_limit, viewer_limit, viewer_chat_enabled,
      viewer_stamp_enabled, created_at, max_ends_at, updated_at,
      provisioning_status
    ) VALUES (?, ?, ?, ?, NULL, 'unlisted', 'waiting', ?, ?, 0, 0, ?, ?, ?,
              'ready')`,
  ).bind(
    roomId,
    publicSlug,
    ownerId,
    "Cleanup integration",
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
  ).bind(roomId, ownerId, "actor-cleanup-integration", now, now).run();
  await env.DB.prepare(
    `INSERT INTO room_invites (
      id, room_id, token_hash, created_by_user_id, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    "invite-cleanup-integration",
    roomId,
    "a".repeat(64),
    ownerId,
    now,
    now + 60_000,
  ).run();

  const room = env.DRAWING_ROOM.getByName(roomId);
  const provisioning = {
    v: ROOM_PROVISIONING_VERSION,
    roomId,
    publicSlug,
    ownerUserId: ownerId,
    name: "Cleanup integration",
    visibility: "unlisted",
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
  });
  const snapshot = await room.requestSnapshot(roomId);
  const objectKey =
    `rooms/${roomId}/snapshots/staging/${snapshot.jobId}.kgs`;
  await env.RUNTIME_SNAPSHOTS.put(objectKey, new Uint8Array([1, 2, 3]));
  expect(await env.RUNTIME_SNAPSHOTS.head(objectKey)).not.toBeNull();

  const close = await room.beginRoomClose({
    closeRequestId: "cleanup-integration-close",
    reason: "probe",
  });
  expect(close.snapshotObjectKeys).toContain(objectKey);
  await expect(env.DB.prepare(
    "SELECT cleanup_job_id FROM rooms WHERE id = ?",
  ).bind(roomId).first<{ cleanup_job_id: string }>()).resolves.toEqual({
    cleanup_job_id: close.closeRequestId,
  });

  const job = {
    v: ROOM_CLEANUP_JOB_VERSION,
    jobId: close.closeRequestId,
    roomId,
    closeRequestId: close.closeRequestId,
    requestedAt: close.startedAt,
    snapshotObjectKeys: close.snapshotObjectKeys,
  } as const satisfies RoomCleanupJob;
  await env.DB.prepare(
    `INSERT INTO reports (
      id, source_room_id, reporter_subject_kind, reporter_subject_id,
      category, description, room_name_snapshot, status, created_at,
      updated_at
    ) VALUES (?, ?, 'user', ?, 'other', NULL, ?, 'open', ?, ?)`,
  ).bind(
    "report-cleanup-integration",
    roomId,
    ownerId,
    provisioning.name,
    now,
    now,
  ).run();
  await expect(processRoomCleanupJob(job, env)).rejects.toThrow(
    "room cleanup blocked until evidence is committed",
  );
  await expect(env.RUNTIME_SNAPSHOTS.head(objectKey)).resolves.not.toBeNull();
  await expect(env.DB.prepare(
    "SELECT id FROM rooms WHERE id = ?",
  ).bind(roomId).first()).resolves.not.toBeNull();

  const evidenceId = "evidence-cleanup-integration";
  const evidenceHash = "b".repeat(64);
  const evidenceObjectKey =
    `moderation-evidence/${evidenceId}/${evidenceHash}`;
  await env.RUNTIME_SNAPSHOTS.put(
    evidenceObjectKey,
    new Uint8Array([4, 5, 6]),
  );
  await env.DB.prepare(
    `INSERT INTO evidence_manifests (
      id, source_room_id, status, object_key, object_bytes, object_hash,
      created_at, committed_at, expires_at
    ) VALUES (?, ?, 'committed', ?, 3, ?, ?, ?, ?)`,
  ).bind(
    evidenceId,
    roomId,
    evidenceObjectKey,
    evidenceHash,
    now,
    now,
    now + 30 * 24 * 60 * 60 * 1_000,
  ).run();
  await env.DB.prepare(
    `UPDATE reports
     SET status = 'under_review', evidence_manifest_id = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(evidenceId, now, "report-cleanup-integration").run();
  await expect(processRoomCleanupJob(job, env)).resolves.toEqual({
    status: "deleted",
    deletedSnapshotObjectCount: 1,
  });

  await expect(env.RUNTIME_SNAPSHOTS.head(objectKey)).resolves.toBeNull();
  await expect(env.RUNTIME_SNAPSHOTS.head(evidenceObjectKey)).resolves
    .not.toBeNull();
  await expect(env.DB.prepare(
    "SELECT id FROM rooms WHERE id = ?",
  ).bind(roomId).first()).resolves.toBeNull();
  await expect(env.DB.prepare(
    "SELECT room_id FROM room_memberships WHERE room_id = ?",
  ).bind(roomId).first()).resolves.toBeNull();
  await expect(env.DB.prepare(
    "SELECT room_id FROM room_invites WHERE room_id = ?",
  ).bind(roomId).first()).resolves.toBeNull();
  await expect(env.DB.prepare(
    "SELECT source_room_id FROM reports WHERE id = ?",
  ).bind("report-cleanup-integration").first()).resolves.toEqual({
    source_room_id: roomId,
  });
  await runInDurableObject(room, async (
    instance: DrawingRoom,
    state,
  ) => {
    expect(instance).toBeInstanceOf(DrawingRoom);
    expect(
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master",
        )
        .one().count,
    ).toBe(0);
  });
});
