CREATE TABLE "service_capacity_limits" (
  "singleton" INTEGER NOT NULL PRIMARY KEY CHECK ("singleton" = 1),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "live_room_limit" INTEGER NOT NULL DEFAULT 20
    CHECK ("live_room_limit" BETWEEN 1 AND 20),
  "participant_limit" INTEGER NOT NULL DEFAULT 10
    CHECK ("participant_limit" BETWEEN 1 AND 20),
  "viewer_limit" INTEGER NOT NULL DEFAULT 10
    CHECK ("viewer_limit" BETWEEN 0 AND 19),
  "updated_at" INTEGER NOT NULL DEFAULT 0,
  "actor_admin_id" TEXT,
  "reason" TEXT,
  CHECK ("participant_limit" + "viewer_limit" <= 20)
);

INSERT INTO "service_capacity_limits" ("singleton") VALUES (1);

CREATE TABLE "service_capacity_limit_actions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actor_admin_id" TEXT NOT NULL,
  "live_room_limit" INTEGER NOT NULL
    CHECK ("live_room_limit" BETWEEN 1 AND 20),
  "participant_limit" INTEGER NOT NULL
    CHECK ("participant_limit" BETWEEN 1 AND 20),
  "viewer_limit" INTEGER NOT NULL
    CHECK ("viewer_limit" BETWEEN 0 AND 19),
  "reason" TEXT NOT NULL,
  "requested_at" INTEGER NOT NULL,
  "applied_revision" INTEGER NOT NULL UNIQUE,
  CHECK ("participant_limit" + "viewer_limit" <= 20)
);

CREATE INDEX "service_capacity_limit_actions_requested_idx"
ON "service_capacity_limit_actions" ("requested_at");
