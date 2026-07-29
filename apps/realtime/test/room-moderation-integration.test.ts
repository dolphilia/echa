import {
  ROOM_MAX_DURATION_MS,
  ROOM_MODERATION_VERSION,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_PROVISIONING_VERSION,
  ROOM_VIEWER_LIMIT,
  type RoomModerationRequest,
  type RoomProvisioningRequest,
} from "@koge/protocol";
import { applyD1Migrations } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, inject, it } from "vitest";

it("applies idempotent suspend and close actions through the private service", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const ownerId = "owner-moderation-integration";
  const roomId = "room-moderation-integration";
  const publicSlug = "fedcba9876543210fedcba9876543210";
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt
    ) VALUES (?, ?, ?, 1, ?, ?)`,
  ).bind(
    ownerId,
    "Moderation owner",
    "moderation-integration@example.invalid",
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
    "Moderation integration",
    ROOM_PARTICIPANT_LIMIT,
    ROOM_VIEWER_LIMIT,
    now,
    now + ROOM_MAX_DURATION_MS,
    now,
  ).run();
  const room = env.DRAWING_ROOM.getByName(roomId);
  await room.initializeRoom({
    v: ROOM_PROVISIONING_VERSION,
    roomId,
    publicSlug,
    ownerUserId: ownerId,
    name: "Moderation integration",
    visibility: "unlisted",
    participantLimit: ROOM_PARTICIPANT_LIMIT,
    viewerLimit: ROOM_VIEWER_LIMIT,
    viewerChatEnabled: false,
    viewerStampEnabled: false,
    createdAt: now,
    maxEndsAt: now + ROOM_MAX_DURATION_MS,
  } as const satisfies RoomProvisioningRequest);

  const suspendRequest = {
    v: ROOM_MODERATION_VERSION,
    actionId: "moderation-integration-suspend",
    roomId,
    actorAdminId: "admin-moderation-integration",
    action: "suspend_room",
    reason: "Safety review",
    requestedAt: now + 1,
  } as const satisfies RoomModerationRequest;
  const suspendResponse = await exports.RoomProvisioningService.fetch(
    "https://room-control.internal/rooms/moderation",
    {
      method: "POST",
      body: JSON.stringify(suspendRequest),
    },
  );
  expect(suspendResponse.status).toBe(200);
  await expect(suspendResponse.json()).resolves.toMatchObject({
    status: "applied",
    action: "suspend_room",
    lifecycle: { status: "suspended" },
  });
  await expect(env.DB.prepare(
    `SELECT status, result_json FROM moderation_actions WHERE id = ?`,
  ).bind(suspendRequest.actionId).first<{
    status: string;
    result_json: string | null;
  }>()).resolves.toMatchObject({
    status: "applied",
    result_json: expect.any(String),
  });
  await expect(env.DB.prepare(
    "SELECT status FROM rooms WHERE id = ?",
  ).bind(roomId).first<{ status: string }>()).resolves.toEqual({
    status: "suspended",
  });

  const duplicateResponse = await exports.RoomProvisioningService.fetch(
    "https://room-control.internal/rooms/moderation",
    {
      method: "POST",
      body: JSON.stringify(suspendRequest),
    },
  );
  expect(duplicateResponse.status).toBe(200);
  await expect(duplicateResponse.json()).resolves.toMatchObject({
    status: "already_applied",
    lifecycle: { status: "suspended" },
  });
  await expect(env.DB.prepare(
    "SELECT COUNT(*) AS count FROM moderation_actions WHERE id = ?",
  ).bind(suspendRequest.actionId).first<{ count: number }>()).resolves.toEqual({
    count: 1,
  });

  const conflictResponse = await exports.RoomProvisioningService.fetch(
    "https://room-control.internal/rooms/moderation",
    {
      method: "POST",
      body: JSON.stringify({
        ...suspendRequest,
        reason: "Different reason",
      }),
    },
  );
  expect(conflictResponse.status).toBe(409);

  const closeRequest = {
    v: ROOM_MODERATION_VERSION,
    actionId: "moderation-integration-close",
    roomId,
    actorAdminId: "admin-moderation-integration",
    action: "close_room",
    reason: "Review complete; remove room",
    requestedAt: now + 2,
  } as const satisfies RoomModerationRequest;
  const closeResponse = await exports.RoomProvisioningService.fetch(
    "https://room-control.internal/rooms/moderation",
    {
      method: "POST",
      body: JSON.stringify(closeRequest),
    },
  );
  expect(closeResponse.status).toBe(200);
  await expect(closeResponse.json()).resolves.toMatchObject({
    status: "applied",
    action: "close_room",
    lifecycle: {
      status: "closing",
      reason: "admin",
      closeRequestId: closeRequest.actionId,
    },
  });
  await expect(env.DB.prepare(
    `SELECT status, cleanup_job_id FROM rooms WHERE id = ?`,
  ).bind(roomId).first<{
    status: string;
    cleanup_job_id: string | null;
  }>()).resolves.toEqual({
    status: "closing",
    cleanup_job_id: closeRequest.actionId,
  });
});

it("room-bans a non-host member and persists the re-entry fence", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const ownerId = "owner-member-moderation";
  const memberId = "user-member-moderation";
  const roomId = "room-member-moderation";
  const actorId = "actor-member-moderation";
  const publicSlug = "0123456789abcdef0123456789abcdef";
  const insertUser = env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt
    ) VALUES (?, ?, ?, 1, ?, ?)`,
  );
  await env.DB.batch([
    insertUser.bind(
      ownerId,
      "Member moderation owner",
      "member-moderation-owner@example.invalid",
      now,
      now,
    ),
    insertUser.bind(
      memberId,
      "Moderated member",
      "moderated-member@example.invalid",
      now,
      now,
    ),
  ]);
  await env.DB.prepare(
    `INSERT INTO rooms (
      id, public_slug, owner_user_id, name, theme, visibility, status,
      participant_limit, viewer_limit, viewer_chat_enabled,
      viewer_stamp_enabled, created_at, max_ends_at, updated_at,
      provisioning_status
    ) VALUES (?, ?, ?, ?, NULL, 'public', 'waiting', ?, ?, 0, 0, ?, ?, ?,
              'ready')`,
  ).bind(
    roomId,
    publicSlug,
    ownerId,
    "Member moderation integration",
    ROOM_PARTICIPANT_LIMIT,
    ROOM_VIEWER_LIMIT,
    now,
    now + ROOM_MAX_DURATION_MS,
    now,
  ).run();
  await env.DB.prepare(
    `INSERT INTO room_memberships (
       room_id, subject_kind, subject_id, actor_id, role,
       created_at, last_seen_at
     ) VALUES (?, 'user', ?, ?, 'participant', ?, ?)`,
  ).bind(roomId, memberId, actorId, now, now).run();
  const room = env.DRAWING_ROOM.getByName(roomId);
  await room.initializeRoom({
    v: ROOM_PROVISIONING_VERSION,
    roomId,
    publicSlug,
    ownerUserId: ownerId,
    name: "Member moderation integration",
    visibility: "public",
    participantLimit: ROOM_PARTICIPANT_LIMIT,
    viewerLimit: ROOM_VIEWER_LIMIT,
    viewerChatEnabled: false,
    viewerStampEnabled: false,
    createdAt: now,
    maxEndsAt: now + ROOM_MAX_DURATION_MS,
  } as const satisfies RoomProvisioningRequest);

  const request = {
    v: ROOM_MODERATION_VERSION,
    actionId: "moderation-integration-room-ban",
    roomId,
    actorAdminId: "admin-member-moderation",
    action: "room_ban",
    targetActorId: actorId,
    reason: "Repeated abuse",
    requestedAt: now + 1,
  } as const satisfies RoomModerationRequest;
  const response = await exports.RoomProvisioningService.fetch(
    "https://room-control.internal/rooms/moderation",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    status: "applied",
    action: "room_ban",
    targetActorId: actorId,
    disconnectedConnectionCount: 0,
    banExpiresAt: now + ROOM_MAX_DURATION_MS,
  });
  await expect(env.DB.prepare(
    `SELECT subject_kind, subject_id, actor_id, expires_at
     FROM bans WHERE room_id = ?`,
  ).bind(roomId).first()).resolves.toEqual({
    subject_kind: "user",
    subject_id: memberId,
    actor_id: actorId,
    expires_at: now + ROOM_MAX_DURATION_MS,
  });

  const duplicate = await exports.RoomProvisioningService.fetch(
    "https://room-control.internal/rooms/moderation",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  expect(duplicate.status).toBe(200);
  await expect(duplicate.json()).resolves.toMatchObject({
    status: "already_applied",
    action: "room_ban",
  });
});

