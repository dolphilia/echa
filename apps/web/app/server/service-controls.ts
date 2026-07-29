const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type ServiceControls = {
  revision: number;
  roomCreationEnabled: boolean;
  roomEntryEnabled: boolean;
  drawingEnabled: boolean;
  updatedAt: number;
};

export type ServiceControlInput = {
  roomCreationEnabled: boolean;
  roomEntryEnabled: boolean;
  drawingEnabled: boolean;
  reason: string;
};

export type ServiceControlResult = {
  status: "applied" | "already_applied";
  actionId: string;
  controls: ServiceControls;
};

type ServiceControlRow = {
  revision: number;
  room_creation_enabled: number;
  room_entry_enabled: number;
  drawing_enabled: number;
  updated_at: number;
};

type ServiceControlActionRow = {
  actor_admin_id: string;
  room_creation_enabled: number;
  room_entry_enabled: number;
  drawing_enabled: number;
  reason: string;
  requested_at: number;
  applied_revision: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function controlsFromRow(row: ServiceControlRow): ServiceControls {
  return {
    revision: row.revision,
    roomCreationEnabled: row.room_creation_enabled === 1,
    roomEntryEnabled: row.room_entry_enabled === 1,
    drawingEnabled: row.drawing_enabled === 1,
    updatedAt: row.updated_at,
  };
}

async function readControlRow(database: D1Database): Promise<ServiceControlRow> {
  const row = await database.prepare(
    `SELECT revision, room_creation_enabled, room_entry_enabled,
            drawing_enabled, updated_at
     FROM service_controls WHERE singleton = 1`,
  ).first<ServiceControlRow>();
  if (!row) throw new Error("service controls are not initialized");
  return row;
}

export async function readServiceControls(
  database: D1Database,
): Promise<ServiceControls> {
  return controlsFromRow(await readControlRow(database));
}

export function parseServiceControlInput(value: unknown): ServiceControlInput {
  if (!isRecord(value)) throw new TypeError("invalid service control input");
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (
    typeof value.roomCreationEnabled !== "boolean"
    || typeof value.roomEntryEnabled !== "boolean"
    || typeof value.drawingEnabled !== "boolean"
    || reason.length < 1
    || reason.length > 500
  ) {
    throw new TypeError("invalid service control input");
  }
  return {
    roomCreationEnabled: value.roomCreationEnabled,
    roomEntryEnabled: value.roomEntryEnabled,
    drawingEnabled: value.drawingEnabled,
    reason,
  };
}

function assertMatchingAction(
  row: ServiceControlActionRow,
  actorAdminId: string,
  input: ServiceControlInput,
): void {
  if (
    row.actor_admin_id !== actorAdminId
    || row.room_creation_enabled !== Number(input.roomCreationEnabled)
    || row.room_entry_enabled !== Number(input.roomEntryEnabled)
    || row.drawing_enabled !== Number(input.drawingEnabled)
    || row.reason !== input.reason
  ) {
    throw new ServiceControlConflictError(
      "service control action ID was reused with different input",
    );
  }
}

function resultFromAction(
  actionId: string,
  row: ServiceControlActionRow,
  status: ServiceControlResult["status"],
): ServiceControlResult {
  return {
    status,
    actionId,
    controls: {
      revision: row.applied_revision,
      roomCreationEnabled: row.room_creation_enabled === 1,
      roomEntryEnabled: row.room_entry_enabled === 1,
      drawingEnabled: row.drawing_enabled === 1,
      updatedAt: row.requested_at,
    },
  };
}

async function readAction(
  database: D1Database,
  actionId: string,
): Promise<ServiceControlActionRow | null> {
  return database.prepare(
    `SELECT actor_admin_id, room_creation_enabled, room_entry_enabled,
            drawing_enabled, reason, requested_at, applied_revision
     FROM service_control_actions WHERE id = ?`,
  ).bind(actionId).first<ServiceControlActionRow>();
}

export async function applyServiceControls(
  database: D1Database,
  input: {
    actionId: string;
    actorAdminId: string;
    controls: ServiceControlInput;
    now?: number;
  },
): Promise<ServiceControlResult> {
  if (
    !IDENTIFIER_PATTERN.test(input.actionId)
    || !IDENTIFIER_PATTERN.test(input.actorAdminId)
  ) {
    throw new TypeError("invalid service control metadata");
  }
  const existing = await readAction(database, input.actionId);
  if (existing) {
    assertMatchingAction(existing, input.actorAdminId, input.controls);
    return resultFromAction(input.actionId, existing, "already_applied");
  }

  const now = input.now ?? Date.now();
  const values = [
    Number(input.controls.roomCreationEnabled),
    Number(input.controls.roomEntryEnabled),
    Number(input.controls.drawingEnabled),
  ] as const;
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO service_control_actions (
           id, actor_admin_id, room_creation_enabled, room_entry_enabled,
           drawing_enabled, reason, requested_at, applied_revision
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, revision + 1
         FROM service_controls WHERE singleton = 1`,
      ).bind(
        input.actionId,
        input.actorAdminId,
        ...values,
        input.controls.reason,
        now,
      ),
      database.prepare(
        `UPDATE service_controls
         SET revision = revision + 1,
             room_creation_enabled = ?,
             room_entry_enabled = ?,
             drawing_enabled = ?,
             updated_at = ?,
             actor_admin_id = ?,
             reason = ?
         WHERE singleton = 1`,
      ).bind(
        ...values,
        now,
        input.actorAdminId,
        input.controls.reason,
      ),
    ]);
  } catch (error) {
    const raced = await readAction(database, input.actionId);
    if (!raced) throw error;
    assertMatchingAction(raced, input.actorAdminId, input.controls);
    return resultFromAction(input.actionId, raced, "already_applied");
  }
  return {
    status: "applied",
    actionId: input.actionId,
    controls: controlsFromRow(await readControlRow(database)),
  };
}

export class ServiceControlConflictError extends Error {}
