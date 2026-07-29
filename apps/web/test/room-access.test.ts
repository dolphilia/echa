import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import authMigration from "../../../migrations/d1/0002_better_auth.sql?raw";
import roomMigration from "../../../migrations/d1/0003_room_projection.sql?raw";
import provisioningMigration from "../../../migrations/d1/0004_room_provisioning.sql?raw";
import accessMigration from "../../../migrations/d1/0005_guest_room_access.sql?raw";
import inviteMigration from "../../../migrations/d1/0006_room_invites.sql?raw";
import cleanupMigration from "../../../migrations/d1/0007_room_cleanup.sql?raw";
import moderationMigration from "../../../migrations/d1/0008_moderation_evidence_fence.sql?raw";
import reportFenceMigration from "../../../migrations/d1/0009_report_abuse_fence.sql?raw";
import retentionMigration from "../../../migrations/d1/0010_evidence_retention_jobs.sql?raw";
import orphanMigration from "../../../migrations/d1/0011_snapshot_orphan_inventory.sql?raw";
import actionStateMigration from "../../../migrations/d1/0012_moderation_action_state.sql?raw";
import bansMigration from "../../../migrations/d1/0013_room_bans.sql?raw";
import serviceControlsMigration from "../../../migrations/d1/0014_service_controls.sql?raw";
import serviceBansMigration from "../../../migrations/d1/0017_service_bans.sql?raw";
import {
  RoomAccessForbiddenError,
  RoomEntryDisabledError,
  issueRoomTicket,
  resolveRoomAccessSubject,
} from "../app/server/room-access";
import { applySqlMigration } from "./migrations";

const NOW = 1_785_300_000_000;
const PUBLIC_SLUG = "1234567890abcdef1234567890abcdef";
const UNLISTED_SLUG = "abcdef1234567890abcdef1234567890";
const INVITE_TOKEN = "d".repeat(64);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

