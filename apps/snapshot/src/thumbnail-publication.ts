import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  SNAPSHOT_CANVAS_GENERATION,
  SNAPSHOT_CODEC,
  SNAPSHOT_JOB_VERSION,
  SNAPSHOT_RENDERER_VERSION,
  decodeSnapshot,
  type SnapshotManifest,
} from "@koge/protocol";
import {
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_EXTENSION,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  createRoomThumbnail,
} from "./thumbnail-codec";

export const THUMBNAIL_RETRY_JOB_VERSION = 1 as const;

export type ThumbnailRetryJob = {
  readonly kind: "thumbnail.retry";
  readonly v: typeof THUMBNAIL_RETRY_JOB_VERSION;
  readonly requestedAt: number;
  readonly manifest: SnapshotManifest;
};

export type ThumbnailPublicationResult =
  | { readonly status: "published"; readonly objectKey: string; readonly bytes: number }
  | {
      readonly status: "skipped";
      readonly reason: "disabled" | "ineligible_room" | "newer_thumbnail";
    };

type RoomThumbnailProjection = {
  visibility: string;
  status: string;
  thumbnail_object_key: string | null;
  thumbnail_base_room_seq: number | null;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const THUMBNAIL_SEQUENCE_PATTERN = /\/thumbnails\/([0-9]+)\.png$/;

function isEligibleRoom(
  room: RoomThumbnailProjection | null,
): room is RoomThumbnailProjection {
  return room !== null
    && room.visibility === "public"
    && (room.status === "active" || room.status === "idle");
}

function validateManifest(manifest: SnapshotManifest): void {
  if (
    manifest.v !== SNAPSHOT_JOB_VERSION
    || !IDENTIFIER_PATTERN.test(manifest.jobId)
    || !IDENTIFIER_PATTERN.test(manifest.roomId)
    || !Number.isSafeInteger(manifest.baseRoomSeq)
    || manifest.baseRoomSeq < 0
    || manifest.protocolVersion !== PROTOCOL_VERSION
    || manifest.rendererVersion !== SNAPSHOT_RENDERER_VERSION
    || manifest.canvasGeneration !== SNAPSHOT_CANVAS_GENERATION
    || manifest.codec !== SNAPSHOT_CODEC
    || manifest.width !== PROTOCOL_LIMITS.canvasWidth
    || manifest.height !== PROTOCOL_LIMITS.canvasHeight
    || !manifest.objectKey.startsWith(
      `rooms/${manifest.roomId}/snapshots/staging/`,
    )
    || !HASH_PATTERN.test(manifest.objectHash)
    || !HASH_PATTERN.test(manifest.rgbaHash)
  ) {
    throw new TypeError("invalid thumbnail source manifest");
  }
}

async function sha256(bytes: Uint8Array): Promise<{
  readonly digest: ArrayBuffer;
  readonly hex: string;
}> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    digest,
    hex: Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0")
    ).join(""),
  };
}

async function roomProjection(
  database: D1Database,
  roomId: string,
): Promise<RoomThumbnailProjection | null> {
  return database.prepare(
    `SELECT visibility, status, thumbnail_object_key,
            thumbnail_base_room_seq
     FROM rooms WHERE id = ?`,
  ).bind(roomId).first<RoomThumbnailProjection>();
}

