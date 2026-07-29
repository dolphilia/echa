import {
  validateRoomModerationRequest,
  validateRoomModerationResult,
  type RoomModerationRequest,
  type RoomModerationResult,
} from "@koge/protocol";

type ExistingModerationActionRow = {
  source_room_id: string | null;
  target_actor_id: string | null;
  action: RoomModerationRequest["action"];
  actor_admin_id: string;
  reason: string;
  ban_duration_hours: number | null;
  created_at: number;
  status: "pending" | "applied" | "failed";
  result_json: string | null;
};

function assertMatchingAction(
  existing: ExistingModerationActionRow,
  request: RoomModerationRequest,
): void {
  if (
    existing.source_room_id !== request.roomId
    || existing.target_actor_id !== (request.targetActorId ?? null)
    || existing.action !== request.action
    || existing.actor_admin_id !== request.actorAdminId
    || existing.reason !== request.reason
    || existing.created_at !== request.requestedAt
    || existing.ban_duration_hours
      !== (request.action === "service_ban" ? request.banDurationHours : null)
  ) {
    throw new RoomModerationConflictError(
      "moderation action ID was reused with different input",
    );
  }
}

function restoredResult(
  row: ExistingModerationActionRow,
): RoomModerationResult {
  if (!row.result_json) {
    throw new Error("applied moderation action is missing its result");
  }
  const value: unknown = JSON.parse(row.result_json);
  validateRoomModerationResult(value);
  return { ...value, status: "already_applied" };
}

