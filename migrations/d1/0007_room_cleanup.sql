ALTER TABLE "rooms"
ADD COLUMN "cleanup_job_id" TEXT;

ALTER TABLE "rooms"
ADD COLUMN "cleanup_requested_at" INTEGER;

CREATE INDEX "rooms_cleanup_idx"
ON "rooms" ("status", "cleanup_job_id")
WHERE "status" = 'closing';
