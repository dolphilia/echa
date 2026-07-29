export const SERVICE_BAN_DURATION_HOURS = [24, 168, 720] as const;

export type ServiceBanDurationHours =
  typeof SERVICE_BAN_DURATION_HOURS[number];

export type AdminServiceBan = {
  id: string;
  subjectKind: "user" | "guest";
  sourceActorId: string | null;
  startsAt: number;
  expiresAt: number;
  reason: string;
  revokedAt: number | null;
  revocationReason: string | null;
};

type ServiceBanRow = {
  id: string;
  subject_kind: AdminServiceBan["subjectKind"];
  source_actor_id: string | null;
  starts_at: number;
  expires_at: number;
  reason: string;
  revoked_at: number | null;
  revocation_reason: string | null;
};

export async function assertSubjectNotServiceBanned(
  database: D1Database,
  subject: { kind: "user" | "guest"; id: string },
  now = Date.now(),
): Promise<void> {
  const active = await database.prepare(
    `SELECT id
     FROM service_bans
     WHERE subject_kind = ? AND subject_id = ?
       AND revoked_at IS NULL
       AND starts_at <= ? AND expires_at > ?
     LIMIT 1`,
  ).bind(subject.kind, subject.id, now, now).first<{ id: string }>();
  if (active) {
    throw new ServiceBanActiveError("subject is temporarily service banned");
  }
}

export async function listAdminServiceBans(
  database: D1Database,
  now = Date.now(),
): Promise<AdminServiceBan[]> {
  const result = await database.prepare(
    `SELECT id, subject_kind, source_actor_id, starts_at, expires_at, reason,
            revoked_at, revocation_reason
     FROM service_bans
     WHERE expires_at > ? OR revoked_at > ?
     ORDER BY starts_at DESC
     LIMIT 100`,
  ).bind(now, now - 30 * 24 * 60 * 60 * 1_000).all<ServiceBanRow>();
  return result.results.map((row) => ({
    id: row.id,
    subjectKind: row.subject_kind,
    sourceActorId: row.source_actor_id,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    reason: row.reason,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  }));
}

export async function revokeServiceBan(
  database: D1Database,
  input: {
    banId: string;
    actionId: string;
    actorAdminId: string;
    reason: string;
    now?: number;
  },
): Promise<"revoked" | "already_revoked"> {
  const now = input.now ?? Date.now();
  const existing = await database.prepare(
    `SELECT revoked_at, revoked_by_admin_id, revocation_reason,
            revocation_action_id
     FROM service_bans WHERE id = ?`,
  ).bind(input.banId).first<{
    revoked_at: number | null;
    revoked_by_admin_id: string | null;
    revocation_reason: string | null;
    revocation_action_id: string | null;
  }>();
  if (!existing) {
    throw new ServiceBanNotFoundError("service ban does not exist");
  }
  if (existing.revoked_at !== null) {
    if (
      existing.revoked_by_admin_id !== input.actorAdminId
      || existing.revocation_reason !== input.reason
      || existing.revocation_action_id !== input.actionId
    ) {
      throw new ServiceBanConflictError(
        "service ban was already revoked by another action",
      );
    }
    return "already_revoked";
  }
  const result = await database.prepare(
    `UPDATE service_bans
     SET revoked_at = ?, revoked_by_admin_id = ?, revocation_reason = ?,
         revocation_action_id = ?
     WHERE id = ? AND revoked_at IS NULL`,
  ).bind(
    now,
    input.actorAdminId,
    input.reason,
    input.actionId,
    input.banId,
  ).run();
  if (result.meta.changes === 1) return "revoked";
  const raced = await database.prepare(
    `SELECT revoked_by_admin_id, revocation_reason, revocation_action_id
     FROM service_bans WHERE id = ?`,
  ).bind(input.banId).first<{
    revoked_by_admin_id: string | null;
    revocation_reason: string | null;
    revocation_action_id: string | null;
  }>();
  if (
    raced?.revoked_by_admin_id === input.actorAdminId
    && raced.revocation_reason === input.reason
    && raced.revocation_action_id === input.actionId
  ) {
    return "already_revoked";
  }
  throw new ServiceBanConflictError("service ban revocation conflicted");
}

export class ServiceBanActiveError extends Error {}
export class ServiceBanConflictError extends Error {}
export class ServiceBanNotFoundError extends Error {}
