import {
  ROOM_MAX_DURATION_MS,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_VIEWER_LIMIT,
} from "@koge/protocol";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, inject, it } from "vitest";
import {
  captureRateAbuseRoomOutcome,
  collectRateAbuseMetrics,
  deleteExpiredRateAbuseOutcomes,
} from "../src/rate-abuse-metrics";

it("collects live and completed room counters without exposing room IDs", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const ownerId = `owner-rate-metrics-${suffix}`;
  const roomId = `room-rate-metrics-${suffix}`;
  const cleanupJobId = `cleanup-rate-metrics-${suffix}`;
  await env.DB.prepare(
    `INSERT INTO user (
       id, name, email, emailVerified, createdAt, updatedAt
     ) VALUES (?, ?, ?, 1, ?, ?)`,
  ).bind(
    ownerId,
    "Rate metrics owner",
    `${suffix}@example.invalid`,
    now,
    now,
  ).run();
  await env.DB.prepare(
    `INSERT INTO rooms (
       id, public_slug, owner_user_id, name, theme, visibility, status,
       participant_limit, viewer_limit, viewer_chat_enabled,
       viewer_stamp_enabled, created_at, max_ends_at, updated_at,
       provisioning_status
     ) VALUES (?, ?, ?, ?, NULL, 'unlisted', 'active', ?, ?, 0, 0, ?, ?, ?,
               'ready')`,
  ).bind(
    roomId,
    suffix,
    ownerId,
    "Rate metrics room",
    ROOM_PARTICIPANT_LIMIT,
    ROOM_VIEWER_LIMIT,
    now,
    now + ROOM_MAX_DURATION_MS,
    now,
  ).run();
  await captureRateAbuseRoomOutcome(
    env.DB,
    cleanupJobId,
    "room-completed-rate-metrics",
    {
      acceptedCount: 120,
      rejectCount: 9,
      rateLimitedCount: 8,
      shortMuteCount: 2,
      abuseDisconnectCount: 1,
    },
    now,
  );

  const capture = await collectRateAbuseMetrics(env, now + 1);
  expect(capture).toMatchObject({
    schema: "koge.rate-abuse-metrics-capture.v1",
    environment: "local",
    retentionDays: 30,
    liveRooms: [{
      acceptedCount: 0,
      rateLimitedCount: 0,
    }],
    outcomes: [{
      acceptedCount: 120,
      rejectCount: 9,
      rateLimitedCount: 8,
      shortMuteCount: 2,
      abuseDisconnectCount: 1,
    }],
  });
  expect(capture.liveRooms[0]?.roomDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(capture.outcomes[0]?.roomDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(capture.outcomes[0]?.outcomeDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(capture)).not.toContain(roomId);
  expect(JSON.stringify(capture)).not.toContain(cleanupJobId);
});

it("expires completed room counters after 30 days", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  const now = Date.now();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  await captureRateAbuseRoomOutcome(
    env.DB,
    `cleanup-expired-${suffix}`,
    `room-expired-${suffix}`,
    {
      acceptedCount: 1,
      rejectCount: 0,
      rateLimitedCount: 0,
      shortMuteCount: 0,
      abuseDisconnectCount: 0,
    },
    now - 31 * 24 * 60 * 60 * 1_000,
  );
  await captureRateAbuseRoomOutcome(
    env.DB,
    `cleanup-current-${suffix}`,
    `room-current-${suffix}`,
    {
      acceptedCount: 2,
      rejectCount: 0,
      rateLimitedCount: 0,
      shortMuteCount: 0,
      abuseDisconnectCount: 0,
    },
    now,
  );

  await expect(deleteExpiredRateAbuseOutcomes(env.DB, now)).resolves.toBe(1);
  await expect(env.DB.prepare(
    `SELECT accepted_count
     FROM rate_abuse_room_outcomes
     WHERE cleanup_job_id = ?`,
  ).bind(`cleanup-current-${suffix}`).first()).resolves.toMatchObject({
    accepted_count: 2,
  });
});
