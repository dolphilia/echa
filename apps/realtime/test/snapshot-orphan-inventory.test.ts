import {
  ROOM_MAX_DURATION_MS,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_VIEWER_LIMIT,
} from "@koge/protocol";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, inject, it } from "vitest";
import {
  createSnapshotOrphanDeletionPlan,
  deleteSnapshotOrphans,
  scanSnapshotOrphans,
} from "../src/snapshot-orphan-inventory";

async function resetOrphanFixtures(): Promise<void> {
  const objects = await env.RUNTIME_SNAPSHOTS.list({ prefix: "rooms/" });
  if (objects.objects.length > 0) {
    await env.RUNTIME_SNAPSHOTS.delete(
      objects.objects.map(({ key }) => key),
    );
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM snapshot_orphan_deletion_items"),
    env.DB.prepare("DELETE FROM snapshot_orphan_deletion_runs"),
    env.DB.prepare("DELETE FROM snapshot_orphans"),
    env.DB.prepare("DELETE FROM snapshot_orphan_scans"),
  ]);
}

it("inventories only mature unreferenced runtime snapshot objects", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  await resetOrphanFixtures();
  const now = Date.now();
  const scanNow = now + 2 * 60 * 60 * 1_000;
  const ownerId = "owner-orphan-inventory";
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const roomId = `room-orphan-${suffix}`;
  const publicSlug = suffix;
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt
    ) VALUES (?, ?, ?, 1, ?, ?)`,
  ).bind(
    ownerId,
    "Orphan inventory owner",
    "orphan-inventory@example.invalid",
    now,
    now,
  ).run();
  await env.DB.prepare(
    `INSERT INTO rooms (
      id, public_slug, owner_user_id, name, theme, visibility, status,
      participant_limit, viewer_limit, viewer_chat_enabled,
      viewer_stamp_enabled, created_at, max_ends_at, updated_at,
      provisioning_status
    ) VALUES (?, ?, ?, ?, NULL, 'unlisted', 'active', ?, ?, 0, 0, ?, ?, ?,
              'ready')`,
  ).bind(
    roomId,
    publicSlug,
    ownerId,
    "Orphan inventory",
    ROOM_PARTICIPANT_LIMIT,
    ROOM_VIEWER_LIMIT,
    now,
    now + ROOM_MAX_DURATION_MS,
    now,
  ).run();
  const room = env.DRAWING_ROOM.getByName(roomId);
  const snapshot = await room.requestSnapshot(roomId);
  const referencedKey =
    `rooms/${roomId}/snapshots/staging/${snapshot.jobId}.kgs`;
  const unreferencedKey =
    `rooms/${roomId}/snapshots/staging/orphan-object-0001.kgs`;
  const missingRoomKey =
    "rooms/room-missing-inventory/snapshots/staging/orphan-object-0002.kgs";
  await Promise.all([
    env.RUNTIME_SNAPSHOTS.put(referencedKey, new Uint8Array([1])),
    env.RUNTIME_SNAPSHOTS.put(unreferencedKey, new Uint8Array([2, 3])),
    env.RUNTIME_SNAPSHOTS.put(missingRoomKey, new Uint8Array([4, 5, 6])),
    env.RUNTIME_SNAPSHOTS.put(
      "moderation-evidence/evidence-ignored/manifest.json",
      new Uint8Array([7]),
    ),
  ]);

  await expect(scanSnapshotOrphans(env, scanNow)).resolves.toMatchObject({
    status: "completed",
    objectCount: 3,
    objectBytes: 6,
    orphanCount: 2,
    orphanBytes: 5,
  });
  await expect(env.DB.prepare(
    `SELECT object_key, reason
     FROM snapshot_orphans
     ORDER BY object_key`,
  ).all()).resolves.toMatchObject({
    results: [
      { object_key: unreferencedKey, reason: "unreferenced" },
      { object_key: missingRoomKey, reason: "room_missing" },
    ].sort((left, right) => left.object_key.localeCompare(right.object_key)),
  });

  await env.RUNTIME_SNAPSHOTS.delete(missingRoomKey);
  await expect(scanSnapshotOrphans(env, scanNow + 1)).resolves.toMatchObject({
    status: "completed",
    objectCount: 2,
    orphanCount: 1,
    orphanBytes: 2,
  });
  await expect(env.DB.prepare(
    "SELECT object_key, reason FROM snapshot_orphans",
  ).all()).resolves.toMatchObject({
    results: [{ object_key: unreferencedKey, reason: "unreferenced" }],
  });
  await expect(env.RUNTIME_SNAPSHOTS.head(unreferencedKey)).resolves
    .not.toBeNull();
});

it("requires two scans and explicit confirmation before deleting an orphan", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  await resetOrphanFixtures();
  const now = Date.now();
  const scanNow = now + 2 * 60 * 60 * 1_000;
  const objectKey =
    "rooms/room-missing-deletion/snapshots/staging/orphan-delete-0001.kgs";
  await env.RUNTIME_SNAPSHOTS.put(objectKey, new Uint8Array([1, 2, 3, 4]));

  const firstPlan = await createSnapshotOrphanDeletionPlan(env, scanNow);
  expect(firstPlan).toMatchObject({
    objectCount: 0,
    objectBytes: 0,
    objects: [],
  });

  const plan = await createSnapshotOrphanDeletionPlan(env, scanNow + 1);
  expect(plan).toMatchObject({
    schema: "koge.snapshot-orphan-deletion-plan.v1",
    environment: "local",
    objectCount: 1,
    objectBytes: 4,
    objects: [{
      objectKey,
      reason: "room_missing",
      objectBytes: 4,
    }],
  });
  await expect(deleteSnapshotOrphans(env, {
    plan,
    confirmation: "DELETE something-else 1",
  }, scanNow + 2)).rejects.toThrow(
    "snapshot orphan deletion confirmation mismatch",
  );
  await expect(env.RUNTIME_SNAPSHOTS.head(objectKey)).resolves.not.toBeNull();

  const deleted = await deleteSnapshotOrphans(env, {
    plan,
    confirmation: plan.confirmation,
  }, scanNow + 2);
  expect(deleted).toMatchObject({
    status: "completed",
    planHash: plan.planHash,
    objectCount: 1,
    objectBytes: 4,
    deletedCount: 1,
    deletedBytes: 4,
    alreadyMissingCount: 0,
  });
  await expect(env.RUNTIME_SNAPSHOTS.head(objectKey)).resolves.toBeNull();
  await expect(env.DB.prepare(
    `SELECT status, object_count, deleted_count
     FROM snapshot_orphan_deletion_runs WHERE plan_hash = ?`,
  ).bind(plan.planHash).first()).resolves.toMatchObject({
    status: "completed",
    object_count: 1,
    deleted_count: 1,
  });
  const item = await env.DB.prepare(
    `SELECT object_key_hash, result
     FROM snapshot_orphan_deletion_items`,
  ).first<{ object_key_hash: string; result: string }>();
  expect(item).toMatchObject({
    result: "deleted",
  });
  expect(item?.object_key_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(item?.object_key_hash).not.toContain(objectKey);

  await expect(deleteSnapshotOrphans(env, {
    plan,
    confirmation: plan.confirmation,
  }, scanNow + 3)).resolves.toEqual(deleted);
});

it("fails closed when an approved orphan plan is changed or expires", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  await resetOrphanFixtures();
  const now = Date.now();
  const scanNow = now + 2 * 60 * 60 * 1_000;
  const objectKey =
    "rooms/room-missing-expiry/snapshots/staging/orphan-expiry-0001.kgs";
  await env.RUNTIME_SNAPSHOTS.put(objectKey, new Uint8Array([9]));
  await scanSnapshotOrphans(env, scanNow);
  const plan = await createSnapshotOrphanDeletionPlan(env, scanNow + 1);
  const changed = {
    ...plan,
    objects: plan.objects.map((object) => ({
      ...object,
      etag: `${object.etag}-changed`,
    })),
  };

  await expect(deleteSnapshotOrphans(env, {
    plan: changed,
    confirmation: plan.confirmation,
  }, scanNow + 2)).rejects.toThrow(
    "snapshot orphan deletion confirmation mismatch",
  );
  await expect(deleteSnapshotOrphans(env, {
    plan,
    confirmation: plan.confirmation,
  }, plan.expiresAt + 1)).rejects.toThrow(
    "snapshot orphan deletion plan is not applicable",
  );
  await expect(env.RUNTIME_SNAPSHOTS.head(objectKey)).resolves.not.toBeNull();
});
