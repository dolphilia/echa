export const ROOM_CLOSE_REASONS = [
  "host",
  "empty_timeout",
  "max_duration",
  "activity_limit",
  "admin",
  "probe",
] as const;

export type RoomCloseReason = typeof ROOM_CLOSE_REASONS[number];
export const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
export const ROOM_EMPTY_TIMEOUT_MS = 10 * 60 * 1_000;
export const ROOM_CLEANUP_JOB_VERSION = 1 as const;
export const ROOM_CLEANUP_MAX_OBJECT_KEYS = 1_000;

export type RoomLifecycleStatus =
  | "waiting"
  | "active"
  | "idle"
  | "closing"
  | "suspended";

export type RoomCloseRequest = {
  readonly closeRequestId: string;
  readonly reason: RoomCloseReason;
};

export type RoomLifecycleState =
  | {
      readonly status: "waiting";
      readonly changedAt: number;
    }
  | {
      readonly status: "active";
      readonly changedAt: number;
      readonly lastActivityAt: number | null;
    }
  | {
      readonly status: "idle";
      readonly changedAt: number;
      readonly lastActivityAt: number;
    }
  | {
      readonly status: "suspended";
      readonly changedAt: number;
    }
  | {
      readonly status: "closing";
      readonly closeRequestId: string;
      readonly reason: RoomCloseReason;
      readonly startedAt: number;
      readonly finalizedStrokeCount: number;
      readonly supersededSnapshotJobCount: number;
    };

export type RoomCloseResult = Extract<
  RoomLifecycleState,
  { readonly status: "closing" }
> & {
  readonly snapshotObjectKeys: readonly string[];
};

export type RoomClosedMessage = {
  readonly type: "room.closed";
  readonly closeRequestId: string;
  readonly reason: RoomCloseReason;
  readonly closedAt: number;
};

export type RoomCleanupJob = {
  readonly v: typeof ROOM_CLEANUP_JOB_VERSION;
  readonly jobId: string;
  readonly roomId: string;
  readonly closeRequestId: string;
  readonly requestedAt: number;
  readonly snapshotObjectKeys: readonly string[];
};

export type RoomUpdatedMessage =
  | {
      readonly type: "room.updated";
      readonly status: "waiting";
      readonly changedAt: number;
    }
  | {
      readonly type: "room.updated";
      readonly status: "active" | "idle";
      readonly changedAt: number;
      readonly lastActivityAt: number | null;
    }
  | {
      readonly type: "room.updated";
      readonly status: "suspended";
      readonly changedAt: number;
    }
  | {
      readonly type: "room.updated";
      readonly status: "closing";
      readonly closeRequestId: string;
      readonly reason: RoomCloseReason;
      readonly startedAt: number;
    };

export type SnapshotJobDisposition = "run" | "discard";

const cleanupIdentifierPattern = /^[A-Za-z0-9_-]{8,128}$/;

export function validateRoomCleanupJob(
  value: unknown,
): asserts value is RoomCleanupJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("room cleanup job must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expectedKeys = [
    "v",
    "jobId",
    "roomId",
    "closeRequestId",
    "requestedAt",
    "snapshotObjectKeys",
  ];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => !expectedKeys.includes(key))
    || record.v !== ROOM_CLEANUP_JOB_VERSION
    || typeof record.jobId !== "string"
    || !cleanupIdentifierPattern.test(record.jobId)
    || typeof record.roomId !== "string"
    || !cleanupIdentifierPattern.test(record.roomId)
    || typeof record.closeRequestId !== "string"
    || !cleanupIdentifierPattern.test(record.closeRequestId)
    || !Number.isSafeInteger(record.requestedAt)
    || (record.requestedAt as number) < 0
    || !Array.isArray(record.snapshotObjectKeys)
    || record.snapshotObjectKeys.length > ROOM_CLEANUP_MAX_OBJECT_KEYS
  ) {
    throw new TypeError("invalid room cleanup job");
  }
  const prefix = `rooms/${record.roomId}/snapshots/`;
  if (
    record.snapshotObjectKeys.some((key) => (
      typeof key !== "string"
      || !key.startsWith(prefix)
      || key.length > 1_024
    ))
    || new Set(record.snapshotObjectKeys).size
      !== record.snapshotObjectKeys.length
  ) {
    throw new TypeError("invalid room cleanup object key");
  }
}
