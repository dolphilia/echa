ALTER TABLE "moderation_actions"
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'applied'
  CHECK ("status" IN ('pending', 'applied', 'failed'));

ALTER TABLE "moderation_actions"
ADD COLUMN "applied_at" INTEGER;

ALTER TABLE "moderation_actions"
ADD COLUMN "error_code" TEXT;

ALTER TABLE "moderation_actions"
ADD COLUMN "result_json" TEXT;

CREATE INDEX "moderation_actions_status_idx"
ON "moderation_actions" ("status", "created_at");
