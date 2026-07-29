ALTER TABLE "rooms"
ADD COLUMN "create_request_id" TEXT;

ALTER TABLE "rooms"
ADD COLUMN "provisioning_attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "rooms"
ADD COLUMN "provisioning_error_code" TEXT;

ALTER TABLE "rooms"
ADD COLUMN "provisioning_updated_at" INTEGER;

CREATE UNIQUE INDEX "rooms_owner_create_request_idx"
ON "rooms" ("owner_user_id", "create_request_id")
WHERE "create_request_id" IS NOT NULL;

CREATE INDEX "rooms_provisioning_retry_idx"
ON "rooms" ("provisioning_status", "provisioning_updated_at");
