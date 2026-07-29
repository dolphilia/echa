import {
  ROOM_TICKET_TTL_MS,
  ROOM_TICKET_VERSION,
  validateRoomTicketRegistrationResult,
  type RoomRole,
  type RoomTicketRegistrationRequest,
  type RoomTicketRegistrationResult,
} from "@koge/protocol";
import { assertSubjectNotServiceBanned } from "./service-bans";

export const GUEST_SESSION_COOKIE = "koge_guest";
export const GUEST_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

type RoomAccessRow = {
  id: string;
  owner_user_id: string;
  status: "waiting" | "active" | "idle";
  provisioning_status: "ready";
  visibility: "public" | "unlisted";
};

type MembershipRow = {
  actor_id: string;
  role: RoomRole;
};

type GuestSessionRow = {
  id: string;
};

type InviteRow = {
  id: string;
};

type UserProfileRow = {
  name: string;
  image: string | null;
};

export type RoomAccessSubject = {
  kind: "user" | "guest";
  id: string;
  setCookie?: string;
};

export type IssuedRoomTicket = RoomTicketRegistrationResult & {
  publicSlug: string;
  canChat: boolean;
};

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

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function guestCookie(token: string, secure: boolean): string {
  return [
    `${GUEST_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${GUEST_SESSION_TTL_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export async function resolveRoomAccessSubject(
  database: D1Database,
  options: {
    appEnvironment: string;
    cookieHeader: string | null;
    userId?: string;
    now?: number;
  },
): Promise<RoomAccessSubject> {
  if (options.userId) {
    return { kind: "user", id: options.userId };
  }

  const now = options.now ?? Date.now();
  const existingToken = readCookie(
    options.cookieHeader,
    GUEST_SESSION_COOKIE,
  );
  if (existingToken && /^[a-f0-9]{64}$/.test(existingToken)) {
    const tokenHash = await sha256Hex(existingToken);
    const existing = await database.prepare(
      `SELECT id
       FROM guest_sessions
       WHERE token_hash = ? AND expires_at > ?`,
    ).bind(tokenHash, now).first<GuestSessionRow>();
    if (existing) {
      await database.prepare(
        "UPDATE guest_sessions SET last_seen_at = ? WHERE id = ?",
      ).bind(now, existing.id).run();
      return { kind: "guest", id: existing.id };
    }
  }

  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const guestId = `guest_${crypto.randomUUID().replaceAll("-", "")}`;
  await database.prepare(
    `INSERT INTO guest_sessions (
       id, token_hash, created_at, expires_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    guestId,
    tokenHash,
    now,
    now + GUEST_SESSION_TTL_SECONDS * 1_000,
    now,
  ).run();
  return {
    kind: "guest",
    id: guestId,
    setCookie: guestCookie(token, options.appEnvironment !== "local"),
  };
}

export async function issueRoomTicket(
  database: D1Database,
  realtime: Pick<Fetcher, "fetch">,
  input: {
    publicSlug: string;
    requestedRole: "participant" | "viewer";
    inviteToken?: string;
    subject: RoomAccessSubject;
    now?: number;
  },
): Promise<IssuedRoomTicket> {
  if (!/^[a-f0-9]{32}$/.test(input.publicSlug)) {
    throw new TypeError("invalid public room slug");
  }
  const room = await database.prepare(
    `SELECT id, owner_user_id, status, provisioning_status, visibility
     FROM rooms
     WHERE public_slug = ?
       AND provisioning_status = 'ready'
       AND status IN ('waiting', 'active', 'idle')`,
  ).bind(input.publicSlug).first<RoomAccessRow>();
  if (!room) throw new RoomAccessNotFoundError("room is not available");
  const now = input.now ?? Date.now();
  const controls = await database.prepare(
    `SELECT room_entry_enabled
     FROM service_controls WHERE singleton = 1`,
  ).first<{ room_entry_enabled: number }>();
  if (controls?.room_entry_enabled !== 1) {
    throw new RoomEntryDisabledError(
      "room entry is paused by emergency control",
    );
  }
  if (
    input.subject.kind === "guest"
    && input.requestedRole === "participant"
  ) {
    throw new RoomAccessForbiddenError(
      "drawing participation requires an authenticated user",
    );
  }
  await assertSubjectNotServiceBanned(database, input.subject, now);
  const isOwner = (
    input.subject.kind === "user"
    && input.subject.id === room.owner_user_id
  );
  const activeBan = await database.prepare(
    `SELECT id
     FROM bans
     WHERE scope = 'room'
       AND room_id = ?
       AND subject_kind = ?
       AND subject_id = ?
       AND starts_at <= ?
       AND expires_at > ?
     LIMIT 1`,
  ).bind(
    room.id,
    input.subject.kind,
    input.subject.id,
    now,
    now,
  ).first<{ id: string }>();
  if (activeBan) {
    throw new RoomAccessForbiddenError("subject is banned from this room");
  }
  const profile = input.subject.kind === "user"
    ? await database.prepare(
        `SELECT name, image
         FROM user
         WHERE id = ? AND status = 'active'`,
      ).bind(input.subject.id).first<UserProfileRow>()
    : null;
  if (input.subject.kind === "user" && !profile) {
    throw new RoomAccessForbiddenError("active user profile is required");
  }
  if (room.visibility === "unlisted" && !isOwner) {
    if (!input.inviteToken || !/^[a-f0-9]{64}$/.test(input.inviteToken)) {
      throw new RoomAccessForbiddenError("valid invite token is required");
    }
    const invite = await database.prepare(
      `SELECT id
       FROM room_invites
       WHERE room_id = ?
         AND token_hash = ?
         AND revoked_at IS NULL
         AND expires_at > ?`,
    ).bind(
      room.id,
      await sha256Hex(input.inviteToken),
      now,
    ).first<InviteRow>();
    if (!invite) {
      throw new RoomAccessForbiddenError("valid invite token is required");
    }
  }

  const resolvedRole: RoomRole = isOwner ? "host" : input.requestedRole;
  const actorId = `actor_${randomHex(16)}`;
  await database.prepare(
    `INSERT OR IGNORE INTO room_memberships (
       room_id, subject_kind, subject_id, actor_id, role, created_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    room.id,
    input.subject.kind,
    input.subject.id,
    actorId,
    resolvedRole,
    now,
    now,
  ).run();
  if (resolvedRole === "host") {
    await database.prepare(
      `UPDATE room_memberships
       SET role = 'host', last_seen_at = ?
       WHERE room_id = ? AND subject_kind = ? AND subject_id = ?`,
    ).bind(
      now,
      room.id,
      input.subject.kind,
      input.subject.id,
    ).run();
  } else {
    await database.prepare(
      `UPDATE room_memberships
       SET role = ?, last_seen_at = ?
       WHERE room_id = ? AND subject_kind = ? AND subject_id = ?`,
    ).bind(
      resolvedRole,
      now,
      room.id,
      input.subject.kind,
      input.subject.id,
    ).run();
  }
  const membership = await database.prepare(
    `SELECT actor_id, role
     FROM room_memberships
     WHERE room_id = ? AND subject_kind = ? AND subject_id = ?`,
  ).bind(
    room.id,
    input.subject.kind,
    input.subject.id,
  ).first<MembershipRow>();
  if (!membership) throw new Error("room membership was not persisted");

  const request = {
    v: ROOM_TICKET_VERSION,
    roomId: room.id,
    actorId: membership.actor_id,
    connectionId: `connection_${randomHex(16)}`,
    role: membership.role,
    canChat: input.subject.kind === "user",
    displayName: profile?.name ?? null,
    avatarUrl: profile?.image ?? null,
    sessionBindingHash: await sha256Hex(
      `${input.subject.kind}:${input.subject.id}`,
    ),
    issuedAt: now,
    expiresAt: now + ROOM_TICKET_TTL_MS,
  } satisfies RoomTicketRegistrationRequest;
  const response = await realtime.fetch(
    "https://room-control.internal/rooms/tickets/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (!response.ok) {
    throw new RoomTicketRegistrationError(
      `realtime ticket registration returned ${response.status}`,
    );
  }
  const result: unknown = await response.json();
  validateRoomTicketRegistrationResult(result);
  if (
    result.actorId !== request.actorId
    || result.connectionId !== request.connectionId
    || result.role !== request.role
    || result.expiresAt !== request.expiresAt
  ) {
    throw new RoomTicketRegistrationError(
      "realtime ticket registration result did not match request",
    );
  }
  return {
    ...result,
    publicSlug: input.publicSlug,
    canChat: input.subject.kind === "user",
  };
}

export class RoomAccessNotFoundError extends Error {}
export class RoomAccessForbiddenError extends Error {}
export class RoomEntryDisabledError extends Error {}
export class RoomTicketRegistrationError extends Error {}
