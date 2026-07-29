import {
  ROOM_MODERATION_ACTIONS,
  ROOM_MODERATION_VERSION,
  validateActiveRoomMembersResult,
  validateRoomModerationResult,
  type ActiveRoomMember,
  type RoomModerationAction,
  type RoomModerationRequest,
  type RoomModerationResult,
} from "@koge/protocol";
import {
  SERVICE_BAN_DURATION_HOURS,
  type ServiceBanDurationHours,
} from "./service-bans";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type AdminRoom = {
  id: string;
  publicSlug: string;
  name: string;
  visibility: "public" | "unlisted";
  status: "waiting" | "active" | "idle" | "suspended" | "closing";
  participantCount: number;
  viewerCount: number;
  createdAt: number;
  updatedAt: number;
};

type AdminRoomRow = {
  id: string;
  public_slug: string;
  name: string;
  visibility: AdminRoom["visibility"];
  status: AdminRoom["status"];
  participant_count: number;
  viewer_count: number;
  created_at: number;
  updated_at: number;
};

export type AdminModerationInput = {
  roomId: string;
  reason: string;
} & (
  | {
      action: "suspend_room" | "close_room";
      targetActorId?: never;
    }
  | {
      action: "kick" | "room_ban";
      targetActorId: string;
      banDurationHours?: never;
    }
  | {
      action: "service_ban";
      targetActorId: string;
      banDurationHours: ServiceBanDurationHours;
    }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAdminModerationInput(
  value: unknown,
): AdminModerationInput {
  if (!isRecord(value)) throw new TypeError("invalid moderation input");
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (
    typeof value.roomId !== "string"
    || !IDENTIFIER_PATTERN.test(value.roomId)
    || typeof value.action !== "string"
    || !ROOM_MODERATION_ACTIONS.includes(value.action as RoomModerationAction)
    || reason.length < 1
    || reason.length > 500
    || (
      (
        value.action === "kick"
        || value.action === "room_ban"
        || value.action === "service_ban"
      )
        ? (
            typeof value.targetActorId !== "string"
            || !IDENTIFIER_PATTERN.test(value.targetActorId)
          )
        : value.targetActorId !== undefined
    )
    || (
      value.action === "service_ban"
        ? (
            typeof value.banDurationHours !== "number"
            || !SERVICE_BAN_DURATION_HOURS.includes(
              value.banDurationHours as ServiceBanDurationHours,
            )
          )
        : value.banDurationHours !== undefined
    )
  ) {
    throw new TypeError("invalid moderation input");
  }
  return {
    roomId: value.roomId,
    action: value.action as RoomModerationAction,
    reason,
    ...(
      value.action === "kick"
      || value.action === "room_ban"
      || value.action === "service_ban"
      ? {
          targetActorId: value.targetActorId as string,
          ...(value.action === "service_ban"
            ? {
                banDurationHours:
                  value.banDurationHours as ServiceBanDurationHours,
              }
            : {}),
        }
      : {}),
  } as AdminModerationInput;
}

export async function listAdminRoomMembers(
  database: D1Database,
  realtime: Pick<Fetcher, "fetch">,
  roomId: string,
): Promise<readonly ActiveRoomMember[]> {
  if (!IDENTIFIER_PATTERN.test(roomId)) {
    throw new TypeError("invalid room ID");
  }
  const room = await database.prepare(
    `SELECT id FROM rooms
     WHERE id = ? AND provisioning_status = 'ready'
       AND status IN ('waiting', 'active', 'idle', 'suspended')`,
  ).bind(roomId).first<{ id: string }>();
  if (!room) {
    throw new AdminModerationNotAvailableError(
      "room moderation target is not available",
    );
  }
  const response = await realtime.fetch(
    "https://room-control.internal/rooms/members",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: ROOM_MODERATION_VERSION, roomId }),
    },
  );
  if (!response.ok) {
    throw new AdminModerationSubmissionError(
      `room member service returned ${response.status}`,
    );
  }
  const result: unknown = await response.json();
  validateActiveRoomMembersResult(result);
  return result.members;
}

export async function listAdminRooms(
  database: D1Database,
): Promise<AdminRoom[]> {
  const result = await database.prepare(
    `SELECT id, public_slug, name, visibility, status,
            participant_count, viewer_count, created_at, updated_at
     FROM rooms
     WHERE provisioning_status = 'ready'
       AND status IN ('waiting', 'active', 'idle', 'suspended', 'closing')
     ORDER BY updated_at DESC, id ASC
     LIMIT 100`,
  ).all<AdminRoomRow>();
  return result.results.map((room) => ({
    id: room.id,
    publicSlug: room.public_slug,
    name: room.name,
    visibility: room.visibility,
    status: room.status,
    participantCount: room.participant_count,
    viewerCount: room.viewer_count,
    createdAt: room.created_at,
    updatedAt: room.updated_at,
  }));
}

export async function submitAdminModeration(
  realtime: Pick<Fetcher, "fetch">,
  input: {
    actionId: string;
    actorAdminId: string;
    moderation: AdminModerationInput;
    now?: number;
  },
): Promise<RoomModerationResult> {
  if (
    !IDENTIFIER_PATTERN.test(input.actionId)
    || !IDENTIFIER_PATTERN.test(input.actorAdminId)
  ) {
    throw new TypeError("invalid moderation metadata");
  }
  const request = {
    v: ROOM_MODERATION_VERSION,
    actionId: input.actionId,
    roomId: input.moderation.roomId,
    actorAdminId: input.actorAdminId,
    action: input.moderation.action,
    reason: input.moderation.reason,
    requestedAt: input.now ?? Date.now(),
    ...("targetActorId" in input.moderation
      ? { targetActorId: input.moderation.targetActorId }
      : {}),
    ...("banDurationHours" in input.moderation
      ? { banDurationHours: input.moderation.banDurationHours }
      : {}),
  } as RoomModerationRequest;
  const response = await realtime.fetch(
    "https://room-control.internal/rooms/moderation",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (response.status === 404) {
    throw new AdminModerationNotAvailableError(
      "room moderation target is not available",
    );
  }
  if (response.status === 409) {
    throw new AdminModerationConflictError(
      "room moderation action conflicts with an existing action",
    );
  }
  if (response.status === 403) {
    throw new AdminModerationTargetForbiddenError(
      "room moderation target is protected",
    );
  }
  if (!response.ok) {
    throw new AdminModerationSubmissionError(
      `room moderation service returned ${response.status}`,
    );
  }
  const result: unknown = await response.json();
  validateRoomModerationResult(result);
  return result;
}

export class AdminModerationConflictError extends Error {}
export class AdminModerationNotAvailableError extends Error {}
export class AdminModerationTargetForbiddenError extends Error {}
export class AdminModerationSubmissionError extends Error {}
