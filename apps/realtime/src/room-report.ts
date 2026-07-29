import {
  MODERATION_EVIDENCE_JOB_VERSION,
  validateModerationEvidenceJob,
  validateRoomReportRequest,
  type ModerationEvidenceJob,
  type RoomReportRequest,
  type RoomReportResult,
} from "@koge/protocol";

type ReportRoomRow = {
  id: string;
  name: string;
  membership_present: number;
};

type ExistingReportRow = {
  report_id: string;
  evidence_id: string;
  evidence_status: "pending" | "committed" | "failed" | "deleted";
  created_at: number;
  expires_at: number;
};

async function findExistingReport(
  database: D1Database,
  roomId: string,
  request: RoomReportRequest,
): Promise<ExistingReportRow | null> {
  return database.prepare(
    `SELECT report.id AS report_id,
            evidence.id AS evidence_id,
            evidence.status AS evidence_status,
            report.created_at,
            evidence.expires_at
     FROM reports report
     JOIN evidence_manifests evidence
       ON evidence.id = report.evidence_manifest_id
     WHERE report.source_room_id = ?
       AND report.reporter_subject_kind = ?
       AND report.reporter_subject_id = ?
       AND report.status IN ('open', 'evidence_pending', 'under_review')
     LIMIT 1`,
  ).bind(
    roomId,
    request.reporterSubjectKind,
    request.reporterSubjectId,
  ).first<ExistingReportRow>();
}

function evidenceJob(
  existing: ExistingReportRow,
  roomId: string,
): ModerationEvidenceJob {
  const job = {
    v: MODERATION_EVIDENCE_JOB_VERSION,
    kind: "moderation.evidence",
    jobId: existing.evidence_id,
    reportId: existing.report_id,
    evidenceId: existing.evidence_id,
    roomId,
    requestedAt: existing.created_at,
    expiresAt: existing.expires_at,
  } as const satisfies ModerationEvidenceJob;
  validateModerationEvidenceJob(job);
  return job;
}

async function enqueueEvidence(
  env: Env,
  existing: ExistingReportRow,
  roomId: string,
): Promise<void> {
  if (existing.evidence_status === "committed") return;
  if (existing.evidence_status === "deleted") {
    throw new Error("unresolved report refers to deleted evidence");
  }
  await env.DB.prepare(
    `UPDATE evidence_manifests
     SET status = 'pending'
     WHERE id = ? AND status IN ('pending', 'failed')`,
  ).bind(existing.evidence_id).run();
  try {
    await env.MODERATION_EVIDENCE_QUEUE.send(evidenceJob(existing, roomId));
  } catch (error) {
    await env.DB.prepare(
      `UPDATE evidence_manifests
       SET status = 'failed'
       WHERE id = ? AND status = 'pending'`,
    ).bind(existing.evidence_id).run();
    throw error;
  }
}

export async function createRoomReport(
  input: unknown,
  env: Env,
): Promise<RoomReportResult> {
  validateRoomReportRequest(input);
  const request = input;
  const room = await env.DB.prepare(
    `SELECT room.id, room.name,
            EXISTS (
              SELECT 1
              FROM room_memberships membership
              WHERE membership.room_id = room.id
                AND membership.subject_kind = ?
                AND membership.subject_id = ?
            ) AS membership_present
     FROM rooms room
     WHERE room.public_slug = ?
       AND room.provisioning_status = 'ready'
       AND room.status IN ('waiting', 'active', 'idle', 'closing', 'suspended')`,
  ).bind(
    request.reporterSubjectKind,
    request.reporterSubjectId,
    request.publicSlug,
  ).first<ReportRoomRow>();
  if (!room || room.membership_present !== 1) {
    throw new RoomReportNotAvailableError("room report is not available");
  }

  const existing = await findExistingReport(env.DB, room.id, request);
  if (existing) {
    await enqueueEvidence(env, existing, room.id);
    return {
      status: "already_created",
      reportId: existing.report_id,
      evidenceId: existing.evidence_id,
      evidenceStatus: existing.evidence_status === "committed"
        ? "committed"
        : "pending",
    };
  }

  const insertEvidence = env.DB.prepare(
    `INSERT INTO evidence_manifests (
      id, source_room_id, status, created_at, expires_at
    ) VALUES (?, ?, 'pending', ?, ?)`,
  ).bind(
    request.evidenceId,
    room.id,
    request.requestedAt,
    request.expiresAt,
  );
  const insertReport = env.DB.prepare(
    `INSERT INTO reports (
      id, source_room_id, reporter_subject_kind, reporter_subject_id,
      category, description, room_name_snapshot, status,
      evidence_manifest_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence_pending', ?, ?, ?)`,
  ).bind(
    request.reportId,
    room.id,
    request.reporterSubjectKind,
    request.reporterSubjectId,
    request.category,
    request.description ?? null,
    room.name,
    request.evidenceId,
    request.requestedAt,
    request.requestedAt,
  );
  try {
    await env.DB.batch([insertEvidence, insertReport]);
  } catch (error) {
    const raced = await findExistingReport(env.DB, room.id, request);
    if (!raced) throw error;
    await enqueueEvidence(env, raced, room.id);
    return {
      status: "already_created",
      reportId: raced.report_id,
      evidenceId: raced.evidence_id,
      evidenceStatus: raced.evidence_status === "committed"
        ? "committed"
        : "pending",
    };
  }

  const created = {
    report_id: request.reportId,
    evidence_id: request.evidenceId,
    evidence_status: "pending",
    created_at: request.requestedAt,
    expires_at: request.expiresAt,
  } as const satisfies ExistingReportRow;
  await enqueueEvidence(env, created, room.id);
  return {
    status: "created",
    reportId: request.reportId,
    evidenceId: request.evidenceId,
    evidenceStatus: "pending",
  };
}

export class RoomReportNotAvailableError extends Error {}
