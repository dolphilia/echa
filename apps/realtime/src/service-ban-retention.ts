export const SERVICE_BAN_AUDIT_RETENTION_MS =
  180 * 24 * 60 * 60 * 1_000;

export async function deleteExpiredServiceBanAudits(
  database: D1Database,
  now = Date.now(),
): Promise<{ serviceBans: number; moderationActions: number }> {
  const cutoff = now - SERVICE_BAN_AUDIT_RETENTION_MS;
  const deletedBans = await database.prepare(
    `DELETE FROM service_bans
     WHERE expires_at <= ?
       AND (revoked_at IS NULL OR revoked_at <= ?)`,
  ).bind(cutoff, cutoff).run();
  const deletedActions = await database.prepare(
    `DELETE FROM moderation_actions
     WHERE action = 'service_ban'
       AND created_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM service_bans
         WHERE service_bans.action_id = moderation_actions.id
       )`,
  ).bind(cutoff).run();
  return {
    serviceBans: deletedBans.meta.changes,
    moderationActions: deletedActions.meta.changes,
  };
}
