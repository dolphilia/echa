import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import authMigration from "../../../migrations/d1/0002_better_auth.sql?raw";
import roomMigration from "../../../migrations/d1/0003_room_projection.sql?raw";
import provisioningMigration from "../../../migrations/d1/0004_room_provisioning.sql?raw";
import inviteMigration from "../../../migrations/d1/0006_room_invites.sql?raw";
import serviceControlsMigration from "../../../migrations/d1/0014_service_controls.sql?raw";
import moderationMigration from "../../../migrations/d1/0008_moderation_evidence_fence.sql?raw";
import serviceBansMigration from "../../../migrations/d1/0017_service_bans.sql?raw";
import removeRoomThemesMigration from "../../../migrations/d1/0019_remove_room_themes.sql?raw";
import roomThumbnailsMigration from "../../../migrations/d1/0020_room_thumbnails.sql?raw";
import { GET, POST } from "../app/api/rooms/route";
import {
  RoomCreationConflictError,
  RoomCreationDisabledError,
  RoomProvisioningError,
  createRoom,
  listOwnedLiveRoomSlugs,
  listPublicRooms,
  parseCreateRoomInput,
} from "../app/server/rooms";
import { applySqlMigration } from "./migrations";

const NOW = 1_785_200_000_000;

beforeAll(async () => {
  await applySqlMigration(env.DB, authMigration);
  await applySqlMigration(env.DB, roomMigration);
  await applySqlMigration(env.DB, provisioningMigration);
  await applySqlMigration(env.DB, inviteMigration);
  await applySqlMigration(env.DB, serviceControlsMigration);
  await applySqlMigration(env.DB, moderationMigration);
  await applySqlMigration(env.DB, serviceBansMigration);
  const insertUser = env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    insertUser.bind(
      "user-room-test",
      "Room owner",
      "owner@example.test",
      1,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-room-fixture",
      "Fixture owner",
      "fixture@example.test",
      1,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-limit-test",
      "Limit owner",
      "limit@example.test",
      1,
      NOW,
      NOW,
      "active",
    ),
  ]);

  const insert = env.DB.prepare(
    `INSERT INTO rooms (
      id,
      public_slug,
      owner_user_id,
      name,
      visibility,
      status,
      participant_limit,
      viewer_limit,
      participant_count,
      viewer_count,
      created_at,
      max_ends_at,
      updated_at,
      provisioning_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    insert.bind(
      "room-public-ready",
      "public-ready-room",
      "user-room-fixture",
      "公開ルーム",
      "public",
      "active",
      20,
      100,
      3,
      8,
      NOW,
      NOW + 7_200_000,
      NOW,
      "ready",
    ),
    insert.bind(
      "room-unlisted",
      "unlisted-room",
      "user-room-fixture",
      "限定ルーム",
      "unlisted",
      "active",
      20,
      100,
      1,
      0,
      NOW,
      NOW + 7_200_000,
      NOW,
      "ready",
    ),
    insert.bind(
      "room-closing",
      "closing-room",
      "user-room-fixture",
      "終了処理中",
      "public",
      "closing",
      20,
      100,
      0,
      0,
      NOW,
      NOW + 7_200_000,
      NOW,
      "ready",
    ),
    insert.bind(
      "room-pending",
      "pending-room",
      "user-room-fixture",
      "準備中",
      "public",
      "waiting",
      20,
      100,
      0,
      0,
      NOW,
      NOW + 7_200_000,
      NOW,
      "pending",
    ),
  ]);
  await env.DB.prepare(
    "UPDATE rooms SET theme = '青いもの' WHERE id = 'room-public-ready'",
  ).run();
  await applySqlMigration(env.DB, removeRoomThemesMigration);
  await applySqlMigration(env.DB, roomThumbnailsMigration);
});

describe("public room projection", () => {
  it("clears themes stored by the retired room schema", async () => {
    await expect(
      env.DB.prepare(
        "SELECT theme FROM rooms WHERE id = 'room-public-ready'",
      ).first<{ theme: string | null }>(),
    ).resolves.toEqual({ theme: null });
  });

  it("returns only ready, live, public rooms", async () => {
    await expect(listPublicRooms(env.DB)).resolves.toEqual([
      {
        publicSlug: "public-ready-room",
        name: "公開ルーム",
        status: "active",
        participantCount: 3,
        participantLimit: 20,
        viewerCount: 8,
        viewerLimit: 100,
        createdAt: NOW,
        maxEndsAt: NOW + 7_200_000,
        thumbnailVersion: null,
      },
    ]);
  });

  it("serves the same projection from the public API", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=5, s-maxage=10",
    );
    await expect(response.json()).resolves.toMatchObject({
      rooms: [{ publicSlug: "public-ready-room" }],
    });
  });

  it("rejects guest room creation before invoking realtime", async () => {
    const response = await POST(new Request("http://koge.test/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "12345678-1234-4123-8123-123456789abc",
        origin: "http://koge.test",
      },
      body: JSON.stringify({
        name: "guest room",
        visibility: "public",
      }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "AUTHENTICATION_REQUIRED",
    });
  });

  it("requires a 256-bit invite token for unlisted room creation", () => {
    expect(() => parseCreateRoomInput({
      name: "unlisted room",
      visibility: "unlisted",
    })).toThrow("invalid room creation input");
    expect(parseCreateRoomInput({
      name: "unlisted room",
      visibility: "unlisted",
      inviteToken: "a".repeat(64),
    })).toEqual({
      name: "unlisted room",
      visibility: "unlisted",
      inviteToken: "a".repeat(64),
    });
  });

  it("rejects the removed theme setting", () => {
    expect(() => parseCreateRoomInput({
      name: "room",
      theme: "青いもの",
      visibility: "public",
    })).toThrow("invalid room creation input");
  });

  it("blocks only new create requests while emergency creation is paused", async () => {
    await env.DB.prepare(
      `UPDATE service_controls SET room_creation_enabled = 0
       WHERE singleton = 1`,
    ).run();
    await expect(createRoom(
      env.DB,
      { fetch: async () => Response.json({}) },
      "user-room-test",
      "create-request-paused",
      {
        name: "paused room",
        visibility: "public",
        inviteToken: null,
      },
      NOW,
    )).rejects.toBeInstanceOf(RoomCreationDisabledError);
    await env.DB.prepare(
      `UPDATE service_controls SET room_creation_enabled = 1
       WHERE singleton = 1`,
    ).run();
  });

  it("provisions one room and reuses the idempotent result", async () => {
    const requests: unknown[] = [];
    const realtime = {
      async fetch(_input: RequestInfo | URL, init?: RequestInit) {
        requests.push(init?.body);
        return Response.json({
          status: "initialized" as const,
          roomId: JSON.parse(String(init?.body)).roomId as string,
          createdAt: NOW,
          maxEndsAt: NOW + 7_200_000,
        });
      },
    };
    const input = {
      name: "新しい公開ルーム",
      visibility: "public" as const,
      inviteToken: null,
    };

    const created = await createRoom(
      env.DB,
      realtime,
      "user-room-test",
      "create-request-idempotent",
      input,
      NOW,
    );
    expect(created).toMatchObject({
      name: input.name,
      visibility: "public",
      reused: false,
    });
    expect(created.publicSlug).toMatch(/^[a-f0-9]{32}$/);
    expect(requests).toHaveLength(1);

    const repeated = await createRoom(
      env.DB,
      realtime,
      "user-room-test",
      "create-request-idempotent",
      input,
      NOW + 1,
    );
    expect(repeated).toMatchObject({
      roomId: created.roomId,
      publicSlug: created.publicSlug,
      reused: true,
    });
    expect(requests).toHaveLength(1);

    await expect(
      createRoom(
        env.DB,
        realtime,
        "user-room-test",
        "create-request-idempotent",
        { ...input, name: "別の設定" },
        NOW + 2,
      ),
    ).rejects.toBeInstanceOf(RoomCreationConflictError);
    await expect(listOwnedLiveRoomSlugs(env.DB, "user-room-test")).resolves
      .toContain(created.publicSlug);
  });

  it("stores only the invite hash and excludes unlisted rooms from discovery", async () => {
    const realtime = {
      async fetch(_input: RequestInfo | URL, init?: RequestInit) {
        const request = JSON.parse(String(init?.body)) as {
          roomId: string;
          createdAt: number;
          maxEndsAt: number;
        };
        return Response.json({
          status: "initialized" as const,
          roomId: request.roomId,
          createdAt: request.createdAt,
          maxEndsAt: request.maxEndsAt,
        });
      },
    };
    const inviteToken = "b".repeat(64);
    const input = {
      name: "招待リンク限定",
      visibility: "unlisted" as const,
      inviteToken,
    };
    const created = await createRoom(
      env.DB,
      realtime,
      "user-room-test",
      "create-request-unlisted",
      input,
      NOW + 3,
    );
    expect(created.visibility).toBe("unlisted");
    const invite = await env.DB.prepare(
      "SELECT token_hash FROM room_invites WHERE room_id = ?",
    ).bind(created.roomId).first<{ token_hash: string }>();
    expect(invite?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(invite?.token_hash).not.toBe(inviteToken);
    await expect(listPublicRooms(env.DB)).resolves.not.toContainEqual(
      expect.objectContaining({ publicSlug: created.publicSlug }),
    );

    const repeated = await createRoom(
      env.DB,
      realtime,
      "user-room-test",
      "create-request-unlisted",
      input,
      NOW + 4,
    );
    expect(repeated).toMatchObject({
      roomId: created.roomId,
      reused: true,
    });
    await expect(createRoom(
      env.DB,
      realtime,
      "user-room-test",
      "create-request-unlisted",
      { ...input, inviteToken: "c".repeat(64) },
      NOW + 5,
    )).rejects.toBeInstanceOf(RoomCreationConflictError);
  });

  it("marks failed provisioning and retries the same room", async () => {
    let attempt = 0;
    const realtime = {
      async fetch(_input: RequestInfo | URL, init?: RequestInit) {
        attempt += 1;
        if (attempt === 1) throw new Error("injected realtime failure");
        const request = JSON.parse(String(init?.body)) as {
          roomId: string;
          createdAt: number;
          maxEndsAt: number;
        };
        return Response.json({
          status: "initialized" as const,
          roomId: request.roomId,
          createdAt: request.createdAt,
          maxEndsAt: request.maxEndsAt,
        });
      },
    };
    const input = {
      name: "再試行ルーム",
      visibility: "public" as const,
      inviteToken: null,
    };

    await expect(
      createRoom(
        env.DB,
        realtime,
        "user-room-test",
        "create-request-retry",
        input,
        NOW + 10,
      ),
    ).rejects.toBeInstanceOf(RoomProvisioningError);
    const failed = await env.DB.prepare(
      `SELECT id, provisioning_status, provisioning_attempts
       FROM rooms WHERE create_request_id = ?`,
    ).bind("create-request-retry").first<{
      id: string;
      provisioning_status: string;
      provisioning_attempts: number;
    }>();
    expect(failed).toMatchObject({
      provisioning_status: "failed",
      provisioning_attempts: 1,
    });

    const retried = await createRoom(
      env.DB,
      realtime,
      "user-room-test",
      "create-request-retry",
      input,
      NOW + 20,
    );
    expect(retried.roomId).toBe(failed?.id);
    expect(retried.reused).toBe(true);
    await expect(
      env.DB.prepare(
        `SELECT provisioning_status, provisioning_attempts
         FROM rooms WHERE id = ?`,
      ).bind(retried.roomId).first(),
    ).resolves.toMatchObject({
      provisioning_status: "ready",
      provisioning_attempts: 2,
    });
  });

  it("enforces the live room limit in the insert statement", async () => {
    let initializationCount = 0;
    const realtime = {
      async fetch(_input: RequestInfo | URL, init?: RequestInit) {
        initializationCount += 1;
        const request = JSON.parse(String(init?.body)) as {
          roomId: string;
          createdAt: number;
          maxEndsAt: number;
        };
        return Response.json({
          status: "initialized" as const,
          roomId: request.roomId,
          createdAt: request.createdAt,
          maxEndsAt: request.maxEndsAt,
        });
      },
    };
    const input = {
      name: "上限確認",
      visibility: "public" as const,
      inviteToken: null,
    };

    for (let index = 0; index < 3; index += 1) {
      // Sequential creation is the behavior under test for the live-room count.
      // oxlint-disable-next-line no-await-in-loop
      await createRoom(
        env.DB,
        realtime,
        "user-limit-test",
        `limit-request-${index}`,
        input,
        NOW + index,
      );
    }
    await expect(
      createRoom(
        env.DB,
        realtime,
        "user-limit-test",
        "limit-request-overflow",
        input,
        NOW + 3,
      ),
    ).rejects.toThrow("owner live room limit reached");
    expect(initializationCount).toBe(3);
  });
});