async function cleanupSupersededThumbnails(
  bucket: R2Bucket,
  roomId: string,
  keepBaseRoomSeq: number,
): Promise<void> {
  const prefix = `rooms/${roomId}/thumbnails/`;
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each R2 page requires the previous cursor.
    const page = await bucket.list({
      prefix,
      ...(cursor ? { cursor } : {}),
    });
    const obsolete = page.objects
      .map(({ key }) => ({
        key,
        sequence: Number(THUMBNAIL_SEQUENCE_PATTERN.exec(key)?.[1]),
      }))
      .filter(({ sequence }) =>
        Number.isSafeInteger(sequence) && sequence < keepBaseRoomSeq
      )
      .map(({ key }) => key);
    if (obsolete.length > 0) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- delete each page before advancing its cursor.
      await bucket.delete(obsolete);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function cleanupSupersededThumbnailsBestEffort(
  bucket: R2Bucket,
  roomId: string,
  keepBaseRoomSeq: number,
): Promise<void> {
  try {
    await cleanupSupersededThumbnails(bucket, roomId, keepBaseRoomSeq);
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "superseded thumbnail object deletion failed",
      roomId,
      keepBaseRoomSeq,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function isThumbnailRetryJob(
  input: unknown,
): input is ThumbnailRetryJob {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (
    record.kind !== "thumbnail.retry"
    || record.v !== THUMBNAIL_RETRY_JOB_VERSION
    || !Number.isSafeInteger(record.requestedAt)
    || (record.requestedAt as number) <= 0
    || typeof record.manifest !== "object"
    || record.manifest === null
    || Array.isArray(record.manifest)
  ) {
    return false;
  }
  try {
    validateManifest(record.manifest as SnapshotManifest);
    return true;
  } catch {
    return false;
  }
}

export function createThumbnailRetryJob(
  manifest: SnapshotManifest,
): ThumbnailRetryJob {
  validateManifest(manifest);
  return {
    kind: "thumbnail.retry",
    v: THUMBNAIL_RETRY_JOB_VERSION,
    requestedAt: Date.now(),
    manifest,
  };
}

export async function publishRoomThumbnail(
  manifest: SnapshotManifest,
  rgba: Uint8Array,
  database: D1Database,
  bucket: R2Bucket,
  enabled: boolean,
): Promise<ThumbnailPublicationResult> {
  validateManifest(manifest);
  if (!enabled) return { status: "skipped", reason: "disabled" };
  if (rgba.byteLength !== manifest.width * manifest.height * 4) {
    throw new Error("thumbnail source RGBA length mismatch");
  }

  const before = await roomProjection(database, manifest.roomId);
  if (!isEligibleRoom(before)) {
    return { status: "skipped", reason: "ineligible_room" };
  }
  if (
    before.thumbnail_base_room_seq !== null
    && before.thumbnail_base_room_seq >= manifest.baseRoomSeq
  ) {
    await cleanupSupersededThumbnailsBestEffort(
      bucket,
      manifest.roomId,
      before.thumbnail_base_room_seq,
    );
    return { status: "skipped", reason: "newer_thumbnail" };
  }

  const encodedAt = Date.now();
  const bytes = await createRoomThumbnail(
    rgba,
    manifest.width,
    manifest.height,
  );
  const objectKey =
    `rooms/${manifest.roomId}/thumbnails/${manifest.baseRoomSeq}.`
    + THUMBNAIL_EXTENSION;
  const objectDigest = await sha256(bytes);
  const objectHash = objectDigest.hex;
  const stored = await bucket.put(objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: objectDigest.digest,
    httpMetadata: {
      contentType: THUMBNAIL_CONTENT_TYPE,
    },
    customMetadata: {
      roomId: manifest.roomId,
      baseRoomSeq: String(manifest.baseRoomSeq),
      sourceSnapshotJobId: manifest.jobId,
      sourceRgbaHash: manifest.rgbaHash,
      objectHash,
      width: String(THUMBNAIL_WIDTH),
      height: String(THUMBNAIL_HEIGHT),
    },
  });
  if (!stored) {
    const existing = await bucket.head(objectKey);
    if (
      !existing
      || existing.size !== bytes.byteLength
      || existing.customMetadata?.objectHash !== objectHash
    ) {
      throw new Error("thumbnail object conflicts with existing data");
    }
  }

  const update = await database.prepare(
    `UPDATE rooms
     SET thumbnail_object_key = ?,
         thumbnail_base_room_seq = ?,
         thumbnail_updated_at = ?
     WHERE id = ?
       AND visibility = 'public'
       AND status IN ('active', 'idle')
       AND (
         thumbnail_base_room_seq IS NULL
         OR thumbnail_base_room_seq < ?
       )`,
  ).bind(
    objectKey,
    manifest.baseRoomSeq,
    encodedAt,
    manifest.roomId,
    manifest.baseRoomSeq,
  ).run();
  if ((update.meta.changes ?? 0) !== 1) {
    const current = await roomProjection(database, manifest.roomId);
    // A room may enter `closing` after the eligibility read and before this
    // fenced update. Never recreate an object for an ineligible room, even
    // when its closing projection still references this object key.
    if (
      !isEligibleRoom(current)
      || current.thumbnail_object_key !== objectKey
    ) {
      await bucket.delete(objectKey);
    }
    return {
      status: "skipped",
      reason: isEligibleRoom(current)
        ? "newer_thumbnail"
        : "ineligible_room",
    };
  }

  await cleanupSupersededThumbnailsBestEffort(
    bucket,
    manifest.roomId,
    manifest.baseRoomSeq,
  );
  return { status: "published", objectKey, bytes: bytes.byteLength };
}

export async function retryRoomThumbnailFromSnapshot(
  job: ThumbnailRetryJob,
  database: D1Database,
  runtimeBucket: R2Bucket,
  thumbnailBucket: R2Bucket,
  enabled: boolean,
): Promise<ThumbnailPublicationResult> {
  if (!isThumbnailRetryJob(job)) {
    throw new TypeError("invalid thumbnail retry job");
  }
  const { manifest } = job;
  const current = await roomProjection(database, manifest.roomId);
  if (!enabled) return { status: "skipped", reason: "disabled" };
  if (!isEligibleRoom(current)) {
    return { status: "skipped", reason: "ineligible_room" };
  }
  if (
    current.thumbnail_base_room_seq !== null
    && current.thumbnail_base_room_seq >= manifest.baseRoomSeq
  ) {
    return { status: "skipped", reason: "newer_thumbnail" };
  }

  const object = await runtimeBucket.get(manifest.objectKey);
  if (
    !object
    || object.size !== manifest.objectBytes
    || object.customMetadata?.objectHash !== manifest.objectHash
    || object.customMetadata?.rgbaHash !== manifest.rgbaHash
  ) {
    throw new Error("thumbnail retry snapshot object is unavailable");
  }
  const snapshotBytes = await object.bytes();
  if ((await sha256(snapshotBytes)).hex !== manifest.objectHash) {
    throw new Error("thumbnail retry snapshot object hash mismatch");
  }
  const decoded = await decodeSnapshot(snapshotBytes);
  if (
    decoded.width !== manifest.width
    || decoded.height !== manifest.height
    || decoded.rendererVersion !== manifest.rendererVersion
    || (await sha256(decoded.rgba)).hex !== manifest.rgbaHash
  ) {
    throw new Error("thumbnail retry snapshot pixels are inconsistent");
  }
  return publishRoomThumbnail(
    manifest,
    decoded.rgba,
    database,
    thumbnailBucket,
    enabled,
  );
}
