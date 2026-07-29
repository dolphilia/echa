import {
  ROOM_MAX_DURATION_MS,
  ROOM_NAME_MAX_LENGTH,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_PROVISIONING_VERSION,
  ROOM_THEME_MAX_LENGTH,
  ROOM_VIEWER_LIMIT,
  validateRoomProvisioningRequest,
  validateRoomProvisioningResult,
  type RoomProvisioningRequest,
  type RoomVisibility,
} from "@koge/protocol";
import { assertSubjectNotServiceBanned } from "./service-bans";

export const PUBLIC_ROOM_LIMIT = 24;
export const OWNER_LIVE_ROOM_LIMIT = 3;

export type PublicRoom = {
  publicSlug: string;
  name: string;
  theme: string | null;
  status: "waiting" | "active" | "idle";
  participantCount: number;
  participantLimit: number;
  viewerCount: number;
  viewerLimit: number;
  createdAt: number;
  maxEndsAt: number;
};

export type RoomDisplayInfo = {
  name: string;
  theme: string | null;
};

type PublicRoomRow = {
  public_slug: string;
  name: string;
  theme: string | null;
  status: PublicRoom["status"];
  participant_count: number;
  participant_limit: number;
  viewer_count: number;
  viewer_limit: number;
  created_at: number;
  max_ends_at: number;
};

export type CreateRoomInput = {
  name: string;
  theme: string | null;
  visibility: RoomVisibility;
  inviteToken: string | null;
};

export type CreatedRoom = {
  roomId: string;
  publicSlug: string;
  name: string;
  theme: string | null;
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
  theme: string | null;
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
  const themeValue = typeof value.theme === "string" ? value.theme.trim() : "";
  const visibility = value.visibility;
  const inviteToken = value.inviteToken;
  if (
    codePointLength(name) < 1
    || codePointLength(name) > ROOM_NAME_MAX_LENGTH
    || codePointLength(themeValue) > ROOM_THEME_MAX_LENGTH
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
    theme: themeValue || null,
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
    theme: room.theme,
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
    theme: room.theme,
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
       id, public_slug, owner_user_id, name, theme, visibility, status,
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
    || room.theme !== input.theme
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
          id, public_slug, owner_user_id, name, theme, visibility, status,
          participant_limit, viewer_limit, participant_count, viewer_count,
          viewer_chat_enabled, viewer_stamp_enabled, created_at, max_ends_at,
          updated_at, provisioning_status, create_request_id,
          provisioning_attempts, provisioning_updated_at
        )
        SELECT
          ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, 0, 0, 0, 0, ?, ?, ?,
          'pending', ?, 0, ?
        WHERE (
          SELECT COUNT(*)
          FROM rooms
          WHERE owner_user_id = ?
            AND provisioning_status IN ('pending', 'ready')
            AND status IN ('waiting', 'active', 'idle')
        ) < ?
        AND EXISTS (
          SELECT 1 FROM service_controls
          WHERE singleton = 1 AND room_creation_enabled = 1
        )`,
      ).bind(
        roomId,
        publicSlug,
        ownerUserId,
        input.name,
        input.theme,
        input.visibility,
        ROOM_PARTICIPANT_LIMIT,
        ROOM_VIEWER_LIMIT,
        now,
        maxEndsAt,
        now,
        createRequestId,
        now,
        ownerUserId,
        OWNER_LIVE_ROOM_LIMIT,
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
  await database.prepare(
    `UPDATE rooms
     SET provisioning_status = 'pending',
         provisioning_attempts = provisioning_attempts + 1,
         provisioning_error_code = NULL,
         provisioning_updated_at = ?,
         updated_at = ?
     WHERE id = ? AND provisioning_status IN ('pending', 'failed')`,
  ).bind(now, now, room.id).run();

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
         public_slug,
         name,
         theme,
         status,
         participant_count,
         participant_limit,
         viewer_count,
         viewer_limit,
         created_at,
         max_ends_at
       FROM rooms
       WHERE visibility = 'public'
         AND provisioning_status = 'ready'
         AND status IN ('waiting', 'active', 'idle')
       ORDER BY
         CASE status
           WHEN 'active' THEN 0
           WHEN 'waiting' THEN 1
           ELSE 2
         END,
         updated_at DESC
       LIMIT ?`,
    )
    .bind(boundedLimit)
    .all<PublicRoomRow>();

  return result.results.map((room) => ({
    publicSlug: room.public_slug,
    name: room.name,
    theme: room.theme,
    status: room.status,
    participantCount: room.participant_count,
    participantLimit: room.participant_limit,
    viewerCount: room.viewer_count,
    viewerLimit: room.viewer_limit,
    createdAt: room.created_at,
    maxEndsAt: room.max_ends_at,
  }));
}

export async function getLiveRoomDisplayInfo(
  database: D1Database,
  publicSlug: string,
): Promise<RoomDisplayInfo | null> {
  return await database.prepare(
    `SELECT name, theme
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
