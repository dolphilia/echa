CREATE TABLE "service_controls" (
  "singleton" INTEGER NOT NULL PRIMARY KEY CHECK ("singleton" = 1),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "room_creation_enabled" INTEGER NOT NULL DEFAULT 1
    CHECK ("room_creation_enabled" IN (0, 1)),
  "room_entry_enabled" INTEGER NOT NULL DEFAULT 1
    CHECK ("room_entry_enabled" IN (0, 1)),
  "drawing_enabled" INTEGER NOT NULL DEFAULT 1
    CHECK ("drawing_enabled" IN (0, 1)),
  "updated_at" INTEGER NOT NULL DEFAULT 0,
  "actor_admin_id" TEXT,
  "reason" TEXT
);

INSERT INTO "service_controls" ("singleton") VALUES (1);

CREATE TABLE "service_control_actions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actor_admin_id" TEXT NOT NULL,
  "room_creation_enabled" INTEGER NOT NULL
    CHECK ("room_creation_enabled" IN (0, 1)),
  "room_entry_enabled" INTEGER NOT NULL
    CHECK ("room_entry_enabled" IN (0, 1)),
  "drawing_enabled" INTEGER NOT NULL
    CHECK ("drawing_enabled" IN (0, 1)),
  "reason" TEXT NOT NULL,
  "requested_at" INTEGER NOT NULL,
  "applied_revision" INTEGER NOT NULL UNIQUE
);

CREATE INDEX "service_control_actions_requested_idx"
ON "service_control_actions" ("requested_at");
