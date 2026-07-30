import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  SNAPSHOT_CANVAS_GENERATION,
  SNAPSHOT_CODEC,
  SNAPSHOT_JOB_VERSION,
  SNAPSHOT_RENDERER_VERSION,
  encodeSnapshot,
  type SnapshotManifest,
} from "@koge/protocol";
import { env } from "cloudflare:workers";
import authMigration from "../../../migrations/d1/0002_better_auth.sql?raw";
import roomMigration from "../../../migrations/d1/0003_room_projection.sql?raw";
import thumbnailMigration from "../../../migrations/d1/0020_room_thumbnails.sql?raw";
import {
  createThumbnailRetryJob,
  publishRoomThumbnail,
  retryRoomThumbnailFromSnapshot,
} from "../src/thumbnail-publication";
import { beforeAll, describe, expect, it } from "vitest";

const NOW = 1_785_300_000_000;
const HASH = "1".repeat(64);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

async function applySqlMigration(migration: string): Promise<void> {
  const statements = migration
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => env.DB.prepare(statement));
  await env.DB.batch(statements);
}

function manifest(roomId: string, baseRoomSeq: number): SnapshotManifest {
  return {
    v: SNAPSHOT_JOB_VERSION,
    jobId: `snapshot-job-${roomId}-${baseRoomSeq}`,
    roomId,
    baseRoomSeq,
    protocolVersion: PROTOCOL_VERSION,
    rendererVersion: SNAPSHOT_RENDERER_VERSION,
    canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
    generation: baseRoomSeq,
    codec: SNAPSHOT_CODEC,
    width: PROTOCOL_LIMITS.canvasWidth,
    height: PROTOCOL_LIMITS.canvasHeight,
    objectKey: `rooms/${roomId}/snapshots/staging/source-job.kgs`,
    objectBytes: 100,
    objectHash: HASH,
    rgbaHash: HASH,
    createdAt: NOW,
  };
}

beforeAll(async () => {
  await applySqlMigration(authMigration);
  await applySqlMigration(roomMigration);
  await applySqlMigration(thumbnailMigration);
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    "thumbnail-owner",
    "Thumbnail owner",
    "thumbnail@example.test",
    1,
    NOW,
    NOW,
    "active",
  ).run();
  const insert = env.DB.prepare(
    `INSERT INTO rooms (
      id, public_slug, owner_user_id, name, visibility, status,
      participant_limit, viewer_limit, participant_count, viewer_count,
      created_at, max_ends_at, updated_at, provisioning_status
    ) VALUES (?, ?, ?, ?, ?, ?, 20, 100, 0, 0, ?, ?, ?, 'ready')`,
  );
  await env.DB.batch([
    insert.bind(
      "room-thumbnail-public",
      "thumbnail-public",
      "thumbnail-owner",
      "Public",
      "public",
      "active",
      NOW,
      NOW + 60_000,
      NOW,
    ),
    insert.bind(
      "room-thumbnail-unlisted",
      "thumbnail-unlisted",
      "thumbnail-owner",
      "Unlisted",
      "unlisted",
      "active",
      NOW,
      NOW + 60_000,
      NOW,
    ),
  ]);
});

