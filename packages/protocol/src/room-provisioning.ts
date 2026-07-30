export const ROOM_PROVISIONING_VERSION = 1;
export const ROOM_MAX_DURATION_MS = 2 * 60 * 60 * 1_000;
export const ROOM_NAME_MAX_LENGTH = 60;
export const ROOM_PARTICIPANT_LIMIT = 10;
export const ROOM_VIEWER_LIMIT = 10;
export const ROOM_ROLE_LIMIT_MAX = 20;
export const LEGACY_ROOM_PARTICIPANT_LIMIT = 20;
export const LEGACY_ROOM_VIEWER_LIMIT = 100;

export type RoomVisibility = "public" | "unlisted";

export type RoomProvisioningRequest = {
  v: typeof ROOM_PROVISIONING_VERSION;
  roomId: string;
  publicSlug: string;
  ownerUserId: string;
  name: string;
  visibility: RoomVisibility;
  participantLimit: number;
  viewerLimit: number;
  viewerChatEnabled: boolean;
  viewerStampEnabled: boolean;
  createdAt: number;
  maxEndsAt: number;
};

export type RoomProvisioningResult = {
  status: "initialized" | "already_initialized";
  roomId: string;
  createdAt: number;
  maxEndsAt: number;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PUBLIC_SLUG_PATTERN = /^[a-f0-9]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePointLength(value: string): number {
  return [...value].length;
}

export function validateRoomProvisioningRequest(
  value: unknown,
): asserts value is RoomProvisioningRequest {
  if (!isRecord(value)) {
    throw new TypeError("invalid room provisioning request");
  }
  const {
    roomId,
    publicSlug,
    ownerUserId,
    name,
    visibility,
    createdAt,
    maxEndsAt,
  } = value;
  const hasSafeCapacityLimits = (
    typeof value.participantLimit === "number"
    && Number.isSafeInteger(value.participantLimit)
    && value.participantLimit >= 1
    && value.participantLimit <= ROOM_ROLE_LIMIT_MAX
    && typeof value.viewerLimit === "number"
    && Number.isSafeInteger(value.viewerLimit)
    && value.viewerLimit >= 0
    && value.viewerLimit < ROOM_ROLE_LIMIT_MAX
    && value.participantLimit + value.viewerLimit <= ROOM_ROLE_LIMIT_MAX
  );
  const hasLegacyCapacityLimits = (
    value.participantLimit === LEGACY_ROOM_PARTICIPANT_LIMIT
    && value.viewerLimit === LEGACY_ROOM_VIEWER_LIMIT
  );
  if (
    value.v !== ROOM_PROVISIONING_VERSION
    || typeof roomId !== "string"
    || !IDENTIFIER_PATTERN.test(roomId)
    || typeof publicSlug !== "string"
    || !PUBLIC_SLUG_PATTERN.test(publicSlug)
    || typeof ownerUserId !== "string"
    || !IDENTIFIER_PATTERN.test(ownerUserId)
    || typeof name !== "string"
    || name !== name.trim()
    || codePointLength(name) < 1
    || codePointLength(name) > ROOM_NAME_MAX_LENGTH
    || (visibility !== "public" && visibility !== "unlisted")
    || (!hasSafeCapacityLimits && !hasLegacyCapacityLimits)
    || typeof value.viewerChatEnabled !== "boolean"
    || typeof value.viewerStampEnabled !== "boolean"
    || typeof createdAt !== "number"
    || !Number.isSafeInteger(createdAt)
    || createdAt <= 0
    || typeof maxEndsAt !== "number"
    || !Number.isSafeInteger(maxEndsAt)
    || maxEndsAt - createdAt !== ROOM_MAX_DURATION_MS
  ) {
    throw new TypeError("invalid room provisioning request");
  }
}

export function validateRoomProvisioningResult(
  value: unknown,
): asserts value is RoomProvisioningResult {
  if (!isRecord(value)) {
    throw new TypeError("invalid room provisioning result");
  }
  const { roomId, createdAt, maxEndsAt } = value;
  if (
    (
      value.status !== "initialized"
      && value.status !== "already_initialized"
    )
    || typeof roomId !== "string"
    || !IDENTIFIER_PATTERN.test(roomId)
    || typeof createdAt !== "number"
    || !Number.isSafeInteger(createdAt)
    || typeof maxEndsAt !== "number"
    || !Number.isSafeInteger(maxEndsAt)
    || maxEndsAt - createdAt !== ROOM_MAX_DURATION_MS
  ) {
    throw new TypeError("invalid room provisioning result");
  }
}
