import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import authMigration from "../../../migrations/d1/0002_better_auth.sql?raw";
import roomMigration from "../../../migrations/d1/0003_room_projection.sql?raw";
import provisioningMigration from "../../../migrations/d1/0004_room_provisioning.sql?raw";
import serviceControlsMigration from "../../../migrations/d1/0014_service_controls.sql?raw";
import serviceCapacityMigration from "../../../migrations/d1/0021_service_capacity_limits.sql?raw";
import publicRoomVisibilityMigration from "../../../migrations/d1/0022_public_room_visibility_limit.sql?raw";
import {
  AdminModerationConflictError,
  AdminModerationNotAvailableError,
  AdminModerationTargetForbiddenError,
  listAdminRoomMembers,
  listAdminRooms,
  parseAdminModerationInput,
  submitAdminModeration,
} from "../app/server/admin-moderation";
import { applySqlMigration } from "./migrations";
import {
  ServiceControlConflictError,
  applyServiceControls,
  parseServiceControlInput,
  readServiceControls,
} from "../app/server/service-controls";
import {
  ServiceCapacityLimitConflictError,
  applyServiceCapacityLimits,
  parseServiceCapacityLimitInput,
  readServiceCapacityLimits,
} from "../app/server/service-capacity";

const NOW = 1_785_400_000_000;

