ALTER TABLE "user"
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active'
CHECK ("status" IN ('active', 'suspended', 'deleting'));

ALTER TABLE "user"
ADD COLUMN "deletionRequestedAt" DATE;

CREATE TABLE "rooms" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "public_slug" TEXT NOT NULL UNIQUE,
  "owner_user_id" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  "name" TEXT NOT NULL,
  "theme" TEXT,
  "visibility" TEXT NOT NULL
    CHECK ("visibility" IN ('public', 'unlisted')),
  "status" TEXT NOT NULL
    CHECK ("status" IN ('waiting', 'active', 'idle', 'closing', 'suspended')),
  "participant_limit" INTEGER NOT NULL,
  "viewer_limit" INTEGER NOT NULL,
  "participant_count" INTEGER NOT NULL DEFAULT 0,
  "viewer_count" INTEGER NOT NULL DEFAULT 0,
  "viewer_chat_enabled" INTEGER NOT NULL DEFAULT 0,
  "viewer_stamp_enabled" INTEGER NOT NULL DEFAULT 0,
  "created_at" INTEGER NOT NULL,
  "starts_at" INTEGER,
  "max_ends_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "provisioning_status" TEXT NOT NULL
    CHECK ("provisioning_status" IN ('pending', 'ready', 'failed'))
);

CREATE INDEX "rooms_public_list_idx"
ON "rooms" ("visibility", "provisioning_status", "status", "updated_at");

CREATE INDEX "rooms_owner_idx"
ON "rooms" ("owner_user_id", "status");
