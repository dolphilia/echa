CREATE TABLE "snapshot_orphan_scans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "status" TEXT NOT NULL
    CHECK ("status" IN ('running', 'completed', 'failed')),
  "started_at" INTEGER NOT NULL,
  "completed_at" INTEGER,
  "object_count" INTEGER NOT NULL DEFAULT 0,
  "object_bytes" INTEGER NOT NULL DEFAULT 0,
  "orphan_count" INTEGER NOT NULL DEFAULT 0,
  "orphan_bytes" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT
);

CREATE UNIQUE INDEX "snapshot_orphan_scans_one_running_idx"
ON "snapshot_orphan_scans" ((1))
WHERE "status" = 'running';

CREATE INDEX "snapshot_orphan_scans_started_idx"
ON "snapshot_orphan_scans" ("started_at");

CREATE TABLE "snapshot_orphans" (
  "object_key" TEXT NOT NULL PRIMARY KEY,
  "room_id" TEXT NOT NULL,
  "object_bytes" INTEGER NOT NULL,
  "uploaded_at" INTEGER NOT NULL,
  "reason" TEXT NOT NULL
    CHECK ("reason" IN ('room_missing', 'unreferenced')),
  "first_detected_at" INTEGER NOT NULL,
  "last_detected_at" INTEGER NOT NULL,
  "scan_id" TEXT NOT NULL
    REFERENCES "snapshot_orphan_scans" ("id") ON DELETE CASCADE
);

CREATE INDEX "snapshot_orphans_reason_idx"
ON "snapshot_orphans" ("reason", "first_detected_at");
