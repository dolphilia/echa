import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, inject, it } from "vitest";
import {
  SERVICE_BAN_AUDIT_RETENTION_MS,
  deleteExpiredServiceBanAudits,
} from "../src/service-ban-retention";

it("retains temporary service ban audit data for 180 days after it ends", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const oldAction = "admin-old-service-ban";
  const recentAction = "admin-recent-service-ban";
  const insertAction = env.DB.prepare(
    `INSERT INTO moderation_actions (
       id, report_id, source_room_id, target_subject_kind, target_subject_id,
       action, actor_admin_id, reason, created_at, ban_duration_hours
     ) VALUES (?, NULL, NULL, 'guest', ?, 'service_ban', ?, ?, ?, 24)`,
  );
  await env.DB.batch([
    insertAction.bind(
      oldAction,
      "guest-old-service-ban",
      "admin-service-ban-retention",
      "old abuse",
      now - SERVICE_BAN_AUDIT_RETENTION_MS - 2 * 24 * 60 * 60 * 1_000,
    ),
    insertAction.bind(
      recentAction,
      "guest-recent-service-ban",
      "admin-service-ban-retention",
      "recent abuse",
      now - 2 * 24 * 60 * 60 * 1_000,
    ),
  ]);
  const insertBan = env.DB.prepare(
    `INSERT INTO service_bans (
       id, subject_kind, subject_id, starts_at, expires_at, reason, action_id
     ) VALUES (?, 'guest', ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    insertBan.bind(
      oldAction,
      "guest-old-service-ban",
      now - SERVICE_BAN_AUDIT_RETENTION_MS - 2 * 24 * 60 * 60 * 1_000,
      now - SERVICE_BAN_AUDIT_RETENTION_MS - 24 * 60 * 60 * 1_000,
      "old abuse",
      oldAction,
    ),
    insertBan.bind(
      recentAction,
      "guest-recent-service-ban",
      now - 2 * 24 * 60 * 60 * 1_000,
      now - 24 * 60 * 60 * 1_000,
      "recent abuse",
      recentAction,
    ),
  ]);

  await expect(deleteExpiredServiceBanAudits(env.DB, now)).resolves.toEqual({
    serviceBans: 1,
    moderationActions: 1,
  });
  await expect(env.DB.prepare(
    "SELECT id FROM service_bans ORDER BY id",
  ).all()).resolves.toMatchObject({
    results: [{ id: recentAction }],
  });
});
