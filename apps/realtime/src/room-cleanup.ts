import {
  validateRoomCleanupJob,
  type RoomCleanupJob,
} from "@koge/protocol";
import type { DurableObject as DurableObjectBase } from "cloudflare:workers";
import {
  captureRateAbuseRoomOutcome,
  type RateAbuseCounters,
} from "./rate-abuse-metrics";
import { finalizeAccountDeletion } from "./account-deletion";

type CleanupRoomTarget = DurableObjectBase<Env> & {
  stats(): Promise<RateAbuseCounters>;
  finalizeRoomCleanup(
    job: RoomCleanupJob,
  ): Promise<{ readonly status: "deleted" }>;
};

export type RoomCleanupResult =
  | { readonly status: "already_deleted" }
  | {
      readonly status: "deleted";
      readonly deletedSnapshotObjectCount: number;
      readonly deletedThumbnailObjectCount: number;
    };

async function deleteRoomThumbnails(
  bucket: R2Bucket,
  roomId: string,
  projectedObjectKey: string | null,
): Promise<number> {
  const prefix = `rooms/${roomId}/thumbnails/`;
  const deletedKeys = new Set<string>();
  if (projectedObjectKey !== null) {
    if (!projectedObjectKey.startsWith(prefix)) {
      throw new Error("invalid room thumbnail cleanup object key");
    }
    await bucket.delete(projectedObjectKey);
    deletedKeys.add(projectedObjectKey);
    if (await bucket.head(projectedObjectKey)) {
      throw new Error("projected room thumbnail remained after deletion");
    }
  }

  let cursor: string | undefined;
  const remainingKeys: string[] = [];
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each R2 page requires the previous cursor.
    const page = await bucket.list({
      prefix,
      ...(cursor ? { cursor } : {}),
    });
    for (const { key } of page.objects) {
      if (!key.startsWith(prefix)) {
        throw new Error("invalid room thumbnail cleanup listing");
      }
      remainingKeys.push(key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  for (let index = 0; index < remainingKeys.length; index += 1_000) {
    const keys = remainingKeys.slice(index, index + 1_000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- R2 accepts at most 1,000 keys per delete.
    await bucket.delete(keys);
    for (const key of keys) deletedKeys.add(key);
  }

  const remaining = await bucket.list({ prefix, limit: 1 });
  if (remaining.objects.length > 0 || remaining.truncated) {
    throw new Error("room thumbnail prefix remained after deletion");
  }
  return deletedKeys.size;
}

export async function processRoomCleanupJob(
  input: unknown,
  env: Env,
): Promise<RoomCleanupResult> {
  validateRoomCleanupJob(input);
  const job = input;
  const projection = await env.DB.prepare(
    `SELECT r.status, r.cleanup_job_id, r.owner_user_id,
            r.thumbnail_object_key,
            EXISTS (
              SELECT 1
              FROM reports report
              LEFT JOIN evidence_manifests evidence
                ON evidence.id = report.evidence_manifest_id
              WHERE report.source_room_id = r.id
                AND report.status IN (
                  'open', 'evidence_pending', 'under_review'
                )
                AND (
                  report.evidence_manifest_id IS NULL
                  OR evidence.status IS NULL
                  OR evidence.status <> 'committed'
                )
            ) AS evidence_required,
            EXISTS (
              SELECT 1 FROM rate_abuse_room_outcomes outcome
              WHERE outcome.cleanup_job_id = r.cleanup_job_id
            ) AS metrics_captured
     FROM rooms r WHERE r.id = ?`,
  ).bind(job.roomId).first<{
    status: string;
    cleanup_job_id: string | null;
    owner_user_id: string;
    thumbnail_object_key: string | null;
    evidence_required: number;
    metrics_captured: number;
  }>();
  if (!projection) return { status: "already_deleted" };
  if (
    projection.status !== "closing"
    || projection.cleanup_job_id !== job.jobId
  ) {
    throw new Error("room cleanup projection fence mismatch");
  }
  if (projection.evidence_required === 1) {
    throw new Error("room cleanup blocked until evidence is committed");
  }

  const rooms = env.DRAWING_ROOM as DurableObjectNamespace<CleanupRoomTarget>;
  const room = rooms.getByName(job.roomId, { locationHint: "apac-ne" });
  if (projection.metrics_captured !== 1) {
    const stats = await room.stats();
    await captureRateAbuseRoomOutcome(
      env.DB,
      job.jobId,
      job.roomId,
      stats,
    );
  }

  if (job.snapshotObjectKeys.length > 0) {
    await env.RUNTIME_SNAPSHOTS.delete([...job.snapshotObjectKeys]);
  }
  // Remove every object below the room prefix, including superseded
  // thumbnails whose earlier best-effort deletion may have failed.
  const deletedThumbnailObjectCount = await deleteRoomThumbnails(
    env.ROOM_THUMBNAILS,
    job.roomId,
    projection.thumbnail_object_key,
  );

  await room.finalizeRoomCleanup(job);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM room_invites WHERE room_id = ?").bind(job.roomId),
    env.DB.prepare("DELETE FROM room_memberships WHERE room_id = ?").bind(job.roomId),
    env.DB.prepare(
      `DELETE FROM rooms
       WHERE id = ? AND status = 'closing' AND cleanup_job_id = ?`,
    ).bind(job.roomId, job.jobId),
  ]);
  const remaining = await env.DB.prepare(
    "SELECT 1 AS present FROM rooms WHERE id = ?",
  ).bind(job.roomId).first<{ present: number }>();
  if (remaining) throw new Error("room cleanup projection delete failed");
  if (projection.owner_user_id) {
    await finalizeAccountDeletion(env.DB, projection.owner_user_id);
  }

  return {
    status: "deleted",
    deletedSnapshotObjectCount: job.snapshotObjectKeys.length,
    deletedThumbnailObjectCount,
  };
}