beforeAll(async () => {
  await applySqlMigration(env.DB, authMigration);
  await applySqlMigration(env.DB, roomMigration);
  await applySqlMigration(env.DB, provisioningMigration);
  await applySqlMigration(env.DB, accessMigration);
  await applySqlMigration(env.DB, inviteMigration);
  await applySqlMigration(env.DB, cleanupMigration);
  await applySqlMigration(env.DB, moderationMigration);
  await applySqlMigration(env.DB, reportFenceMigration);
  await applySqlMigration(env.DB, retentionMigration);
  await applySqlMigration(env.DB, orphanMigration);
  await applySqlMigration(env.DB, actionStateMigration);
  await applySqlMigration(env.DB, bansMigration);
  await applySqlMigration(env.DB, serviceControlsMigration);
  await applySqlMigration(env.DB, serviceBansMigration);
  await env.DB.prepare(
    `INSERT INTO user (
       id, name, email, emailVerified, createdAt, updatedAt, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    "user-access-owner",
    "Access owner",
    "access-owner@example.test",
    1,
    NOW,
    NOW,
    "active",
  ).run();
  await env.DB.prepare(
    `INSERT INTO user (
       id, name, email, emailVerified, image, createdAt, updatedAt, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    "user-access-member",
    "Access member",
    "access-member@example.test",
    1,
    "https://example.test/member.png",
    NOW,
    NOW,
    "active",
  ).run();
  const insertRoom = env.DB.prepare(
    `INSERT INTO rooms (
       id, public_slug, owner_user_id, name, theme, visibility, status,
       participant_limit, viewer_limit, participant_count, viewer_count,
       created_at, max_ends_at, updated_at, provisioning_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    insertRoom.bind(
      "room-access-test",
      PUBLIC_SLUG,
      "user-access-owner",
      "Access room",
      null,
      "public",
      "waiting",
      20,
      100,
      0,
      0,
      NOW,
      NOW + 7_200_000,
      NOW,
      "ready",
    ),
    insertRoom.bind(
      "room-unlisted-access-test",
      UNLISTED_SLUG,
      "user-access-owner",
      "Unlisted access room",
      null,
      "unlisted",
      "waiting",
      20,
      100,
      0,
      0,
      NOW,
      NOW + 7_200_000,
      NOW,
      "ready",
    ),
  ]);
  await env.DB.prepare(
    `INSERT INTO room_invites (
       id, room_id, token_hash, created_by_user_id,
       created_at, expires_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    "invite-access-test",
    "room-unlisted-access-test",
    await sha256Hex(INVITE_TOKEN),
    "user-access-owner",
    NOW,
    NOW + 7_200_000,
  ).run();
});

function fakeRealtime(registrations: unknown[]) {
  return {
    async fetch(_input: RequestInfo | URL, init?: RequestInit) {
      const request = JSON.parse(String(init?.body)) as {
        actorId: string;
        connectionId: string;
        role: "host" | "participant" | "viewer";
        expiresAt: number;
      };
      registrations.push(request);
      return Response.json({
        ticket: "a".repeat(64),
        actorId: request.actorId,
        connectionId: request.connectionId,
        role: request.role,
        expiresAt: request.expiresAt,
      });
    },
  };
}

describe("phase 5 guest identity and room tickets", () => {
  it("creates an HttpOnly guest session and reuses only its server identity", async () => {
    const first = await resolveRoomAccessSubject(env.DB, {
      appEnvironment: "preview",
      cookieHeader: null,
      now: NOW,
    });
    expect(first).toMatchObject({ kind: "guest" });
    expect(first.setCookie).toContain("HttpOnly");
    expect(first.setCookie).toContain("SameSite=Lax");
    expect(first.setCookie).toContain("Secure");
    const cookie = first.setCookie?.split(";", 1)[0];
    expect(cookie).toBeDefined();

    const repeated = await resolveRoomAccessSubject(env.DB, {
      appEnvironment: "preview",
      cookieHeader: cookie!,
      now: NOW + 1,
    });
    expect(repeated).toEqual({ kind: "guest", id: first.id });
    const stored = await env.DB.prepare(
      "SELECT token_hash FROM guest_sessions WHERE id = ?",
    ).bind(first.id).first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(cookie).not.toContain(stored!.token_hash);
  });

  it("keeps a stable viewer actor and disables guest chat", async () => {
    const registrations: unknown[] = [];
    const realtime = fakeRealtime(registrations);
    const subject = await resolveRoomAccessSubject(env.DB, {
      appEnvironment: "local",
      cookieHeader: null,
      now: NOW + 10,
    });
    const first = await issueRoomTicket(env.DB, realtime, {
      publicSlug: PUBLIC_SLUG,
      requestedRole: "viewer",
      subject,
      now: NOW + 10,
    });
    const second = await issueRoomTicket(env.DB, realtime, {
      publicSlug: PUBLIC_SLUG,
      requestedRole: "viewer",
      subject,
      now: NOW + 20,
    });
    expect(second.actorId).toBe(first.actorId);
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(second.role).toBe("viewer");
    expect(first.canChat).toBe(false);
    expect(second.canChat).toBe(false);
    expect(registrations).toHaveLength(2);
  });

  it("requires login for drawing and allows logged-in viewers to chat", async () => {
    const guest = await resolveRoomAccessSubject(env.DB, {
      appEnvironment: "local",
      cookieHeader: null,
      now: NOW + 25,
    });
    await expect(issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: PUBLIC_SLUG,
      requestedRole: "participant",
      subject: guest,
      now: NOW + 25,
    })).rejects.toBeInstanceOf(RoomAccessForbiddenError);

    const registrations: unknown[] = [];
    const viewer = await issueRoomTicket(env.DB, fakeRealtime(registrations), {
      publicSlug: PUBLIC_SLUG,
      requestedRole: "viewer",
      subject: { kind: "user", id: "user-access-member" },
      now: NOW + 26,
    });
    expect(viewer.role).toBe("viewer");
    expect(viewer.canChat).toBe(true);
    expect(registrations).toContainEqual(expect.objectContaining({
      canChat: true,
      displayName: "Access member",
      avatarUrl: "https://example.test/member.png",
    }));
  });

  it("derives host role from account ownership", async () => {
    const ticket = await issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: PUBLIC_SLUG,
      requestedRole: "viewer",
      subject: { kind: "user", id: "user-access-owner" },
      now: NOW + 30,
    });
    expect(ticket.role).toBe("host");
    expect(ticket.canChat).toBe(true);
  });

  it("requires a valid invite for an unlisted room but lets its owner enter", async () => {
    const subject = await resolveRoomAccessSubject(env.DB, {
      appEnvironment: "local",
      cookieHeader: null,
      now: NOW + 40,
    });
    await expect(issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: UNLISTED_SLUG,
      requestedRole: "viewer",
      subject,
      now: NOW + 40,
    })).rejects.toBeInstanceOf(RoomAccessForbiddenError);
    await expect(issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: UNLISTED_SLUG,
      requestedRole: "viewer",
      inviteToken: "e".repeat(64),
      subject,
      now: NOW + 40,
    })).rejects.toBeInstanceOf(RoomAccessForbiddenError);

    const invited = await issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: UNLISTED_SLUG,
      requestedRole: "viewer",
      inviteToken: INVITE_TOKEN,
      subject,
      now: NOW + 40,
    });
    expect(invited.role).toBe("viewer");

    const owner = await issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: UNLISTED_SLUG,
      requestedRole: "viewer",
      subject: { kind: "user", id: "user-access-owner" },
      now: NOW + 40,
    });
    expect(owner.role).toBe("host");
  });

  it("rejects a room-banned subject before issuing another ticket", async () => {
    const subject = await resolveRoomAccessSubject(env.DB, {
      appEnvironment: "local",
      cookieHeader: null,
      now: NOW + 50,
    });
    const ticket = await issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: PUBLIC_SLUG,
      requestedRole: "viewer",
      subject,
      now: NOW + 50,
    });
    const actionId = "moderation-room-ban-access";
    await env.DB.prepare(
      `INSERT INTO moderation_actions (
         id, source_room_id, target_subject_kind, target_subject_id,
         target_actor_id, action, actor_admin_id, reason, created_at,
         status, applied_at
       ) VALUES (?, ?, ?, ?, ?, 'room_ban', ?, ?, ?, 'applied', ?)`,
    ).bind(
      actionId,
      "room-access-test",
      subject.kind,
      subject.id,
      ticket.actorId,
      "admin-room-access-test",
      "Safety policy",
      NOW + 51,
      NOW + 51,
    ).run();
    await env.DB.prepare(
      `INSERT INTO bans (
         id, scope, room_id, subject_kind, subject_id, actor_id,
         starts_at, expires_at, reason, action_id
       ) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      actionId,
      "room-access-test",
      subject.kind,
      subject.id,
      ticket.actorId,
      NOW + 51,
      NOW + 7_200_000,
      "Safety policy",
      actionId,
    ).run();
    await expect(issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: PUBLIC_SLUG,
      requestedRole: "viewer",
      subject,
      now: NOW + 52,
    })).rejects.toBeInstanceOf(RoomAccessForbiddenError);
  });

  it("pauses new room entry without changing the room projection", async () => {
    await env.DB.prepare(
      `UPDATE service_controls SET room_entry_enabled = 0
       WHERE singleton = 1`,
    ).run();
    await expect(issueRoomTicket(env.DB, fakeRealtime([]), {
      publicSlug: PUBLIC_SLUG,
      requestedRole: "viewer",
      subject: { kind: "user", id: "user-access-owner" },
      now: NOW + 60,
    })).rejects.toBeInstanceOf(RoomEntryDisabledError);
    await env.DB.prepare(
      `UPDATE service_controls SET room_entry_enabled = 1
       WHERE singleton = 1`,
    ).run();
  });
});
