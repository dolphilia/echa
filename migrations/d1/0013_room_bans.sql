ALTER TABLE "moderation_actions"
ADD COLUMN "target_actor_id" TEXT;

CREATE TABLE "bans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scope" TEXT NOT NULL CHECK ("scope" = 'room'),
  "room_id" TEXT NOT NULL REFERENCES "rooms" ("id") ON DELETE CASCADE,
  "subject_kind" TEXT NOT NULL
    CHECK ("subject_kind" IN ('user', 'guest')),
  "subject_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "starts_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "action_id" TEXT NOT NULL UNIQUE
    REFERENCES "moderation_actions" ("id") ON DELETE CASCADE,
  CHECK ("expires_at" > "starts_at"),
  UNIQUE ("room_id", "subject_kind", "subject_id")
);

CREATE INDEX "bans_room_actor_idx"
ON "bans" ("room_id", "actor_id", "expires_at");

CREATE INDEX "bans_subject_expiry_idx"
ON "bans" ("subject_kind", "subject_id", "expires_at");
