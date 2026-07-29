import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  ROOM_ACTIVITY_EVENT_LIMIT,
  ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES,
  SNAPSHOT_CANVAS_GENERATION,
  SNAPSHOT_CODEC,
  SNAPSHOT_EVENT_CHUNK_LIMIT,
  SNAPSHOT_JOB_VERSION,
  SNAPSHOT_RENDERER_VERSION,
  ROOM_EMPTY_TIMEOUT_MS,
  ROOM_IDLE_TIMEOUT_MS,
  ROOM_CLOSE_REASONS,
  ROOM_CLEANUP_JOB_VERSION,
  validateModerationEvidenceJob,
  validateRoomModerationRequest,
  validateRoomCleanupJob,
  validateRoomProvisioningRequest,
  validateRoomTicketRegistrationRequest,
  decodeClientRealtimeMessage,
  decodeEvent,
  decodeRoomEvent,
  encodeRoomEvent,
  encodeServerMessage,
  type AcceptedStrokeEvent,
  type ActiveRoomMember,
  type ChatMessage,
  type ClientChatMessage,
  type ClientStrokeEvent,
  type RejectCode,
  type RejectMessage,
  type RoomCloseRequest,
  type RoomCloseResult,
  type RoomCleanupJob,
  type ModerationEvidenceEventChunk,
  type ModerationEvidenceJob,
  type ModerationEvidencePlan,
  type RoomLifecycleState,
  type RoomModerationRequest,
  type RoomActivityLevel,
  type RoomActivityMessage,
  type RoomTimeMessage,
  type RoomTimeWarningMinutes,
  type RoomProvisioningRequest,
  type RoomProvisioningResult,
  type RoomRole,
  type RoomTicketRegistrationRequest,
  type RoomUpdatedMessage,
  type ServerMessage,
  type SnapshotCommitResult,
  type SnapshotCompactionChunk,
  type SnapshotCompactionState,
  type SnapshotEventChunk,
  type SnapshotJob,
  type SnapshotJobDisposition,
  type SnapshotManifest,
  type SnapshotOfferMessage,
  type SnapshotReadGrant,
} from "@koge/protocol";
import { DurableObject } from "cloudflare:workers";
import {
  decideSnapshotAutomation,
  shouldArmSnapshotCompaction,
  snapshotAutomationConfig,
  type SnapshotAutomationDecision,
} from "./snapshot-automation";

type ConnectionAttachment = {
  actor: string;
  connectionId: string;
  role: RoomRole;
  roomId: string;
  canChat?: boolean;
  displayName?: string | null;
  avatarUrl?: string | null;
};

type ReplayFrameCacheEntry = {
  afterRoomSeq: number;
  throughRoomSeq: number;
  eventCount: number;
  frames: readonly Uint8Array[];
  encodedBytes: number;
};

type RoomTicketRow = {
  actor_id: string;
  connection_id: string;
  role: RoomRole;
  can_chat: number;
  display_name: string | null;
  avatar_url: string | null;
  session_binding_hash: string;
  expires_at: number;
  consumed_at: number | null;
};

type StrokeRow = {
  actor: string;
  status: "active" | "ended" | "cancelled";
  last_dt: number;
  point_count: number;
};

type StoredEventRow = {
  room_seq: number;
  actor: string;
  connection_id: string;
  accepted_at: number;
  payload: ArrayBuffer;
};

type StoredChatMessageRow = {
  seq: number;
  message_id: string;
  actor: string;
  role: RoomRole;
  display_name: string | null;
  avatar_url: string | null;
  text: string;
  created_at: number;
};

type RoomCleanupRow = {
  job_id: string;
  close_request_id: string;
  requested_at: number;
  snapshot_object_keys: string;
  enqueued_at: number | null;
  next_enqueue_at: number | null;
};

type ModerationEvidenceExportRow = {
  evidence_id: string;
  report_id: string;
  target_room_seq: number;
  source_base_room_seq: number;
  plan_json: string;
  created_at: number;
};

type SnapshotJobRow = {
  job_id: string;
  room_id: string;
  target_room_seq: number;
  protocol_version: number;
  renderer_version: number;
  canvas_generation: number;
  generation: number;
  requested_at: number;
  source_job_id: string | null;
  source_base_room_seq: number;
  trigger_kind: "manual" | "events" | "payload";
  trigger_event_count: number;
  trigger_payload_bytes: number;
  status: "queued" | "committed" | "superseded";
};

type SnapshotManifestRow = {
  job_id: string;
  room_id: string;
  base_room_seq: number;
  protocol_version: number;
  renderer_version: number;
  canvas_generation: number;
  generation: number;
  codec: string;
  width: number;
  height: number;
  object_key: string;
  object_bytes: number;
  object_hash: string;
  rgba_hash: string;
  created_at: number;
};

type SnapshotReadTicketRow = SnapshotManifestRow & {
  expires_at: number;
};

type SnapshotStateRow = {
  current_job_id: string | null;
  previous_job_id: string | null;
  mode: "shadow" | "snapshot_compacted";
  compacted_through_room_seq: number;
};

type QueuedSnapshotSourceRow = {
  job_id: string;
  source_base_room_seq: number;
};

type RoomLifecycleRow = {
  status: "waiting" | "active" | "idle" | "closing" | "suspended";
  status_changed_at: number;
  last_activity_at: number | null;
  close_request_id: string | null;
  close_reason: string | null;
  closing_started_at: number | null;
  finalized_stroke_count: number;
  superseded_snapshot_job_count: number;
};

type RoomMetadataRow = {
  room_id: string;
  public_slug: string;
  owner_user_id: string;
  name: string;
  visibility: RoomProvisioningRequest["visibility"];
  participant_limit: number;
  viewer_limit: number;
  viewer_chat_enabled: number;
  viewer_stamp_enabled: number;
  created_at: number;
  max_ends_at: number;
};

type SnapshotAutomationRow = {
  room_id: string | null;
  pending_compaction_job_id: string | null;
  compaction_due_at: number | null;
  last_evaluated_at: number;
  last_evaluation_status: SnapshotAutomationDecision["status"] | null;
};

type SnapshotAutomationResult = SnapshotAutomationDecision & {
  eventCount: number;
  payloadBytes: number;
  job?: SnapshotJob;
};

type SnapshotAutomationState = {
  config: ReturnType<typeof snapshotAutomationConfig>;
  roomId?: string;
  pendingCompactionJobId?: string;
  compactionDueAt?: number;
  lastEvaluatedAt: number;
  lastEvaluationStatus?: SnapshotAutomationDecision["status"];
};

type RoomStats = {
  eventCount: number;
  activeStrokeCount: number;
  connectionCount: number;
  lastRoomSeq: number;
  acceptedCount: number;
  rejectCount: number;
  broadcastCount: number;
  replayEventCount: number;
  totalPayloadBytes: number;
  rateLimitedCount: number;
  shortMuteCount: number;
  abuseDisconnectCount: number;
};

type RoomActivityLimitRow = {
  warning_level: number;
  reached_at: number | null;
};

type RoomActivityLimitEvaluation = {
  message?: RoomActivityMessage;
  closeRequest?: RoomCloseRequest;
};

type ActorAbuseRow = {
  violation_count: number;
  window_started_at: number;
  muted_until: number;
  disconnected_at: number | null;
};

type ActorAbuseAction = {
  mutedUntil: number;
  disconnect: boolean;
  newlyMuted: boolean;
  newlyDisconnected: boolean;
};

type RoomTimeLimitRow = {
  warning_stage: number;
  due_at: number;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const UNFINISHED_STROKE_TIMEOUT_MS = 2_000;
const RATE_CLOCK_REFRESH_THRESHOLD =
  PROTOCOL_LIMITS.eventRatePerSecond / 2;
const CURSOR_RATE_CLOCK_REFRESH_THRESHOLD =
  PROTOCOL_LIMITS.cursorRatePerSecond / 2;
const CHAT_RATE_CLOCK_REFRESH_THRESHOLD =
  PROTOCOL_LIMITS.chatRatePerSecond / 2;
const SERVER_TIMEOUT_CONNECTION_ID = "server_timeout";
const SERVER_CLOSE_CONNECTION_ID = "server_room_close";
const SERVER_SUSPEND_CONNECTION_ID = "server_room_suspend";
const SERVER_MEMBER_MODERATION_CONNECTION_ID = "server_member_moderation";
const SERVER_EMERGENCY_CONTROL_CONNECTION_ID = "server_emergency_control";
const SERVER_RATE_ABUSE_CONNECTION_ID = "server_rate_abuse";
const SERVICE_CONTROL_CACHE_TTL_MS = 5_000;
const RATE_ABUSE_WINDOW_MS = 10_000;
const RATE_ABUSE_MUTE_MS = 5_000;
const RATE_ABUSE_MUTE_THRESHOLD = 3;
const RATE_ABUSE_DISCONNECT_THRESHOLD = 8;
const SNAPSHOT_READ_TTL_MS = 60_000;
const SNAPSHOT_READ_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EXCLUDED_SNAPSHOT_JOBS = 2;
const MAX_REPLAY_FRAME_CACHE_BYTES = 8 * 1024 * 1024;
const MINUTE_MS = 60 * 1_000;
const LATEST_SCHEMA_VERSION = 28;

function roomTimeWarningForStage(
  stage: number,
): RoomTimeWarningMinutes | undefined {
  if (stage === 1) return 15;
  if (stage === 2) return 5;
  if (stage === 3) return 1;
  return undefined;
}

function roomTimeWarningStage(remainingMs: number): number {
  if (remainingMs <= MINUTE_MS) return 3;
  if (remainingMs <= 5 * MINUTE_MS) return 2;
  if (remainingMs <= 15 * MINUTE_MS) return 1;
  return 0;
}

function roomActivityLevel(
  eventCount: number,
  payloadBytes: number,
): RoomActivityLevel | 0 {
  for (const level of [100, 98, 90, 80] as const) {
    if (
      eventCount * 100 >= ROOM_ACTIVITY_EVENT_LIMIT * level
      || payloadBytes * 100 >= ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES * level
    ) {
      return level;
    }
  }
  return 0;
}

function isConnectionAttachment(value: unknown): value is ConnectionAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.actor === "string"
    && IDENTIFIER_PATTERN.test(record.actor)
    && typeof record.connectionId === "string"
    && IDENTIFIER_PATTERN.test(record.connectionId)
    && (
      record.role === "host"
      || record.role === "participant"
      || record.role === "viewer"
    )
    && typeof record.roomId === "string"
    && IDENTIFIER_PATTERN.test(record.roomId)
    && (
      record.canChat === undefined
      || typeof record.canChat === "boolean"
    )
    && (
      record.displayName === undefined
      || record.displayName === null
      || typeof record.displayName === "string"
    )
    && (
      record.avatarUrl === undefined
      || record.avatarUrl === null
      || typeof record.avatarUrl === "string"
    )
  );
}

function reject(
  code: RejectCode,
  message: string,
  clientSeq?: number,
): RejectMessage {
  return {
    type: "reject",
    code,
    message,
    ...(clientSeq === undefined ? {} : { clientSeq }),
  };
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer;
}

function snapshotJobFromRow(row: SnapshotJobRow): SnapshotJob {
  if (
    row.protocol_version !== PROTOCOL_VERSION
    || row.renderer_version !== SNAPSHOT_RENDERER_VERSION
    || row.canvas_generation !== SNAPSHOT_CANVAS_GENERATION
  ) {
    throw new RangeError("snapshot job renderer version is unsupported");
  }
  return {
    v: SNAPSHOT_JOB_VERSION,
    jobId: row.job_id,
    roomId: row.room_id,
    targetRoomSeq: row.target_room_seq,
    protocolVersion: PROTOCOL_VERSION,
    rendererVersion: SNAPSHOT_RENDERER_VERSION,
    canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
    generation: row.generation,
    requestedAt: row.requested_at,
    sourceBaseRoomSeq: row.source_base_room_seq,
    ...(row.source_job_id === null
      ? {}
      : { sourceSnapshotJobId: row.source_job_id }),
  };
}

function validateSnapshotManifest(manifest: SnapshotManifest): void {
  if (
    manifest.v !== SNAPSHOT_JOB_VERSION
    || !IDENTIFIER_PATTERN.test(manifest.jobId)
    || !IDENTIFIER_PATTERN.test(manifest.roomId)
    || !Number.isSafeInteger(manifest.baseRoomSeq)
    || manifest.baseRoomSeq < 0
    || manifest.protocolVersion !== PROTOCOL_VERSION
    || manifest.rendererVersion !== SNAPSHOT_RENDERER_VERSION
    || manifest.canvasGeneration !== SNAPSHOT_CANVAS_GENERATION
    || !Number.isSafeInteger(manifest.generation)
    || manifest.generation < 1
    || manifest.codec !== SNAPSHOT_CODEC
    || manifest.width !== PROTOCOL_LIMITS.canvasWidth
    || manifest.height !== PROTOCOL_LIMITS.canvasHeight
    || !manifest.objectKey.startsWith(`rooms/${manifest.roomId}/snapshots/staging/`)
    || !Number.isSafeInteger(manifest.objectBytes)
    || manifest.objectBytes <= 0
    || !/^[a-f0-9]{64}$/.test(manifest.objectHash)
    || !/^[a-f0-9]{64}$/.test(manifest.rgbaHash)
    || !Number.isSafeInteger(manifest.createdAt)
    || manifest.createdAt <= 0
  ) {
    throw new TypeError("invalid snapshot manifest");
  }
}

function snapshotManifestFromRow(row: SnapshotManifestRow): SnapshotManifest {
  if (
    row.protocol_version !== PROTOCOL_VERSION
    || row.renderer_version !== SNAPSHOT_RENDERER_VERSION
    || row.canvas_generation !== SNAPSHOT_CANVAS_GENERATION
    || !Number.isSafeInteger(row.generation)
    || row.generation < 1
    || row.codec !== SNAPSHOT_CODEC
  ) {
    throw new RangeError("stored snapshot version is unsupported");
  }
  return {
    v: SNAPSHOT_JOB_VERSION,
    jobId: row.job_id,
    roomId: row.room_id,
    baseRoomSeq: row.base_room_seq,
    protocolVersion: PROTOCOL_VERSION,
    rendererVersion: SNAPSHOT_RENDERER_VERSION,
    canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
    generation: row.generation,
    codec: SNAPSHOT_CODEC,
    width: row.width,
    height: row.height,
    objectKey: row.object_key,
    objectBytes: row.object_bytes,
    objectHash: row.object_hash,
    rgbaHash: row.rgba_hash,
    createdAt: row.created_at,
  };
}

