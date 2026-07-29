CREATE TABLE "rate_abuse_room_outcomes" (
  "cleanup_job_id" TEXT NOT NULL PRIMARY KEY,
  "room_digest" TEXT NOT NULL,
  "captured_at" INTEGER NOT NULL,
  "accepted_count" INTEGER NOT NULL,
  "reject_count" INTEGER NOT NULL,
  "rate_limited_count" INTEGER NOT NULL,
  "short_mute_count" INTEGER NOT NULL,
  "abuse_disconnect_count" INTEGER NOT NULL
);

CREATE INDEX "rate_abuse_room_outcomes_captured_idx"
ON "rate_abuse_room_outcomes" ("captured_at");
