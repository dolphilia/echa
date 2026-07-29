CREATE TABLE "guest_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "token_hash" TEXT NOT NULL UNIQUE,
  "created_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "last_seen_at" INTEGER NOT NULL
);

CREATE INDEX "guest_sessions_expiry_idx"
ON "guest_sessions" ("expires_at");

CREATE TABLE "room_memberships" (
  "room_id" TEXT NOT NULL REFERENCES "rooms" ("id") ON DELETE CASCADE,
  "subject_kind" TEXT NOT NULL
    CHECK ("subject_kind" IN ('user', 'guest')),
  "subject_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "role" TEXT NOT NULL
    CHECK ("role" IN ('host', 'participant', 'viewer')),
  "created_at" INTEGER NOT NULL,
  "last_seen_at" INTEGER NOT NULL,
  PRIMARY KEY ("room_id", "subject_kind", "subject_id"),
  UNIQUE ("room_id", "actor_id")
);

CREATE INDEX "room_memberships_subject_idx"
ON "room_memberships" ("subject_kind", "subject_id", "last_seen_at");
