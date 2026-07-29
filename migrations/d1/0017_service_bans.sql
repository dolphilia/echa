ALTER TABLE "moderation_actions"
ADD COLUMN "ban_duration_hours" INTEGER
  CHECK (
    "ban_duration_hours" IS NULL
    OR "ban_duration_hours" IN (24, 168, 720)
  );

CREATE TABLE "service_bans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "subject_kind" TEXT NOT NULL
    CHECK ("subject_kind" IN ('user', 'guest')),
  "subject_id" TEXT NOT NULL,
  "source_room_id" TEXT,
  "source_actor_id" TEXT,
  "starts_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "action_id" TEXT NOT NULL UNIQUE
    REFERENCES "moderation_actions" ("id") ON DELETE RESTRICT,
  "revoked_at" INTEGER,
  "revoked_by_admin_id" TEXT,
  "revocation_reason" TEXT,
  "revocation_action_id" TEXT UNIQUE,
  CHECK ("expires_at" > "starts_at"),
  CHECK (
    ("revoked_at" IS NULL
      AND "revoked_by_admin_id" IS NULL
      AND "revocation_reason" IS NULL
      AND "revocation_action_id" IS NULL)
    OR
    ("revoked_at" IS NOT NULL
      AND "revoked_by_admin_id" IS NOT NULL
      AND "revocation_reason" IS NOT NULL
      AND "revocation_action_id" IS NOT NULL)
  )
);

CREATE INDEX "service_bans_subject_active_idx"
ON "service_bans" (
  "subject_kind", "subject_id", "revoked_at", "starts_at", "expires_at"
);

CREATE INDEX "service_bans_review_idx"
ON "service_bans" ("revoked_at", "expires_at", "starts_at");
