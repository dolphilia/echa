import type {
  SnapshotObjectInventoryRoomRpc,
} from "@koge/protocol";
import type { DurableObject as DurableObjectBase } from "cloudflare:workers";

type InventoryRoomTarget =
  & DurableObjectBase<Env>
  & SnapshotObjectInventoryRoomRpc;

type RoomRow = {
  id: string;
  thumbnail_object_key: string | null;
};

type OrphanCandidate = {
  objectKey: string;
  roomId: string;
  kind: "snapshot" | "thumbnail";
  objectBytes: number;
  uploadedAt: number;
};

type OrphanRecord = OrphanCandidate & {
  reason: "room_missing" | "unreferenced";
};

type DeletionCandidateRow = {
  object_key: string;
  room_id: string;
  object_bytes: number;
  uploaded_at: number;
  reason: OrphanRecord["reason"];
};

export type SnapshotOrphanDeletionPlanObject = {
  readonly objectKey: string;
  readonly roomId: string;
  readonly objectBytes: number;
  readonly uploadedAt: number;
  readonly reason: OrphanRecord["reason"];
  readonly etag: string;
};

type SnapshotOrphanDeletionPlanPayload = {
  readonly schema: "koge.snapshot-orphan-deletion-plan.v1";
  readonly environment: string;
  readonly planId: string;
  readonly sourceScanId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly objectCount: number;
  readonly objectBytes: number;
  readonly objects: readonly SnapshotOrphanDeletionPlanObject[];
};

export type SnapshotOrphanDeletionPlan =
  & SnapshotOrphanDeletionPlanPayload
  & {
    readonly planHash: string;
    readonly confirmation: string;
  };

export type SnapshotOrphanDeletionResult = {
  readonly status: "completed";
  readonly runId: string;
  readonly planHash: string;
  readonly verificationScanId: string;
  readonly objectCount: number;
  readonly objectBytes: number;
  readonly deletedCount: number;
  readonly deletedBytes: number;
  readonly alreadyMissingCount: number;
};

export type SnapshotOrphanScanResult =
  | { readonly status: "already_running" }
  | {
      readonly status: "completed";
      readonly scanId: string;
      readonly objectCount: number;
      readonly objectBytes: number;
      readonly orphanCount: number;
      readonly orphanBytes: number;
    };

const SNAPSHOT_PREFIX = "rooms/";
const SNAPSHOT_KEY_PATTERN =
  /^rooms\/([A-Za-z0-9_-]{8,128})\/snapshots\/staging\/([A-Za-z0-9_-]{8,128})\.kgs$/;
const THUMBNAIL_KEY_PATTERN =
  /^rooms\/([A-Za-z0-9_-]{8,128})\/thumbnails\/([0-9]+)\.png$/;
const ORPHAN_GRACE_MS = 60 * 60 * 1_000;
const MAX_SCANNED_OBJECTS = 10_000;
const MAX_SCANNED_ROOMS = 500;
const MAX_REFERENCED_KEYS_PER_ROOM = 1_000;
const R2_LIST_LIMIT = 1_000;
const D1_BATCH_LIMIT = 50;
const STALE_RUNNING_SCAN_MS = 6 * 60 * 60 * 1_000;
const DELETION_PLAN_TTL_MS = 30 * 60 * 1_000;
const MAX_DELETION_PLAN_OBJECTS = 100;

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function objectKeyMatch(
  objectKey: string,
): { roomId: string; kind: OrphanCandidate["kind"] } | undefined {
  const snapshot = SNAPSHOT_KEY_PATTERN.exec(objectKey);
  if (snapshot?.[1]) return { roomId: snapshot[1], kind: "snapshot" };
  const thumbnail = THUMBNAIL_KEY_PATTERN.exec(objectKey);
  if (thumbnail?.[1]) return { roomId: thumbnail[1], kind: "thumbnail" };
  return undefined;
}

function objectBucket(env: Env, objectKey: string): R2Bucket {
  const match = objectKeyMatch(objectKey);
  if (!match) throw new TypeError("unsupported orphan object key");
  return match.kind === "snapshot"
    ? env.RUNTIME_SNAPSHOTS
    : env.ROOM_THUMBNAILS;
}

function deletionPlanPayload(
  plan: SnapshotOrphanDeletionPlan,
): SnapshotOrphanDeletionPlanPayload {
  return {
    schema: plan.schema,
    environment: plan.environment,
    planId: plan.planId,
    sourceScanId: plan.sourceScanId,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    objectCount: plan.objectCount,
    objectBytes: plan.objectBytes,
    objects: plan.objects,
  };
}

