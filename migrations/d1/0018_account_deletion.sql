CREATE INDEX "user_deletion_queue_idx"
ON "user" ("status", "deletionRequestedAt");
