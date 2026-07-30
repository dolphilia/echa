import {
  ROOM_MAX_DURATION_MS,
  ROOM_NAME_MAX_LENGTH,
  ROOM_PROVISIONING_VERSION,
  validateRoomProvisioningRequest,
  validateRoomProvisioningResult,
  type RoomProvisioningRequest,
  type RoomVisibility,
} from "@koge/protocol";
import { assertSubjectNotServiceBanned } from "./service-bans";

export const PUBLIC_ROOM_LIMIT = 24;
export const OWNER_LIVE_ROOM_LIMIT = 1;

export type PublicRoom = {
  publicSlug: string;
  name: string;
  status: "waiting" | "active" | "idle";
  participantCount: number;
  participantLimit: number;
  viewerCount: number;
  viewerLimit: number;
  ownerName: string;
  ownerImage: string | null;
  createdAt: number;
  maxEndsAt: number;
  thumbnailVersion: number | null;
};

export type RoomDisplayInfo = {
  name: string;
};

type PublicRoomRow = {
  public_slug: string;
  name: string;
  status: PublicRoom["status"];
  participant_count: number;
  participant_limit: number;
  viewer_count: number;
  viewer_limit: number;
  owner_name: string;
  owner_image: string | null;
  created_at: number;
  max_ends_at: number;
  thumbnail_base_room_seq: number | null;
};

export type CreateRoomInput = {
  name: string;
  visibility: RoomVisibility;
  inviteToken: string | null;
};

export type CreatedRoom = {
  roomId: string;
  publicSlug: string;
  name: string;
  visibility: RoomVisibility;
  status: "waiting";
  createdAt: number;
  maxEndsAt: number;
  reused: boolean;
};

type ProvisioningRoomRow = {
  id: string;
  public_slug: string;
  owner_user_id: string;
  name: string;
  visibility: RoomVisibility;
  status: "waiting";
  participant_limit: number;
  viewer_limit: number;
  viewer_chat_enabled: number;
  viewer_stamp_enabled: number;
  created_at: number;
  max_ends_at: number;
  provisioning_status: "pending" | "ready" | "failed";
};

export class RoomCreationConflictError extends Error {}
export class RoomCreationDisabledError extends Error {}
export class RoomCreationLimitError extends Error {}
export class SiteRoomCreationLimitError extends Error {}
export class RoomVisibilityRestrictedError extends Error {}
export class RoomProvisioningError extends Error {}