async function hashDeletionPlan(
  payload: SnapshotOrphanDeletionPlanPayload,
): Promise<string> {
  return sha256Hex(JSON.stringify(payload));
}

function assertDeletionPlanShape(
  value: unknown,
): asserts value is SnapshotOrphanDeletionPlan {
  if (!value || typeof value !== "object") {
    throw new TypeError("invalid snapshot orphan deletion plan");
  }
  const plan = value as Partial<SnapshotOrphanDeletionPlan>;
  if (
    plan.schema !== "koge.snapshot-orphan-deletion-plan.v1"
    || typeof plan.environment !== "string"
    || typeof plan.planId !== "string"
    || typeof plan.sourceScanId !== "string"
    || !Number.isSafeInteger(plan.createdAt)
    || !Number.isSafeInteger(plan.expiresAt)
    || !Number.isSafeInteger(plan.objectCount)
    || !Number.isSafeInteger(plan.objectBytes)
    || typeof plan.planHash !== "string"
    || typeof plan.confirmation !== "string"
    || !Array.isArray(plan.objects)
    || plan.objects.length !== plan.objectCount
    || plan.objects.length > MAX_DELETION_PLAN_OBJECTS
  ) {
    throw new TypeError("invalid snapshot orphan deletion plan");
  }
  const keys = new Set<string>();
  let objectBytes = 0;
  for (const object of plan.objects) {
    const match = object && typeof object === "object"
      && typeof object.objectKey === "string"
      ? objectKeyMatch(object.objectKey)
      : null;
    if (
      !object
      || typeof object !== "object"
      || typeof object.objectKey !== "string"
      || !match
      || typeof object.roomId !== "string"
      || match.roomId !== object.roomId
      || typeof object.objectBytes !== "number"
      || !Number.isSafeInteger(object.objectBytes)
      || object.objectBytes < 0
      || typeof object.uploadedAt !== "number"
      || !Number.isSafeInteger(object.uploadedAt)
      || (object.reason !== "room_missing" && object.reason !== "unreferenced")
      || typeof object.etag !== "string"
      || object.etag.length === 0
      || keys.has(object.objectKey)
    ) {
      throw new TypeError("invalid snapshot orphan deletion plan object");
    }
    keys.add(object.objectKey);
    objectBytes += object.objectBytes;
  }
  if (objectBytes !== plan.objectBytes) {
    throw new TypeError("invalid snapshot orphan deletion plan bytes");
  }
}

function parseInventoryObject(object: R2Object): OrphanCandidate | undefined {
  const match = objectKeyMatch(object.key);
  if (!match) return undefined;
  return {
    objectKey: object.key,
    roomId: match.roomId,
    kind: match.kind,
    objectBytes: object.size,
    uploadedAt: object.uploaded.getTime(),
  };
}

async function createScan(
  database: D1Database,
  scanId: string,
  now: number,
): Promise<boolean> {
  await database.prepare(
    `UPDATE snapshot_orphan_scans
     SET status = 'failed',
         completed_at = ?,
         error = 'stale running scan superseded'
     WHERE status = 'running' AND started_at <= ?`,
  ).bind(now, now - STALE_RUNNING_SCAN_MS).run();
  try {
    await database.prepare(
      `INSERT INTO snapshot_orphan_scans (id, status, started_at)
       VALUES (?, 'running', ?)`,
    ).bind(scanId, now).run();
    return true;
  } catch (error) {
    const running = await database.prepare(
      `SELECT 1 AS present
       FROM snapshot_orphan_scans WHERE status = 'running'`,
    ).first<{ present: number }>();
    if (running) return false;
    throw error;
  }
}

