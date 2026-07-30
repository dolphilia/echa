import { env } from "cloudflare:workers";
import authMigration from "../../../migrations/d1/0002_better_auth.sql?raw";
import roomMigration from "../../../migrations/d1/0003_room_projection.sql?raw";
import roomThumbnailsMigration from "../../../migrations/d1/0020_room_thumbnails.sql?raw";
import { GET } from "../app/api/rooms/[slug]/thumbnail/route";
import { applySqlMigration } from "./migrations";
import { beforeAll, describe, expect, it } from "vitest";

const NOW = 1_785_300_000_000;
const SLUG = "0123456789abcdef0123456789abcdef";
const ROOM_ID = "room-web-thumbnail-test";
const OBJECT_KEY = `rooms/${ROOM_ID}/thumbnails/42.png`;

beforeAll(async () => {
  await applySqlMigration(env.DB, authMigration);
  await applySqlMigration(env.DB, roomMigration);
  await applySqlMigration(env.DB, roomThumbnailsMigration);
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt, status
    ) VALUES (?, ?, ?, 1, ?, ?, 'active')`,
  ).bind(
    "room-thumbnail-web-owner",
    "Owner",
    "thumbnail-web@example.test",
    NOW,
    NOW,
  ).run();
  await env.DB.prepare(
    `INSERT INTO rooms (
      id, public_slug, owner_user_id, name, visibility, status,
      participant_limit, viewer_limit, participant_count, viewer_count,
      created_at, max_ends_at, updated_at, provisioning_status,
      thumbnail_object_key, thumbnail_base_room_seq, thumbnail_updated_at
    ) VALUES (?, ?, ?, 'Thumbnail', 'public', 'active',
              20, 100, 0, 0, ?, ?, ?, 'ready', ?, 42, ?)`,
  ).bind(
    ROOM_ID,
    SLUG,
    "room-thumbnail-web-owner",
    NOW,
    NOW + 60_000,
    NOW,
    OBJECT_KEY,
    NOW,
  ).run();
  await env.ROOM_THUMBNAILS.put(OBJECT_KEY, new Uint8Array([1, 2, 3]), {
    httpMetadata: {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });
});

function request(version = "42", headers?: HeadersInit): Request {
  return new Request(
    `https://koge.test/api/rooms/${SLUG}/thumbnail?v=${version}`,
    { headers },
  );
}

describe("public room thumbnail endpoint", () => {
  it("serves only the current immutable projection and supports ETag", async () => {
    const response = await GET(request(), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    await expect(response.bytes()).resolves.toEqual(new Uint8Array([1, 2, 3]));

    const etag = response.headers.get("etag")!;
    const cached = await GET(request("42", { "if-none-match": etag }), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(cached.status).toBe(304);
  });

  it("rejects stale versions and non-public lifecycle states", async () => {
    const stale = await GET(request("41"), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(stale.status).toBe(404);

    await env.DB.prepare(
      "UPDATE rooms SET visibility = 'unlisted' WHERE id = ?",
    ).bind(ROOM_ID).run();
    const unlisted = await GET(request(), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(unlisted.status).toBe(404);
    await env.DB.prepare(
      "UPDATE rooms SET visibility = 'public' WHERE id = ?",
    ).bind(ROOM_ID).run();
  });

  it("returns a short-lived placeholder if the projected object is missing", async () => {
    await env.ROOM_THUMBNAILS.delete(OBJECT_KEY);
    const response = await GET(request(), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=30, s-maxage=30",
    );
    const placeholder = await response.text();
    expect(placeholder).toContain('fill="#fff"');
    expect(placeholder).not.toContain("<path");
  });

  it("fails closed while the thumbnail feature flag is disabled", async () => {
    const mutableEnv = env as unknown as { THUMBNAIL_ENABLED: string };
    const original = mutableEnv.THUMBNAIL_ENABLED;
    try {
      mutableEnv.THUMBNAIL_ENABLED = "false";
      const response = await GET(request(), {
        params: Promise.resolve({ slug: SLUG }),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store",
      );
    } finally {
      mutableEnv.THUMBNAIL_ENABLED = original;
    }
  });
});
