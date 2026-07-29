export const ROOM_TICKET_VERSION = 1;
export const ROOM_TICKET_TTL_MS = 60_000;

export type RoomRole = "host" | "participant" | "viewer";

export type RoomTicketRegistrationRequest = {
  v: typeof ROOM_TICKET_VERSION;
  roomId: string;
  actorId: string;
  connectionId: string;
  role: RoomRole;
  sessionBindingHash: string;
  issuedAt: number;
  expiresAt: number;
};

export type RoomTicketRegistrationResult = {
  ticket: string;
  actorId: string;
  connectionId: string;
  role: RoomRole;
  expiresAt: number;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRoomTicketRegistrationRequest(
  value: unknown,
): asserts value is RoomTicketRegistrationRequest {
  if (!isRecord(value)) {
    throw new TypeError("invalid room ticket registration request");
  }
  if (
    value.v !== ROOM_TICKET_VERSION
    || typeof value.roomId !== "string"
    || !IDENTIFIER_PATTERN.test(value.roomId)
    || typeof value.actorId !== "string"
    || !IDENTIFIER_PATTERN.test(value.actorId)
    || typeof value.connectionId !== "string"
    || !IDENTIFIER_PATTERN.test(value.connectionId)
    || (
      value.role !== "host"
      && value.role !== "participant"
      && value.role !== "viewer"
    )
    || typeof value.sessionBindingHash !== "string"
    || !HASH_PATTERN.test(value.sessionBindingHash)
    || typeof value.issuedAt !== "number"
    || !Number.isSafeInteger(value.issuedAt)
    || value.issuedAt <= 0
    || typeof value.expiresAt !== "number"
    || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt - value.issuedAt !== ROOM_TICKET_TTL_MS
  ) {
    throw new TypeError("invalid room ticket registration request");
  }
}

export function validateRoomTicketRegistrationResult(
  value: unknown,
): asserts value is RoomTicketRegistrationResult {
  if (!isRecord(value)) {
    throw new TypeError("invalid room ticket registration result");
  }
  if (
    typeof value.ticket !== "string"
    || !HASH_PATTERN.test(value.ticket)
    || typeof value.actorId !== "string"
    || !IDENTIFIER_PATTERN.test(value.actorId)
    || typeof value.connectionId !== "string"
    || !IDENTIFIER_PATTERN.test(value.connectionId)
    || (
      value.role !== "host"
      && value.role !== "participant"
      && value.role !== "viewer"
    )
    || typeof value.expiresAt !== "number"
    || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= 0
  ) {
    throw new TypeError("invalid room ticket registration result");
  }
}