async function listInventoryObjects(
  bucket: R2Bucket,
): Promise<OrphanCandidate[]> {
  const objects: OrphanCandidate[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- R2 cursors are sequential.
    const page = await bucket.list({
      prefix: SNAPSHOT_PREFIX,
      limit: R2_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) {
      const candidate = parseInventoryObject(object);
      if (candidate) objects.push(candidate);
      if (objects.length > MAX_SCANNED_OBJECTS) {
        throw new Error("snapshot orphan scan object limit exceeded");
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function classifyOrphans(
  env: Env,
  candidates: readonly OrphanCandidate[],
  now: number,
): Promise<OrphanRecord[]> {
  const mature = candidates.filter(
    ({ uploadedAt }) => uploadedAt <= now - ORPHAN_GRACE_MS,
  );
  const roomRows = await env.DB.prepare(
    "SELECT id, thumbnail_object_key FROM rooms",
  ).all<RoomRow>();
  const existingRooms = new Map(roomRows.results.map((room) => [room.id, room]));
  const byRoom = new Map<string, OrphanCandidate[]>();
  for (const candidate of mature) {
    const values = byRoom.get(candidate.roomId) ?? [];
    values.push(candidate);
    byRoom.set(candidate.roomId, values);
  }
  if (byRoom.size > MAX_SCANNED_ROOMS) {
    throw new Error("snapshot orphan scan room limit exceeded");
  }

  const orphans: OrphanRecord[] = [];
  const rooms = env.DRAWING_ROOM as DurableObjectNamespace<InventoryRoomTarget>;
  for (const [roomId, objects] of byRoom) {
    const roomRow = existingRooms.get(roomId);
    if (!roomRow) {
      orphans.push(...objects.map((object) => ({
        ...object,
        reason: "room_missing" as const,
      })));
      continue;
    }
    const snapshotObjects = objects.filter(({ kind }) => kind === "snapshot");
    const room = rooms.getByName(roomId, { locationHint: "apac-ne" });
    let referencedKeys: readonly string[] = [];
    if (snapshotObjects.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- each room owns its inventory.
      referencedKeys = await room.runtimeSnapshotObjectKeys(roomId);
    }
    if (
      !Array.isArray(referencedKeys)
      || referencedKeys.length > MAX_REFERENCED_KEYS_PER_ROOM
      || referencedKeys.some((objectKey) => {
        const match = typeof objectKey === "string"
          ? SNAPSHOT_KEY_PATTERN.exec(objectKey)
          : null;
        return match?.[1] !== roomId;
      })
    ) {
      throw new Error("invalid runtime snapshot inventory response");
    }
    const referenced = new Set(referencedKeys);
    for (const object of objects) {
      const isReferenced = object.kind === "snapshot"
        ? referenced.has(object.objectKey)
        : roomRow.thumbnail_object_key === object.objectKey;
      if (!isReferenced) {
        orphans.push({ ...object, reason: "unreferenced" });
      }
    }
  }
  return orphans;
}

async function commitInventory(
  database: D1Database,
  scanId: string,
  now: number,
  candidates: readonly OrphanCandidate[],
  orphans: readonly OrphanRecord[],
): Promise<SnapshotOrphanScanResult> {
  const objectBytes = candidates.reduce(
    (total, object) => total + object.objectBytes,
    0,
  );
  const orphanBytes = orphans.reduce(
    (total, object) => total + object.objectBytes,
    0,
  );
  const statements = orphans.map((orphan) => database.prepare(
    `INSERT INTO snapshot_orphans (
       object_key, room_id, object_bytes, uploaded_at, reason,
       first_detected_at, last_detected_at, scan_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(object_key) DO UPDATE SET
       room_id = excluded.room_id,
       object_bytes = excluded.object_bytes,
       uploaded_at = excluded.uploaded_at,
       reason = excluded.reason,
       last_detected_at = excluded.last_detected_at,
       scan_id = excluded.scan_id`,
  ).bind(
    orphan.objectKey,
    orphan.roomId,
    orphan.objectBytes,
    orphan.uploadedAt,
    orphan.reason,
    now,
    now,
    scanId,
  ));
  for (let index = 0; index < statements.length; index += D1_BATCH_LIMIT) {
    // oxlint-disable-next-line no-await-in-loop -- D1 batch size is bounded.
    await database.batch(statements.slice(index, index + D1_BATCH_LIMIT));
  }
  await database.batch([
    database.prepare(
      "DELETE FROM snapshot_orphans WHERE scan_id <> ?",
    ).bind(scanId),
    database.prepare(
      `UPDATE snapshot_orphan_scans
       SET status = 'completed',
           completed_at = ?,
           object_count = ?,
           object_bytes = ?,
           orphan_count = ?,
           orphan_bytes = ?,
           error = NULL
       WHERE id = ? AND status = 'running'`,
    ).bind(
      now,
      candidates.length,
      objectBytes,
      orphans.length,
      orphanBytes,
      scanId,
    ),
  ]);
  return {
    status: "completed",
    scanId,
    objectCount: candidates.length,
    objectBytes,
    orphanCount: orphans.length,
    orphanBytes,
  };
}

export async function scanSnapshotOrphans(
  env: Env,
  now = Date.now(),
): Promise<SnapshotOrphanScanResult> {
  const scanId = `orphan_scan_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!await createScan(env.DB, scanId, now)) {
    return { status: "already_running" };
  }
  try {
    const [snapshotCandidates, thumbnailCandidates] = await Promise.all([
      listInventoryObjects(env.RUNTIME_SNAPSHOTS),
      listInventoryObjects(env.ROOM_THUMBNAILS),
    ]);
    const candidates = [...snapshotCandidates, ...thumbnailCandidates];
    const orphans = await classifyOrphans(env, candidates, now);
    return await commitInventory(env.DB, scanId, now, candidates, orphans);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE snapshot_orphan_scans
       SET status = 'failed', completed_at = ?, error = ?
       WHERE id = ? AND status = 'running'`,
    ).bind(
      now,
      error instanceof Error ? error.message.slice(0, 500) : String(error),
      scanId,
    ).run();
    throw error;
  }
}

export async function createSnapshotOrphanDeletionPlan(
  env: Env,
  now = Date.now(),
): Promise<SnapshotOrphanDeletionPlan> {
  const scan = await scanSnapshotOrphans(env, now);
  if (scan.status !== "completed") {
    throw new Error("snapshot orphan scan is already running");
  }
  const rows = await env.DB.prepare(
    `SELECT object_key, room_id, object_bytes, uploaded_at, reason
     FROM snapshot_orphans
     WHERE scan_id = ? AND first_detected_at < last_detected_at
     ORDER BY uploaded_at, object_key
     LIMIT ?`,
  ).bind(scan.scanId, MAX_DELETION_PLAN_OBJECTS).all<DeletionCandidateRow>();
  const objects: SnapshotOrphanDeletionPlanObject[] = [];
  for (const row of rows.results) {
    // oxlint-disable-next-line no-await-in-loop -- each candidate is fail-closed.
    const object = await objectBucket(env, row.object_key).head(row.object_key);
    if (
      !object
      || object.size !== row.object_bytes
      || object.uploaded.getTime() !== row.uploaded_at
    ) {
      throw new Error("snapshot orphan candidate changed during planning");
    }
    objects.push({
      objectKey: row.object_key,
      roomId: row.room_id,
      objectBytes: row.object_bytes,
      uploadedAt: row.uploaded_at,
      reason: row.reason,
      etag: object.etag,
    });
  }
  const payload: SnapshotOrphanDeletionPlanPayload = {
    schema: "koge.snapshot-orphan-deletion-plan.v1",
    environment: env.APP_ENV,
    planId: `orphan_delete_plan_${crypto.randomUUID().replaceAll("-", "")}`,
    sourceScanId: scan.scanId,
    createdAt: now,
    expiresAt: now + DELETION_PLAN_TTL_MS,
    objectCount: objects.length,
    objectBytes: objects.reduce(
      (total, object) => total + object.objectBytes,
      0,
    ),
    objects,
  };
  const planHash = await hashDeletionPlan(payload);
  return {
    ...payload,
    planHash,
    confirmation: `DELETE ${planHash} ${payload.objectCount}`,
  };
}

export async function deleteSnapshotOrphans(
  env: Env,
  input: {
    readonly plan: unknown;
    readonly confirmation: unknown;
  },
  now = Date.now(),
): Promise<SnapshotOrphanDeletionResult> {
  assertDeletionPlanShape(input.plan);
  const plan = input.plan;
  const expectedHash = await hashDeletionPlan(deletionPlanPayload(plan));
  if (
    plan.planHash !== expectedHash
    || plan.confirmation !== `DELETE ${expectedHash} ${plan.objectCount}`
    || input.confirmation !== plan.confirmation
  ) {
    throw new TypeError("snapshot orphan deletion confirmation mismatch");
  }
  const existing = await env.DB.prepare(
    `SELECT id, verification_scan_id, object_count, object_bytes,
            deleted_count, deleted_bytes
     FROM snapshot_orphan_deletion_runs
     WHERE plan_hash = ? AND status = 'completed'`,
  ).bind(plan.planHash).first<{
    id: string;
    verification_scan_id: string;
    object_count: number;
    object_bytes: number;
    deleted_count: number;
    deleted_bytes: number;
  }>();
  if (existing) {
    return {
      status: "completed",
      runId: existing.id,
      planHash: plan.planHash,
      verificationScanId: existing.verification_scan_id,
      objectCount: existing.object_count,
      objectBytes: existing.object_bytes,
      deletedCount: existing.deleted_count,
      deletedBytes: existing.deleted_bytes,
      alreadyMissingCount: existing.object_count - existing.deleted_count,
    };
  }
  if (
    plan.environment !== env.APP_ENV
    || plan.objectCount === 0
    || plan.expiresAt < now
    || plan.createdAt > now
  ) {
    throw new TypeError("snapshot orphan deletion plan is not applicable");
  }

  const verification = await scanSnapshotOrphans(env, now);
  if (verification.status !== "completed") {
    throw new Error("snapshot orphan verification scan is already running");
  }
  const verifiedRows = await env.DB.prepare(
    `SELECT object_key, room_id, object_bytes, uploaded_at, reason
     FROM snapshot_orphans
     WHERE scan_id = ?`,
  ).bind(verification.scanId).all<DeletionCandidateRow>();
  const verified = new Map(
    verifiedRows.results.map((row) => [row.object_key, row]),
  );
  const alreadyMissing: SnapshotOrphanDeletionPlanObject[] = [];
  const deletable: SnapshotOrphanDeletionPlanObject[] = [];
  for (const planned of plan.objects) {
    // oxlint-disable-next-line no-await-in-loop -- each candidate is fail-closed.
    const object = await objectBucket(env, planned.objectKey)
      .head(planned.objectKey);
    if (!object) {
      alreadyMissing.push(planned);
      continue;
    }
    const row = verified.get(planned.objectKey);
    if (
      !row
      || row.room_id !== planned.roomId
      || row.object_bytes !== planned.objectBytes
      || row.uploaded_at !== planned.uploadedAt
      || row.reason !== planned.reason
      || object.size !== planned.objectBytes
      || object.uploaded.getTime() !== planned.uploadedAt
      || object.etag !== planned.etag
    ) {
      throw new Error("snapshot orphan deletion candidate failed revalidation");
    }
    deletable.push(planned);
  }

  if (deletable.length > 0) {
    const snapshotKeys = deletable
      .map(({ objectKey }) => objectKey)
      .filter((objectKey) => objectKeyMatch(objectKey)?.kind === "snapshot");
    const thumbnailKeys = deletable
      .map(({ objectKey }) => objectKey)
      .filter((objectKey) => objectKeyMatch(objectKey)?.kind === "thumbnail");
    await Promise.all([
      snapshotKeys.length > 0
        ? env.RUNTIME_SNAPSHOTS.delete(snapshotKeys)
        : Promise.resolve(),
      thumbnailKeys.length > 0
        ? env.ROOM_THUMBNAILS.delete(thumbnailKeys)
        : Promise.resolve(),
    ]);
    for (const object of deletable) {
      // oxlint-disable-next-line no-await-in-loop -- deletion verification is bounded.
      if (await objectBucket(env, object.objectKey).head(object.objectKey)) {
        throw new Error("snapshot orphan object remained after deletion");
      }
    }
  }

  const runId = `orphan_delete_${crypto.randomUUID().replaceAll("-", "")}`;
  const itemStatements = await Promise.all(plan.objects.map(async (object) =>
    env.DB.prepare(
      `INSERT INTO snapshot_orphan_deletion_items (
         run_id, object_key_hash, room_id, reason, object_bytes, result
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      await sha256Hex(object.objectKey),
      object.roomId,
      object.reason,
      object.objectBytes,
      alreadyMissing.includes(object) ? "already_missing" : "deleted",
    )
  ));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO snapshot_orphan_deletion_runs (
         id, plan_hash, environment, source_scan_id, verification_scan_id,
         status, object_count, object_bytes, deleted_count, deleted_bytes,
         requested_at, completed_at, error
       ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      runId,
      plan.planHash,
      plan.environment,
      plan.sourceScanId,
      verification.scanId,
      plan.objectCount,
      plan.objectBytes,
      deletable.length,
      deletable.reduce((total, object) => total + object.objectBytes, 0),
      now,
      Date.now(),
    ),
    ...itemStatements,
  ]);
  await scanSnapshotOrphans(env, now + 1);
  console.log(JSON.stringify({
    level: "info",
    message: "snapshot orphan deletion completed",
    runId,
    planHash: plan.planHash,
    objectCount: plan.objectCount,
    deletedCount: deletable.length,
    alreadyMissingCount: alreadyMissing.length,
  }));
  return {
    status: "completed",
    runId,
    planHash: plan.planHash,
    verificationScanId: verification.scanId,
    objectCount: plan.objectCount,
    objectBytes: plan.objectBytes,
    deletedCount: deletable.length,
    deletedBytes: deletable.reduce(
      (total, object) => total + object.objectBytes,
      0,
    ),
    alreadyMissingCount: alreadyMissing.length,
  };
}
