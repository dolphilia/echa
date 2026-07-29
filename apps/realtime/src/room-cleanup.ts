import {
  validateRoomCleanupJob,
  type RoomCleanupJob,
} from "@koge/protocol";
import type { DurableObject as DurableObjectBase } from "cloudflare:workers";
import {
  captureRateAbuseRoomOutcome,
  type RateAbuseCounters,
} from "./rate-abuse-metrics";

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
    };

export async function processRoomCleanupJob(
  input: unknown,
  env: Env,
): Promise<RoomCleanupResult> {
  validateRoomCleanupJob(input);
  const job = input;
  const projection = await env.DB.prepare(
    `SELECT r.status, r.cleanup_job_id,
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

  return {
    status: "deleted",
    deletedSnapshotObjectCount: job.snapshotObjectKeys.length,
  };
}
