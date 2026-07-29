import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, inject, it } from "vitest";
import { finalizeAccountDeletion } from "../src/account-deletion";

it("removes auth data and detaches retained moderation evidence", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const userId = "user-account-deletion-test";
  await env.DB.prepare(
    `INSERT INTO user (
      id, name, email, emailVerified, createdAt, updatedAt, status,
      deletionRequestedAt
    ) VALUES (?, ?, ?, 1, ?, ?, 'deleting', ?)`,
  ).bind(
    userId,
    "Deletion test",
    "account-deletion@example.invalid",
    now,
    now,
    now,
  ).run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO session (
        id, expiresAt, token, createdAt, updatedAt, userId
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      "session-account-deletion",
      now + 60_000,
      "token-account-deletion",
      now,
      now,
      userId,
    ),
    env.DB.prepare(
      `INSERT INTO account (
        id, accountId, providerId, userId, createdAt, updatedAt
      ) VALUES (?, ?, 'google', ?, ?, ?)`,
    ).bind(
      "account-account-deletion",
      "google-account-deletion",
      userId,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO reports (
        id, source_room_id, reporter_subject_kind, reporter_subject_id,
        category, room_name_snapshot, status, created_at, updated_at
      ) VALUES (?, ?, 'user', ?, 'other', ?, 'resolved', ?, ?)`,
    ).bind(
      "report-account-deletion",
      "deleted-room-account-deletion",
      userId,
      "Deleted room",
      now,
      now,
    ),
  ]);

  await expect(
    finalizeAccountDeletion(env.DB, userId),
  ).resolves.toEqual({ status: "deleted" });
  await expect(
    env.DB.prepare("SELECT id FROM user WHERE id = ?")
      .bind(userId)
      .first(),
  ).resolves.toBeNull();
  await expect(
    env.DB.prepare("SELECT id FROM session WHERE userId = ?")
      .bind(userId)
      .first(),
  ).resolves.toBeNull();
  const report = await env.DB.prepare(
    "SELECT reporter_subject_id FROM reports WHERE id = ?",
  ).bind("report-account-deletion").first<{
    reporter_subject_id: string;
  }>();
  expect(report?.reporter_subject_id).toMatch(/^deleted_[a-f0-9]{40}$/);
  expect(report?.reporter_subject_id).not.toBe(userId);
});
