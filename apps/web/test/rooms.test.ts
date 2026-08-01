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
import serviceCapacityMigration from "../../../migrations/d1/0021_service_capacity_limits.sql?raw";
import publicRoomVisibilityMigration from "../../../migrations/d1/0022_public_room_visibility_limit.sql?raw";
import { GET, POST } from "../app/api/rooms/route";
import {
  RoomCreationConflictError,
  RoomCreationDisabledError,
  RoomCreationLimitError,
  RoomProvisioningError,
  RoomVisibilityRestrictedError,
  SiteRoomCreationLimitError,
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
  await applySqlMigration(env.DB, serviceCapacityMigration);
  await applySqlMigration(env.DB, publicRoomVisibilityMigration);
  await applySqlMigration(env.DB, moderationMigration);
  await applySqlMigration(env.DB, serviceBansMigration);
  const insertUser = env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, image, createdAt, updatedAt, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    insertUser.bind(
      "user-room-test",
      "Room owner",
      "owner@example.test",
      1,
      null,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-room-fixture",
      "Fixture owner",
      "fixture@example.test",
      1,
      "https://example.test/fixture-owner.png",
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-limit-test",
      "Limit owner",
      "limit@example.test",
      1,
      null,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-unlisted-test",
      "Unlisted owner",
      "unlisted@example.test",
      1,
      null,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-retry-test",
      "Retry owner",
      "retry@example.test",
      1,
      null,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-retry-limit-test",
      "Retry limit owner",
      "retry-limit@example.test",
      1,
      null,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-site-limit-test",
      "Site limit owner",
      "site-limit@example.test",
      1,
      null,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-site-limit-test-two",
      "Second site limit owner",
      "site-limit-two@example.test",
      1,
      null,
      NOW,
      NOW,
      "active",
    ),
    insertUser.bind(
      "user-visibility-policy-test",
      "Visibility policy owner",
      "visibility-policy@example.test",
      1,
      null,
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
        ownerName: "Fixture owner",
        ownerImage: "https://example.test/fixture-owner.png",
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
      "user-unlisted-test",
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
      "user-unlisted-test",
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
      "user-unlisted-test",
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
        "user-retry-test",
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
      "user-retry-test",
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

  it("does not retry a failed projection beside another live room", async () => {
    const input = {
      name: "競合再試行",
      visibility: "public" as const,
      inviteToken: null,
    };
    await expect(createRoom(
      env.DB,
      { fetch: async () => {
        throw new Error("injected realtime failure");
      } },
      "user-retry-limit-test",
      "retry-limit-failed",
      input,
      NOW + 30,
    )).rejects.toBeInstanceOf(RoomProvisioningError);

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
    await createRoom(
      env.DB,
      realtime,
      "user-retry-limit-test",
      "retry-limit-live",
      input,
      NOW + 31,
    );
    await expect(createRoom(
      env.DB,
      realtime,
      "user-retry-limit-test",
      "retry-limit-failed",
      input,
      NOW + 32,
    )).rejects.toBeInstanceOf(RoomCreationLimitError);
    await expect(
      env.DB.prepare(
        `SELECT provisioning_status
         FROM rooms WHERE owner_user_id = ? ORDER BY created_at`,
      ).bind("user-retry-limit-test").all<{
        provisioning_status: string;
      }>(),
    ).resolves.toMatchObject({
      results: [
        { provisioning_status: "failed" },
        { provisioning_status: "ready" },
      ],
    });
  });

  it("allows one live room, rejects concurrent creation, and ignores closing rooms", async () => {
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

    const attempts = await Promise.allSettled([
      createRoom(
        env.DB,
        realtime,
        "user-limit-test",
        "limit-request-a",
        input,
        NOW,
      ),
      createRoom(
        env.DB,
        realtime,
        "user-limit-test",
        "limit-request-b",
        input,
        NOW,
      ),
    ]);
    const fulfilled = attempts.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof createRoom>>
      > => result.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(RoomCreationLimitError);
    expect(initializationCount).toBe(1);

    const firstRoom = fulfilled[0]?.value;
    expect(firstRoom).toBeDefined();
    await expect(
      createRoom(
        env.DB,
        realtime,
        "user-limit-test",
        "limit-request-overflow",
        input,
        NOW + 1,
      ),
    ).rejects.toThrow("owner live room limit reached");
    await env.DB.prepare(
      "UPDATE rooms SET status = 'closing' WHERE id = ?",
    ).bind(firstRoom?.roomId).run();

    const replacement = await createRoom(
      env.DB,
      realtime,
      "user-limit-test",
      "limit-request-after-close",
      input,
      NOW + 2,
    );
    expect(replacement.reused).toBe(false);
    expect(initializationCount).toBe(2);
    await expect(
      env.DB.prepare(
        `SELECT status FROM rooms
         WHERE owner_user_id = ? ORDER BY created_at`,
      ).bind("user-limit-test").all<{ status: string }>(),
    ).resolves.toMatchObject({
      results: [{ status: "closing" }, { status: "waiting" }],
    });

    await env.DB.prepare(
      "UPDATE rooms SET status = 'suspended' WHERE id = ?",
    ).bind(replacement.roomId).run();
    await expect(
      createRoom(
        env.DB,
        realtime,
        "user-limit-test",
        "limit-request-while-suspended",
        input,
        NOW + 3,
      ),
    ).rejects.toBeInstanceOf(RoomCreationLimitError);
  });

  it("rejects creation atomically when the site live-room limit is reached", async () => {
    const current = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM rooms
       WHERE provisioning_status IN ('pending', 'ready')
         AND status IN ('waiting', 'active', 'idle', 'suspended')`,
    ).first<{ count: number }>();
    const liveRoomLimit = (current?.count ?? 0) + 1;
    expect(liveRoomLimit).toBeLessThanOrEqual(20);
    await env.DB.prepare(
      `UPDATE service_capacity_limits
       SET live_room_limit = ?, participant_limit = 4, viewer_limit = 16
       WHERE singleton = 1`,
    ).bind(liveRoomLimit).run();
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
    try {
      const input = {
        name: "全体上限",
        visibility: "public" as const,
        inviteToken: null,
      };
      const attempts = await Promise.allSettled([
        createRoom(
          env.DB,
          realtime,
          "user-site-limit-test",
          "site-limit-request-one",
          input,
          NOW + 10,
        ),
        createRoom(
          env.DB,
          realtime,
          "user-site-limit-test-two",
          "site-limit-request-two",
          input,
          NOW + 10,
        ),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled"))
        .toHaveLength(1);
      const rejected = attempts.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(SiteRoomCreationLimitError);
    } finally {
      await env.DB.prepare(
        `UPDATE service_capacity_limits
         SET live_room_limit = 20, participant_limit = 10, viewer_limit = 10
         WHERE singleton = 1`,
      ).run();
    }
  });

  it("rejects new unlisted rooms when the public-only policy is enabled", async () => {
    await env.DB.prepare(
      `UPDATE service_capacity_limits
       SET public_rooms_only = 1
       WHERE singleton = 1`,
    ).run();
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
    try {
      await expect(createRoom(
        env.DB,
        realtime,
        "user-visibility-policy-test",
        "visibility-policy-unlisted",
        {
          name: "限定ルーム",
          visibility: "unlisted",
          inviteToken: "f".repeat(64),
        },
        NOW + 20,
      )).rejects.toBeInstanceOf(RoomVisibilityRestrictedError);
      await expect(
        env.DB.prepare(
          "SELECT 1 FROM rooms WHERE owner_user_id = ?",
        ).bind("user-visibility-policy-test").first(),
      ).resolves.toBeNull();

      await expect(createRoom(
        env.DB,
        realtime,
        "user-visibility-policy-test",
        "visibility-policy-public",
        {
          name: "公開ルーム",
          visibility: "public",
          inviteToken: null,
        },
        NOW + 21,
      )).resolves.toMatchObject({ visibility: "public" });
    } finally {
      await env.DB.prepare(
        `UPDATE service_capacity_limits
         SET public_rooms_only = 0
         WHERE singleton = 1`,
      ).run();
    }
  });
});