function codePointLength(value: string): number {
  return [...value].length;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCreateRoomInput(value: unknown): CreateRoomInput {
  if (!isRecord(value)) throw new TypeError("request body must be an object");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const visibility = value.visibility;
  const inviteToken = value.inviteToken;
  if (
    codePointLength(name) < 1
    || codePointLength(name) > ROOM_NAME_MAX_LENGTH
    || "theme" in value
    || (visibility !== "public" && visibility !== "unlisted")
    || (
      visibility === "public"
      && inviteToken !== undefined
      && inviteToken !== null
    )
    || (
      visibility === "unlisted"
      && (
        typeof inviteToken !== "string"
        || !/^[a-f0-9]{64}$/.test(inviteToken)
      )
    )
  ) {
    throw new TypeError("invalid room creation input");
  }
  return {
    name,
    visibility,
    inviteToken: visibility === "unlisted" ? inviteToken as string : null,
  };
}

function provisioningRequestFromRow(
  room: ProvisioningRoomRow,
): RoomProvisioningRequest {
  const request = {
    v: ROOM_PROVISIONING_VERSION,
    roomId: room.id,
    publicSlug: room.public_slug,
    ownerUserId: room.owner_user_id,
    name: room.name,
    visibility: room.visibility,
    participantLimit: room.participant_limit,
    viewerLimit: room.viewer_limit,
    viewerChatEnabled: room.viewer_chat_enabled === 1,
    viewerStampEnabled: room.viewer_stamp_enabled === 1,
    createdAt: room.created_at,
    maxEndsAt: room.max_ends_at,
  } satisfies RoomProvisioningRequest;
  validateRoomProvisioningRequest(request);
  return request;
}

function createdRoomFromRow(
  room: ProvisioningRoomRow,
  reused: boolean,
): CreatedRoom {
  return {
    roomId: room.id,
    publicSlug: room.public_slug,
    name: room.name,
    visibility: room.visibility,
    status: room.status,
    createdAt: room.created_at,
    maxEndsAt: room.max_ends_at,
    reused,
  };
}

async function findRoomByCreateRequest(
  database: D1Database,
  ownerUserId: string,
  createRequestId: string,
): Promise<ProvisioningRoomRow | null> {
  return await database.prepare(
    `SELECT
       id, public_slug, owner_user_id, name, visibility, status,
       participant_limit, viewer_limit, viewer_chat_enabled,
       viewer_stamp_enabled, created_at, max_ends_at, provisioning_status
     FROM rooms
     WHERE owner_user_id = ? AND create_request_id = ?`,
  ).bind(ownerUserId, createRequestId).first<ProvisioningRoomRow>();
}

async function assertInviteMatches(
  database: D1Database,
  room: ProvisioningRoomRow,
  input: CreateRoomInput,
): Promise<void> {
  if (room.visibility !== "unlisted") return;
  if (!input.inviteToken) {
    throw new RoomCreationConflictError("unlisted invite token is missing");
  }
  const invite = await database.prepare(
    `SELECT token_hash
     FROM room_invites
     WHERE room_id = ? AND revoked_at IS NULL`,
  ).bind(room.id).first<{ token_hash: string }>();
  if (!invite || invite.token_hash !== await sha256Hex(input.inviteToken)) {
    throw new RoomCreationConflictError(
      "idempotency key was used with a different invite token",
    );
  }
}

function assertIdempotentInput(
  room: ProvisioningRoomRow,
  input: CreateRoomInput,
): void {
  if (
    room.name !== input.name
    || room.visibility !== input.visibility
  ) {
    throw new RoomCreationConflictError(
      "idempotency key was used with different room settings",
    );
  }
}

export async function createRoom(
  database: D1Database,
  realtime: Pick<Fetcher, "fetch">,
  ownerUserId: string,
  createRequestId: string,
  input: CreateRoomInput,
  now = Date.now(),
): Promise<CreatedRoom> {
  await assertSubjectNotServiceBanned(
    database,
    { kind: "user", id: ownerUserId },
    now,
  );
  let room = await findRoomByCreateRequest(
    database,
    ownerUserId,
    createRequestId,
  );
  const reused = room !== null;
  if (room) {
    assertIdempotentInput(room, input);
    await assertInviteMatches(database, room, input);
    if (room.provisioning_status === "ready") {
      return createdRoomFromRow(room, true);
    }
  } else {
    const controls = await database.prepare(
      `SELECT room_creation_enabled
       FROM service_controls WHERE singleton = 1`,
    ).first<{ room_creation_enabled: number }>();
    if (controls?.room_creation_enabled !== 1) {
      throw new RoomCreationDisabledError(
        "room creation is paused by emergency control",
      );
    }
    const roomId = crypto.randomUUID();
    const publicSlug = randomHex(16);
    const maxEndsAt = now + ROOM_MAX_DURATION_MS;
    const inviteHash = input.inviteToken
      ? await sha256Hex(input.inviteToken)
      : null;
    try {
      const roomInsert = database.prepare(
        `INSERT INTO rooms (
          id, public_slug, owner_user_id, name, visibility, status,
          participant_limit, viewer_limit, participant_count, viewer_count,
          viewer_chat_enabled, viewer_stamp_enabled, created_at, max_ends_at,
          updated_at, provisioning_status, create_request_id,
          provisioning_attempts, provisioning_updated_at
        )
        SELECT
          ?, ?, ?, ?, ?, 'waiting',
          capacity.participant_limit, capacity.viewer_limit,
          0, 0, 0, 0, ?, ?, ?,
          'pending', ?, 0, ?
        FROM service_capacity_limits AS capacity
        WHERE (
          SELECT COUNT(*)
          FROM rooms
          WHERE owner_user_id = ?
            AND provisioning_status IN ('pending', 'ready')
            AND status IN ('waiting', 'active', 'idle', 'suspended')
        ) < ?
        AND (
          SELECT COUNT(*)
          FROM rooms
          WHERE provisioning_status IN ('pending', 'ready')
            AND status IN ('waiting', 'active', 'idle', 'suspended')
        ) < capacity.live_room_limit
        AND (capacity.public_rooms_only = 0 OR ? = 'public')
        AND EXISTS (
          SELECT 1 FROM service_controls
          WHERE singleton = 1 AND room_creation_enabled = 1
        )`,
      ).bind(
        roomId,
        publicSlug,
        ownerUserId,
        input.name,
        input.visibility,
        now,
        maxEndsAt,
        now,
        createRequestId,
        now,
        ownerUserId,
        OWNER_LIVE_ROOM_LIMIT,
        input.visibility,
      );
      const results = await database.batch([
        roomInsert,
        ...(inviteHash
          ? [
              database.prepare(
                `INSERT INTO room_invites (
                   id, room_id, token_hash, created_by_user_id,
                   created_at, expires_at, revoked_at
                 )
                 SELECT ?, ?, ?, ?, ?, ?, NULL
                 WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ?)`,
              ).bind(
                crypto.randomUUID(),
                roomId,
                inviteHash,
                ownerUserId,
                now,
                maxEndsAt,
                roomId,
              ),
            ]
          : []),
      ]);
      if (results[0]?.meta.changes !== 1) {
        const latestControls = await database.prepare(
          `SELECT room_creation_enabled
           FROM service_controls WHERE singleton = 1`,
        ).first<{ room_creation_enabled: number }>();
        if (latestControls?.room_creation_enabled !== 1) {
          throw new RoomCreationDisabledError(
            "room creation is paused by emergency control",
          );
        }
        const capacity = await database.prepare(
          `SELECT
             limits.live_room_limit,
             limits.public_rooms_only,
             (
               SELECT COUNT(*) FROM rooms
               WHERE owner_user_id = ?
                 AND provisioning_status IN ('pending', 'ready')
                 AND status IN ('waiting', 'active', 'idle', 'suspended')
             ) AS owner_live_rooms,
             (
               SELECT COUNT(*) FROM rooms
               WHERE provisioning_status IN ('pending', 'ready')
                 AND status IN ('waiting', 'active', 'idle', 'suspended')
             ) AS live_rooms
           FROM service_capacity_limits AS limits
           WHERE limits.singleton = 1`,
        ).bind(ownerUserId).first<{
          live_room_limit: number;
          public_rooms_only: number;
          owner_live_rooms: number;
          live_rooms: number;
        }>();
        if (
          input.visibility === "unlisted"
          && capacity?.public_rooms_only === 1
        ) {
          throw new RoomVisibilityRestrictedError(
            "unlisted room creation is disabled",
          );
        }
        if (
          capacity
          && capacity.live_rooms >= capacity.live_room_limit
          && capacity.owner_live_rooms < OWNER_LIVE_ROOM_LIMIT
        ) {
          throw new SiteRoomCreationLimitError(
            "site live room limit reached",
          );
        }
        throw new RoomCreationLimitError("owner live room limit reached");
      }
    } catch (error) {
      room = await findRoomByCreateRequest(
        database,
        ownerUserId,
        createRequestId,
      );
      if (!room) throw error;
      assertIdempotentInput(room, input);
      await assertInviteMatches(database, room, input);
    }
    room ??= await findRoomByCreateRequest(
      database,
      ownerUserId,
      createRequestId,
    );
    if (!room) throw new Error("pending room was not persisted");
  }

  const request = provisioningRequestFromRow(room);
  const provisioningClaim = await database.prepare(
    `UPDATE rooms
     SET provisioning_status = 'pending',
         provisioning_attempts = provisioning_attempts + 1,
         provisioning_error_code = NULL,
         provisioning_updated_at = ?,
         updated_at = ?
     WHERE id = ?
       AND provisioning_status IN ('pending', 'failed')
       AND status IN ('waiting', 'active', 'idle', 'suspended')
       AND NOT EXISTS (
         SELECT 1
         FROM rooms AS other
         WHERE other.owner_user_id = ?
           AND other.id <> ?
           AND other.provisioning_status IN ('pending', 'ready')
           AND other.status IN ('waiting', 'active', 'idle', 'suspended')
       )`,
  ).bind(now, now, room.id, ownerUserId, room.id).run();
  if (provisioningClaim.meta.changes !== 1) {
    const latestRoom = await findRoomByCreateRequest(
      database,
      ownerUserId,
      createRequestId,
    );
    if (latestRoom?.provisioning_status === "ready") {
      return createdRoomFromRow(latestRoom, true);
    }
    const competingRoom = await database.prepare(
      `SELECT 1
       FROM rooms
       WHERE owner_user_id = ?
         AND id <> ?
         AND provisioning_status IN ('pending', 'ready')
         AND status IN ('waiting', 'active', 'idle', 'suspended')
       LIMIT 1`,
    ).bind(ownerUserId, room.id).first();
    if (competingRoom) {
      throw new RoomCreationLimitError("owner live room limit reached");
    }
    throw new RoomProvisioningError("room is no longer provisionable");
  }

  try {
    const response = await realtime.fetch(
      "https://room-provisioning.internal/rooms/initialize",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok) {
      throw new Error(`realtime initialization returned ${response.status}`);
    }
    const result: unknown = await response.json();
    validateRoomProvisioningResult(result);
    if (result.roomId !== room.id) {
      throw new Error("realtime initialized a different room");
    }
  } catch (error) {
    await database.prepare(
      `UPDATE rooms
       SET provisioning_status = 'failed',
           provisioning_error_code = 'REALTIME_INIT_FAILED',
           provisioning_updated_at = ?,
           updated_at = ?
       WHERE id = ? AND provisioning_status = 'pending'`,
    ).bind(Date.now(), Date.now(), room.id).run();
    console.error(JSON.stringify({
      level: "error",
      message: "room provisioning failed",
      roomId: room.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw new RoomProvisioningError("realtime room initialization failed");
  }

  await database.prepare(
    `UPDATE rooms
     SET provisioning_status = 'ready',
         provisioning_error_code = NULL,
         provisioning_updated_at = ?,
         updated_at = ?
     WHERE id = ? AND provisioning_status = 'pending'`,
  ).bind(Date.now(), Date.now(), room.id).run();
  return createdRoomFromRow(room, reused);
}

export async function listPublicRooms(
  database: D1Database,
  limit = PUBLIC_ROOM_LIMIT,
): Promise<PublicRoom[]> {
  const boundedLimit = Math.max(1, Math.min(PUBLIC_ROOM_LIMIT, limit));
  const result = await database
    .prepare(
      `SELECT
         rooms.public_slug AS public_slug,
         rooms.name AS name,
         rooms.status AS status,
         rooms.participant_count AS participant_count,
         rooms.participant_limit AS participant_limit,
         rooms.viewer_count AS viewer_count,
         rooms.viewer_limit AS viewer_limit,
         owner.name AS owner_name,
         owner.image AS owner_image,
         rooms.created_at AS created_at,
         rooms.max_ends_at AS max_ends_at,
         rooms.thumbnail_base_room_seq AS thumbnail_base_room_seq
       FROM rooms
       INNER JOIN "user" AS owner ON owner.id = rooms.owner_user_id
       WHERE rooms.visibility = 'public'
         AND rooms.provisioning_status = 'ready'
         AND rooms.status IN ('waiting', 'active', 'idle')
       ORDER BY
         CASE rooms.status
           WHEN 'active' THEN 0
           WHEN 'waiting' THEN 1
           ELSE 2
         END,
         rooms.updated_at DESC
       LIMIT ?`,
    )
    .bind(boundedLimit)
    .all<PublicRoomRow>();

  return result.results.map((room) => ({
    publicSlug: room.public_slug,
    name: room.name,
    status: room.status,
    participantCount: room.participant_count,
    participantLimit: room.participant_limit,
    viewerCount: room.viewer_count,
    viewerLimit: room.viewer_limit,
    ownerName: room.owner_name,
    ownerImage: room.owner_image,
    createdAt: room.created_at,
    maxEndsAt: room.max_ends_at,
    thumbnailVersion: room.thumbnail_base_room_seq,
  }));
}

export async function getLiveRoomDisplayInfo(
  database: D1Database,
  publicSlug: string,
): Promise<RoomDisplayInfo | null> {
  return await database.prepare(
    `SELECT name
     FROM rooms
     WHERE public_slug = ?
       AND provisioning_status = 'ready'
       AND status IN ('waiting', 'active', 'idle')
     LIMIT 1`,
  ).bind(publicSlug).first<RoomDisplayInfo>();
}

export async function listOwnedLiveRoomSlugs(
  database: D1Database,
  ownerUserId: string,
): Promise<Set<string>> {
  const result = await database.prepare(
    `SELECT public_slug
     FROM rooms
     WHERE owner_user_id = ?
       AND provisioning_status = 'ready'
       AND status IN ('waiting', 'active', 'idle')`,
  ).bind(ownerUserId).all<{ public_slug: string }>();
  return new Set(result.results.map((room) => room.public_slug));
}
