CREATE TABLE "snapshot_orphan_deletion_runs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "plan_hash" TEXT NOT NULL UNIQUE,
  "environment" TEXT NOT NULL,
  "source_scan_id" TEXT NOT NULL,
  "verification_scan_id" TEXT NOT NULL,
  "status" TEXT NOT NULL
    CHECK ("status" IN ('completed', 'failed')),
  "object_count" INTEGER NOT NULL,
  "object_bytes" INTEGER NOT NULL,
  "deleted_count" INTEGER NOT NULL DEFAULT 0,
  "deleted_bytes" INTEGER NOT NULL DEFAULT 0,
  "requested_at" INTEGER NOT NULL,
  "completed_at" INTEGER NOT NULL,
  "error" TEXT
);

CREATE TABLE "snapshot_orphan_deletion_items" (
  "run_id" TEXT NOT NULL
    REFERENCES "snapshot_orphan_deletion_runs" ("id") ON DELETE CASCADE,
  "object_key_hash" TEXT NOT NULL,
  "room_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL
    CHECK ("reason" IN ('room_missing', 'unreferenced')),
  "object_bytes" INTEGER NOT NULL,
  "result" TEXT NOT NULL
    CHECK ("result" IN ('deleted', 'already_missing')),
  PRIMARY KEY ("run_id", "object_key_hash")
);

CREATE INDEX "snapshot_orphan_deletion_runs_completed_idx"
ON "snapshot_orphan_deletion_runs" ("completed_at");
