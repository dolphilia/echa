import type { DurableObject as DurableObjectBase } from "cloudflare:workers";
import type { RoomCloseResult } from "@koge/protocol";

const identifierPattern = /^[A-Za-z0-9_-]{8,128}$/;
const deletionScanLimit = 100;

type AccountDeletionInput = {
  userId: string;
  requestId: string;
};

type OwnedRoomRow = {
  id: string;
  status: "waiting" | "active" | "idle" | "closing" | "suspended";
  provisioning_status: "pending" | "ready" | "failed";
};

type AccountDeletionRoom = DurableObjectBase<Env> & {
  beginRoomClose(request: {
    closeRequestId: string;
    reason: "account";
  }): Promise<RoomCloseResult>;
};

export type AccountDeletionResult =
  | { status: "already_deleted" }
  | { status: "not_deleting" }
  | {
      status: "pending";
      remainingRoomCount: number;
      retryRoomCount: number;
    }
  | { status: "deleted" };

function validateInput(value: unknown): AccountDeletionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("account deletion request must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || typeof record.userId !== "string"
    || !identifierPattern.test(record.userId)
    || typeof record.requestId !== "string"
    || !identifierPattern.test(record.requestId)
  ) {
    throw new TypeError("invalid account deletion request");
  }
  return {
    userId: record.userId,
    requestId: record.requestId,
  };
}

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

export async function finalizeAccountDeletion(
  database: D1Database,
  userId: string,
): Promise<AccountDeletionResult> {
  if (!identifierPattern.test(userId)) {
    throw new TypeError("invalid account deletion user");
  }
  const user = await database.prepare(
    `SELECT status,
            (SELECT COUNT(*) FROM rooms WHERE owner_user_id = ?) AS room_count
     FROM user WHERE id = ?`,
  ).bind(userId, userId).first<{
    status: string;
    room_count: number;
  }>();
  if (!user) return { status: "already_deleted" };
  if (user.status !== "deleting") return { status: "not_deleting" };
  if (user.room_count > 0) {
    return {
      status: "pending",
      remainingRoomCount: user.room_count,
      retryRoomCount: 0,
    };
  }

  const deletedSubjectId = `deleted_${(await sha256Hex(userId)).slice(0, 40)}`;
  await database.batch([
    database.prepare(
      `UPDATE reports SET reporter_subject_id = ?
       WHERE reporter_subject_kind = 'user' AND reporter_subject_id = ?`,
    ).bind(deletedSubjectId, userId),
    database.prepare(
      `UPDATE moderation_actions SET target_subject_id = ?
       WHERE target_subject_kind = 'user' AND target_subject_id = ?`,
    ).bind(deletedSubjectId, userId),
    database.prepare(
      `UPDATE bans SET subject_id = ?
       WHERE subject_kind = 'user' AND subject_id = ?`,
    ).bind(deletedSubjectId, userId),
    database.prepare(
      `UPDATE service_bans SET subject_id = ?
       WHERE subject_kind = 'user' AND subject_id = ?`,
    ).bind(deletedSubjectId, userId),
    database.prepare(
      `DELETE FROM room_memberships
       WHERE subject_kind = 'user' AND subject_id = ?`,
    ).bind(userId),
    database.prepare(
      "DELETE FROM room_invites WHERE created_by_user_id = ?",
    ).bind(userId),
    database.prepare("DELETE FROM session WHERE userId = ?").bind(userId),
    database.prepare("DELETE FROM account WHERE userId = ?").bind(userId),
    database.prepare(
      "DELETE FROM user WHERE id = ? AND status = 'deleting'",
    ).bind(userId),
  ]);
  const remaining = await database.prepare(
    "SELECT 1 AS present FROM user WHERE id = ?",
  ).bind(userId).first<{ present: number }>();
  if (remaining) throw new Error("account deletion did not remove the user");
  return { status: "deleted" };
}

export async function requestAccountDeletion(
  value: unknown,
  env: Env,
): Promise<AccountDeletionResult> {
  const input = validateInput(value);
  const user = await env.DB.prepare(
    "SELECT status FROM user WHERE id = ?",
  ).bind(input.userId).first<{ status: string }>();
  if (!user) return { status: "already_deleted" };
  if (user.status !== "deleting") return { status: "not_deleting" };

  const rooms = await env.DB.prepare(
    `SELECT id, status, provisioning_status
     FROM rooms WHERE owner_user_id = ?`,
  ).bind(input.userId).all<OwnedRoomRow>();
  let retryRoomCount = 0;
  for (const projection of rooms.results) {
    if (projection.provisioning_status === "failed") {
      // A failed projection has no usable room. Remove its D1-only residue.
      // oxlint-disable-next-line no-await-in-loop
      await env.DB.batch([
        env.DB.prepare("DELETE FROM room_invites WHERE room_id = ?")
          .bind(projection.id),
        env.DB.prepare("DELETE FROM room_memberships WHERE room_id = ?")
          .bind(projection.id),
        env.DB.prepare(
          `DELETE FROM rooms
           WHERE id = ? AND provisioning_status = 'failed'`,
        ).bind(projection.id),
      ]);
      continue;
    }
    try {
      const room = (
        env.DRAWING_ROOM as DurableObjectNamespace<AccountDeletionRoom>
      ).getByName(projection.id, { locationHint: "apac-ne" });
      // Room close is idempotent and re-enqueues cleanup when already closing.
      // oxlint-disable-next-line no-await-in-loop
      await room.beginRoomClose({
        closeRequestId: `${input.requestId}_${projection.id}`.slice(0, 128),
        reason: "account",
      });
    } catch (error) {
      retryRoomCount += 1;
      console.error(JSON.stringify({
        level: "error",
        message: "account-owned room close failed",
        userId: input.userId,
        roomId: projection.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const result = await finalizeAccountDeletion(env.DB, input.userId);
  if (result.status !== "pending") return result;
  return {
    ...result,
    retryRoomCount,
  };
}

export async function resumePendingAccountDeletions(
  env: Env,
): Promise<{
  scanned: number;
  deleted: number;
  pending: number;
}> {
  const users = await env.DB.prepare(
    `SELECT id FROM user
     WHERE status = 'deleting'
     ORDER BY deletionRequestedAt
     LIMIT ?`,
  ).bind(deletionScanLimit).all<{ id: string }>();
  let deleted = 0;
  let pending = 0;
  for (const user of users.results) {
    // The user ID keeps retries deterministic within the room close ID contract.
    const requestId = `account_retry_${user.id}`.slice(0, 128);
    // oxlint-disable-next-line no-await-in-loop
    const result = await requestAccountDeletion({
      userId: user.id,
      requestId,
    }, env);
    if (result.status === "deleted" || result.status === "already_deleted") {
      deleted += 1;
    } else {
      pending += 1;
    }
  }
  return { scanned: users.results.length, deleted, pending };
}
