import {
  MODERATION_EVIDENCE_DELETE_JOB_VERSION,
  validateModerationEvidenceDeleteJob,
  type ModerationEvidenceDeleteJob,
} from "@koge/protocol";

type ExpiredEvidenceRow = {
  id: string;
  expires_at: number;
};

type EvidenceDeletionRow = {
  status: "pending" | "committed" | "failed" | "deleted";
  expires_at: number;
  deletion_job_id: string | null;
};

export type ModerationEvidenceDeletionResult = {
  readonly status: "deleted" | "already_deleted" | "not_due";
  readonly deletedObjectCount: number;
};

const SCAN_LIMIT = 100;
const RETRY_STALE_AFTER_MS = 5 * 60 * 1_000;
const R2_LIST_LIMIT = 1_000;

function evidencePrefix(evidenceId: string): string {
  return `moderation-evidence/${evidenceId}/`;
}

function deletionJob(row: ExpiredEvidenceRow): ModerationEvidenceDeleteJob {
  return {
    v: MODERATION_EVIDENCE_DELETE_JOB_VERSION,
    kind: "moderation.evidence.delete",
    jobId: row.id,
    evidenceId: row.id,
    expiresAt: row.expires_at,
  };
}

export async function enqueueExpiredModerationEvidence(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const candidates = await env.DB.prepare(
    `SELECT id, expires_at
     FROM evidence_manifests
     WHERE status = 'committed'
       AND expires_at <= ?
       AND (
         deletion_job_id IS NULL
         OR deletion_requested_at <= ?
       )
     ORDER BY expires_at
     LIMIT ?`,
  ).bind(now, now - RETRY_STALE_AFTER_MS, SCAN_LIMIT)
    .all<ExpiredEvidenceRow>();
  let enqueued = 0;
  for (const row of candidates.results) {
    const job = deletionJob(row);
    // Claim before enqueue; a stale claim is intentionally reusable.
    // oxlint-disable-next-line no-await-in-loop
    const claim = await env.DB.prepare(
      `UPDATE evidence_manifests
       SET deletion_job_id = ?, deletion_requested_at = ?
       WHERE id = ?
         AND status = 'committed'
         AND expires_at = ?
         AND expires_at <= ?
         AND (
           deletion_job_id IS NULL
           OR deletion_requested_at <= ?
         )`,
    ).bind(
      job.jobId,
      now,
      row.id,
      row.expires_at,
      now,
      now - RETRY_STALE_AFTER_MS,
    ).run();
    if (claim.meta.changes !== 1) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop
      await env.MODERATION_EVIDENCE_QUEUE.send(job);
      enqueued += 1;
    } catch (error) {
      // Release only our unchanged claim so the next scheduled scan can retry.
      // oxlint-disable-next-line no-await-in-loop
      await env.DB.prepare(
        `UPDATE evidence_manifests
         SET deletion_job_id = NULL, deletion_requested_at = NULL
         WHERE id = ? AND deletion_job_id = ? AND deletion_requested_at = ?`,
      ).bind(row.id, job.jobId, now).run();
      throw error;
    }
  }
  return enqueued;
}

async function deleteEvidenceObjects(
  bucket: R2Bucket,
  evidenceId: string,
): Promise<number> {
  const prefix = evidencePrefix(evidenceId);
  let deleted = 0;
  while (true) {
    // Re-list the prefix after each delete so object removal cannot invalidate a
    // continuation cursor.
    // oxlint-disable-next-line no-await-in-loop
    const page = await bucket.list({
      prefix,
      limit: R2_LIST_LIMIT,
    });
    const keys = page.objects.map(({ key }) => key);
    if (keys.some((key) => !key.startsWith(prefix))) {
      throw new Error("moderation evidence deletion escaped its prefix");
    }
    if (keys.length > 0) {
      // R2 bulk delete accepts at most 1,000 keys.
      // oxlint-disable-next-line no-await-in-loop
      await bucket.delete(keys);
      deleted += keys.length;
    }
    if (!page.truncated) break;
  }
  return deleted;
}

export async function processModerationEvidenceDeleteJob(
  input: unknown,
  env: Env,
  now = Date.now(),
): Promise<ModerationEvidenceDeletionResult> {
  validateModerationEvidenceDeleteJob(input);
  const row = await env.DB.prepare(
    `SELECT status, expires_at, deletion_job_id
     FROM evidence_manifests
     WHERE id = ?`,
  ).bind(input.evidenceId).first<EvidenceDeletionRow>();
  if (!row) throw new Error("moderation evidence deletion projection is missing");
  if (row.status === "deleted") {
    return { status: "already_deleted", deletedObjectCount: 0 };
  }
  if (
    row.status !== "committed"
    || row.expires_at !== input.expiresAt
    || row.deletion_job_id !== input.jobId
    || row.expires_at > now
  ) {
    return { status: "not_due", deletedObjectCount: 0 };
  }

  const deletedObjectCount = await deleteEvidenceObjects(
    env.RUNTIME_SNAPSHOTS,
    input.evidenceId,
  );
  const result = await env.DB.prepare(
    `UPDATE evidence_manifests
     SET status = 'deleted',
         object_key = NULL,
         object_bytes = NULL,
         object_hash = NULL,
         deleted_at = ?
     WHERE id = ?
       AND status = 'committed'
       AND expires_at = ?
       AND deletion_job_id = ?
       AND expires_at <= ?`,
  ).bind(
    now,
    input.evidenceId,
    input.expiresAt,
    input.jobId,
    now,
  ).run();
  if (result.meta.changes !== 1) {
    throw new Error("moderation evidence deletion fence changed after R2 delete");
  }
  return { status: "deleted", deletedObjectCount };
}