function publicSnapshotManifest(
  manifest: SnapshotManifest,
): SnapshotOfferMessage["manifest"] {
  return {
    v: manifest.v,
    jobId: manifest.jobId,
    roomId: manifest.roomId,
    baseRoomSeq: manifest.baseRoomSeq,
    protocolVersion: manifest.protocolVersion,
    rendererVersion: manifest.rendererVersion,
    canvasGeneration: manifest.canvasGeneration,
    generation: manifest.generation,
    codec: manifest.codec,
    width: manifest.width,
    height: manifest.height,
    objectBytes: manifest.objectBytes,
    objectHash: manifest.objectHash,
    rgbaHash: manifest.rgbaHash,
    createdAt: manifest.createdAt,
  };
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class DrawingRoom extends DurableObject<Env> {
  private serviceControlCache: {
    drawingEnabled: boolean;
    revision: number;
    fetchedAt: number;
  } | null = null;
  private readonly webSocketMessageQueues = new WeakMap<
    WebSocket,
    Promise<void>
  >();
  private replayFrameCache: ReplayFrameCacheEntry | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      const migrated = this.migrate();
      if (migrated || await this.ctx.storage.getAlarm() === null) {
        await this.scheduleNextAlarm();
      }
    });
  }

  private migrate(): boolean {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const currentVersion = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
      )
      .one().version;

    if (currentVersion < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS phase0_health (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO phase0_health (singleton, created_at)
        VALUES (1, unixepoch());
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `);
    }

    if (currentVersion < 2) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE connections (
          connection_id TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          last_client_seq INTEGER NOT NULL DEFAULT 0,
          connected_at INTEGER NOT NULL
        );
        CREATE TABLE strokes (
          stroke_id TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'cancelled')),
          last_dt INTEGER NOT NULL,
          last_append_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX one_active_stroke_per_actor
          ON strokes(actor) WHERE status = 'active';
        CREATE TABLE stroke_events (
          room_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          client_seq INTEGER NOT NULL,
          stroke_id TEXT NOT NULL,
          op TEXT NOT NULL,
          payload BLOB NOT NULL,
          accepted_at INTEGER NOT NULL,
          UNIQUE(connection_id, client_seq)
        );
        CREATE INDEX stroke_events_by_stroke
          ON stroke_events(stroke_id, room_seq);
        INSERT INTO _sql_schema_migrations (id) VALUES (2);
      `);
    }

    if (currentVersion < 3) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_metrics (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO room_metrics (name, value) VALUES
          ('accepted', 0),
          ('reject', 0),
          ('broadcast', 0),
          ('replay_event', 0);
        INSERT INTO _sql_schema_migrations (id) VALUES (3);
      `);
    }

    if (currentVersion < 4) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE strokes ADD COLUMN point_count INTEGER NOT NULL DEFAULT 1;
        INSERT INTO _sql_schema_migrations (id) VALUES (4);
      `);
    }

    if (currentVersion < 5) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE connections
          ADD COLUMN rate_tokens REAL NOT NULL DEFAULT ${PROTOCOL_LIMITS.eventRateBurst};
        ALTER TABLE connections
          ADD COLUMN rate_updated_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE stroke_events
          ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0;
        INSERT INTO room_metrics (name, value) VALUES ('payload_bytes', 0);
        INSERT INTO _sql_schema_migrations (id) VALUES (5);
      `);
    }

    if (currentVersion < 6) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE snapshot_jobs (
          job_id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          target_room_seq INTEGER NOT NULL,
          renderer_version INTEGER NOT NULL,
          requested_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('queued', 'committed', 'superseded')
          ),
          UNIQUE(target_room_seq, renderer_version)
        );
        CREATE TABLE snapshot_manifests (
          job_id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          base_room_seq INTEGER NOT NULL,
          renderer_version INTEGER NOT NULL,
          codec TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          object_key TEXT NOT NULL UNIQUE,
          object_bytes INTEGER NOT NULL,
          object_hash TEXT NOT NULL,
          rgba_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE snapshot_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          current_job_id TEXT,
          FOREIGN KEY(current_job_id) REFERENCES snapshot_manifests(job_id)
        );
        INSERT INTO snapshot_state (singleton, current_job_id) VALUES (1, NULL);
        INSERT INTO _sql_schema_migrations (id) VALUES (6);
      `);
    }

    if (currentVersion < 7) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE snapshot_jobs
          ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE snapshot_jobs
          ADD COLUMN canvas_generation INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE snapshot_jobs
          ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE snapshot_manifests
          ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE snapshot_manifests
          ADD COLUMN canvas_generation INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE snapshot_manifests
          ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
        INSERT INTO _sql_schema_migrations (id) VALUES (7);
      `);
    }

    if (currentVersion < 8) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE snapshot_read_tickets (
          token_hash TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER,
          FOREIGN KEY(job_id) REFERENCES snapshot_manifests(job_id)
        );
        CREATE INDEX snapshot_read_tickets_by_expiry
          ON snapshot_read_tickets(expires_at);
        INSERT INTO _sql_schema_migrations (id) VALUES (8);
      `);
    }

    if (currentVersion < 9) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE snapshot_state
          ADD COLUMN previous_job_id TEXT
          REFERENCES snapshot_manifests(job_id);
        INSERT INTO _sql_schema_migrations (id) VALUES (9);
      `);
    }

    if (currentVersion < 10) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE snapshot_jobs
          ADD COLUMN source_job_id TEXT
          REFERENCES snapshot_manifests(job_id);
        ALTER TABLE snapshot_jobs
          ADD COLUMN source_base_room_seq INTEGER NOT NULL DEFAULT 0;
        INSERT INTO _sql_schema_migrations (id) VALUES (10);
      `);
    }

    if (currentVersion < 11) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE snapshot_state
          ADD COLUMN mode TEXT NOT NULL DEFAULT 'shadow'
          CHECK (mode IN ('shadow', 'snapshot_compacted'));
        ALTER TABLE snapshot_state
          ADD COLUMN compacted_through_room_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE snapshot_state
          ADD COLUMN compaction_updated_at INTEGER NOT NULL DEFAULT 0;
        INSERT INTO _sql_schema_migrations (id) VALUES (11);
      `);
    }

    if (currentVersion < 12) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_lifecycle (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'closing')),
          close_request_id TEXT,
          close_reason TEXT,
          closing_started_at INTEGER,
          finalized_stroke_count INTEGER NOT NULL DEFAULT 0,
          superseded_snapshot_job_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO room_lifecycle (singleton, status) VALUES (1, 'active');
        INSERT INTO _sql_schema_migrations (id) VALUES (12);
      `);
    }

    if (currentVersion < 13) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE snapshot_jobs
          ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'manual'
          CHECK (trigger_kind IN ('manual', 'events', 'payload'));
        ALTER TABLE snapshot_jobs
          ADD COLUMN trigger_event_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE snapshot_jobs
          ADD COLUMN trigger_payload_bytes INTEGER NOT NULL DEFAULT 0;
        UPDATE snapshot_jobs
        SET trigger_event_count = (
              SELECT value FROM room_metrics WHERE name = 'accepted'
            ),
            trigger_payload_bytes = (
              SELECT value FROM room_metrics WHERE name = 'payload_bytes'
            );
        CREATE TABLE snapshot_automation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          room_id TEXT,
          pending_compaction_job_id TEXT,
          compaction_due_at INTEGER,
          last_evaluated_at INTEGER NOT NULL DEFAULT 0,
          last_evaluation_status TEXT
        );
        INSERT INTO snapshot_automation (singleton) VALUES (1);
        INSERT INTO _sql_schema_migrations (id) VALUES (13);
      `);
    }

    if (currentVersion < 14) {
      this.ctx.storage.sql.exec(`
        UPDATE connections
        SET rate_tokens = ${PROTOCOL_LIMITS.eventRateBurst},
            rate_updated_at = 0;
        INSERT INTO _sql_schema_migrations (id) VALUES (14);
      `);
    }

    if (currentVersion < 15) {
      this.ctx.storage.sql.exec(`
        DROP TABLE IF EXISTS room_runtime;
        INSERT INTO _sql_schema_migrations (id) VALUES (15);
      `);
    }

    if (currentVersion < 16) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          room_id TEXT NOT NULL UNIQUE,
          public_slug TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          theme TEXT,
          visibility TEXT NOT NULL
            CHECK (visibility IN ('public', 'unlisted')),
          participant_limit INTEGER NOT NULL,
          viewer_limit INTEGER NOT NULL,
          viewer_chat_enabled INTEGER NOT NULL,
          viewer_stamp_enabled INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          max_ends_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (16);
      `);
    }

    if (currentVersion < 17) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_tickets (
          token_hash TEXT PRIMARY KEY,
          actor_id TEXT NOT NULL,
          connection_id TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL
            CHECK (role IN ('host', 'participant', 'viewer')),
          session_binding_hash TEXT NOT NULL,
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER
        );
        CREATE INDEX room_tickets_by_expiry
          ON room_tickets(expires_at);
        ALTER TABLE connections
          ADD COLUMN role TEXT NOT NULL DEFAULT 'participant'
          CHECK (role IN ('host', 'participant', 'viewer'));
        ALTER TABLE connections
          ADD COLUMN session_binding_hash TEXT;
        INSERT INTO _sql_schema_migrations (id) VALUES (17);
      `);
    }

    if (currentVersion < 18) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE connections
          ADD COLUMN cursor_rate_tokens REAL NOT NULL
          DEFAULT ${PROTOCOL_LIMITS.cursorRateBurst};
        ALTER TABLE connections
          ADD COLUMN cursor_rate_updated_at INTEGER NOT NULL DEFAULT 0;
        INSERT INTO room_metrics (name, value) VALUES
          ('presence_broadcast', 0),
          ('cursor_broadcast', 0),
          ('cursor_dropped', 0);
        INSERT INTO _sql_schema_migrations (id) VALUES (18);
      `);
    }

    if (currentVersion < 19) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE connections
          ADD COLUMN chat_rate_tokens REAL NOT NULL
          DEFAULT ${PROTOCOL_LIMITS.chatRateBurst};
        ALTER TABLE connections
          ADD COLUMN chat_rate_updated_at INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE chat_messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          actor TEXT NOT NULL,
          role TEXT NOT NULL
            CHECK (role IN ('host', 'participant', 'viewer')),
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX chat_messages_by_created_at
          ON chat_messages(created_at);
        INSERT INTO room_metrics (name, value) VALUES
          ('chat_accepted', 0),
          ('chat_broadcast', 0);
        INSERT INTO _sql_schema_migrations (id) VALUES (19);
      `);
    }

    if (currentVersion < 20) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE room_lifecycle RENAME TO room_lifecycle_v12;
        CREATE TABLE room_lifecycle (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL
            CHECK (status IN ('waiting', 'active', 'idle', 'closing', 'suspended')),
          status_changed_at INTEGER NOT NULL DEFAULT 0,
          last_activity_at INTEGER,
          close_request_id TEXT,
          close_reason TEXT,
          closing_started_at INTEGER,
          finalized_stroke_count INTEGER NOT NULL DEFAULT 0,
          superseded_snapshot_job_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO room_lifecycle (
          singleton, status, status_changed_at, last_activity_at,
          close_request_id, close_reason, closing_started_at,
          finalized_stroke_count, superseded_snapshot_job_count
        )
        SELECT
          singleton, status, 0, NULL, close_request_id, close_reason,
          closing_started_at, finalized_stroke_count,
          superseded_snapshot_job_count
        FROM room_lifecycle_v12;
        DROP TABLE room_lifecycle_v12;
        CREATE TABLE scheduled_tasks (
          kind TEXT PRIMARY KEY
            CHECK (kind IN ('idle_timeout', 'empty_timeout', 'max_duration')),
          due_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (20);
      `);
    }

    if (currentVersion < 21) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_cleanup (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          job_id TEXT NOT NULL,
          close_request_id TEXT NOT NULL,
          requested_at INTEGER NOT NULL,
          snapshot_object_keys TEXT NOT NULL,
          enqueued_at INTEGER,
          next_enqueue_at INTEGER
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (21);
      `);
    }

    if (currentVersion < 22) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE moderation_evidence_exports (
          evidence_id TEXT PRIMARY KEY,
          report_id TEXT NOT NULL UNIQUE,
          target_room_seq INTEGER NOT NULL,
          source_base_room_seq INTEGER NOT NULL,
          plan_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (22);
      `);
    }

    if (currentVersion < 23) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_activity_limit (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          warning_level INTEGER NOT NULL DEFAULT 0
            CHECK (warning_level IN (0, 80, 90, 98, 100)),
          reached_at INTEGER
        );
        INSERT INTO room_activity_limit (singleton) VALUES (1);
        INSERT INTO _sql_schema_migrations (id) VALUES (23);
      `);
    }

    if (currentVersion < 24) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_time_limit (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          warning_stage INTEGER NOT NULL DEFAULT 0
            CHECK (warning_stage IN (0, 1, 2, 3))
        );
        INSERT INTO room_time_limit (singleton) VALUES (1);
        INSERT INTO _sql_schema_migrations (id) VALUES (24);
      `);
    }
    if (currentVersion < 25) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_bans (
          actor_id TEXT PRIMARY KEY,
          action_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (25);
      `);
    }
    if (currentVersion < 26) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE actor_abuse_state (
          actor_id TEXT PRIMARY KEY,
          violation_count INTEGER NOT NULL DEFAULT 0
            CHECK (violation_count >= 0),
          window_started_at INTEGER NOT NULL DEFAULT 0,
          muted_until INTEGER NOT NULL DEFAULT 0,
          disconnected_at INTEGER
        );
        INSERT OR IGNORE INTO room_metrics (name, value) VALUES
          ('rate_limited', 0),
          ('short_mute', 0),
          ('abuse_disconnect', 0);
        INSERT INTO _sql_schema_migrations (id) VALUES (26);
      `);
    }
    if (currentVersion < 27) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE room_metadata RENAME TO room_metadata_v16;
        CREATE TABLE room_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          room_id TEXT NOT NULL UNIQUE,
          public_slug TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          visibility TEXT NOT NULL
            CHECK (visibility IN ('public', 'unlisted')),
          participant_limit INTEGER NOT NULL,
          viewer_limit INTEGER NOT NULL,
          viewer_chat_enabled INTEGER NOT NULL,
          viewer_stamp_enabled INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          max_ends_at INTEGER NOT NULL
        );
        INSERT INTO room_metadata (
          singleton, room_id, public_slug, owner_user_id, name, visibility,
          participant_limit, viewer_limit, viewer_chat_enabled,
          viewer_stamp_enabled, created_at, max_ends_at
        )
        SELECT
          singleton, room_id, public_slug, owner_user_id, name, visibility,
          participant_limit, viewer_limit, viewer_chat_enabled,
          viewer_stamp_enabled, created_at, max_ends_at
        FROM room_metadata_v16;
        DROP TABLE room_metadata_v16;
        INSERT INTO _sql_schema_migrations (id) VALUES (27);
      `);
    }
    if (currentVersion < 28) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE room_tickets
          ADD COLUMN can_chat INTEGER NOT NULL DEFAULT 1
          CHECK (can_chat IN (0, 1));
        ALTER TABLE room_tickets
          ADD COLUMN display_name TEXT;
        ALTER TABLE room_tickets
          ADD COLUMN avatar_url TEXT;
        ALTER TABLE connections
          ADD COLUMN can_chat INTEGER NOT NULL DEFAULT 1
          CHECK (can_chat IN (0, 1));
        ALTER TABLE connections
          ADD COLUMN display_name TEXT;
        ALTER TABLE connections
          ADD COLUMN avatar_url TEXT;
        ALTER TABLE chat_messages
          ADD COLUMN display_name TEXT;
        ALTER TABLE chat_messages
          ADD COLUMN avatar_url TEXT;
        INSERT INTO _sql_schema_migrations (id) VALUES (28);
      `);
    }
    return currentVersion < LATEST_SCHEMA_VERSION;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WEBSOCKET_REQUIRED" }, { status: 426 });
    }

    const roomId = request.headers.get("x-koge-room-id");
    const roomTicket = request.headers.get("x-koge-room-ticket");
    let identity: ConnectionAttachment;
    let sessionBindingHash: string | null = null;
    if (roomTicket) {
      if (!SNAPSHOT_READ_TOKEN_PATTERN.test(roomTicket)) {
        return Response.json({ error: "INVALID_ROOM_TICKET" }, { status: 401 });
      }
      const consumed = this.consumeRoomTicket(
        await sha256Hex(roomTicket),
        Date.now(),
      );
      if (!consumed || !roomId) {
        return Response.json({ error: "ROOM_TICKET_REJECTED" }, { status: 401 });
      }
      identity = {
        actor: consumed.actor_id,
        connectionId: consumed.connection_id,
        role: consumed.role,
        roomId,
        canChat: consumed.can_chat === 1,
        displayName: consumed.display_name,
        avatarUrl: consumed.avatar_url,
      };
      sessionBindingHash = consumed.session_binding_hash;
    } else {
      const actor = request.headers.get("x-koge-actor");
      const connectionId = request.headers.get("x-koge-connection");
      const role = request.headers.get("x-koge-role") ?? "participant";
      const directCanChat = request.headers.get("x-koge-can-chat");
      const displayName = request.headers.get("x-koge-display-name");
      const avatarUrl = request.headers.get("x-koge-avatar-url");
      if (
        !actor
        || !IDENTIFIER_PATTERN.test(actor)
        || !connectionId
        || !IDENTIFIER_PATTERN.test(connectionId)
        || (role !== "host" && role !== "participant" && role !== "viewer")
        || !roomId
      ) {
        return Response.json(
          { error: "INVALID_CONNECTION_IDENTITY" },
          { status: 400 },
        );
      }
      identity = {
        actor,
        connectionId,
        role,
        roomId,
        canChat: directCanChat === "1" || (
          directCanChat === null && role !== "viewer"
        ),
        displayName,
        avatarUrl,
      };
    }
    const resumeAfterRoomSeq = Number(
      request.headers.get("x-koge-last-room-seq") ?? "0",
    );
    const rendererVersion = Number(
      request.headers.get("x-koge-renderer-version") ?? "0",
    );
    const snapshotRecoveryEnabled =
      request.headers.get("x-koge-snapshot-recovery") === "1";
    const excludedSnapshotJobsValue =
      request.headers.get("x-koge-snapshot-exclude-jobs") ?? "";
    const excludedSnapshotJobs = excludedSnapshotJobsValue === ""
      ? []
      : excludedSnapshotJobsValue.split(",");
    if (
      !Number.isSafeInteger(resumeAfterRoomSeq)
      || resumeAfterRoomSeq < 0
      || !roomId
      || !IDENTIFIER_PATTERN.test(roomId)
      || !Number.isSafeInteger(rendererVersion)
      || rendererVersion < 0
      || excludedSnapshotJobs.length > MAX_EXCLUDED_SNAPSHOT_JOBS
      || excludedSnapshotJobs.some((jobId) => !IDENTIFIER_PATTERN.test(jobId))
      || new Set(excludedSnapshotJobs).size !== excludedSnapshotJobs.length
    ) {
      return Response.json({ error: "INVALID_CONNECTION_IDENTITY" }, { status: 400 });
    }
    this.ensureRoomIdentity(roomId);
    const lifecycle = this.roomLifecycleState();
    if (lifecycle.status === "closing" || lifecycle.status === "suspended") {
      return Response.json(
        { error: "ROOM_NOT_ACTIVE", status: lifecycle.status },
        { status: 410 },
      );
    }
    if (this.isActorRoomBanned(identity.actor)) {
      return Response.json({ error: "ROOM_ACCESS_FORBIDDEN" }, { status: 403 });
    }
    const socketsForActor = roomTicket
      ? this.ctx.getWebSockets(`actor:${identity.actor}`)
      : [];
    const connectionCountExcludingActor = Math.max(
      0,
      this.ctx.getWebSockets().length - socketsForActor.length,
    );
    if (connectionCountExcludingActor >= PROTOCOL_LIMITS.maxRoomConnections) {
      return Response.json({ error: "ROOM_CAPACITY_REACHED" }, { status: 429 });
    }

    const lastRoomSeq = this.ctx.storage.sql
      .exec<{ room_seq: number }>(
        "SELECT COALESCE(MAX(room_seq), 0) AS room_seq FROM stroke_events",
      )
      .one().room_seq;
    if (resumeAfterRoomSeq > lastRoomSeq) {
      return Response.json({ error: "RESUME_CURSOR_EXCEEDS_ROOM" }, { status: 400 });
    }
    const compaction = this.snapshotCompactionState();
    const snapshotOffer = snapshotRecoveryEnabled
      && rendererVersion === SNAPSHOT_RENDERER_VERSION
      ? await this.issueSnapshotOffer(
          roomId,
          resumeAfterRoomSeq,
          new Set(excludedSnapshotJobs),
        )
      : undefined;
    if (
      compaction.mode === "snapshot_compacted"
      && !snapshotOffer
      && resumeAfterRoomSeq < compaction.compactedThroughRoomSeq
    ) {
      return Response.json(
        { error: "SNAPSHOT_RECOVERY_REQUIRED" },
        { status: 409 },
      );
    }
    if (snapshotRecoveryEnabled) {
      console.log(JSON.stringify({
        level: "info",
        message: "snapshot recovery selected",
        roomId,
        resumeAfterRoomSeq,
        rendererVersion,
        excludedSnapshotJobs,
        snapshotMode: compaction.mode,
        offered: snapshotOffer !== undefined,
        baseRoomSeq: snapshotOffer?.manifest.baseRoomSeq,
      }));
    }
    for (const socket of socketsForActor) {
      socket.close(1000, "connection replaced");
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [
      `actor:${identity.actor}`,
      `role:${identity.role}`,
    ]);
    server.serializeAttachment(identity);
    this.ctx.storage.sql.exec(
      "DELETE FROM scheduled_tasks WHERE kind = 'empty_timeout'",
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (
        connection_id, actor, last_client_seq, connected_at,
        rate_tokens, rate_updated_at, role, session_binding_hash,
        can_chat, display_name, avatar_url
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        actor = excluded.actor,
        connected_at = excluded.connected_at,
        role = excluded.role,
        session_binding_hash = excluded.session_binding_hash,
        can_chat = excluded.can_chat,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url`,
      identity.connectionId,
      identity.actor,
      Date.now(),
      PROTOCOL_LIMITS.eventRateBurst,
      Date.now(),
      identity.role,
      sessionBindingHash,
      identity.canChat === false ? 0 : 1,
      identity.displayName ?? null,
      identity.avatarUrl ?? null,
    );

    const metadata = this.ctx.storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM room_metadata WHERE singleton = 1",
      )
      .toArray()[0];
    if (metadata) {
      server.send(encodeServerMessage(this.lifecycleUpdatedMessage(lifecycle)));
    }
    const roomActivity = this.currentRoomActivityMessage();
    if (roomActivity) server.send(encodeServerMessage(roomActivity));
    const roomTime = this.currentRoomTimeMessage(Date.now());
    if (roomTime) server.send(encodeServerMessage(roomTime));
    if (snapshotOffer) server.send(encodeServerMessage(snapshotOffer));
    const replayStats = this.sendReplay(
      server,
      snapshotOffer?.manifest.baseRoomSeq ?? resumeAfterRoomSeq,
      lastRoomSeq,
    );
    if (replayStats.eventCount > 0 || snapshotOffer) {
      console.log(JSON.stringify({
        level: "info",
        message: "websocket recovery replay queued",
        roomId,
        snapshotOffered: snapshotOffer !== undefined,
        snapshotJobId: snapshotOffer?.manifest.jobId,
        snapshotBaseRoomSeq: snapshotOffer?.manifest.baseRoomSeq,
        resumeAfterRoomSeq,
        readyRoomSeq: lastRoomSeq,
        replayEventCount: replayStats.eventCount,
        replayFrameCount: replayStats.frameCount,
        replayEncodedBytes: replayStats.encodedBytes,
        replayFrameCacheHit: replayStats.cacheHit,
        replayEncodedFrameCount: replayStats.encodedFrameCount,
      }));
    }
    const chatHistory = this.readChatHistory(Date.now());
    if (chatHistory.length > 0) {
      server.send(encodeServerMessage({
        type: "chat.history",
        messages: chatHistory,
      }));
    }
    server.send(encodeServerMessage({ type: "ready", roomSeq: lastRoomSeq }));
    this.broadcastPresence();
    if (lifecycle.status === "active") this.armIdleTask();
    await this.scheduleNextAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const previous = this.webSocketMessageQueues.get(ws) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.processWebSocketMessage(ws, message));
    this.webSocketMessageQueues.set(ws, current);
    try {
      await current;
    } finally {
      if (this.webSocketMessageQueues.get(ws) === current) {
        this.webSocketMessageQueues.delete(ws);
      }
    }
  }

  private async processWebSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment: unknown = ws.deserializeAttachment();
    if (!isConnectionAttachment(attachment)) {
      this.sendReject(ws, reject("UNAUTHORIZED", "connection state is missing"));
      ws.close(1011, "connection state is missing");
      return;
    }
    const lifecycle = this.roomLifecycleState();
    if (lifecycle.status === "closing" || lifecycle.status === "suspended") {
      this.sendReject(ws, reject("ROOM_NOT_ACTIVE", "room is closing"));
      ws.close(1001, "room is closing");
      return;
    }
    if (
      typeof message !== "string"
      && message.byteLength > PROTOCOL_LIMITS.maxFrameBytes
    ) {
      this.sendReject(ws, reject("MESSAGE_TOO_LARGE", "frame exceeds 64 KiB"));
      return;
    }

    if (typeof message === "string") {
      let realtimeMessage;
      try {
        realtimeMessage = decodeClientRealtimeMessage(message);
      } catch (error) {
        this.sendReject(ws, reject(
          error instanceof RangeError ? "MESSAGE_TOO_LARGE" : "INVALID_FIELD",
          "invalid realtime frame",
        ));
        return;
      }
      if (realtimeMessage.type === "room.start") {
        if (attachment.role !== "host") {
          this.sendReject(ws, reject("ROLE_FORBIDDEN", "only the host can start"));
          return;
        }
        const update = this.startRoom();
        if (update) {
          this.broadcastEphemeral(update);
          this.projectLifecycleStatus("active", update.changedAt);
          await this.scheduleNextAlarm();
        }
        return;
      }
      if (realtimeMessage.type === "room.close") {
        if (attachment.role !== "host") {
          this.sendReject(ws, reject("ROLE_FORBIDDEN", "only the host can close"));
          return;
        }
        await this.beginRoomClose({
          closeRequestId: realtimeMessage.requestId,
          reason: "host",
        });
        return;
      }
      if (realtimeMessage.type === "chat.send") {
        if (this.roomLifecycleState().status === "waiting") {
          this.sendReject(ws, reject("ROOM_NOT_ACTIVE", "room has not started"));
          return;
        }
        if (this.actorIsTemporarilyMuted(attachment.actor, Date.now())) {
          this.rejectRateAbuse(
            ws,
            attachment,
            reject("RATE_LIMITED", "actor is temporarily muted"),
          );
          return;
        }
        await this.refreshChatRateClockIfNeeded(attachment);
        const result = this.persistChatMessage(attachment, realtimeMessage);
        if ("code" in result) {
          if (result.code === "RATE_LIMITED") {
            this.rejectRateAbuse(ws, attachment, result);
          } else {
            this.sendReject(ws, result);
          }
          return;
        }
        this.incrementMetric("chat_broadcast");
        this.broadcastEphemeral({ type: "chat.message", message: result });
        const update = this.recordRoomActivity(result.createdAt);
        if (update) this.broadcastEphemeral(update);
        await this.scheduleNextAlarm();
        return;
      }
      await this.refreshCursorRateClockIfNeeded(attachment);
      if (this.consumeCursorRateToken(attachment)) {
        this.incrementMetric("cursor_broadcast");
        this.broadcastEphemeral({
          type: "cursor",
          actor: attachment.actor,
          ...(realtimeMessage.visible
            ? {
                visible: true,
                x: realtimeMessage.x,
                y: realtimeMessage.y,
              }
            : { visible: false }),
        }, ws);
      } else {
        this.incrementMetric("cursor_dropped");
      }
      return;
    }

    if (attachment.role === "viewer") {
      this.sendReject(ws, reject("ROLE_FORBIDDEN", "viewer cannot draw"));
      return;
    }

    let event: ClientStrokeEvent;
    try {
      event = decodeEvent(new Uint8Array(message), "messagepack");
    } catch (error) {
      this.sendReject(ws, reject(
        error instanceof RangeError ? "MESSAGE_TOO_LARGE" : "INVALID_FIELD",
        "invalid protocol frame",
      ));
      return;
    }
    if (this.roomLifecycleState().status === "waiting") {
      this.sendReject(ws, reject(
        "ROOM_NOT_ACTIVE",
        "room has not started",
        event.clientSeq,
      ));
      return;
    }

    const serviceControl = await this.drawingServiceControl(Date.now());
    if (!serviceControl.drawingEnabled) {
      const discarded = this.ctx.storage.transactionSync(() => ({
        finalized: this.finalizeActiveStrokes(
          SERVER_EMERGENCY_CONTROL_CONNECTION_ID,
          Date.now(),
        ),
        rejection: this.discardOrderedEvent(
          attachment,
          event,
          "SERVICE_EMERGENCY_STOP",
          "drawing is paused by emergency control",
        ),
      }));
      for (const accepted of discarded.finalized) this.broadcast(accepted);
      if (discarded.finalized.length > 0) {
        this.ctx.waitUntil(
          this.reconcileSnapshotAutomation(attachment.roomId).catch((error) => {
            console.error(JSON.stringify({
              level: "error",
              message: "emergency stroke finalization reconciliation failed",
              roomId: attachment.roomId,
              error: error instanceof Error ? error.message : String(error),
            }));
          }),
        );
      }
      this.sendReject(ws, discarded.rejection);
      return;
    }

    if (this.actorIsTemporarilyMuted(attachment.actor, Date.now())) {
      this.rejectRateLimitedDrawing(
        ws,
        attachment,
        event,
        "actor is temporarily muted",
      );
      return;
    }
    await this.refreshRateClockIfNeeded(attachment);
    const result = this.persistEvent(attachment, event);
    if ("code" in result) {
      if (result.code === "RATE_LIMITED") {
        this.rejectRateLimitedDrawing(
          ws,
          attachment,
          event,
          result.message,
        );
      } else {
        this.sendReject(ws, result);
      }
      if (result.code === "ROOM_LIMIT_REACHED") {
        await this.reconcileRoomActivityLimit();
      }
      return;
    }

    this.broadcast(result);
    const update = this.recordRoomActivity(result.acceptedAt);
    if (update) this.broadcastEphemeral(update);
    if (await this.reconcileRoomActivityLimit()) return;
    await this.scheduleNextAlarm();
    if (event.op === "stroke.end" || event.op === "stroke.cancel") {
      this.ctx.waitUntil(
        this.reconcileSnapshotAutomation(attachment.roomId).catch((error) => {
          console.error(JSON.stringify({
            level: "error",
            message: "snapshot automation reconciliation failed",
            roomId: attachment.roomId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }),
      );
    }
  }

  private async drawingServiceControl(now: number): Promise<{
    drawingEnabled: boolean;
    revision: number;
  }> {
    if (
      this.serviceControlCache
      && now - this.serviceControlCache.fetchedAt
        < SERVICE_CONTROL_CACHE_TTL_MS
    ) {
      return this.serviceControlCache;
    }
    try {
      const row = await this.env.DB.prepare(
        `SELECT revision, drawing_enabled
         FROM service_controls WHERE singleton = 1`,
      ).first<{ revision: number; drawing_enabled: number }>();
      if (!row) throw new Error("service controls are not initialized");
      this.serviceControlCache = {
        drawingEnabled: row.drawing_enabled === 1,
        revision: row.revision,
        fetchedAt: now,
      };
    } catch (error) {
      if (
        this.env.APP_ENV !== "local"
        || !(
          error instanceof Error
          && error.message.includes("no such table")
        )
      ) {
        console.error(JSON.stringify({
          level: "error",
          message: "drawing service control read failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      this.serviceControlCache = {
        drawingEnabled: this.serviceControlCache?.drawingEnabled ?? true,
        revision: this.serviceControlCache?.revision ?? 0,
        fetchedAt: now,
      };
    }
    return this.serviceControlCache;
  }

  private discardOrderedEvent(
    attachment: ConnectionAttachment,
    event: ClientStrokeEvent,
    code: RejectMessage["code"],
    message: string,
  ): RejectMessage {
    const connection = this.ctx.storage.sql
      .exec<{ actor: string; last_client_seq: number }>(
        `SELECT actor, last_client_seq FROM connections
         WHERE connection_id = ?`,
        attachment.connectionId,
      )
      .toArray()[0];
    if (!connection || connection.actor !== attachment.actor) {
      return reject(
        "UNAUTHORIZED",
        "connection is not registered",
        event.clientSeq,
      );
    }
    const expectedClientSeq = connection.last_client_seq + 1;
    if (event.clientSeq < expectedClientSeq) {
      return reject(
        "DUPLICATE",
        "clientSeq was already consumed",
        event.clientSeq,
      );
    }
    if (event.clientSeq > expectedClientSeq) {
      return reject(
        "OUT_OF_ORDER",
        `expected clientSeq ${expectedClientSeq}`,
        event.clientSeq,
      );
    }
    this.ctx.storage.sql.exec(
      `UPDATE connections SET last_client_seq = ?
       WHERE connection_id = ?`,
      event.clientSeq,
      attachment.connectionId,
    );
    return reject(
      code,
      message,
      event.clientSeq,
    );
  }

  private broadcast(message: AcceptedStrokeEvent): void {
    this.incrementMetric("broadcast");
    const frame = encodeServerMessage(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(frame);
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "websocket broadcast failed",
          error: error instanceof Error ? error.message : String(error),
          roomSeq: message.roomSeq,
        }));
        socket.close(1011, "broadcast failed");
      }
    }
  }

  private broadcastEphemeral(
    message: ServerMessage,
    excludedSocket?: WebSocket,
  ): void {
    const frame = encodeServerMessage(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excludedSocket) continue;
      try {
        socket.send(frame);
      } catch {
        // Presence and cursor are best effort. The normal close/error path
        // removes failed connections without making drawing unavailable.
      }
    }
  }

  private broadcastPresence(excludedSocket?: WebSocket): void {
    const members = new Map<string, ConnectionAttachment["role"]>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excludedSocket) continue;
      const attachment: unknown = socket.deserializeAttachment();
      if (!isConnectionAttachment(attachment)) continue;
      members.set(attachment.actor, attachment.role);
    }
    this.incrementMetric("presence_broadcast");
    this.broadcastEphemeral({
      type: "presence",
      members: Array.from(
        members,
        ([actor, role]) => ({ actor, role }),
      ).sort((left, right) => left.actor.localeCompare(right.actor)),
    }, excludedSocket);
  }

  private sendReject(ws: WebSocket, message: RejectMessage): void {
    this.incrementMetric("reject");
    ws.send(encodeServerMessage(message));
  }

  private actorIsTemporarilyMuted(actor: string, now: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ muted_until: number }>(
        `SELECT muted_until FROM actor_abuse_state
         WHERE actor_id = ?`,
        actor,
      )
      .toArray()[0];
    return (row?.muted_until ?? 0) > now;
  }

  private recordRateAbuse(actor: string, now: number): ActorAbuseAction {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.ctx.storage.sql
        .exec<ActorAbuseRow>(
          `SELECT violation_count, window_started_at, muted_until,
                  disconnected_at
           FROM actor_abuse_state WHERE actor_id = ?`,
          actor,
        )
        .toArray()[0];
      const resetWindow = (
        !previous
        || (
          now - previous.window_started_at >= RATE_ABUSE_WINDOW_MS
          && previous.muted_until <= now
        )
      );
      const windowStartedAt = resetWindow
        ? now
        : previous.window_started_at;
      const violationCount = resetWindow
        ? 1
        : previous.violation_count + 1;
      const wasMuted = (previous?.muted_until ?? 0) > now;
      const mutedUntil = violationCount >= RATE_ABUSE_MUTE_THRESHOLD
        ? Math.max(previous?.muted_until ?? 0, now + RATE_ABUSE_MUTE_MS)
        : previous?.muted_until ?? 0;
      const disconnect =
        violationCount >= RATE_ABUSE_DISCONNECT_THRESHOLD;
      const disconnectAlreadyRecorded = (
        previous?.disconnected_at !== null
        && previous?.disconnected_at !== undefined
        && previous.disconnected_at >= windowStartedAt
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO actor_abuse_state (
           actor_id, violation_count, window_started_at, muted_until,
           disconnected_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor_id) DO UPDATE SET
           violation_count = excluded.violation_count,
           window_started_at = excluded.window_started_at,
           muted_until = excluded.muted_until,
           disconnected_at = excluded.disconnected_at`,
        actor,
        violationCount,
        windowStartedAt,
        mutedUntil,
        disconnect
          ? (disconnectAlreadyRecorded ? previous?.disconnected_at : now)
          : (resetWindow ? null : previous?.disconnected_at ?? null),
      );
      this.incrementMetric("rate_limited");
      const newlyMuted = !wasMuted && mutedUntil > now;
      const newlyDisconnected = disconnect && !disconnectAlreadyRecorded;
      if (newlyMuted) this.incrementMetric("short_mute");
      if (newlyDisconnected) {
        this.incrementMetric("abuse_disconnect");
      }
      return {
        mutedUntil,
        disconnect,
        newlyMuted,
        newlyDisconnected,
      };
    });
  }

  private rejectRateAbuse(
    ws: WebSocket,
    attachment: ConnectionAttachment,
    message: RejectMessage,
  ): void {
    const action = this.recordRateAbuse(attachment.actor, Date.now());
    this.sendReject(ws, message);
    if (action.newlyMuted || action.newlyDisconnected) {
      console.warn(JSON.stringify({
        level: "warn",
        message: "rate abuse escalation",
        roomId: attachment.roomId,
        actor: attachment.actor,
        action: action.newlyDisconnected ? "disconnect" : "short_mute",
        mutedUntil: action.mutedUntil,
      }));
    }
    if (action.disconnect) {
      ws.close(1008, "repeated rate limit abuse");
    }
  }

  private rejectRateLimitedDrawing(
    ws: WebSocket,
    attachment: ConnectionAttachment,
    event: ClientStrokeEvent,
    message: string,
  ): void {
    const discarded = this.ctx.storage.transactionSync(() => {
      const rejection = this.discardOrderedEvent(
        attachment,
        event,
        "RATE_LIMITED",
        message,
      );
      return {
        rejection,
        finalized: rejection.code === "RATE_LIMITED"
          ? this.finalizeActiveStrokes(
              SERVER_RATE_ABUSE_CONNECTION_ID,
              Date.now(),
              attachment.actor,
            )
          : [],
      };
    });
    for (const accepted of discarded.finalized) this.broadcast(accepted);
    if (discarded.finalized.length > 0) {
      this.ctx.waitUntil(
        this.reconcileSnapshotAutomation(attachment.roomId).catch((error) => {
          console.error(JSON.stringify({
            level: "error",
            message: "rate abuse stroke finalization reconciliation failed",
            roomId: attachment.roomId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }),
      );
    }
    if (discarded.rejection.code === "RATE_LIMITED") {
      this.rejectRateAbuse(ws, attachment, discarded.rejection);
    } else {
      this.sendReject(ws, discarded.rejection);
    }
  }

  override async alarm(): Promise<void> {
    const lifecycle = this.roomLifecycleState();
    if (lifecycle.status === "closing") {
      await this.enqueueRoomCleanup();
      return;
    }
    if (lifecycle.status === "suspended") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const closeTask = this.ctx.storage.sql
      .exec<{ kind: "empty_timeout" | "max_duration"; due_at: number }>(
        `SELECT kind, due_at
         FROM scheduled_tasks
         WHERE kind IN ('empty_timeout', 'max_duration') AND due_at <= ?
         ORDER BY CASE kind WHEN 'max_duration' THEN 0 ELSE 1 END, due_at
         LIMIT 1`,
        now,
      )
      .toArray()[0];
    if (closeTask) {
      if (
        closeTask.kind === "max_duration"
        || this.ctx.getWebSockets().length === 0
      ) {
        await this.beginRoomClose({
          closeRequestId: `system_${closeTask.kind}_${closeTask.due_at}`,
          reason: closeTask.kind,
        });
        return;
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM scheduled_tasks WHERE kind = 'empty_timeout'",
      );
    }
    const roomTimeWarning = this.reconcileRoomTimeWarning(now);
    if (roomTimeWarning) this.broadcastEphemeral(roomTimeWarning);
    const due = this.ctx.storage.sql
      .exec<{ stroke_id: string; actor: string }>(
        `SELECT stroke_id, actor
         FROM strokes
         WHERE status = 'active' AND last_append_at <= ?
         ORDER BY last_append_at, stroke_id`,
        now - UNFINISHED_STROKE_TIMEOUT_MS,
      )
      .toArray();

    for (const stroke of due) {
      const event = {
        v: PROTOCOL_VERSION,
        op: "stroke.end",
        id: stroke.stroke_id,
        serverGenerated: true,
      } as const;
      const acceptedAt = Date.now();
      const payload = toArrayBuffer(encodeRoomEvent(event));
      const serverClientSeq = this.ctx.storage.sql
        .exec<{ next_seq: number }>(
          "SELECT COALESCE(MAX(room_seq), 0) + 1 AS next_seq FROM stroke_events",
        )
        .one().next_seq;
      const roomSeq = this.ctx.storage.sql
        .exec<{ room_seq: number }>(
          `INSERT INTO stroke_events (
            actor, connection_id, client_seq, stroke_id, op, payload,
            payload_bytes, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING room_seq`,
          stroke.actor,
          SERVER_TIMEOUT_CONNECTION_ID,
          serverClientSeq,
          stroke.stroke_id,
          event.op,
          payload,
          payload.byteLength,
          acceptedAt,
        )
        .one().room_seq;
      this.incrementMetric("accepted");
      this.incrementMetric("payload_bytes", payload.byteLength);
      this.ctx.storage.sql.exec(
        `UPDATE strokes
         SET status = 'ended', last_append_at = ?
         WHERE stroke_id = ? AND status = 'active'`,
        acceptedAt,
        stroke.stroke_id,
      );
      this.broadcast({
        type: "accepted",
        roomSeq,
        actor: stroke.actor,
        connectionId: SERVER_TIMEOUT_CONNECTION_ID,
        acceptedAt,
        event,
      });
    }

    await this.runPendingSnapshotCompaction(now);
    const roomId = this.roomIdentity();
    if (due.length > 0 && roomId) {
      if (await this.reconcileRoomActivityLimit()) return;
      await this.reconcileSnapshotAutomation(roomId);
    }
    const idleTask = this.ctx.storage.sql
      .exec<{ due_at: number }>(
        "SELECT due_at FROM scheduled_tasks WHERE kind = 'idle_timeout'",
      )
      .toArray()[0];
    if (
      idleTask
      && idleTask.due_at <= now
      && this.roomLifecycleState().status === "active"
    ) {
      if (this.ctx.getWebSockets().length > 0) {
        const update = this.markRoomIdle(now);
        if (update) {
          this.broadcastEphemeral(update);
          this.projectLifecycleStatus("idle", now);
        }
      } else {
        this.ctx.storage.sql.exec(
          "DELETE FROM scheduled_tasks WHERE kind = 'idle_timeout'",
        );
      }
    }
    await this.scheduleNextAlarm();
  }

  override webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    // The runtime replies to Close frames. Connection rows are retained for
    // clientSeq deduplication during the room lifetime.
    this.broadcastPresence(ws);
    this.ctx.waitUntil(this.afterSocketClose());
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    console.error(JSON.stringify({
      level: "error",
      message: "websocket error",
      error: error instanceof Error ? error.message : String(error),
    }));
    ws.close(1011, "websocket error");
  }

  health(): { ok: true; schemaVersion: number } {
    const schemaVersion = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
      )
      .one().version;
    return { ok: true, schemaVersion };
  }

  runtimeSnapshotObjectKeys(roomId: string): readonly string[] {
    const actualRoomId = this.roomIdentity();
    if (actualRoomId === undefined) return [];
    if (actualRoomId !== roomId) {
      throw new Error("snapshot inventory room identity mismatch");
    }
    return this.snapshotObjectKeys();
  }

  async initializeRoom(
    request: RoomProvisioningRequest,
  ): Promise<RoomProvisioningResult> {
    validateRoomProvisioningRequest(request);
    const result: RoomProvisioningResult = this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<RoomMetadataRow>(
          "SELECT * FROM room_metadata WHERE singleton = 1",
        )
        .toArray()[0];
      if (existing) {
        if (!this.roomMetadataMatches(existing, request)) {
          throw new Error("room was initialized with different metadata");
        }
        return {
          status: "already_initialized",
          roomId: existing.room_id,
          createdAt: existing.created_at,
          maxEndsAt: existing.max_ends_at,
        };
      }

      this.ensureRoomIdentity(request.roomId);
      this.ctx.storage.sql.exec(
        `INSERT INTO room_metadata (
          singleton, room_id, public_slug, owner_user_id, name, visibility,
          participant_limit, viewer_limit, viewer_chat_enabled,
          viewer_stamp_enabled, created_at, max_ends_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        request.roomId,
        request.publicSlug,
        request.ownerUserId,
        request.name,
        request.visibility,
        request.participantLimit,
        request.viewerLimit,
        request.viewerChatEnabled ? 1 : 0,
        request.viewerStampEnabled ? 1 : 0,
        request.createdAt,
        request.maxEndsAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE room_lifecycle
         SET status = 'waiting', status_changed_at = ?,
             last_activity_at = NULL
         WHERE singleton = 1 AND status = 'active'`,
        request.createdAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO scheduled_tasks (kind, due_at)
         VALUES ('max_duration', ?)
         ON CONFLICT(kind) DO UPDATE SET due_at = excluded.due_at`,
        request.maxEndsAt,
      );
      this.ctx.storage.sql.exec(
        "UPDATE room_time_limit SET warning_stage = 0 WHERE singleton = 1",
      );
      return {
        status: "initialized",
        roomId: request.roomId,
        createdAt: request.createdAt,
        maxEndsAt: request.maxEndsAt,
      };
    });
    await this.scheduleNextAlarm();
    return result;
  }

  registerRoomTicket(
    request: RoomTicketRegistrationRequest,
    tokenHash: string,
  ): void {
    validateRoomTicketRegistrationRequest(request);
    if (!SNAPSHOT_READ_TOKEN_PATTERN.test(tokenHash)) {
      throw new TypeError("invalid room ticket hash");
    }
    const metadata = this.ctx.storage.sql
      .exec<RoomMetadataRow>(
        "SELECT * FROM room_metadata WHERE singleton = 1",
      )
      .toArray()[0];
    if (!metadata || metadata.room_id !== request.roomId) {
      throw new Error("room ticket targets an uninitialized room");
    }
    const lifecycle = this.roomLifecycleState();
    if (lifecycle.status === "closing" || lifecycle.status === "suspended") {
      throw new Error("room ticket targets an inactive room");
    }
    if (this.isActorRoomBanned(request.actorId)) {
      throw new Error("room ticket targets a banned actor");
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM room_tickets WHERE expires_at <= ?",
      request.issuedAt,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO room_tickets (
         token_hash, actor_id, connection_id, role, session_binding_hash,
         issued_at, expires_at, consumed_at, can_chat, display_name, avatar_url
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      tokenHash,
      request.actorId,
      request.connectionId,
      request.role,
      request.sessionBindingHash,
      request.issuedAt,
      request.expiresAt,
      request.canChat === undefined
        ? (request.role === "viewer" ? 0 : 1)
        : (request.canChat ? 1 : 0),
      request.displayName ?? null,
      request.avatarUrl ?? null,
    );
  }

  private isActorRoomBanned(actorId: string): boolean {
    return this.ctx.storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM room_bans WHERE actor_id = ? LIMIT 1",
        actorId,
      )
      .toArray()[0] !== undefined;
  }

  private consumeRoomTicket(
    tokenHash: string,
    now: number,
  ): RoomTicketRow | null {
    return this.ctx.storage.transactionSync(() => {
      const ticket = this.ctx.storage.sql
        .exec<RoomTicketRow>(
          `SELECT
             actor_id, connection_id, role, session_binding_hash,
             expires_at, consumed_at, can_chat, display_name, avatar_url
           FROM room_tickets
           WHERE token_hash = ?`,
          tokenHash,
        )
        .toArray()[0];
      if (
        !ticket
        || ticket.consumed_at !== null
        || ticket.expires_at <= now
      ) {
        return null;
      }
      this.ctx.storage.sql.exec(
        `UPDATE room_tickets
         SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL`,
        now,
        tokenHash,
      );
      return ticket;
    });
  }

  roomLifecycleState(): RoomLifecycleState {
    const row = this.readRoomLifecycle();
    if (row.status === "waiting") {
      return { status: "waiting", changedAt: row.status_changed_at };
    }
    if (row.status === "active") {
      return {
        status: "active",
        changedAt: row.status_changed_at,
        lastActivityAt: row.last_activity_at,
      };
    }
    if (row.status === "idle" && row.last_activity_at !== null) {
      return {
        status: "idle",
        changedAt: row.status_changed_at,
        lastActivityAt: row.last_activity_at,
      };
    }
    if (row.status === "suspended") {
      return { status: "suspended", changedAt: row.status_changed_at };
    }
    if (
      !row.close_request_id
      || !row.close_reason
      || !ROOM_CLOSE_REASONS.includes(
        row.close_reason as RoomCloseResult["reason"],
      )
      || row.closing_started_at === null
    ) {
      throw new Error("room lifecycle state is inconsistent");
    }
    return {
      status: "closing",
      closeRequestId: row.close_request_id,
      reason: row.close_reason as RoomCloseResult["reason"],
      startedAt: row.closing_started_at,
      finalizedStrokeCount: row.finalized_stroke_count,
      supersededSnapshotJobCount: row.superseded_snapshot_job_count,
    };
  }

  private finalizeActiveStrokes(
    connectionId: string,
    acceptedAt: number,
    actor?: string,
  ): AcceptedStrokeEvent[] {
    const active = actor
      ? this.ctx.storage.sql
          .exec<{ stroke_id: string; actor: string }>(
            `SELECT stroke_id, actor
             FROM strokes
             WHERE status = 'active' AND actor = ?
             ORDER BY stroke_id`,
            actor,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<{ stroke_id: string; actor: string }>(
            `SELECT stroke_id, actor
             FROM strokes
             WHERE status = 'active'
             ORDER BY stroke_id`,
          )
          .toArray();
    const finalized: AcceptedStrokeEvent[] = [];
    for (const stroke of active) {
      const event = {
        v: PROTOCOL_VERSION,
        op: "stroke.end",
        id: stroke.stroke_id,
        serverGenerated: true,
      } as const;
      const payload = toArrayBuffer(encodeRoomEvent(event));
      const serverClientSeq = this.ctx.storage.sql
        .exec<{ next_seq: number }>(
          `SELECT COALESCE(MAX(client_seq), 0) + 1 AS next_seq
           FROM stroke_events WHERE connection_id = ?`,
          connectionId,
        )
        .one().next_seq;
      const roomSeq = this.ctx.storage.sql
        .exec<{ room_seq: number }>(
          `INSERT INTO stroke_events (
            actor, connection_id, client_seq, stroke_id, op, payload,
            payload_bytes, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING room_seq`,
          stroke.actor,
          connectionId,
          serverClientSeq,
          stroke.stroke_id,
          event.op,
          payload,
          payload.byteLength,
          acceptedAt,
        )
        .one().room_seq;
      this.incrementMetric("accepted");
      this.incrementMetric("payload_bytes", payload.byteLength);
      this.ctx.storage.sql.exec(
        `UPDATE strokes
         SET status = 'ended', last_append_at = ?
         WHERE stroke_id = ? AND status = 'active'`,
        acceptedAt,
        stroke.stroke_id,
      );
      finalized.push({
        type: "accepted",
        roomSeq,
        actor: stroke.actor,
        connectionId,
        acceptedAt,
        event,
      });
    }
    return finalized;
  }

  activeRoomMembers(): readonly ActiveRoomMember[] {
    const members = new Map<string, RoomRole>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (!isConnectionAttachment(attachment)) continue;
      members.set(attachment.actor, attachment.role);
    }
    return Array.from(
      members,
      ([actorId, role]) => ({ actorId, role }),
    ).sort((left, right) => left.actorId.localeCompare(right.actorId));
  }

  async moderateMember(
    request: RoomModerationRequest,
  ): Promise<{ readonly disconnectedConnectionCount: number }> {
    validateRoomModerationRequest(request);
    if (request.action !== "kick" && request.action !== "room_ban") {
      throw new TypeError("member moderation requires a member action");
    }
    const lifecycle = this.roomLifecycleState();
    if (
      lifecycle.status === "closing"
      || lifecycle.status === "suspended"
    ) {
      throw new Error("member moderation targets an inactive room");
    }
    const hostConnection = this.ctx.storage.sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM connections
         WHERE actor = ? AND role = 'host' LIMIT 1`,
        request.targetActorId,
      )
      .toArray()[0];
    const hostTicket = this.ctx.storage.sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM room_tickets
         WHERE actor_id = ? AND role = 'host' LIMIT 1`,
        request.targetActorId,
      )
      .toArray()[0];
    if (hostConnection || hostTicket) {
      throw new TypeError("host cannot be kicked or room banned");
    }
    const changedAt = Date.now();
    const finalized = this.ctx.storage.transactionSync(() => {
      if (request.action === "room_ban") {
        this.ctx.storage.sql.exec(
          `INSERT INTO room_bans (actor_id, action_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(actor_id) DO UPDATE SET
             action_id = excluded.action_id,
             created_at = excluded.created_at`,
          request.targetActorId,
          request.actionId,
          changedAt,
        );
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM room_tickets WHERE actor_id = ?",
        request.targetActorId,
      );
      return this.finalizeActiveStrokes(
        SERVER_MEMBER_MODERATION_CONNECTION_ID,
        changedAt,
        request.targetActorId,
      );
    });
    for (const event of finalized) this.broadcast(event);

    const sockets = this.ctx.getWebSockets(`actor:${request.targetActorId}`);
    const removal = {
      type: "room.removed",
      reason: request.action === "room_ban" ? "room_banned" : "kicked",
      actionId: request.actionId,
    } as const satisfies ServerMessage;
    for (const socket of sockets) {
      try {
        socket.send(encodeServerMessage(removal));
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "room member removal notification failed",
          error: error instanceof Error ? error.message : String(error),
          actionId: request.actionId,
          targetActorId: request.targetActorId,
        }));
      } finally {
        socket.close(1008, removal.reason);
      }
    }
    return {
      disconnectedConnectionCount: sockets.length,
    };
  }

  async disconnectServiceBannedActor(
    actorId: string,
    actionId: string,
  ): Promise<{ readonly disconnectedConnectionCount: number }> {
    if (
      !IDENTIFIER_PATTERN.test(actorId)
      || !IDENTIFIER_PATTERN.test(actionId)
    ) {
      throw new TypeError("invalid service ban disconnection request");
    }
    const changedAt = Date.now();
    const finalized = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM room_tickets WHERE actor_id = ?",
        actorId,
      );
      return this.finalizeActiveStrokes(
        SERVER_MEMBER_MODERATION_CONNECTION_ID,
        changedAt,
        actorId,
      );
    });
    for (const event of finalized) this.broadcast(event);

    const sockets = this.ctx.getWebSockets(`actor:${actorId}`);
    const removal = {
      type: "room.removed",
      reason: "service_banned",
      actionId,
    } as const satisfies ServerMessage;
    for (const socket of sockets) {
      try {
        socket.send(encodeServerMessage(removal));
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "service banned member notification failed",
          error: error instanceof Error ? error.message : String(error),
          actionId,
          actorId,
        }));
      } finally {
        socket.close(1008, removal.reason);
      }
    }
    return { disconnectedConnectionCount: sockets.length };
  }

  async suspendRoom(request: RoomModerationRequest): Promise<RoomLifecycleState> {
    validateRoomModerationRequest(request);
    if (request.action !== "suspend_room") {
      throw new TypeError("room suspension requires suspend_room action");
    }
    const transition = this.ctx.storage.transactionSync(() => {
      const existing = this.roomLifecycleState();
      if (existing.status === "suspended" || existing.status === "closing") {
        return {
          state: existing,
          finalized: [] as AcceptedStrokeEvent[],
          changed: false,
        };
      }
      const changedAt = Date.now();
      const finalized = this.finalizeActiveStrokes(
        SERVER_SUSPEND_CONNECTION_ID,
        changedAt,
      );
      const supersededSnapshotJobCount = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM snapshot_jobs WHERE status = 'queued'",
        )
        .one().count;
      this.ctx.storage.sql.exec(
        "UPDATE snapshot_jobs SET status = 'superseded' WHERE status = 'queued'",
      );
      this.ctx.storage.sql.exec("DELETE FROM snapshot_read_tickets");
      this.ctx.storage.sql.exec("DELETE FROM room_tickets");
      this.ctx.storage.sql.exec("DELETE FROM scheduled_tasks");
      this.ctx.storage.sql.exec(
        `UPDATE snapshot_automation
         SET pending_compaction_job_id = NULL, compaction_due_at = NULL
         WHERE singleton = 1`,
      );
      this.ctx.storage.sql.exec(
        `UPDATE room_lifecycle
         SET status = 'suspended',
             status_changed_at = ?,
             close_request_id = NULL,
             close_reason = NULL,
             closing_started_at = NULL,
             finalized_stroke_count = ?,
             superseded_snapshot_job_count = ?
         WHERE singleton = 1 AND status IN ('waiting', 'active', 'idle')`,
        changedAt,
        finalized.length,
        supersededSnapshotJobCount,
      );
      return {
        state: { status: "suspended", changedAt } as const,
        finalized,
        changed: true,
      };
    });

    if (!transition.changed) return transition.state;
    if (transition.state.status !== "suspended") {
      throw new Error("room suspension transition is inconsistent");
    }
    for (const event of transition.finalized) this.broadcast(event);
    const message = {
      type: "room.updated",
      status: "suspended",
      changedAt: transition.state.changedAt,
    } as const satisfies RoomUpdatedMessage;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encodeServerMessage(message));
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "room suspension notification failed",
          error: error instanceof Error ? error.message : String(error),
          actionId: request.actionId,
        }));
      } finally {
        socket.close(1008, "room suspended");
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.projectRoomSuspended(transition.state.changedAt);
    return transition.state;
  }

  async beginRoomClose(request: RoomCloseRequest): Promise<RoomCloseResult> {
    if (
      !IDENTIFIER_PATTERN.test(request.closeRequestId)
      || !ROOM_CLOSE_REASONS.includes(request.reason)
    ) {
      throw new TypeError("invalid room close request");
    }
    const transition = this.ctx.storage.transactionSync(() => {
      const existing = this.roomLifecycleState();
      if (existing.status === "closing") {
        this.ensureRoomCleanup(existing);
        return {
          state: existing,
          finalized: [] as AcceptedStrokeEvent[],
          changed: false,
        };
      }

      const startedAt = Date.now();
      const finalized = this.finalizeActiveStrokes(
        SERVER_CLOSE_CONNECTION_ID,
        startedAt,
      );

      const supersededSnapshotJobCount = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM snapshot_jobs WHERE status = 'queued'",
        )
        .one().count;
      this.ctx.storage.sql.exec(
        "UPDATE snapshot_jobs SET status = 'superseded' WHERE status = 'queued'",
      );
      this.ctx.storage.sql.exec("DELETE FROM snapshot_read_tickets");
      this.ctx.storage.sql.exec("DELETE FROM room_tickets");
      this.ctx.storage.sql.exec(
        `UPDATE snapshot_automation
         SET pending_compaction_job_id = NULL, compaction_due_at = NULL
         WHERE singleton = 1`,
      );
      this.ctx.storage.sql.exec("DELETE FROM scheduled_tasks");
      this.ctx.storage.sql.exec(
        `UPDATE room_lifecycle
         SET status = 'closing',
             status_changed_at = ?,
             close_request_id = ?,
             close_reason = ?,
             closing_started_at = ?,
             finalized_stroke_count = ?,
             superseded_snapshot_job_count = ?
         WHERE singleton = 1
           AND status IN ('waiting', 'active', 'idle', 'suspended')`,
        startedAt,
        request.closeRequestId,
        request.reason,
        startedAt,
        finalized.length,
        supersededSnapshotJobCount,
      );
      const state = {
        status: "closing",
        closeRequestId: request.closeRequestId,
        reason: request.reason,
        startedAt,
        finalizedStrokeCount: finalized.length,
        supersededSnapshotJobCount,
      } as const;
      this.ensureRoomCleanup(state);
      return {
        state,
        finalized,
        changed: true,
      };
    });

    if (transition.changed) {
      for (const event of transition.finalized) this.broadcast(event);
      const messages: readonly ServerMessage[] = [
        {
          type: "room.updated",
          status: "closing",
          closeRequestId: transition.state.closeRequestId,
          reason: transition.state.reason,
          startedAt: transition.state.startedAt,
        } satisfies RoomUpdatedMessage,
        {
          type: "room.closed",
          closeRequestId: transition.state.closeRequestId,
          reason: transition.state.reason,
          closedAt: Date.now(),
        },
      ];
      for (const socket of this.ctx.getWebSockets()) {
        try {
          for (const message of messages) {
            socket.send(encodeServerMessage(message));
          }
        } catch (error) {
          console.error(JSON.stringify({
            level: "error",
            message: "room closing notification failed",
            error: error instanceof Error ? error.message : String(error),
            closeRequestId: transition.state.closeRequestId,
          }));
        } finally {
          socket.close(1001, "room is closing");
        }
      }
    }
    await this.enqueueRoomCleanup();
    return {
      ...transition.state,
      snapshotObjectKeys: this.snapshotObjectKeys(),
    };
  }

  async finalizeRoomCleanup(job: RoomCleanupJob): Promise<{
    readonly status: "deleted";
  }> {
    validateRoomCleanupJob(job);
    const projected = await this.env.DB.prepare(
      `SELECT status, cleanup_job_id
       FROM rooms WHERE id = ?`,
    ).bind(job.roomId).first<{
      status: string;
      cleanup_job_id: string | null;
    }>();
    if (
      projected
      && (
        projected.status !== "closing"
        || projected.cleanup_job_id !== job.jobId
      )
    ) {
      throw new Error("room cleanup fence mismatch");
    }
    const schemaPresent = this.ctx.storage.sql.exec<{ present: number }>(
      `SELECT 1 AS present
       FROM sqlite_master
       WHERE type = 'table' AND name = 'snapshot_automation'
       LIMIT 1`,
    ).toArray().length > 0;
    if (!schemaPresent) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return { status: "deleted" };
    }
    const metadataRoomId = this.roomIdentity();
    if (metadataRoomId !== null) {
      const lifecycle = this.roomLifecycleState();
      if (
        metadataRoomId !== job.roomId
        || lifecycle.status !== "closing"
        || lifecycle.closeRequestId !== job.closeRequestId
      ) {
        throw new Error("room cleanup durable object fence mismatch");
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { status: "deleted" };
  }

  stats(): RoomStats {
    const stored = this.ctx.storage.sql.exec<Omit<RoomStats, "connectionCount">>(`
      SELECT
        (SELECT COUNT(*) FROM stroke_events) AS eventCount,
        (SELECT COUNT(*) FROM strokes WHERE status = 'active') AS activeStrokeCount,
        (SELECT COALESCE(MAX(room_seq), 0) FROM stroke_events) AS lastRoomSeq,
        (SELECT value FROM room_metrics WHERE name = 'accepted') AS acceptedCount,
        (SELECT value FROM room_metrics WHERE name = 'reject') AS rejectCount,
        (SELECT value FROM room_metrics WHERE name = 'broadcast') AS broadcastCount,
        (SELECT value FROM room_metrics WHERE name = 'replay_event') AS replayEventCount,
        (SELECT value FROM room_metrics WHERE name = 'payload_bytes') AS totalPayloadBytes,
        (SELECT value FROM room_metrics WHERE name = 'rate_limited') AS rateLimitedCount,
        (SELECT value FROM room_metrics WHERE name = 'short_mute') AS shortMuteCount,
        (SELECT value FROM room_metrics WHERE name = 'abuse_disconnect')
          AS abuseDisconnectCount
    `).one();
    return {
      ...stored,
      connectionCount: this.ctx.getWebSockets().length,
    };
  }

  eventsAfter(afterRoomSeq: number, limit = 500): AcceptedStrokeEvent[] {
    if (!Number.isSafeInteger(afterRoomSeq) || afterRoomSeq < 0) {
      throw new RangeError("afterRoomSeq must be a non-negative safe integer");
    }
    const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
    return this.ctx.storage.sql
      .exec<StoredEventRow>(
        `SELECT room_seq, actor, connection_id, accepted_at, payload
         FROM stroke_events
         WHERE room_seq > ?
         ORDER BY room_seq
         LIMIT ?`,
        afterRoomSeq,
        boundedLimit,
      )
      .toArray()
      .map((row) => ({
        type: "accepted",
        roomSeq: row.room_seq,
        actor: row.actor,
        connectionId: row.connection_id,
        acceptedAt: row.accepted_at,
        event: decodeRoomEvent(new Uint8Array(row.payload)),
      }));
  }

  createModerationEvidencePlan(
    job: ModerationEvidenceJob,
  ): ModerationEvidencePlan {
    validateModerationEvidenceJob(job);
    this.ensureRoomIdentity(job.roomId);
    const existing = this.ctx.storage.sql
      .exec<ModerationEvidenceExportRow>(
        `SELECT evidence_id, report_id, target_room_seq, source_base_room_seq,
                plan_json, created_at
         FROM moderation_evidence_exports
         WHERE evidence_id = ?`,
        job.evidenceId,
      )
      .toArray()[0];
    if (existing) {
      if (existing.report_id !== job.reportId) {
        throw new Error("evidence export is bound to another report");
      }
      return JSON.parse(existing.plan_json) as ModerationEvidencePlan;
    }

    const metadata = this.ctx.storage.sql
      .exec<RoomMetadataRow>(
        "SELECT * FROM room_metadata WHERE singleton = 1",
      )
      .one();
    const targetRoomSeq = this.ctx.storage.sql
      .exec<{ room_seq: number }>(
        "SELECT COALESCE(MAX(room_seq), 0) AS room_seq FROM stroke_events",
      )
      .one().room_seq;
    const sourceSnapshot = this.currentSnapshot();
    if (
      sourceSnapshot
      && (
        sourceSnapshot.roomId !== job.roomId
        || sourceSnapshot.baseRoomSeq > targetRoomSeq
      )
    ) {
      throw new Error("evidence snapshot source is inconsistent");
    }
    const capturedAt = Date.now();
    const plan = {
      evidenceId: job.evidenceId,
      reportId: job.reportId,
      roomId: job.roomId,
      capturedAt,
      targetRoomSeq,
      metadata: {
        name: metadata.name,
        visibility: metadata.visibility,
        createdAt: metadata.created_at,
        maxEndsAt: metadata.max_ends_at,
      },
      lifecycle: this.roomLifecycleState(),
      chatMessages: this.readChatHistory(capturedAt),
      ...(sourceSnapshot ? { sourceSnapshot } : {}),
    } as const satisfies ModerationEvidencePlan;
    this.ctx.storage.sql.exec(
      `INSERT INTO moderation_evidence_exports (
        evidence_id, report_id, target_room_seq, source_base_room_seq,
        plan_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      job.evidenceId,
      job.reportId,
      targetRoomSeq,
      sourceSnapshot?.baseRoomSeq ?? 0,
      JSON.stringify(plan),
      capturedAt,
    );
    return plan;
  }

  moderationEvidenceEvents(
    evidenceId: string,
    afterRoomSeq: number,
    limit = 50,
  ): ModerationEvidenceEventChunk {
    if (
      !IDENTIFIER_PATTERN.test(evidenceId)
      || !Number.isSafeInteger(afterRoomSeq)
      || afterRoomSeq < 0
    ) {
      throw new TypeError("invalid moderation evidence event cursor");
    }
    const evidence = this.ctx.storage.sql
      .exec<ModerationEvidenceExportRow>(
        `SELECT evidence_id, report_id, target_room_seq, source_base_room_seq,
                plan_json, created_at
         FROM moderation_evidence_exports
         WHERE evidence_id = ?`,
        evidenceId,
      )
      .toArray()[0];
    if (!evidence) throw new Error("moderation evidence plan is unavailable");
    if (
      afterRoomSeq < evidence.source_base_room_seq
      || afterRoomSeq > evidence.target_room_seq
    ) {
      throw new RangeError("moderation evidence cursor is outside its plan");
    }
    const boundedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
    const events = this.ctx.storage.sql
      .exec<StoredEventRow>(
        `SELECT room_seq, actor, connection_id, accepted_at, payload
         FROM stroke_events
         WHERE room_seq > ? AND room_seq <= ?
         ORDER BY room_seq
         LIMIT ?`,
        afterRoomSeq,
        evidence.target_room_seq,
        boundedLimit,
      )
      .toArray()
      .map((row) => ({
        type: "accepted" as const,
        roomSeq: row.room_seq,
        actor: row.actor,
        connectionId: row.connection_id,
        acceptedAt: row.accepted_at,
        event: decodeRoomEvent(new Uint8Array(row.payload)),
      }));
    const nextAfterRoomSeq = events.at(-1)?.roomSeq ?? afterRoomSeq;
    if (
      nextAfterRoomSeq < evidence.target_room_seq
      && events.length === 0
    ) {
      throw new Error("moderation evidence event log has a gap");
    }
    return {
      events,
      nextAfterRoomSeq,
      done: nextAfterRoomSeq === evidence.target_room_seq,
    };
  }

  async resumeRoomCleanupAfterEvidence(
    roomId: string,
  ): Promise<"not_closing" | "enqueued"> {
    if (!IDENTIFIER_PATTERN.test(roomId)) {
      throw new TypeError("invalid room id");
    }
    this.ensureRoomIdentity(roomId);
    const lifecycle = this.roomLifecycleState();
    if (lifecycle.status !== "closing") return "not_closing";
    this.ensureRoomCleanup(lifecycle);
    await this.enqueueRoomCleanup();
    return "enqueued";
  }

  async requestSnapshot(roomId: string): Promise<SnapshotJob> {
    return this.createSnapshotJob(roomId, "manual");
  }

  async reconcileSnapshotAutomation(
    roomId: string,
  ): Promise<SnapshotAutomationResult> {
    if (!IDENTIFIER_PATTERN.test(roomId)) {
      throw new TypeError("invalid room id");
    }
    this.ensureRoomIdentity(roomId);
    const config = snapshotAutomationConfig(this.env);
    const state = this.ctx.storage.sql.exec<{
      lifecycle_active: number;
      active_strokes: number;
      queued_jobs: number;
      event_count: number;
      payload_bytes: number;
      last_job_event_count: number | null;
      last_job_payload_bytes: number | null;
    }>(`
      SELECT
        (SELECT status = 'active' FROM room_lifecycle WHERE singleton = 1)
          AS lifecycle_active,
        (SELECT COUNT(*) FROM strokes WHERE status = 'active') AS active_strokes,
        (SELECT COUNT(*) FROM snapshot_jobs WHERE status = 'queued') AS queued_jobs,
        (SELECT value FROM room_metrics WHERE name = 'accepted') AS event_count,
        (SELECT value FROM room_metrics WHERE name = 'payload_bytes') AS payload_bytes,
        (SELECT trigger_event_count FROM snapshot_jobs
         ORDER BY generation DESC, requested_at DESC LIMIT 1)
          AS last_job_event_count,
        (SELECT trigger_payload_bytes FROM snapshot_jobs
         ORDER BY generation DESC, requested_at DESC LIMIT 1)
          AS last_job_payload_bytes
    `).one();
    const decision = decideSnapshotAutomation(config, {
      lifecycleActive: state.lifecycle_active === 1,
      activeStrokeCount: state.active_strokes,
      queuedJobCount: state.queued_jobs,
      totalEventCount: state.event_count,
      totalPayloadBytes: state.payload_bytes,
      ...(state.last_job_event_count === null
        || state.last_job_payload_bytes === null
        ? {}
        : {
            lastJobEventCount: state.last_job_event_count,
            lastJobPayloadBytes: state.last_job_payload_bytes,
          }),
    });
    const evaluatedAt = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE snapshot_automation
       SET last_evaluated_at = ?, last_evaluation_status = ?
       WHERE singleton = 1`,
      evaluatedAt,
      decision.status,
    );
    if (decision.status !== "trigger" || decision.trigger === undefined) {
      return {
        ...decision,
        eventCount: state.event_count,
        payloadBytes: state.payload_bytes,
      };
    }
    const job = await this.createSnapshotJob(roomId, decision.trigger);
    console.log(JSON.stringify({
      level: "info",
      message: "automatic snapshot queued",
      roomId,
      jobId: job.jobId,
      trigger: decision.trigger,
      eventCount: state.event_count,
      payloadBytes: state.payload_bytes,
      mode: config.mode,
    }));
    return {
      ...decision,
      eventCount: state.event_count,
      payloadBytes: state.payload_bytes,
      job,
    };
  }

  snapshotAutomationState(): SnapshotAutomationState {
    const row = this.readSnapshotAutomation();
    return {
      config: snapshotAutomationConfig(this.env),
      ...(row.room_id === null ? {} : { roomId: row.room_id }),
      ...(row.pending_compaction_job_id === null
        ? {}
        : { pendingCompactionJobId: row.pending_compaction_job_id }),
      ...(row.compaction_due_at === null
        ? {}
        : { compactionDueAt: row.compaction_due_at }),
      lastEvaluatedAt: row.last_evaluated_at,
      ...(row.last_evaluation_status === null
        ? {}
        : { lastEvaluationStatus: row.last_evaluation_status }),
    };
  }

  private async createSnapshotJob(
    roomId: string,
    triggerKind: "manual" | "events" | "payload",
  ): Promise<SnapshotJob> {
    if (!IDENTIFIER_PATTERN.test(roomId)) {
      throw new TypeError("invalid room id");
    }
    this.ensureRoomIdentity(roomId);
    if (this.roomLifecycleState().status !== "active") {
      throw new Error("room is closing");
    }
    const state = this.ctx.storage.sql.exec<{
      last_room_seq: number;
      active_strokes: number;
      event_count: number;
      payload_bytes: number;
    }>(`
      SELECT
        (SELECT COALESCE(MAX(room_seq), 0) FROM stroke_events) AS last_room_seq,
        (SELECT COUNT(*) FROM strokes WHERE status = 'active') AS active_strokes,
        (SELECT value FROM room_metrics WHERE name = 'accepted') AS event_count,
        (SELECT value FROM room_metrics WHERE name = 'payload_bytes') AS payload_bytes
    `).one();
    if (state.active_strokes !== 0) {
      throw new Error("snapshot requires a completed-stroke boundary");
    }

    const existing = this.ctx.storage.sql
      .exec<SnapshotJobRow>(
        `SELECT job_id, room_id, target_room_seq, protocol_version,
                renderer_version, canvas_generation, generation,
                requested_at, source_job_id, source_base_room_seq, status
         FROM snapshot_jobs
         WHERE target_room_seq = ? AND renderer_version = ?`,
        state.last_room_seq,
        SNAPSHOT_RENDERER_VERSION,
      )
      .toArray()[0];
    if (existing) {
      if (existing.room_id !== roomId) {
        throw new Error("snapshot room identity mismatch");
      }
      const job = snapshotJobFromRow(existing);
      if (existing.status === "queued") {
        await this.env.SNAPSHOT_QUEUE.send(job);
      }
      return job;
    }

    const source = this.currentSnapshot();
    if (
      source
      && (
        source.roomId !== roomId
        || source.baseRoomSeq > state.last_room_seq
        || source.protocolVersion !== PROTOCOL_VERSION
        || source.rendererVersion !== SNAPSHOT_RENDERER_VERSION
        || source.canvasGeneration !== SNAPSHOT_CANVAS_GENERATION
      )
    ) {
      throw new Error("current snapshot cannot be used as an incremental source");
    }
    const incrementalSource = source?.baseRoomSeq === state.last_room_seq
      ? undefined
      : source;
    const job = {
      v: SNAPSHOT_JOB_VERSION,
      jobId: crypto.randomUUID(),
      roomId,
      targetRoomSeq: state.last_room_seq,
      protocolVersion: PROTOCOL_VERSION,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: this.ctx.storage.sql
        .exec<{ generation: number }>(
          "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM snapshot_jobs",
        )
        .one().generation,
      requestedAt: Date.now(),
      sourceBaseRoomSeq: incrementalSource?.baseRoomSeq ?? 0,
      ...(incrementalSource
        ? { sourceSnapshotJobId: incrementalSource.jobId }
        : {}),
    } as const satisfies SnapshotJob;
    this.ctx.storage.sql.exec(
      `INSERT INTO snapshot_jobs (
        job_id, room_id, target_room_seq, protocol_version, renderer_version,
        canvas_generation, generation, requested_at, source_job_id,
        source_base_room_seq, trigger_kind, trigger_event_count,
        trigger_payload_bytes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
      job.jobId,
      job.roomId,
      job.targetRoomSeq,
      job.protocolVersion,
      job.rendererVersion,
      job.canvasGeneration,
      job.generation,
      job.requestedAt,
      job.sourceSnapshotJobId ?? null,
      job.sourceBaseRoomSeq,
      triggerKind,
      state.event_count,
      state.payload_bytes,
    );
    await this.env.SNAPSHOT_QUEUE.send(job);
    return job;
  }

  snapshotEvents(
    jobId: string,
    afterRoomSeq: number,
    limit: number = SNAPSHOT_EVENT_CHUNK_LIMIT,
  ): SnapshotEventChunk {
    if (
      !IDENTIFIER_PATTERN.test(jobId)
      || !Number.isSafeInteger(afterRoomSeq)
      || afterRoomSeq < 0
    ) {
      throw new TypeError("invalid snapshot event cursor");
    }
    const row = this.ctx.storage.sql
      .exec<SnapshotJobRow>(
        `SELECT job_id, room_id, target_room_seq, protocol_version,
                renderer_version, canvas_generation, generation,
                requested_at, source_job_id, source_base_room_seq, status
         FROM snapshot_jobs WHERE job_id = ?`,
        jobId,
      )
      .toArray()[0];
    if (!row) {
      throw new Error("snapshot job is not available");
    }
    if (afterRoomSeq > row.target_room_seq) {
      throw new RangeError("snapshot cursor exceeds target");
    }
    if (afterRoomSeq < row.source_base_room_seq) {
      throw new RangeError("snapshot cursor precedes its fixed source");
    }
    const boundedLimit = Math.min(
      SNAPSHOT_EVENT_CHUNK_LIMIT,
      Math.max(1, Math.trunc(limit)),
    );
    const events = this.ctx.storage.sql
      .exec<StoredEventRow>(
        `SELECT room_seq, actor, connection_id, accepted_at, payload
         FROM stroke_events
         WHERE room_seq > ? AND room_seq <= ?
         ORDER BY room_seq
         LIMIT ?`,
        afterRoomSeq,
        row.target_room_seq,
        boundedLimit,
      )
      .toArray()
      .map((eventRow) => ({
        type: "accepted" as const,
        roomSeq: eventRow.room_seq,
        actor: eventRow.actor,
        connectionId: eventRow.connection_id,
        acceptedAt: eventRow.accepted_at,
        event: decodeRoomEvent(new Uint8Array(eventRow.payload)),
      }));
    const nextAfterRoomSeq = events.at(-1)?.roomSeq ?? afterRoomSeq;
    if (nextAfterRoomSeq < row.target_room_seq && events.length === 0) {
      throw new Error("snapshot event log has a gap");
    }
    return {
      job: snapshotJobFromRow(row),
      events,
      nextAfterRoomSeq,
      done: nextAfterRoomSeq === row.target_room_seq,
    };
  }

  snapshotJobDisposition(jobId: string): SnapshotJobDisposition {
    if (!IDENTIFIER_PATTERN.test(jobId)) {
      throw new TypeError("invalid snapshot job id");
    }
    const lifecycle = this.roomLifecycleState();
    const job = this.ctx.storage.sql
      .exec<{ status: SnapshotJobRow["status"] }>(
        "SELECT status FROM snapshot_jobs WHERE job_id = ?",
        jobId,
      )
      .toArray()[0];
    return lifecycle.status === "active" && job?.status === "queued"
      ? "run"
      : "discard";
  }

  async snapshotSource(jobId: string): Promise<SnapshotManifest | undefined> {
    if (!IDENTIFIER_PATTERN.test(jobId)) {
      throw new TypeError("invalid snapshot job id");
    }
    const job = this.ctx.storage.sql
      .exec<SnapshotJobRow>(
        `SELECT job_id, room_id, target_room_seq, protocol_version,
                renderer_version, canvas_generation, generation,
                requested_at, source_job_id, source_base_room_seq, status
         FROM snapshot_jobs WHERE job_id = ?`,
        jobId,
      )
      .toArray()[0];
    if (!job) {
      throw new Error("snapshot job is not available");
    }
    if (job.source_job_id === null) {
      if (job.source_base_room_seq !== 0) {
        throw new Error("snapshot job has an inconsistent source cursor");
      }
      return undefined;
    }
    const source = this.readSnapshotManifest(job.source_job_id);
    if (
      !source
      || source.roomId !== job.room_id
      || source.baseRoomSeq !== job.source_base_room_seq
      || source.baseRoomSeq >= job.target_room_seq
      || source.protocolVersion !== job.protocol_version
      || source.rendererVersion !== job.renderer_version
      || source.canvasGeneration !== job.canvas_generation
    ) {
      throw new Error("snapshot job source is unavailable or inconsistent");
    }
    return source;
  }

  commitSnapshot(manifest: SnapshotManifest): SnapshotCommitResult {
    validateSnapshotManifest(manifest);
    const result: SnapshotCommitResult = this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql
        .exec<SnapshotJobRow>(
          `SELECT job_id, room_id, target_room_seq, protocol_version,
                  renderer_version, canvas_generation, generation,
                  requested_at, source_job_id, source_base_room_seq, status
           FROM snapshot_jobs WHERE job_id = ?`,
          manifest.jobId,
        )
        .toArray()[0];
      if (
        !job
        || job.room_id !== manifest.roomId
        || job.target_room_seq !== manifest.baseRoomSeq
        || job.protocol_version !== manifest.protocolVersion
        || job.renderer_version !== manifest.rendererVersion
        || job.canvas_generation !== manifest.canvasGeneration
        || job.generation !== manifest.generation
      ) {
        throw new Error("snapshot manifest does not match its job");
      }

      const committed = this.readSnapshotManifest(manifest.jobId);
      if (committed) {
        if (
          committed.objectHash !== manifest.objectHash
          || committed.rgbaHash !== manifest.rgbaHash
          || committed.objectKey !== manifest.objectKey
        ) {
          throw new Error("snapshot job was committed with different output");
        }
        return { status: "already_committed", manifest: committed };
      }

      if (
        job.status !== "queued"
        || this.roomLifecycleState().status !== "active"
      ) {
        this.ctx.storage.sql.exec(
          "UPDATE snapshot_jobs SET status = 'superseded' WHERE job_id = ?",
          manifest.jobId,
        );
        return { status: "superseded" };
      }

      const current = this.currentSnapshot();
      if (current && current.baseRoomSeq > manifest.baseRoomSeq) {
        this.ctx.storage.sql.exec(
          "UPDATE snapshot_jobs SET status = 'superseded' WHERE job_id = ?",
          manifest.jobId,
        );
        return { status: "superseded" };
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO snapshot_manifests (
          job_id, room_id, base_room_seq, protocol_version, renderer_version,
          canvas_generation, generation, codec, width, height, object_key,
          object_bytes, object_hash, rgba_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        manifest.jobId,
        manifest.roomId,
        manifest.baseRoomSeq,
        manifest.protocolVersion,
        manifest.rendererVersion,
        manifest.canvasGeneration,
        manifest.generation,
        manifest.codec,
        manifest.width,
        manifest.height,
        manifest.objectKey,
        manifest.objectBytes,
        manifest.objectHash,
        manifest.rgbaHash,
        manifest.createdAt,
      );
      this.ctx.storage.sql.exec(
        "UPDATE snapshot_jobs SET status = 'committed' WHERE job_id = ?",
        manifest.jobId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE snapshot_state
         SET previous_job_id = current_job_id,
             current_job_id = ?
         WHERE singleton = 1`,
        manifest.jobId,
      );
      return { status: "committed", manifest };
    });
    if (
      result.status !== "superseded"
      && shouldArmSnapshotCompaction(
        snapshotAutomationConfig(this.env).mode,
        this.previousSnapshot()?.baseRoomSeq,
      )
    ) {
      const compaction = this.snapshotCompactionState();
      if (
        compaction.currentJobId === manifest.jobId
        && compaction.previousBaseRoomSeq !== undefined
        && compaction.compactedThroughRoomSeq < compaction.previousBaseRoomSeq
      ) {
        this.ctx.storage.sql.exec(
          `UPDATE snapshot_automation
           SET pending_compaction_job_id = ?, compaction_due_at = ?
           WHERE singleton = 1`,
          manifest.jobId,
          Date.now(),
        );
        this.ctx.waitUntil(this.scheduleNextAlarm().catch((error) => {
          console.error(JSON.stringify({
            level: "error",
            message: "snapshot compaction alarm scheduling failed",
            jobId: manifest.jobId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }));
      }
    }
    return result;
  }

  currentSnapshot(): SnapshotManifest | undefined {
    const row = this.ctx.storage.sql
      .exec<SnapshotManifestRow>(
        `SELECT m.*
         FROM snapshot_state s
         JOIN snapshot_manifests m ON m.job_id = s.current_job_id
         WHERE s.singleton = 1`,
      )
      .toArray()[0];
    return row ? snapshotManifestFromRow(row) : undefined;
  }

  previousSnapshot(): SnapshotManifest | undefined {
    const row = this.ctx.storage.sql
      .exec<SnapshotManifestRow>(
        `SELECT m.*
         FROM snapshot_state s
         JOIN snapshot_manifests m ON m.job_id = s.previous_job_id
         WHERE s.singleton = 1`,
      )
      .toArray()[0];
    return row ? snapshotManifestFromRow(row) : undefined;
  }

  snapshotCompactionState(): SnapshotCompactionState {
    const state = this.ctx.storage.sql
      .exec<SnapshotStateRow>(
        `SELECT current_job_id, previous_job_id, mode,
                compacted_through_room_seq
         FROM snapshot_state WHERE singleton = 1`,
      )
      .one();
    const current = state.current_job_id
      ? this.readSnapshotManifest(state.current_job_id)
      : undefined;
    const previous = state.previous_job_id
      ? this.readSnapshotManifest(state.previous_job_id)
      : undefined;
    if (
      (state.current_job_id && !current)
      || (state.previous_job_id && !previous)
    ) {
      throw new Error("snapshot compaction state references a missing manifest");
    }
    const desiredThrough = previous?.baseRoomSeq
      ?? state.compacted_through_room_seq;
    const blocker = this.ctx.storage.sql
      .exec<QueuedSnapshotSourceRow>(
        `SELECT job_id, source_base_room_seq
         FROM snapshot_jobs
         WHERE status = 'queued'
         ORDER BY source_base_room_seq, requested_at, job_id
         LIMIT 1`,
      )
      .toArray()[0];
    const safeThroughRoomSeq = Math.max(
      state.compacted_through_room_seq,
      Math.min(
        desiredThrough,
        blocker?.source_base_room_seq ?? desiredThrough,
      ),
    );
    return {
      mode: state.mode,
      compactedThroughRoomSeq: state.compacted_through_room_seq,
      ...(current
        ? {
            currentJobId: current.jobId,
            currentBaseRoomSeq: current.baseRoomSeq,
          }
        : {}),
      ...(previous
        ? {
            previousJobId: previous.jobId,
            previousBaseRoomSeq: previous.baseRoomSeq,
          }
        : {}),
      safeThroughRoomSeq,
      ...(blocker && blocker.source_base_room_seq < desiredThrough
        ? { blockedByQueuedJobId: blocker.job_id }
        : {}),
    };
  }

  compactSnapshotEvents(
    currentJobId: string,
    limit: number = SNAPSHOT_EVENT_CHUNK_LIMIT,
  ): SnapshotCompactionChunk {
    if (!IDENTIFIER_PATTERN.test(currentJobId) || !Number.isFinite(limit)) {
      throw new TypeError("invalid snapshot compaction request");
    }
    const boundedLimit = Math.min(
      SNAPSHOT_EVENT_CHUNK_LIMIT,
      Math.max(1, Math.trunc(limit)),
    );
    return this.ctx.storage.transactionSync(() => {
      const before = this.snapshotCompactionState();
      if (this.roomLifecycleState().status !== "active") {
        return {
          ...before,
          status: "room_closing",
          deletedEventCount: 0,
          done: false,
        };
      }
      if (before.currentJobId !== currentJobId) {
        return {
          ...before,
          status: "stale",
          deletedEventCount: 0,
          done: false,
        };
      }
      const desiredThrough = before.previousBaseRoomSeq;
      if (desiredThrough === undefined || desiredThrough <= 0) {
        return {
          ...before,
          status: "not_ready",
          deletedEventCount: 0,
          done: false,
        };
      }
      if (before.safeThroughRoomSeq <= before.compactedThroughRoomSeq) {
        return {
          ...before,
          status: before.blockedByQueuedJobId ? "blocked" : "compacted",
          deletedEventCount: 0,
          done: before.compactedThroughRoomSeq >= desiredThrough,
        };
      }

      const rows = this.ctx.storage.sql
        .exec<{ room_seq: number }>(
          `SELECT room_seq
           FROM stroke_events
           WHERE room_seq > ? AND room_seq <= ?
           ORDER BY room_seq
           LIMIT ?`,
          before.compactedThroughRoomSeq,
          before.safeThroughRoomSeq,
          boundedLimit,
        )
        .toArray();
      if (rows.length > 0) {
        const firstRoomSeq = rows[0]!.room_seq;
        const lastRoomSeq = rows.at(-1)!.room_seq;
        this.ctx.storage.sql.exec(
          `DELETE FROM stroke_events
           WHERE room_seq >= ? AND room_seq <= ?`,
          firstRoomSeq,
          lastRoomSeq,
        );
      }
      const selectedThrough = rows.at(-1)?.room_seq
        ?? before.compactedThroughRoomSeq;
      const compactedThroughRoomSeq = rows.length < boundedLimit
        ? before.safeThroughRoomSeq
        : selectedThrough;
      this.ctx.storage.sql.exec(
        `UPDATE snapshot_state
         SET mode = 'snapshot_compacted',
             compacted_through_room_seq = ?,
             compaction_updated_at = ?
         WHERE singleton = 1`,
        compactedThroughRoomSeq,
        Date.now(),
      );
      const after = this.snapshotCompactionState();
      return {
        ...after,
        status: after.blockedByQueuedJobId ? "blocked" : "compacted",
        deletedEventCount: rows.length,
        done: after.compactedThroughRoomSeq >= desiredThrough,
      };
    });
  }

  async consumeSnapshotReadTicket(
    roomId: string,
    jobId: string,
    readToken: string,
  ): Promise<SnapshotReadGrant | undefined> {
    if (
      !IDENTIFIER_PATTERN.test(roomId)
      || !IDENTIFIER_PATTERN.test(jobId)
      || !SNAPSHOT_READ_TOKEN_PATTERN.test(readToken)
    ) {
      return undefined;
    }
    const tokenHash = await sha256Hex(readToken);
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      if (this.roomLifecycleState().status !== "active") return undefined;
      const row = this.ctx.storage.sql
        .exec<SnapshotReadTicketRow>(
          `SELECT m.*, t.expires_at
           FROM snapshot_read_tickets t
           JOIN snapshot_manifests m ON m.job_id = t.job_id
           WHERE t.token_hash = ?
             AND t.job_id = ?
             AND m.room_id = ?
             AND t.consumed_at IS NULL
             AND t.expires_at >= ?`,
          tokenHash,
          jobId,
          roomId,
          now,
        )
        .toArray()[0];
      if (!row) return undefined;
      this.ctx.storage.sql.exec(
        `UPDATE snapshot_read_tickets
         SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL`,
        now,
        tokenHash,
      );
      return {
        manifest: snapshotManifestFromRow(row),
        expiresAt: row.expires_at,
      };
    });
  }

  private async issueSnapshotOffer(
    roomId: string,
    resumeAfterRoomSeq: number,
    excludedJobIds: ReadonlySet<string>,
  ): Promise<SnapshotOfferMessage | undefined> {
    if (this.roomLifecycleState().status !== "active") return undefined;
    const manifest = [this.currentSnapshot(), this.previousSnapshot()]
      .find((candidate) => (
        candidate !== undefined
        && !excludedJobIds.has(candidate.jobId)
      ));
    if (
      !manifest
      || manifest.roomId !== roomId
      || resumeAfterRoomSeq > manifest.baseRoomSeq
    ) {
      return undefined;
    }
    const readToken = randomHex(32);
    const tokenHash = await sha256Hex(readToken);
    const expiresAt = Date.now() + SNAPSHOT_READ_TTL_MS;
    this.ctx.storage.sql.exec(
      "DELETE FROM snapshot_read_tickets WHERE expires_at < ?",
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO snapshot_read_tickets (
        token_hash, job_id, expires_at, consumed_at
      ) VALUES (?, ?, ?, NULL)`,
      tokenHash,
      manifest.jobId,
      expiresAt,
    );
    return {
      type: "snapshot",
      manifest: publicSnapshotManifest(manifest),
      readToken,
      expiresAt,
    };
  }

  private readSnapshotManifest(jobId: string): SnapshotManifest | undefined {
    const row = this.ctx.storage.sql
      .exec<SnapshotManifestRow>(
        "SELECT * FROM snapshot_manifests WHERE job_id = ?",
        jobId,
      )
      .toArray()[0];
    return row ? snapshotManifestFromRow(row) : undefined;
  }

  private readRoomLifecycle(): RoomLifecycleRow {
    return this.ctx.storage.sql
      .exec<RoomLifecycleRow>(
        `SELECT status, status_changed_at, last_activity_at,
                close_request_id, close_reason, closing_started_at,
                finalized_stroke_count, superseded_snapshot_job_count
         FROM room_lifecycle WHERE singleton = 1`,
      )
      .one();
  }

  private readSnapshotAutomation(): SnapshotAutomationRow {
    return this.ctx.storage.sql
      .exec<SnapshotAutomationRow>(
        `SELECT room_id, pending_compaction_job_id, compaction_due_at,
                last_evaluated_at, last_evaluation_status
         FROM snapshot_automation WHERE singleton = 1`,
      )
      .one();
  }

  private ensureRoomIdentity(roomId: string): void {
    if (!IDENTIFIER_PATTERN.test(roomId)) {
      throw new TypeError("invalid room id");
    }
    this.ctx.storage.sql.exec(
      `UPDATE snapshot_automation
       SET room_id = ?
       WHERE singleton = 1 AND room_id IS NULL`,
      roomId,
    );
    if (this.roomIdentity() !== roomId) {
      throw new Error("room identity mismatch");
    }
  }

  private roomMetadataMatches(
    stored: RoomMetadataRow,
    request: RoomProvisioningRequest,
  ): boolean {
    return (
      stored.room_id === request.roomId
      && stored.public_slug === request.publicSlug
      && stored.owner_user_id === request.ownerUserId
      && stored.name === request.name
      && stored.visibility === request.visibility
      && stored.participant_limit === request.participantLimit
      && stored.viewer_limit === request.viewerLimit
      && stored.viewer_chat_enabled === (request.viewerChatEnabled ? 1 : 0)
      && stored.viewer_stamp_enabled === (request.viewerStampEnabled ? 1 : 0)
      && stored.created_at === request.createdAt
      && stored.max_ends_at === request.maxEndsAt
    );
  }

  private roomIdentity(): string | undefined {
    return this.readSnapshotAutomation().room_id ?? undefined;
  }

  private async runPendingSnapshotCompaction(now: number): Promise<void> {
    const automation = this.readSnapshotAutomation();
    if (
      automation.pending_compaction_job_id === null
      || automation.compaction_due_at === null
      || automation.compaction_due_at > now
    ) {
      return;
    }
    const mode = snapshotAutomationConfig(this.env).mode;
    if (mode !== "compact") {
      this.ctx.storage.sql.exec(
        `UPDATE snapshot_automation
         SET pending_compaction_job_id = NULL, compaction_due_at = NULL
         WHERE singleton = 1`,
      );
      return;
    }

    const result = this.compactSnapshotEvents(
      automation.pending_compaction_job_id,
      SNAPSHOT_EVENT_CHUNK_LIMIT,
    );
    const retryAt = result.status === "blocked"
      ? now + 1_000
      : result.status === "compacted" && !result.done
      ? now + 100
      : undefined;
    this.ctx.storage.sql.exec(
      `UPDATE snapshot_automation
       SET pending_compaction_job_id = ?, compaction_due_at = ?
       WHERE singleton = 1`,
      retryAt === undefined ? null : automation.pending_compaction_job_id,
      retryAt ?? null,
    );
    console.log(JSON.stringify({
      level: "info",
      message: "automatic snapshot compaction chunk processed",
      jobId: automation.pending_compaction_job_id,
      status: result.status,
      deletedEventCount: result.deletedEventCount,
      done: result.done,
      retryAt,
    }));
  }

  private snapshotObjectKeys(): string[] {
    return this.ctx.storage.sql
      .exec<{ object_key: string }>(
        `SELECT object_key FROM snapshot_manifests
         UNION
         SELECT 'rooms/' || room_id || '/snapshots/staging/' || job_id || '.kgs'
         FROM snapshot_jobs
         ORDER BY object_key`,
      )
      .toArray()
      .map((row) => row.object_key);
  }

  private ensureRoomCleanup(
    lifecycle: Extract<RoomLifecycleState, { status: "closing" }>,
  ): void {
    const roomId = this.roomIdentity();
    if (!roomId) throw new Error("room cleanup requires initialized metadata");
    const job = {
      v: ROOM_CLEANUP_JOB_VERSION,
      jobId: lifecycle.closeRequestId,
      roomId,
      closeRequestId: lifecycle.closeRequestId,
      requestedAt: lifecycle.startedAt,
      snapshotObjectKeys: this.snapshotObjectKeys(),
    } as const satisfies RoomCleanupJob;
    validateRoomCleanupJob(job);
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO room_cleanup (
        singleton, job_id, close_request_id, requested_at,
        snapshot_object_keys, next_enqueue_at
      ) VALUES (1, ?, ?, ?, ?, ?)`,
      job.jobId,
      job.closeRequestId,
      job.requestedAt,
      JSON.stringify(job.snapshotObjectKeys),
      Date.now(),
    );
  }

  private readRoomCleanup(): RoomCleanupRow | undefined {
    return this.ctx.storage.sql
      .exec<RoomCleanupRow>(
        `SELECT job_id, close_request_id, requested_at,
                snapshot_object_keys, enqueued_at, next_enqueue_at
         FROM room_cleanup WHERE singleton = 1`,
      )
      .toArray()[0];
  }

  private async enqueueRoomCleanup(): Promise<void> {
    const row = this.readRoomCleanup();
    if (!row || row.enqueued_at !== null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const roomId = this.roomIdentity();
    if (!roomId) throw new Error("room cleanup requires initialized metadata");
    const parsedKeys: unknown = JSON.parse(row.snapshot_object_keys);
    const job = {
      v: ROOM_CLEANUP_JOB_VERSION,
      jobId: row.job_id,
      roomId,
      closeRequestId: row.close_request_id,
      requestedAt: row.requested_at,
      snapshotObjectKeys: parsedKeys,
    };
    validateRoomCleanupJob(job);
    try {
      const lifecycle = this.roomLifecycleState();
      if (lifecycle.status !== "closing") {
        throw new Error("room cleanup enqueue requires closing lifecycle");
      }
      await this.projectRoomClosing(lifecycle);
      await this.env.ROOM_CLEANUP_QUEUE.send(job);
      this.ctx.storage.sql.exec(
        `UPDATE room_cleanup
         SET enqueued_at = ?, next_enqueue_at = NULL
         WHERE singleton = 1 AND enqueued_at IS NULL`,
        Date.now(),
      );
      await this.ctx.storage.deleteAlarm();
    } catch (error) {
      const retryAt = Date.now() + 10_000;
      this.ctx.storage.sql.exec(
        `UPDATE room_cleanup SET next_enqueue_at = ?
         WHERE singleton = 1 AND enqueued_at IS NULL`,
        retryAt,
      );
      await this.ctx.storage.setAlarm(retryAt);
      console.error(JSON.stringify({
        level: "error",
        message: "room cleanup enqueue failed",
        roomId,
        jobId: job.jobId,
        retryAt,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private sendReplay(
    ws: WebSocket,
    afterRoomSeq: number,
    throughRoomSeq: number,
  ): {
    eventCount: number;
    frameCount: number;
    encodedBytes: number;
    cacheHit: boolean;
    encodedFrameCount: number;
  } {
    const cached = this.replayFrameCache;
    if (
      cached
      && cached.afterRoomSeq === afterRoomSeq
      && cached.throughRoomSeq === throughRoomSeq
    ) {
      for (const frame of cached.frames) ws.send(frame);
      if (cached.eventCount > 0) {
        this.incrementMetric("replay_event", cached.eventCount);
      }
      return {
        eventCount: cached.eventCount,
        frameCount: cached.frames.length,
        encodedBytes: cached.encodedBytes,
        cacheHit: true,
        encodedFrameCount: 0,
      };
    }

    let cursor = afterRoomSeq;
    let replayed = 0;
    const frames: Uint8Array[] = [];
    let frameCount = 0;
    let encodedBytes = 0;
    let cacheable = true;
    while (true) {
      const events = this.eventsAfter(cursor);
      const chunk = this.encodeReplayChunk(events);
      replayed += events.length;
      frameCount += chunk.length;
      encodedBytes += chunk.encodedBytes;
      if (cacheable && encodedBytes <= MAX_REPLAY_FRAME_CACHE_BYTES) {
        frames.push(...chunk);
      } else {
        if (cacheable) {
          for (const frame of frames) ws.send(frame);
          frames.length = 0;
          cacheable = false;
        }
        for (const frame of chunk) ws.send(frame);
      }
      const last = events.at(-1);
      if (!last || events.length < 500) break;
      cursor = last.roomSeq;
    }
    if (cacheable) {
      for (const frame of frames) ws.send(frame);
    }
    if (replayed > 0) this.incrementMetric("replay_event", replayed);
    this.replayFrameCache = cacheable
      ? {
          afterRoomSeq,
          throughRoomSeq,
          eventCount: replayed,
          frames,
          encodedBytes,
        }
      : null;
    return {
      eventCount: replayed,
      frameCount,
      encodedBytes,
      cacheHit: false,
      encodedFrameCount: frameCount,
    };
  }

  private encodeReplayChunk(
    events: readonly AcceptedStrokeEvent[],
  ): Uint8Array[] & { encodedBytes: number } {
    if (events.length === 0) {
      return Object.assign([], { encodedBytes: 0 });
    }
    try {
      const frame = encodeServerMessage({ type: "replay", events });
      return Object.assign([frame], { encodedBytes: frame.byteLength });
    } catch (error) {
      if (!(error instanceof RangeError) || events.length === 1) throw error;
    }
    const middle = Math.ceil(events.length / 2);
    const left = this.encodeReplayChunk(events.slice(0, middle));
    const right = this.encodeReplayChunk(events.slice(middle));
    return Object.assign([...left, ...right], {
      encodedBytes: left.encodedBytes + right.encodedBytes,
    });
  }

  private lifecycleUpdatedMessage(
    lifecycle: Extract<
      RoomLifecycleState,
      { status: "waiting" | "active" | "idle" }
    >,
  ): RoomUpdatedMessage {
    if (lifecycle.status === "waiting") {
      return {
        type: "room.updated",
        status: "waiting",
        changedAt: lifecycle.changedAt,
      };
    }
    return {
      type: "room.updated",
      status: lifecycle.status,
      changedAt: lifecycle.changedAt,
      lastActivityAt: lifecycle.lastActivityAt,
    };
  }

  private roomTimeLimitRow(): RoomTimeLimitRow | undefined {
    return this.ctx.storage.sql
      .exec<RoomTimeLimitRow>(
        `SELECT room_time_limit.warning_stage, scheduled_tasks.due_at
         FROM room_time_limit
         JOIN scheduled_tasks ON scheduled_tasks.kind = 'max_duration'
         WHERE room_time_limit.singleton = 1`,
      )
      .toArray()[0];
  }

  private currentRoomTimeMessage(now: number): RoomTimeMessage | undefined {
    const limit = this.roomTimeLimitRow();
    if (!limit) return undefined;
    const warningMinutes = roomTimeWarningForStage(limit.warning_stage);
    if (!warningMinutes) return undefined;
    return {
      type: "room.time",
      warningMinutes,
      endsAt: limit.due_at,
      remainingMs: Math.max(0, limit.due_at - now),
    };
  }

  private reconcileRoomTimeWarning(
    now: number,
  ): RoomTimeMessage | undefined {
    const limit = this.roomTimeLimitRow();
    if (!limit || limit.due_at <= now) return undefined;
    const remainingMs = limit.due_at - now;
    const nextStage = roomTimeWarningStage(remainingMs);
    if (nextStage <= limit.warning_stage) return undefined;
    this.ctx.storage.sql.exec(
      `UPDATE room_time_limit SET warning_stage = ?
       WHERE singleton = 1 AND warning_stage < ?`,
      nextStage,
      nextStage,
    );
    const warningMinutes = roomTimeWarningForStage(nextStage);
    if (!warningMinutes) return undefined;
    return {
      type: "room.time",
      warningMinutes,
      endsAt: limit.due_at,
      remainingMs,
    };
  }

  private nextRoomTimeAlarm(): number | null {
    const limit = this.roomTimeLimitRow();
    if (!limit) return null;
    const warningMinutes = limit.warning_stage === 0
      ? 15
      : limit.warning_stage === 1
        ? 5
        : limit.warning_stage === 2
          ? 1
          : 0;
    return limit.due_at - warningMinutes * MINUTE_MS;
  }

  private currentRoomActivityMessage(): RoomActivityMessage | undefined {
    const limit = this.ctx.storage.sql
      .exec<RoomActivityLimitRow>(
        `SELECT warning_level, reached_at
         FROM room_activity_limit WHERE singleton = 1`,
      )
      .one();
    if (limit.warning_level === 0) return undefined;
    const activity = this.ctx.storage.sql.exec<{
      event_count: number;
      payload_bytes: number;
    }>(`
      SELECT
        (SELECT value FROM room_metrics WHERE name = 'accepted') AS event_count,
        (SELECT value FROM room_metrics WHERE name = 'payload_bytes')
          AS payload_bytes
    `).one();
    return {
      type: "room.activity",
      level: limit.warning_level as RoomActivityLevel,
      eventCount: activity.event_count,
      eventLimit: ROOM_ACTIVITY_EVENT_LIMIT,
      payloadBytes: activity.payload_bytes,
      payloadLimitBytes: ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES,
      acceptingNewStrokes: limit.reached_at === null,
    };
  }

  private evaluateRoomActivityLimit(
    now = Date.now(),
  ): RoomActivityLimitEvaluation {
    return this.ctx.storage.transactionSync(() => {
      const lifecycle = this.roomLifecycleState();
      if (lifecycle.status !== "active" && lifecycle.status !== "idle") {
        return {};
      }
      const activity = this.ctx.storage.sql.exec<{
        event_count: number;
        payload_bytes: number;
        active_strokes: number;
      }>(`
        SELECT
          (SELECT value FROM room_metrics WHERE name = 'accepted')
            AS event_count,
          (SELECT value FROM room_metrics WHERE name = 'payload_bytes')
            AS payload_bytes,
          (SELECT COUNT(*) FROM strokes WHERE status = 'active')
            AS active_strokes
      `).one();
      const level = roomActivityLevel(
        activity.event_count,
        activity.payload_bytes,
      );
      if (level === 0) return {};
      const current = this.ctx.storage.sql
        .exec<RoomActivityLimitRow>(
          `SELECT warning_level, reached_at
           FROM room_activity_limit WHERE singleton = 1`,
        )
        .one();
      const reachedAt = level === 100
        ? current.reached_at ?? now
        : current.reached_at;
      if (level > current.warning_level || reachedAt !== current.reached_at) {
        this.ctx.storage.sql.exec(
          `UPDATE room_activity_limit
           SET warning_level = ?, reached_at = ?
           WHERE singleton = 1`,
          Math.max(level, current.warning_level),
          reachedAt,
        );
      }
      const hardLimitReached =
        activity.event_count >= PROTOCOL_LIMITS.maxRoomEvents
        || activity.payload_bytes >= PROTOCOL_LIMITS.maxRoomPayloadBytes;
      return {
        ...(level > current.warning_level
          ? {
              message: {
                type: "room.activity",
                level,
                eventCount: activity.event_count,
                eventLimit: ROOM_ACTIVITY_EVENT_LIMIT,
                payloadBytes: activity.payload_bytes,
                payloadLimitBytes: ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES,
                acceptingNewStrokes: level !== 100,
              } satisfies RoomActivityMessage,
            }
          : {}),
        ...(level === 100
            && (activity.active_strokes === 0 || hardLimitReached)
          ? {
              closeRequest: {
                closeRequestId: `system_activity_limit_${reachedAt}`,
                reason: "activity_limit",
              } satisfies RoomCloseRequest,
            }
          : {}),
      };
    });
  }

  private async reconcileRoomActivityLimit(): Promise<boolean> {
    const evaluation = this.evaluateRoomActivityLimit();
    if (evaluation.message) {
      this.broadcastEphemeral(evaluation.message);
      console.log(JSON.stringify({
        level: "info",
        message: "room activity threshold reached",
        roomId: this.roomIdentity(),
        activityLevel: evaluation.message.level,
        eventCount: evaluation.message.eventCount,
        payloadBytes: evaluation.message.payloadBytes,
        acceptingNewStrokes: evaluation.message.acceptingNewStrokes,
      }));
    }
    if (!evaluation.closeRequest) return false;
    await this.beginRoomClose(evaluation.closeRequest);
    return true;
  }

  private startRoom(): {
    readonly type: "room.updated";
    readonly status: "active";
    readonly changedAt: number;
    readonly lastActivityAt: number;
  } | undefined {
    const now = Date.now();
    const changed = this.ctx.storage.sql
      .exec<{ changed: number }>(
        `UPDATE room_lifecycle
         SET status = 'active', status_changed_at = ?,
             last_activity_at = ?
         WHERE singleton = 1 AND status = 'waiting'
         RETURNING 1 AS changed`,
        now,
        now,
      )
      .toArray()[0];
    if (!changed) return undefined;
    this.ctx.storage.sql.exec(
      "DELETE FROM scheduled_tasks WHERE kind = 'empty_timeout'",
    );
    this.armIdleTask(now);
    return {
      type: "room.updated",
      status: "active",
      changedAt: now,
      lastActivityAt: now,
    };
  }

  private recordRoomActivity(now: number): RoomUpdatedMessage | undefined {
    const prior = this.readRoomLifecycle();
    if (prior.status !== "active" && prior.status !== "idle") return undefined;
    this.ctx.storage.sql.exec(
      `UPDATE room_lifecycle
       SET status = 'active',
           status_changed_at = CASE WHEN status = 'idle' THEN ? ELSE status_changed_at END,
           last_activity_at = ?
       WHERE singleton = 1 AND status IN ('active', 'idle')`,
      now,
      now,
    );
    this.armIdleTask(now);
    if (prior.status !== "idle") return undefined;
    this.projectLifecycleStatus("active", now);
    return {
      type: "room.updated",
      status: "active",
      changedAt: now,
      lastActivityAt: now,
    };
  }

  private markRoomIdle(now: number): RoomUpdatedMessage | undefined {
    const row = this.ctx.storage.sql
      .exec<{ last_activity_at: number }>(
        `UPDATE room_lifecycle
         SET status = 'idle', status_changed_at = ?
         WHERE singleton = 1 AND status = 'active'
           AND last_activity_at IS NOT NULL
           AND last_activity_at + ? <= ?
         RETURNING last_activity_at`,
        now,
        ROOM_IDLE_TIMEOUT_MS,
        now,
      )
      .toArray()[0];
    if (!row) {
      this.armIdleTask();
      return undefined;
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM scheduled_tasks WHERE kind = 'idle_timeout'",
    );
    return {
      type: "room.updated",
      status: "idle",
      changedAt: now,
      lastActivityAt: row.last_activity_at,
    };
  }

  private armIdleTask(lastActivityAt?: number): void {
    const lifecycle = this.readRoomLifecycle();
    if (
      lifecycle.status !== "active"
      || this.ctx.getWebSockets().length === 0
    ) {
      this.ctx.storage.sql.exec(
        "DELETE FROM scheduled_tasks WHERE kind = 'idle_timeout'",
      );
      return;
    }
    const activityAt = lastActivityAt ?? lifecycle.last_activity_at;
    if (activityAt === null) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO scheduled_tasks (kind, due_at)
       VALUES ('idle_timeout', ?)
       ON CONFLICT(kind) DO UPDATE SET due_at = excluded.due_at`,
      activityAt + ROOM_IDLE_TIMEOUT_MS,
    );
  }

  private async afterSocketClose(): Promise<void> {
    const lifecycle = this.readRoomLifecycle();
    if (lifecycle.status === "closing" || lifecycle.status === "suspended") {
      return;
    }
    if (this.ctx.getWebSockets().length === 0) {
      this.ctx.storage.sql.exec(
        "DELETE FROM scheduled_tasks WHERE kind = 'idle_timeout'",
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO scheduled_tasks (kind, due_at)
         VALUES ('empty_timeout', ?)
         ON CONFLICT(kind) DO UPDATE SET due_at = excluded.due_at`,
        Date.now() + ROOM_EMPTY_TIMEOUT_MS,
      );
    } else {
      this.ctx.storage.sql.exec(
        "DELETE FROM scheduled_tasks WHERE kind = 'empty_timeout'",
      );
      this.armIdleTask();
    }
    await this.scheduleNextAlarm();
  }

  private projectLifecycleStatus(
    status: "active" | "idle" | "closing",
    changedAt: number,
  ): void {
    const roomId = this.roomIdentity();
    if (!roomId) return;
    this.ctx.waitUntil(
      this.env.DB.prepare(
        `UPDATE rooms SET status = ?, updated_at = ?
         WHERE id = ? AND status IN ('waiting', 'active', 'idle')`,
      ).bind(status, changedAt, roomId).run().then(() => undefined).catch((error) => {
        console.error(JSON.stringify({
          level: "error",
          message: "room lifecycle projection failed",
          roomId,
          status,
          error: error instanceof Error ? error.message : String(error),
        }));
      }),
    );
  }

  private async projectRoomClosing(
    lifecycle: Extract<RoomLifecycleState, { status: "closing" }>,
  ): Promise<void> {
    const roomId = this.roomIdentity();
    if (!roomId) throw new Error("room closing projection requires metadata");
    let result: D1Result;
    try {
      result = await this.env.DB.prepare(
        `UPDATE rooms
         SET status = 'closing', updated_at = ?,
             cleanup_job_id = ?, cleanup_requested_at = ?
         WHERE id = ?
           AND status IN ('waiting', 'active', 'idle', 'suspended', 'closing')`,
      ).bind(
        lifecycle.startedAt,
        lifecycle.closeRequestId,
        lifecycle.startedAt,
        roomId,
      ).run();
    } catch (error) {
      // Isolated DO unit tests intentionally omit the D1 migration fixture.
      if (this.env.APP_ENV === "local") return;
      throw error;
    }
    if (this.env.APP_ENV !== "local" && result.meta.changes !== 1) {
      throw new Error("room closing projection was not updated");
    }
  }

  private async projectRoomSuspended(changedAt: number): Promise<void> {
    const roomId = this.roomIdentity();
    if (!roomId) throw new Error("room suspension projection requires metadata");
    try {
      const result = await this.env.DB.prepare(
        `UPDATE rooms
         SET status = 'suspended', updated_at = ?
         WHERE id = ? AND status IN ('waiting', 'active', 'idle', 'suspended')`,
      ).bind(changedAt, roomId).run();
      if (this.env.APP_ENV !== "local" && result.meta.changes !== 1) {
        throw new Error("room suspension projection was not updated");
      }
    } catch (error) {
      // Isolated DO unit tests intentionally omit the D1 migration fixture.
      if (this.env.APP_ENV === "local") return;
      throw error;
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const strokeAlarm = this.ctx.storage.sql
      .exec<{ next_alarm: number | null }>(
        `SELECT MIN(last_append_at + ?) AS next_alarm
         FROM strokes
         WHERE status = 'active'`,
        UNFINISHED_STROKE_TIMEOUT_MS,
      )
      .one().next_alarm;
    const compactionAlarm = this.readSnapshotAutomation().compaction_due_at;
    const lifecycleAlarm = this.ctx.storage.sql
      .exec<{ next_alarm: number | null }>(
        "SELECT MIN(due_at) AS next_alarm FROM scheduled_tasks",
      )
      .one().next_alarm;
    const roomTimeAlarm = this.nextRoomTimeAlarm();
    const cleanupAlarm = this.readRoomCleanup()?.next_enqueue_at ?? null;
    const candidates = [
      strokeAlarm,
      compactionAlarm,
      lifecycleAlarm,
      roomTimeAlarm,
      cleanupAlarm,
    ].filter(
      (value): value is number => value !== null,
    );
    const nextAlarm = candidates.length === 0
      ? null
      : Math.min(...candidates);
    if (nextAlarm === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now(), nextAlarm));
  }

  private async refreshRateClockIfNeeded(
    attachment: ConnectionAttachment,
  ): Promise<void> {
    const connection = this.ctx.storage.sql
      .exec<{ rate_tokens: number }>(
        "SELECT rate_tokens FROM connections WHERE connection_id = ?",
        attachment.connectionId,
      )
      .toArray()[0];
    if (
      !connection
      || connection.rate_tokens > RATE_CLOCK_REFRESH_THRESHOLD
    ) {
      return;
    }

    // Deployed Workers freeze Date.now() between I/O operations. A bounded
    // storage read refreshes the clock before token-bucket arithmetic without
    // adding an I/O operation to every WebSocket message.
    await this.ctx.storage.getAlarm();
  }

  private async refreshCursorRateClockIfNeeded(
    attachment: ConnectionAttachment,
  ): Promise<void> {
    const connection = this.ctx.storage.sql
      .exec<{ cursor_rate_tokens: number }>(
        "SELECT cursor_rate_tokens FROM connections WHERE connection_id = ?",
        attachment.connectionId,
      )
      .toArray()[0];
    if (
      !connection
      || connection.cursor_rate_tokens > CURSOR_RATE_CLOCK_REFRESH_THRESHOLD
    ) {
      return;
    }
    await this.ctx.storage.getAlarm();
  }

  private async refreshChatRateClockIfNeeded(
    attachment: ConnectionAttachment,
  ): Promise<void> {
    const connection = this.ctx.storage.sql
      .exec<{ chat_rate_tokens: number }>(
        "SELECT chat_rate_tokens FROM connections WHERE connection_id = ?",
        attachment.connectionId,
      )
      .toArray()[0];
    if (
      !connection
      || connection.chat_rate_tokens > CHAT_RATE_CLOCK_REFRESH_THRESHOLD
    ) {
      return;
    }
    await this.ctx.storage.getAlarm();
  }

  private consumeCursorRateToken(
    attachment: ConnectionAttachment,
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      const connection = this.ctx.storage.sql
        .exec<{
          actor: string;
          cursor_rate_tokens: number;
          cursor_rate_updated_at: number;
        }>(
          `SELECT actor, cursor_rate_tokens, cursor_rate_updated_at
           FROM connections
           WHERE connection_id = ?`,
          attachment.connectionId,
        )
        .toArray()[0];
      if (!connection || connection.actor !== attachment.actor) return false;
      const now = Date.now();
      const elapsedMs = Math.max(0, now - connection.cursor_rate_updated_at);
      const availableTokens = Math.min(
        PROTOCOL_LIMITS.cursorRateBurst,
        connection.cursor_rate_tokens
          + (elapsedMs * PROTOCOL_LIMITS.cursorRatePerSecond) / 1_000,
      );
      const accepted = availableTokens >= 1;
      this.ctx.storage.sql.exec(
        `UPDATE connections
         SET cursor_rate_tokens = ?, cursor_rate_updated_at = ?
         WHERE connection_id = ?`,
        accepted ? availableTokens - 1 : availableTokens,
        now,
        attachment.connectionId,
      );
      return accepted;
    });
  }

  private persistChatMessage(
    attachment: ConnectionAttachment,
    clientMessage: ClientChatMessage,
  ): ChatMessage | RejectMessage {
    return this.ctx.storage.transactionSync(() => {
      const connection = this.ctx.storage.sql
        .exec<{
          actor: string;
          role: RoomRole;
          can_chat: number;
          display_name: string | null;
          avatar_url: string | null;
          chat_rate_tokens: number;
          chat_rate_updated_at: number;
        }>(
          `SELECT actor, role, can_chat, display_name, avatar_url,
                  chat_rate_tokens, chat_rate_updated_at
           FROM connections
           WHERE connection_id = ?`,
          attachment.connectionId,
        )
        .toArray()[0];
      if (
        !connection
        || connection.actor !== attachment.actor
        || connection.role !== attachment.role
      ) {
        return reject("UNAUTHORIZED", "connection is not registered");
      }
      if (connection.can_chat !== 1) {
        return reject("ROLE_FORBIDDEN", "chat requires an authenticated user");
      }
      const duplicate = this.ctx.storage.sql
        .exec<{ seq: number }>(
          "SELECT seq FROM chat_messages WHERE message_id = ?",
          clientMessage.id,
        )
        .toArray()[0];
      if (duplicate) {
        return reject("DUPLICATE", "chat message was already accepted");
      }

      const now = Date.now();
      const elapsedMs = Math.max(0, now - connection.chat_rate_updated_at);
      const availableTokens = Math.min(
        PROTOCOL_LIMITS.chatRateBurst,
        connection.chat_rate_tokens
          + (elapsedMs * PROTOCOL_LIMITS.chatRatePerSecond) / 1_000,
      );
      if (availableTokens < 1) {
        this.ctx.storage.sql.exec(
          `UPDATE connections
           SET chat_rate_tokens = ?, chat_rate_updated_at = ?
           WHERE connection_id = ?`,
          availableTokens,
          now,
          attachment.connectionId,
        );
        return reject("RATE_LIMITED", "chat rate limit exceeded");
      }
      this.ctx.storage.sql.exec(
        `UPDATE connections
         SET chat_rate_tokens = ?, chat_rate_updated_at = ?
         WHERE connection_id = ?`,
        availableTokens - 1,
        now,
        attachment.connectionId,
      );
      this.pruneChatMessages(now);
      const row = this.ctx.storage.sql
          .exec<StoredChatMessageRow>(
            `INSERT INTO chat_messages (
             message_id, actor, role, display_name, avatar_url, text, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING seq, message_id, actor, role, display_name, avatar_url,
                     text, created_at`,
          clientMessage.id,
          attachment.actor,
          attachment.role,
          connection.display_name,
          connection.avatar_url,
          clientMessage.text,
          now,
        )
        .one();
      this.pruneChatMessages(now);
      this.incrementMetric("chat_accepted");
      return this.chatMessageFromRow(row);
    });
  }

  private readChatHistory(now: number): ChatMessage[] {
    this.pruneChatMessages(now);
    return this.ctx.storage.sql
      .exec<StoredChatMessageRow>(
        `SELECT seq, message_id, actor, role, display_name, avatar_url,
                text, created_at
         FROM chat_messages
         ORDER BY seq DESC
         LIMIT ?`,
        PROTOCOL_LIMITS.maxChatMessages,
      )
      .toArray()
      .reverse()
      .map((row) => this.chatMessageFromRow(row));
  }

  private pruneChatMessages(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM chat_messages WHERE created_at <= ?",
      now - PROTOCOL_LIMITS.chatMessageTtlMs,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM chat_messages
       WHERE seq IN (
         SELECT seq FROM chat_messages
         ORDER BY seq DESC
         LIMIT -1 OFFSET ?
       )`,
      PROTOCOL_LIMITS.maxChatMessages,
    );
  }

  private chatMessageFromRow(row: StoredChatMessageRow): ChatMessage {
    return {
      id: row.message_id,
      seq: row.seq,
      actor: row.actor,
      role: row.role,
      ...(row.display_name !== null || row.avatar_url !== null
        ? {
            displayName: row.display_name,
            avatarUrl: row.avatar_url,
          }
        : {}),
      text: row.text,
      createdAt: row.created_at,
    };
  }

  private incrementMetric(name: string, amount = 1): void {
    this.ctx.storage.sql.exec(
      "UPDATE room_metrics SET value = value + ? WHERE name = ?",
      amount,
      name,
    );
  }

  private persistEvent(
    attachment: ConnectionAttachment,
    event: ClientStrokeEvent,
  ): AcceptedStrokeEvent | RejectMessage {
    return this.ctx.storage.transactionSync(() => {
      const lifecycle = this.roomLifecycleState();
      if (lifecycle.status !== "active" && lifecycle.status !== "idle") {
        return reject("ROOM_NOT_ACTIVE", "room is closing", event.clientSeq);
      }
      const connection = this.ctx.storage.sql
        .exec<{
          actor: string;
          last_client_seq: number;
          rate_tokens: number;
          rate_updated_at: number;
        }>(
          `SELECT actor, last_client_seq, rate_tokens, rate_updated_at
           FROM connections
           WHERE connection_id = ?`,
          attachment.connectionId,
        )
        .toArray()[0];
      if (!connection || connection.actor !== attachment.actor) {
        return reject("UNAUTHORIZED", "connection is not registered", event.clientSeq);
      }

      const expectedClientSeq = connection.last_client_seq + 1;
      if (event.clientSeq < expectedClientSeq) {
        return reject("DUPLICATE", "clientSeq was already accepted", event.clientSeq);
      }
      if (event.clientSeq > expectedClientSeq) {
        return reject(
          "OUT_OF_ORDER",
          `expected clientSeq ${expectedClientSeq}`,
          event.clientSeq,
        );
      }

      const now = Date.now();
      const elapsedMs = Math.max(0, now - connection.rate_updated_at);
      const availableTokens = Math.min(
        PROTOCOL_LIMITS.eventRateBurst,
        connection.rate_tokens
          + (elapsedMs * PROTOCOL_LIMITS.eventRatePerSecond) / 1_000,
      );
      if (availableTokens < 1) {
        this.ctx.storage.sql.exec(
          `UPDATE connections
           SET rate_tokens = ?, rate_updated_at = ?
           WHERE connection_id = ?`,
          availableTokens,
          now,
          attachment.connectionId,
        );
        return reject("RATE_LIMITED", "event rate limit exceeded", event.clientSeq);
      }
      this.ctx.storage.sql.exec(
        `UPDATE connections
         SET rate_tokens = ?, rate_updated_at = ?
         WHERE connection_id = ?`,
        availableTokens - 1,
        now,
        attachment.connectionId,
      );

      const payload = toArrayBuffer(encodeRoomEvent(event));
      const activity = this.ctx.storage.sql.exec<{
        event_count: number;
        payload_bytes: number;
        activity_limit_reached_at: number | null;
      }>(`
        SELECT
          (SELECT value FROM room_metrics WHERE name = 'accepted') AS event_count,
          (SELECT value FROM room_metrics WHERE name = 'payload_bytes')
            AS payload_bytes,
          (SELECT reached_at FROM room_activity_limit WHERE singleton = 1)
            AS activity_limit_reached_at
      `).one();
      if (
        (event.op === "stroke.begin"
          && (activity.activity_limit_reached_at !== null
            || activity.event_count >= ROOM_ACTIVITY_EVENT_LIMIT
            || activity.payload_bytes >= ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES))
        || (
          event.op !== "stroke.end"
          && event.op !== "stroke.cancel"
          && (
            activity.event_count >= PROTOCOL_LIMITS.maxRoomEvents
            || activity.payload_bytes + payload.byteLength
              > PROTOCOL_LIMITS.maxRoomPayloadBytes
          )
        )
      ) {
        return reject("ROOM_LIMIT_REACHED", "room activity limit reached", event.clientSeq);
      }

      const lifecycleRejection = this.applyStrokeLifecycle(
        attachment.actor,
        event,
        now,
      );
      if (lifecycleRejection) return lifecycleRejection;

      const acceptedAt = now;
      const roomSeq = this.ctx.storage.sql
        .exec<{ room_seq: number }>(
          `INSERT INTO stroke_events (
            actor, connection_id, client_seq, stroke_id, op, payload,
            payload_bytes, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING room_seq`,
          attachment.actor,
          attachment.connectionId,
          event.clientSeq,
          event.id,
          event.op,
          payload,
          payload.byteLength,
          acceptedAt,
        )
        .one().room_seq;
      this.incrementMetric("accepted");
      this.incrementMetric("payload_bytes", payload.byteLength);
      this.ctx.storage.sql.exec(
        `UPDATE connections SET last_client_seq = ?
         WHERE connection_id = ?`,
        event.clientSeq,
        attachment.connectionId,
      );

      return {
        type: "accepted",
        roomSeq,
        actor: attachment.actor,
        connectionId: attachment.connectionId,
        acceptedAt,
        event,
      };
    });
  }

  private applyStrokeLifecycle(
    actor: string,
    event: ClientStrokeEvent,
    now: number,
  ): RejectMessage | undefined {
    if (event.op === "stroke.begin") {
      const active = this.ctx.storage.sql
        .exec<{ stroke_id: string }>(
          "SELECT stroke_id FROM strokes WHERE actor = ? AND status = 'active'",
          actor,
        )
        .toArray()[0];
      if (active) {
        return reject("OUT_OF_ORDER", "actor already has an active stroke", event.clientSeq);
      }
      const existing = this.ctx.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM strokes WHERE stroke_id = ?",
          event.id,
        )
        .toArray()[0];
      if (existing) {
        return reject("STROKE_ALREADY_FINAL", "stroke id was already used", event.clientSeq);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO strokes (
          stroke_id, actor, status, last_dt, last_append_at
        ) VALUES (?, ?, 'active', ?, ?)`,
        event.id,
        actor,
        event.point[2],
        now,
      );
      return undefined;
    }

    const stroke = this.ctx.storage.sql
      .exec<StrokeRow>(
        `SELECT actor, status, last_dt, point_count
         FROM strokes WHERE stroke_id = ?`,
        event.id,
      )
      .toArray()[0];
    if (!stroke) {
      return reject("STROKE_NOT_FOUND", "stroke.begin was not accepted", event.clientSeq);
    }
    if (stroke.actor !== actor) {
      return reject("UNAUTHORIZED", "stroke belongs to another actor", event.clientSeq);
    }
    if (stroke.status !== "active") {
      return reject("STROKE_ALREADY_FINAL", "stroke is already final", event.clientSeq);
    }

    if (event.op === "stroke.append") {
      const first = event.points[0]!;
      const last = event.points.at(-1)!;
      if (
        stroke.point_count + event.points.length
        > PROTOCOL_LIMITS.maxPointsPerStroke
      ) {
        return reject(
          "ROOM_LIMIT_REACHED",
          "stroke exceeds the point limit",
          event.clientSeq,
        );
      }
      if (first[2] < stroke.last_dt) {
        return reject("OUT_OF_ORDER", "point dt moved backwards", event.clientSeq);
      }
      this.ctx.storage.sql.exec(
        `UPDATE strokes
         SET last_dt = ?, last_append_at = ?, point_count = point_count + ?
         WHERE stroke_id = ?`,
        last[2],
        now,
        event.points.length,
        event.id,
      );
      return undefined;
    }

    this.ctx.storage.sql.exec(
      `UPDATE strokes SET status = ?, last_append_at = ?
       WHERE stroke_id = ?`,
      event.op === "stroke.end" ? "ended" : "cancelled",
      now,
      event.id,
    );
    return undefined;
  }
}