beforeAll(async () => {
  await applySqlMigration(env.DB, authMigration);
  await applySqlMigration(env.DB, roomMigration);
  await applySqlMigration(env.DB, provisioningMigration);
  await applySqlMigration(env.DB, serviceControlsMigration);
  await applySqlMigration(env.DB, serviceCapacityMigration);
  await applySqlMigration(env.DB, publicRoomVisibilityMigration);
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    "admin-room-owner",
    "Admin room owner",
    "admin-room-owner@example.test",
    1,
    NOW,
    NOW,
    "active",
  ).run();
  const insert = env.DB.prepare(
    `INSERT INTO rooms (
      id, public_slug, owner_user_id, name, theme, visibility, status,
      participant_limit, viewer_limit, participant_count, viewer_count,
      created_at, max_ends_at, updated_at, provisioning_status
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, 20, 100, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    insert.bind(
      "admin-room-active",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "admin-room-owner",
      "管理対象",
      "public",
      "active",
      2,
      4,
      NOW,
      NOW + 7_200_000,
      NOW + 100,
      "ready",
    ),
    insert.bind(
      "admin-room-suspended",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "admin-room-owner",
      "停止済み",
      "unlisted",
      "suspended",
      0,
      0,
      NOW,
      NOW + 7_200_000,
      NOW,
      "ready",
    ),
  ]);
});

describe("administrator moderation boundary", () => {
  it("applies bounded capacity limits and audits idempotently", async () => {
    expect(parseServiceCapacityLimitInput({
      liveRoomLimit: 12,
      participantLimit: 4,
      viewerLimit: 16,
      publicRoomsOnly: true,
      reason: "  staged capacity reduction  ",
    })).toEqual({
      liveRoomLimit: 12,
      participantLimit: 4,
      viewerLimit: 16,
      publicRoomsOnly: true,
      reason: "staged capacity reduction",
    });
    expect(() => parseServiceCapacityLimitInput({
      liveRoomLimit: 12,
      participantLimit: 4,
      viewerLimit: 17,
      publicRoomsOnly: true,
      reason: "over combined limit",
    })).toThrow("invalid capacity limit input");

    const input = {
      actionId: "capacity_12345678-1234-4123-8123-123456789abc",
      actorAdminId: "access_12345678-1234-4123-8123-123456789abc",
      limits: {
        liveRoomLimit: 12,
        participantLimit: 4,
        viewerLimit: 16,
        publicRoomsOnly: true,
        reason: "staged capacity reduction",
      },
      now: NOW,
    };
    await expect(applyServiceCapacityLimits(env.DB, input)).resolves
      .toMatchObject({
        status: "applied",
        limits: {
          revision: 1,
          liveRoomLimit: 12,
          participantLimit: 4,
          viewerLimit: 16,
          publicRoomsOnly: true,
        },
      });
    await expect(applyServiceCapacityLimits(env.DB, input)).resolves
      .toMatchObject({
        status: "already_applied",
        limits: { revision: 1 },
      });
    await expect(readServiceCapacityLimits(env.DB)).resolves.toMatchObject({
      revision: 1,
      liveRoomLimit: 12,
      participantLimit: 4,
      viewerLimit: 16,
      publicRoomsOnly: true,
    });
    await expect(applyServiceCapacityLimits(env.DB, {
      ...input,
      limits: { ...input.limits, viewerLimit: 15 },
    })).rejects.toBeInstanceOf(ServiceCapacityLimitConflictError);
  });

  it("applies and audits idempotent emergency controls", async () => {
    expect(parseServiceControlInput({
      roomCreationEnabled: false,
      roomEntryEnabled: true,
      drawingEnabled: false,
      reason: "  active incident  ",
    })).toEqual({
      roomCreationEnabled: false,
      roomEntryEnabled: true,
      drawingEnabled: false,
      reason: "active incident",
    });
    const input = {
      actionId: "emergency_12345678-1234-4123-8123-123456789abc",
      actorAdminId: "access_12345678-1234-4123-8123-123456789abc",
      controls: {
        roomCreationEnabled: false,
        roomEntryEnabled: true,
        drawingEnabled: false,
        reason: "active incident",
      },
      now: NOW,
    };
    await expect(applyServiceControls(env.DB, input)).resolves.toMatchObject({
      status: "applied",
      controls: {
        revision: 1,
        roomCreationEnabled: false,
        roomEntryEnabled: true,
        drawingEnabled: false,
      },
    });
    await expect(applyServiceControls(env.DB, input)).resolves.toMatchObject({
      status: "already_applied",
      controls: { revision: 1 },
    });
    await expect(readServiceControls(env.DB)).resolves.toMatchObject({
      revision: 1,
      roomCreationEnabled: false,
      drawingEnabled: false,
    });
    await expect(applyServiceControls(env.DB, {
      ...input,
      controls: { ...input.controls, drawingEnabled: true },
    })).rejects.toBeInstanceOf(ServiceControlConflictError);
    await applyServiceControls(env.DB, {
      ...input,
      actionId: "emergency_22345678-1234-4123-8123-123456789abc",
      controls: {
        roomCreationEnabled: true,
        roomEntryEnabled: true,
        drawingEnabled: true,
        reason: "incident resolved",
      },
      now: NOW + 1,
    });
  });
  it("lists ready live and suspended rooms for the protected console", async () => {
    await expect(listAdminRooms(env.DB)).resolves.toEqual([
      expect.objectContaining({
        id: "admin-room-active",
        status: "active",
        participantCount: 2,
        viewerCount: 4,
      }),
      expect.objectContaining({
        id: "admin-room-suspended",
        status: "suspended",
      }),
    ]);
  });

  it("normalizes a bounded action reason", () => {
    expect(parseAdminModerationInput({
      roomId: "admin-room-active",
      action: "suspend_room",
      reason: "  policy violation  ",
    })).toEqual({
      roomId: "admin-room-active",
      action: "suspend_room",
      reason: "policy violation",
    });
    expect(parseAdminModerationInput({
      roomId: "admin-room-active",
      action: "service_ban",
      targetActorId: "actor_12345678",
      banDurationHours: 168,
      reason: "  repeated cross-room abuse  ",
    })).toEqual({
      roomId: "admin-room-active",
      action: "service_ban",
      targetActorId: "actor_12345678",
      banDurationHours: 168,
      reason: "repeated cross-room abuse",
    });
    expect(() => parseAdminModerationInput({
      roomId: "short",
      action: "unknown",
      reason: "",
    })).toThrow("invalid moderation input");
    expect(parseAdminModerationInput({
      roomId: "admin-room-active",
      action: "room_ban",
      targetActorId: "actor_12345678",
      reason: "  repeated abuse  ",
    })).toEqual({
      roomId: "admin-room-active",
      action: "room_ban",
      targetActorId: "actor_12345678",
      reason: "repeated abuse",
    });
    expect(() => parseAdminModerationInput({
      roomId: "admin-room-active",
      action: "kick",
      reason: "missing target",
    })).toThrow("invalid moderation input");
  });

  it("lists active members through the private service binding", async () => {
    const fetch = vi.fn(async () => Response.json({
      members: [
        { actorId: "actor_12345678", role: "participant" },
        { actorId: "actor_87654321", role: "viewer" },
      ],
    }));
    await expect(listAdminRoomMembers(
      env.DB,
      { fetch },
      "admin-room-active",
    )).resolves.toEqual([
      { actorId: "actor_12345678", role: "participant" },
      { actorId: "actor_87654321", role: "viewer" },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends the Access subject only through the private service binding", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        v: 1,
        actionId: "admin_12345678-1234-4123-8123-123456789abc",
        roomId: "admin-room-active",
        actorAdminId: "access_12345678-1234-4123-8123-123456789abc",
        action: "suspend_room",
        reason: "policy violation",
        requestedAt: NOW,
      });
      return Response.json({
        status: "applied",
        actionId: body.actionId,
        roomId: body.roomId,
        action: body.action,
        lifecycle: {
          status: "suspended",
          changedAt: NOW,
        },
      });
    });
    await expect(submitAdminModeration({ fetch }, {
      actionId: "admin_12345678-1234-4123-8123-123456789abc",
      actorAdminId: "access_12345678-1234-4123-8123-123456789abc",
      moderation: {
        roomId: "admin-room-active",
        action: "suspend_room",
        reason: "policy violation",
      },
      now: NOW,
    })).resolves.toMatchObject({
      status: "applied",
      action: "suspend_room",
      lifecycle: { status: "suspended" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps unavailable and conflicting service results", async () => {
    const base = {
      actionId: "admin_12345678-1234-4123-8123-123456789abc",
      actorAdminId: "access_12345678-1234-4123-8123-123456789abc",
      moderation: {
        roomId: "admin-room-active",
        action: "close_room" as const,
        reason: "policy violation",
      },
    };
    await expect(submitAdminModeration({
      fetch: async () => Response.json({}, { status: 404 }),
    }, base)).rejects.toBeInstanceOf(AdminModerationNotAvailableError);
    await expect(submitAdminModeration({
      fetch: async () => Response.json({}, { status: 409 }),
    }, base)).rejects.toBeInstanceOf(AdminModerationConflictError);
    await expect(submitAdminModeration({
      fetch: async () => Response.json({}, { status: 403 }),
    }, base)).rejects.toBeInstanceOf(AdminModerationTargetForbiddenError);
  });

  it("submits a targeted room ban", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.targetActorId).toBe("actor_12345678");
      return Response.json({
        status: "applied",
        actionId: body.actionId,
        roomId: body.roomId,
        action: "room_ban",
        targetActorId: body.targetActorId,
        disconnectedConnectionCount: 1,
        banExpiresAt: NOW + 7_200_000,
      });
    });
    await expect(submitAdminModeration({ fetch }, {
      actionId: "admin_12345678-1234-4123-8123-123456789abc",
      actorAdminId: "access_12345678-1234-4123-8123-123456789abc",
      moderation: {
        roomId: "admin-room-active",
        action: "room_ban",
        targetActorId: "actor_12345678",
        reason: "repeated abuse",
      },
      now: NOW,
    })).resolves.toMatchObject({
      action: "room_ban",
      targetActorId: "actor_12345678",
      disconnectedConnectionCount: 1,
    });
  });
});
