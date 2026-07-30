import { PROTOCOL_LIMITS } from "@koge/protocol";

export const SERVICE_LIVE_ROOM_HARD_LIMIT = 20;
export const SERVICE_ROOM_CONNECTION_HARD_LIMIT =
  PROTOCOL_LIMITS.maxRoomConnections;
export const DEFAULT_LIVE_ROOM_LIMIT = 20;
export const DEFAULT_PARTICIPANT_LIMIT = 10;
export const DEFAULT_VIEWER_LIMIT = 10;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type ServiceCapacityLimits = {
  revision: number;
  liveRoomLimit: number;
  participantLimit: number;
  viewerLimit: number;
  publicRoomsOnly: boolean;
  updatedAt: number;
};

export type ServiceCapacityLimitInput = {
  liveRoomLimit: number;
  participantLimit: number;
  viewerLimit: number;
  publicRoomsOnly: boolean;
  reason: string;
};

export type ServiceCapacityLimitResult = {
  status: "applied" | "already_applied";
  actionId: string;
  limits: ServiceCapacityLimits;
};

type ServiceCapacityLimitRow = {
  revision: number;
  live_room_limit: number;
  participant_limit: number;
  viewer_limit: number;
  public_rooms_only: number;
  updated_at: number;
};

type ServiceCapacityLimitActionRow = {
  actor_admin_id: string;
  live_room_limit: number;
  participant_limit: number;
  viewer_limit: number;
  public_rooms_only: number;
  reason: string;
  requested_at: number;
  applied_revision: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitsFromRow(
  row: ServiceCapacityLimitRow,
): ServiceCapacityLimits {
  return {
    revision: row.revision,
    liveRoomLimit: row.live_room_limit,
    participantLimit: row.participant_limit,
    viewerLimit: row.viewer_limit,
    publicRoomsOnly: row.public_rooms_only === 1,
    updatedAt: row.updated_at,
  };
}

async function readLimitRow(
  database: D1Database,
): Promise<ServiceCapacityLimitRow> {
  const row = await database.prepare(
    `SELECT revision, live_room_limit, participant_limit, viewer_limit,
            public_rooms_only, updated_at
     FROM service_capacity_limits WHERE singleton = 1`,
  ).first<ServiceCapacityLimitRow>();
  if (!row) throw new Error("service capacity limits are not initialized");
  return row;
}

export async function readServiceCapacityLimits(
  database: D1Database,
): Promise<ServiceCapacityLimits> {
  return limitsFromRow(await readLimitRow(database));
}

export function parseServiceCapacityLimitInput(
  value: unknown,
): ServiceCapacityLimitInput {
  if (!isRecord(value)) throw new TypeError("invalid capacity limit input");
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  const liveRoomLimit = value.liveRoomLimit;
  const participantLimit = value.participantLimit;
  const viewerLimit = value.viewerLimit;
  const publicRoomsOnly = value.publicRoomsOnly;
  if (
    typeof liveRoomLimit !== "number"
    || !Number.isSafeInteger(liveRoomLimit)
    || liveRoomLimit < 1
    || liveRoomLimit > SERVICE_LIVE_ROOM_HARD_LIMIT
    || typeof participantLimit !== "number"
    || !Number.isSafeInteger(participantLimit)
    || participantLimit < 1
    || participantLimit > SERVICE_ROOM_CONNECTION_HARD_LIMIT
    || typeof viewerLimit !== "number"
    || !Number.isSafeInteger(viewerLimit)
    || viewerLimit < 0
    || viewerLimit >= SERVICE_ROOM_CONNECTION_HARD_LIMIT
    || typeof publicRoomsOnly !== "boolean"
    || participantLimit + viewerLimit
      > SERVICE_ROOM_CONNECTION_HARD_LIMIT
    || reason.length < 1
    || reason.length > 500
  ) {
    throw new TypeError("invalid capacity limit input");
  }
  return {
    liveRoomLimit,
    participantLimit,
    viewerLimit,
    publicRoomsOnly,
    reason,
  };
}

function assertMatchingAction(
  row: ServiceCapacityLimitActionRow,
  actorAdminId: string,
  input: ServiceCapacityLimitInput,
): void {
  if (
    row.actor_admin_id !== actorAdminId
    || row.live_room_limit !== input.liveRoomLimit
    || row.participant_limit !== input.participantLimit
    || row.viewer_limit !== input.viewerLimit
    || row.public_rooms_only !== Number(input.publicRoomsOnly)
    || row.reason !== input.reason
  ) {
    throw new ServiceCapacityLimitConflictError(
      "capacity action ID was reused with different input",
    );
  }
}

function resultFromAction(
  actionId: string,
  row: ServiceCapacityLimitActionRow,
  status: ServiceCapacityLimitResult["status"],
): ServiceCapacityLimitResult {
  return {
    status,
    actionId,
    limits: {
      revision: row.applied_revision,
      liveRoomLimit: row.live_room_limit,
      participantLimit: row.participant_limit,
      viewerLimit: row.viewer_limit,
      publicRoomsOnly: row.public_rooms_only === 1,
      updatedAt: row.requested_at,
    },
  };
}

async function readAction(
  database: D1Database,
  actionId: string,
): Promise<ServiceCapacityLimitActionRow | null> {
  return database.prepare(
    `SELECT actor_admin_id, live_room_limit, participant_limit, viewer_limit,
            public_rooms_only, reason, requested_at, applied_revision
     FROM service_capacity_limit_actions WHERE id = ?`,
  ).bind(actionId).first<ServiceCapacityLimitActionRow>();
}

export async function applyServiceCapacityLimits(
  database: D1Database,
  input: {
    actionId: string;
    actorAdminId: string;
    limits: ServiceCapacityLimitInput;
    now?: number;
  },
): Promise<ServiceCapacityLimitResult> {
  if (
    !IDENTIFIER_PATTERN.test(input.actionId)
    || !IDENTIFIER_PATTERN.test(input.actorAdminId)
  ) {
    throw new TypeError("invalid capacity limit metadata");
  }
  const existing = await readAction(database, input.actionId);
  if (existing) {
    assertMatchingAction(existing, input.actorAdminId, input.limits);
    return resultFromAction(input.actionId, existing, "already_applied");
  }

  const now = input.now ?? Date.now();
  const values = [
    input.limits.liveRoomLimit,
    input.limits.participantLimit,
    input.limits.viewerLimit,
    Number(input.limits.publicRoomsOnly),
  ] as const;
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO service_capacity_limit_actions (
           id, actor_admin_id, live_room_limit, participant_limit,
           viewer_limit, public_rooms_only, reason, requested_at,
           applied_revision
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, revision + 1
         FROM service_capacity_limits WHERE singleton = 1`,
      ).bind(
        input.actionId,
        input.actorAdminId,
        ...values,
        input.limits.reason,
        now,
      ),
      database.prepare(
        `UPDATE service_capacity_limits
         SET revision = revision + 1,
             live_room_limit = ?,
             participant_limit = ?,
             viewer_limit = ?,
             public_rooms_only = ?,
             updated_at = ?,
             actor_admin_id = ?,
             reason = ?
         WHERE singleton = 1`,
      ).bind(
        ...values,
        now,
        input.actorAdminId,
        input.limits.reason,
      ),
    ]);
  } catch (error) {
    const raced = await readAction(database, input.actionId);
    if (!raced) throw error;
    assertMatchingAction(raced, input.actorAdminId, input.limits);
    return resultFromAction(input.actionId, raced, "already_applied");
  }
  return {
    status: "applied",
    actionId: input.actionId,
    limits: limitsFromRow(await readLimitRow(database)),
  };
}

export class ServiceCapacityLimitConflictError extends Error {}
