CREATE UNIQUE INDEX "reports_one_unresolved_per_subject_room_idx"
ON "reports" (
  "source_room_id",
  "reporter_subject_kind",
  "reporter_subject_id"
)
WHERE "status" IN ('open', 'evidence_pending', 'under_review');
