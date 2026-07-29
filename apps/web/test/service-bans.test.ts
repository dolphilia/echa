import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import authMigration from "../../../migrations/d1/0002_better_auth.sql?raw";
import roomMigration from "../../../migrations/d1/0003_room_projection.sql?raw";
import moderationMigration from "../../../migrations/d1/0008_moderation_evidence_fence.sql?raw";
import serviceBansMigration from "../../../migrations/d1/0017_service_bans.sql?raw";
import {
  ServiceBanActiveError,
  assertSubjectNotServiceBanned,
  listAdminServiceBans,
  revokeServiceBan,
} from "../app/server/service-bans";
import { applySqlMigration } from "./migrations";

const NOW = 1_785_500_000_000;
const ACTION_ID = "admin_12345678-1234-4123-8123-123456789abc";

beforeAll(async () => {
  await applySqlMigration(env.DB, authMigration);
  await applySqlMigration(env.DB, roomMigration);
  await applySqlMigration(env.DB, moderationMigration);
  await applySqlMigration(env.DB, serviceBansMigration);
  await env.DB.prepare(
    `INSERT INTO moderation_actions (
       id, report_id, source_room_id, target_subject_kind, target_subject_id,
       action, actor_admin_id, reason, created_at, ban_duration_hours
     ) VALUES (?, NULL, NULL, 'user', ?, 'service_ban', ?, ?, ?, 168)`,
  ).bind(
    ACTION_ID,
    "user-service-ban-test",
    "access_admin-service-ban",
    "repeated abuse",
    NOW,
  ).run();
  await env.DB.prepare(
    `INSERT INTO service_bans (
       id, subject_kind, subject_id, source_room_id, source_actor_id,
       starts_at, expires_at, reason, action_id
     ) VALUES (?, 'user', ?, NULL, ?, ?, ?, ?, ?)`,
  ).bind(
    ACTION_ID,
    "user-service-ban-test",
    "actor-service-ban-test",
    NOW,
    NOW + 168 * 60 * 60 * 1_000,
    "repeated abuse",
    ACTION_ID,
  ).run();
});

describe("temporary service bans", () => {
  it("blocks the subject only while the ban is active", async () => {
    await expect(assertSubjectNotServiceBanned(
      env.DB,
      { kind: "user", id: "user-service-ban-test" },
      NOW + 1,
    )).rejects.toBeInstanceOf(ServiceBanActiveError);
    await expect(assertSubjectNotServiceBanned(
      env.DB,
      { kind: "user", id: "another-user" },
      NOW + 1,
    )).resolves.toBeUndefined();
    await expect(assertSubjectNotServiceBanned(
      env.DB,
      { kind: "user", id: "user-service-ban-test" },
      NOW + 169 * 60 * 60 * 1_000,
    )).resolves.toBeUndefined();
  });

  it("lists and idempotently revokes a ban with audit metadata", async () => {
    await expect(listAdminServiceBans(env.DB, NOW + 1)).resolves.toEqual([
      expect.objectContaining({
        id: ACTION_ID,
        subjectKind: "user",
        sourceActorId: "actor-service-ban-test",
        revokedAt: null,
      }),
    ]);
    const input = {
      banId: ACTION_ID,
      actionId: "unban_12345678-1234-4123-8123-123456789abc",
      actorAdminId: "access_admin-service-ban",
      reason: "appeal accepted",
      now: NOW + 2,
    };
    await expect(revokeServiceBan(env.DB, input)).resolves.toBe("revoked");
    await expect(revokeServiceBan(env.DB, input)).resolves.toBe(
      "already_revoked",
    );
    await expect(assertSubjectNotServiceBanned(
      env.DB,
      { kind: "user", id: "user-service-ban-test" },
      NOW + 3,
    )).resolves.toBeUndefined();
  });
});
