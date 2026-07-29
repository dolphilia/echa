CREATE TABLE "evidence_manifests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source_room_id" TEXT NOT NULL,
  "status" TEXT NOT NULL
    CHECK ("status" IN ('pending', 'committed', 'failed', 'deleted')),
  "object_key" TEXT,
  "object_bytes" INTEGER,
  "object_hash" TEXT,
  "created_at" INTEGER NOT NULL,
  "committed_at" INTEGER,
  "expires_at" INTEGER NOT NULL,
  "deleted_at" INTEGER
);

CREATE INDEX "evidence_manifests_room_idx"
ON "evidence_manifests" ("source_room_id", "status");

CREATE INDEX "evidence_manifests_expiry_idx"
ON "evidence_manifests" ("status", "expires_at");

CREATE TABLE "reports" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source_room_id" TEXT NOT NULL,
  "reporter_subject_kind" TEXT NOT NULL
    CHECK ("reporter_subject_kind" IN ('user', 'guest')),
  "reporter_subject_id" TEXT NOT NULL,
  "category" TEXT NOT NULL
    CHECK ("category" IN (
      'harassment', 'sexual', 'violence', 'copyright', 'other'
    )),
  "description" TEXT,
  "room_name_snapshot" TEXT NOT NULL,
  "status" TEXT NOT NULL
    CHECK ("status" IN (
      'open', 'evidence_pending', 'under_review', 'resolved', 'dismissed'
    )),
  "evidence_manifest_id" TEXT
    REFERENCES "evidence_manifests" ("id") ON DELETE SET NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "resolved_at" INTEGER
);

CREATE INDEX "reports_room_status_idx"
ON "reports" ("source_room_id", "status");

CREATE INDEX "reports_review_queue_idx"
ON "reports" ("status", "created_at");

CREATE TABLE "moderation_actions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "report_id" TEXT REFERENCES "reports" ("id") ON DELETE SET NULL,
  "source_room_id" TEXT,
  "target_subject_kind" TEXT
    CHECK (
      "target_subject_kind" IS NULL
      OR "target_subject_kind" IN ('user', 'guest', 'actor')
    ),
  "target_subject_id" TEXT,
  "action" TEXT NOT NULL
    CHECK ("action" IN (
      'suspend_room', 'close_room', 'kick', 'mute', 'room_ban',
      'service_ban', 'preserve_evidence', 'delete_evidence'
    )),
  "actor_admin_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL
);

CREATE INDEX "moderation_actions_room_idx"
ON "moderation_actions" ("source_room_id", "created_at");
