ALTER TABLE "evidence_manifests"
ADD COLUMN "deletion_job_id" TEXT;

ALTER TABLE "evidence_manifests"
ADD COLUMN "deletion_requested_at" INTEGER;

CREATE INDEX "evidence_manifests_deletion_jobs_idx"
ON "evidence_manifests" ("status", "deletion_requested_at")
WHERE "deletion_job_id" IS NOT NULL;