describe("room thumbnail publication", () => {
  it("publishes only a forward-moving public room projection", async () => {
    const rgba = new Uint8Array(
      PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4,
    ).fill(255);
    const first = await publishRoomThumbnail(
      manifest("room-thumbnail-public", 20),
      rgba,
      env.DB,
      env.ROOM_THUMBNAILS,
      true,
    );
    expect(first.status).toBe("published");
    const projection = await env.DB.prepare(
      `SELECT thumbnail_object_key, thumbnail_base_room_seq
       FROM rooms WHERE id = ?`,
    ).bind("room-thumbnail-public").first<{
      thumbnail_object_key: string | null;
      thumbnail_base_room_seq: number | null;
    }>();
    expect(projection).toEqual({
      thumbnail_object_key:
        "rooms/room-thumbnail-public/thumbnails/20.png",
      thumbnail_base_room_seq: 20,
    });
    const object = await env.ROOM_THUMBNAILS.head(
      "rooms/room-thumbnail-public/thumbnails/20.png",
    );
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe("image/png");
    expect(object?.httpMetadata?.cacheControl).toBeUndefined();

    await expect(publishRoomThumbnail(
      manifest("room-thumbnail-public", 10),
      rgba,
      env.DB,
      env.ROOM_THUMBNAILS,
      true,
    )).resolves.toEqual({ status: "skipped", reason: "newer_thumbnail" });

    await env.ROOM_THUMBNAILS.put(
      "rooms/room-thumbnail-public/thumbnails/5.png",
      new Uint8Array([1, 2, 3]),
    );
    await expect(publishRoomThumbnail(
      manifest("room-thumbnail-public", 20),
      rgba,
      env.DB,
      env.ROOM_THUMBNAILS,
      true,
    )).resolves.toEqual({ status: "skipped", reason: "newer_thumbnail" });
    await expect(env.ROOM_THUMBNAILS.head(
      "rooms/room-thumbnail-public/thumbnails/5.png",
    )).resolves.toBeNull();
  });

  it("does not publish unlisted rooms or when the feature is disabled", async () => {
    const rgba = new Uint8Array(
      PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4,
    ).fill(255);
    await expect(publishRoomThumbnail(
      manifest("room-thumbnail-unlisted", 20),
      rgba,
      env.DB,
      env.ROOM_THUMBNAILS,
      true,
    )).resolves.toEqual({ status: "skipped", reason: "ineligible_room" });
    await expect(publishRoomThumbnail(
      manifest("room-thumbnail-public", 30),
      rgba,
      env.DB,
      env.ROOM_THUMBNAILS,
      false,
    )).resolves.toEqual({ status: "skipped", reason: "disabled" });
  });

  it("deletes an object recreated while the room becomes ineligible", async () => {
    const rgba = new Uint8Array(
      PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4,
    ).fill(255);
    const roomId = "room-thumbnail-public";
    const objectKey = `rooms/${roomId}/thumbnails/40.png`;
    const originalPut = env.ROOM_THUMBNAILS.put.bind(env.ROOM_THUMBNAILS);
    const racingBucket = {
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        const stored = await originalPut(...args);
        await env.DB.prepare(
          "UPDATE rooms SET status = 'closing' WHERE id = ?",
        ).bind(roomId).run();
        return stored;
      },
      head: env.ROOM_THUMBNAILS.head.bind(env.ROOM_THUMBNAILS),
      delete: env.ROOM_THUMBNAILS.delete.bind(env.ROOM_THUMBNAILS),
    } as unknown as R2Bucket;

    await expect(publishRoomThumbnail(
      manifest(roomId, 40),
      rgba,
      env.DB,
      racingBucket,
      true,
    )).resolves.toEqual({ status: "skipped", reason: "ineligible_room" });
    await expect(env.ROOM_THUMBNAILS.head(objectKey)).resolves.toBeNull();
    await env.DB.prepare(
      "UPDATE rooms SET status = 'active' WHERE id = ?",
    ).bind(roomId).run();
  });

  it("retries from the committed lossless snapshot without event replay", async () => {
    const rgba = new Uint8Array(
      PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4,
    ).fill(255);
    const snapshotBytes = await encodeSnapshot(
      rgba,
      PROTOCOL_LIMITS.canvasWidth,
      PROTOCOL_LIMITS.canvasHeight,
      SNAPSHOT_RENDERER_VERSION,
    );
    const source = {
      ...manifest("room-thumbnail-public", 30),
      objectBytes: snapshotBytes.byteLength,
      objectHash: await sha256(snapshotBytes),
      rgbaHash: await sha256(rgba),
    } satisfies SnapshotManifest;
    await env.RUNTIME_SNAPSHOTS.put(source.objectKey, snapshotBytes, {
      customMetadata: {
        objectHash: source.objectHash,
        rgbaHash: source.rgbaHash,
      },
    });
    const result = await retryRoomThumbnailFromSnapshot(
      createThumbnailRetryJob(source),
      env.DB,
      env.RUNTIME_SNAPSHOTS,
      env.ROOM_THUMBNAILS,
      true,
    );
    expect(result.status).toBe("published");
    await expect(env.DB.prepare(
      `SELECT thumbnail_base_room_seq
       FROM rooms WHERE id = 'room-thumbnail-public'`,
    ).first()).resolves.toEqual({ thumbnail_base_room_seq: 30 });
    await expect(env.ROOM_THUMBNAILS.head(
      "rooms/room-thumbnail-public/thumbnails/20.png",
    )).resolves.toBeNull();
  });
});