it("temporarily service-bans a subject and persists an idempotent audit result", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const ownerId = "owner-service-ban";
  const memberId = "user-service-ban";
  const roomId = "room-service-ban-integration";
  const actorId = "actor-service-ban-integration";
  const publicSlug = "1123456789abcdef1123456789abcdef";
  const insertUser = env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt
    ) VALUES (?, ?, ?, 1, ?, ?)`,
  );
  await env.DB.batch([
    insertUser.bind(
      ownerId,
      "Service ban owner",
      "service-ban-owner@example.invalid",
      now,
      now,
    ),
    insertUser.bind(
      memberId,
      "Service banned member",
      "service-banned-member@example.invalid",
      now,
      now,
    ),
  ]);
  await env.DB.prepare(
    `INSERT INTO rooms (
      id, public_slug, owner_user_id, name, theme, visibility, status,
      participant_limit, viewer_limit, viewer_chat_enabled,
      viewer_stamp_enabled, created_at, max_ends_at, updated_at,
      provisioning_status
    ) VALUES (?, ?, ?, ?, NULL, 'public', 'waiting', ?, ?, 0, 0, ?, ?, ?,
              'ready')`,
  ).bind(
    roomId,
    publicSlug,
    ownerId,
    "Service ban integration",
    ROOM_PARTICIPANT_LIMIT,
    ROOM_VIEWER_LIMIT,
    now,
    now + ROOM_MAX_DURATION_MS,
    now,
  ).run();
  await env.DB.prepare(
    `INSERT INTO room_memberships (
       room_id, subject_kind, subject_id, actor_id, role,
       created_at, last_seen_at
     ) VALUES (?, 'user', ?, ?, 'participant', ?, ?)`,
  ).bind(roomId, memberId, actorId, now, now).run();
  const room = env.DRAWING_ROOM.getByName(roomId);
  await room.initializeRoom({
    v: ROOM_PROVISIONING_VERSION,
    roomId,
    publicSlug,
    ownerUserId: ownerId,
    name: "Service ban integration",
    visibility: "public",
    participantLimit: ROOM_PARTICIPANT_LIMIT,
    viewerLimit: ROOM_VIEWER_LIMIT,
    viewerChatEnabled: false,
    viewerStampEnabled: false,
    createdAt: now,
    maxEndsAt: now + ROOM_MAX_DURATION_MS,
  } as const satisfies RoomProvisioningRequest);

  const request = {
    v: ROOM_MODERATION_VERSION,
    actionId: "moderation-integration-service-ban",
    roomId,
    actorAdminId: "admin-service-moderation",
    action: "service_ban",
    targetActorId: actorId,
    banDurationHours: 168,
    reason: "Cross-room abuse",
    requestedAt: now + 1,
  } as const satisfies RoomModerationRequest;
  const response = await exports.RoomProvisioningService.fetch(
    "https://room-control.internal/rooms/moderation",
    { method: "POST", body: JSON.stringify(request) },
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    status: "applied",
    action: "service_ban",
    targetActorId: actorId,
    disconnectedConnectionCount: 0,
    affectedRoomCount: 1,
    banExpiresAt: now + 1 + 168 * 60 * 60 * 1_000,
  });
  await expect(env.DB.prepare(
    `SELECT subject_kind, subject_id, expires_at, revoked_at
     FROM service_bans WHERE action_id = ?`,
  ).bind(request.actionId).first()).resolves.toEqual({
    subject_kind: "user",
    subject_id: memberId,
    expires_at: now + 1 + 168 * 60 * 60 * 1_000,
    revoked_at: null,
  });

  const duplicate = await exports.RoomProvisioningService.fetch(
    "https://room-control.internal/rooms/moderation",
    { method: "POST", body: JSON.stringify(request) },
  );
  expect(duplicate.status).toBe(200);
  await expect(duplicate.json()).resolves.toMatchObject({
    status: "already_applied",
    action: "service_ban",
  });
});