export async function applyRoomModerationAction(
  input: unknown,
  env: Env,
): Promise<RoomModerationResult> {
  validateRoomModerationRequest(input);
  const request = input;
  const existing = await env.DB.prepare(
     `SELECT source_room_id, action, actor_admin_id, reason, created_at,
            ban_duration_hours,
            target_actor_id, status, result_json
     FROM moderation_actions
     WHERE id = ?`,
  ).bind(request.actionId).first<ExistingModerationActionRow>();
  let roomProjection = await env.DB.prepare(
    `SELECT id, max_ends_at FROM rooms
     WHERE id = ? AND provisioning_status = 'ready'
       AND status IN ('waiting', 'active', 'idle', 'suspended', 'closing')`,
  ).bind(request.roomId).first<{ id: string; max_ends_at: number }>();
  if (existing) {
    assertMatchingAction(existing, request);
    if (existing.status === "applied") return restoredResult(existing);
  } else {
    if (!roomProjection) {
      throw new RoomModerationNotAvailableError(
        "room moderation target is not available",
      );
    }
    const target = (
      request.action === "kick"
      || request.action === "room_ban"
      || request.action === "service_ban"
    )
      ? await env.DB.prepare(
          `SELECT subject_kind, subject_id, role
           FROM room_memberships
           WHERE room_id = ? AND actor_id = ?`,
        ).bind(request.roomId, request.targetActorId).first<{
          subject_kind: "user" | "guest";
          subject_id: string;
          role: "host" | "participant" | "viewer";
        }>()
      : null;
    if (
      (
        request.action === "kick"
        || request.action === "room_ban"
        || request.action === "service_ban"
      )
      && !target
    ) {
      throw new RoomModerationNotAvailableError(
        "room moderation target member is not available",
      );
    }
    if (
      target?.role === "host"
      && (request.action === "kick" || request.action === "room_ban")
    ) {
      throw new RoomModerationTargetForbiddenError(
        "room host cannot be kicked or room banned",
      );
    }
    try {
      await env.DB.prepare(
        `INSERT INTO moderation_actions (
          id, report_id, source_room_id, target_subject_kind,
          target_subject_id, target_actor_id, action,
          actor_admin_id, reason, created_at, ban_duration_hours,
          status, applied_at, error_code, result_json
        ) VALUES (
          ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL
        )`,
      ).bind(
        request.actionId,
        request.roomId,
        target?.subject_kind ?? null,
        target?.subject_id ?? null,
        request.targetActorId ?? null,
        request.action,
        request.actorAdminId,
        request.reason,
        request.requestedAt,
        request.action === "service_ban" ? request.banDurationHours : null,
      ).run();
    } catch (error) {
      const raced = await env.DB.prepare(
        `SELECT source_room_id, action, actor_admin_id, reason, created_at,
                ban_duration_hours,
                target_actor_id, status, result_json
         FROM moderation_actions WHERE id = ?`,
      ).bind(request.actionId).first<ExistingModerationActionRow>();
      if (!raced) throw error;
      assertMatchingAction(raced, request);
      if (raced.status === "applied") return restoredResult(raced);
    }
  }

  if (!roomProjection) {
    roomProjection = await env.DB.prepare(
      `SELECT id, max_ends_at FROM rooms
       WHERE id = ? AND provisioning_status = 'ready'
         AND status IN ('waiting', 'active', 'idle', 'suspended', 'closing')`,
    ).bind(request.roomId).first<{ id: string; max_ends_at: number }>();
  }
  if (!roomProjection) {
    throw new RoomModerationNotAvailableError(
      "room moderation target is not available",
    );
  }
  const room = env.DRAWING_ROOM.getByName(request.roomId, {
    locationHint: "apac-ne",
  });
  try {
    let result: RoomModerationResult;
    if (request.action === "suspend_room") {
      const lifecycle = await room.suspendRoom(request);
      result = {
        status: "applied",
        actionId: request.actionId,
        roomId: request.roomId,
        action: request.action,
        lifecycle,
      };
    } else if (request.action === "close_room") {
      const lifecycle = await room.beginRoomClose({
        closeRequestId: request.actionId,
        reason: "admin",
      });
      result = {
        status: "applied",
        actionId: request.actionId,
        roomId: request.roomId,
        action: request.action,
        lifecycle,
      };
    } else if (request.action === "service_ban") {
      if (!request.targetActorId) {
        throw new TypeError("service ban target is required");
      }
      const target = await env.DB.prepare(
        `SELECT subject_kind, subject_id
         FROM room_memberships
         WHERE room_id = ? AND actor_id = ?`,
      ).bind(request.roomId, request.targetActorId).first<{
        subject_kind: "user" | "guest";
        subject_id: string;
      }>();
      if (!target) {
        throw new RoomModerationNotAvailableError(
          "service ban target is not available",
        );
      }
      const banExpiresAt =
        request.requestedAt + request.banDurationHours * 60 * 60 * 1_000;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO service_bans (
           id, subject_kind, subject_id, source_room_id, source_actor_id,
           starts_at, expires_at, reason, action_id,
           revoked_at, revoked_by_admin_id, revocation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).bind(
        request.actionId,
        target.subject_kind,
        target.subject_id,
        request.roomId,
        request.targetActorId,
        request.requestedAt,
        banExpiresAt,
        request.reason,
        request.actionId,
      ).run();
      const memberships = await env.DB.prepare(
        `SELECT rm.room_id, rm.actor_id
         FROM room_memberships rm
         JOIN rooms r ON r.id = rm.room_id
         WHERE rm.subject_kind = ? AND rm.subject_id = ?
           AND r.provisioning_status = 'ready'
           AND r.status IN ('waiting', 'active', 'idle', 'suspended')
         ORDER BY r.updated_at DESC
         LIMIT 25`,
      ).bind(target.subject_kind, target.subject_id).all<{
        room_id: string;
        actor_id: string;
      }>();
      let disconnectedConnectionCount = 0;
      let affectedRoomCount = 0;
      for (const membership of memberships.results) {
        const affectedRoom = env.DRAWING_ROOM.getByName(membership.room_id, {
          locationHint: "apac-ne",
        });
        // Ordered calls keep the aggregate deterministic for the audit result.
        // oxlint-disable-next-line no-await-in-loop
        const disconnected = await affectedRoom.disconnectServiceBannedActor(
          membership.actor_id,
          request.actionId,
        );
        disconnectedConnectionCount += disconnected.disconnectedConnectionCount;
        affectedRoomCount += 1;
      }
      result = {
        status: "applied",
        actionId: request.actionId,
        roomId: request.roomId,
        action: "service_ban",
        targetActorId: request.targetActorId,
        disconnectedConnectionCount,
        affectedRoomCount,
        banExpiresAt,
      };
    } else {
      if (!request.targetActorId) {
        throw new TypeError("member moderation target is required");
      }
      const memberResult = await room.moderateMember(request);
      if (request.action === "room_ban") {
        const target = await env.DB.prepare(
          `SELECT subject_kind, subject_id
           FROM room_memberships
           WHERE room_id = ? AND actor_id = ?`,
        ).bind(request.roomId, request.targetActorId).first<{
          subject_kind: "user" | "guest";
          subject_id: string;
        }>();
        if (!target) {
          throw new RoomModerationNotAvailableError(
            "room ban target is not available",
          );
        }
        await env.DB.prepare(
          `INSERT INTO bans (
             id, scope, room_id, subject_kind, subject_id, actor_id,
             starts_at, expires_at, reason, action_id
           ) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(room_id, subject_kind, subject_id) DO UPDATE SET
             id = excluded.id,
             actor_id = excluded.actor_id,
             starts_at = excluded.starts_at,
             expires_at = excluded.expires_at,
             reason = excluded.reason,
             action_id = excluded.action_id`,
        ).bind(
          request.actionId,
          request.roomId,
          target.subject_kind,
          target.subject_id,
          request.targetActorId,
          request.requestedAt,
          roomProjection.max_ends_at,
          request.reason,
          request.actionId,
        ).run();
      }
      result = request.action === "room_ban"
        ? {
            status: "applied",
            actionId: request.actionId,
            roomId: request.roomId,
            action: "room_ban",
            targetActorId: request.targetActorId,
            disconnectedConnectionCount:
              memberResult.disconnectedConnectionCount,
            banExpiresAt: roomProjection.max_ends_at,
          }
        : {
            status: "applied",
            actionId: request.actionId,
            roomId: request.roomId,
            action: "kick",
            targetActorId: request.targetActorId,
            disconnectedConnectionCount:
              memberResult.disconnectedConnectionCount,
          };
    }
    validateRoomModerationResult(result);
    await env.DB.prepare(
      `UPDATE moderation_actions
       SET status = 'applied', applied_at = ?, error_code = NULL,
           result_json = ?
       WHERE id = ? AND status IN ('pending', 'failed')`,
    ).bind(Date.now(), JSON.stringify(result), request.actionId).run();
    return result;
  } catch (error) {
    await env.DB.prepare(
      `UPDATE moderation_actions
       SET status = 'failed', error_code = 'APPLY_FAILED'
       WHERE id = ? AND status = 'pending'`,
    ).bind(request.actionId).run();
    throw error;
  }
}

export class RoomModerationConflictError extends Error {}
export class RoomModerationNotAvailableError extends Error {}
export class RoomModerationTargetForbiddenError extends Error {}
