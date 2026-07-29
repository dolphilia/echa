CREATE TABLE "room_invites" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "room_id" TEXT NOT NULL REFERENCES "rooms" ("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL UNIQUE,
  "created_by_user_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  "created_at" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "revoked_at" INTEGER
);

CREATE UNIQUE INDEX "room_invites_active_room_idx"
ON "room_invites" ("room_id")
WHERE "revoked_at" IS NULL;

CREATE INDEX "room_invites_token_lookup_idx"
ON "room_invites" ("token_hash", "expires_at", "revoked_at");
