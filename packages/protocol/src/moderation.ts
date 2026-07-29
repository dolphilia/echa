export const MODERATION_EVIDENCE_JOB_VERSION = 1 as const;
export const MODERATION_EVIDENCE_DELETE_JOB_VERSION = 1 as const;
export const ROOM_REPORT_VERSION = 1 as const;
export const ROOM_MODERATION_VERSION = 1 as const;

export const ROOM_MODERATION_ACTIONS = [
  "suspend_room",
  "close_room",
  "kick",
  "room_ban",
  "service_ban",
] as const;

export type RoomModerationAction =
  typeof ROOM_MODERATION_ACTIONS[number];

export const ROOM_MEMBER_MODERATION_ACTIONS = [
  "kick",
  "room_ban",
  "service_ban",
] as const;

export type RoomMemberModerationAction =
  typeof ROOM_MEMBER_MODERATION_ACTIONS[number];

type RoomModerationRequestBase = {
  readonly v: typeof ROOM_MODERATION_VERSION;
  readonly actionId: string;
  readonly roomId: string;
  readonly actorAdminId: string;
  readonly reason: string;
  readonly requestedAt: number;
};

export type RoomModerationRequest = RoomModerationRequestBase & (
  | {
      readonly action: "suspend_room" | "close_room";
      readonly targetActorId?: never;
    }
  | {
      readonly action: "kick" | "room_ban";
      readonly targetActorId: string;
      readonly banDurationHours?: never;
    }
  | {
      readonly action: "service_ban";
      readonly targetActorId: string;
      readonly banDurationHours: 24 | 168 | 720;
    }
);

type RoomModerationResultBase = {
  readonly status: "applied" | "already_applied";
  readonly actionId: string;
  readonly roomId: string;
};

export type RoomModerationResult = RoomModerationResultBase & (
  | {
      readonly action: "suspend_room" | "close_room";
      readonly lifecycle: import("./lifecycle").RoomLifecycleState;
    }
  | {
      readonly action: "kick";
      readonly targetActorId: string;
      readonly disconnectedConnectionCount: number;
      readonly banExpiresAt?: never;
    }
  | {
      readonly action: "room_ban";
      readonly targetActorId: string;
      readonly disconnectedConnectionCount: number;
      readonly banExpiresAt: number;
    }
  | {
      readonly action: "service_ban";
      readonly targetActorId: string;
      readonly disconnectedConnectionCount: number;
      readonly affectedRoomCount: number;
      readonly banExpiresAt: number;
    }
);

export type ActiveRoomMember = {
  readonly actorId: string;
  readonly role: import("./room-access").RoomRole;
};

export type ActiveRoomMembersRequest = {
  readonly v: typeof ROOM_MODERATION_VERSION;
  readonly roomId: string;
};

export type ActiveRoomMembersResult = {
  readonly members: readonly ActiveRoomMember[];
};

export const ROOM_REPORT_CATEGORIES = [
  "harassment",
  "sexual",
  "violence",
  "copyright",
  "other",
] as const;

export type RoomReportCategory = typeof ROOM_REPORT_CATEGORIES[number];

export type RoomReportRequest = {
  readonly v: typeof ROOM_REPORT_VERSION;
  readonly reportId: string;
  readonly evidenceId: string;
  readonly publicSlug: string;
  readonly reporterSubjectKind: "user" | "guest";
  readonly reporterSubjectId: string;
  readonly category: RoomReportCategory;
  readonly description?: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
};

export type RoomReportResult = {
  readonly status: "created" | "already_created";
  readonly reportId: string;
  readonly evidenceId: string;
  readonly evidenceStatus: "pending" | "committed";
};

export type ModerationEvidenceJob = {
  readonly v: typeof MODERATION_EVIDENCE_JOB_VERSION;
  readonly kind: "moderation.evidence";
  readonly jobId: string;
  readonly reportId: string;
  readonly evidenceId: string;
  readonly roomId: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
};

export type ModerationEvidenceDeleteJob = {
  readonly v: typeof MODERATION_EVIDENCE_DELETE_JOB_VERSION;
  readonly kind: "moderation.evidence.delete";
  readonly jobId: string;
  readonly evidenceId: string;
  readonly expiresAt: number;
};

export type ModerationEvidencePlan = {
  readonly evidenceId: string;
  readonly reportId: string;
  readonly roomId: string;
  readonly capturedAt: number;
  readonly targetRoomSeq: number;
  readonly metadata: {
    readonly name: string;
    readonly theme: string | null;
    readonly visibility: "public" | "unlisted";
    readonly createdAt: number;
    readonly maxEndsAt: number;
  };
  readonly lifecycle: import("./lifecycle").RoomLifecycleState;
  readonly chatMessages: readonly import("./types").ChatMessage[];
  readonly sourceSnapshot?: import("./snapshot").SnapshotManifest;
};

export type ModerationEvidenceEventChunk = {
  readonly events: readonly import("./types").AcceptedStrokeEvent[];
  readonly nextAfterRoomSeq: number;
  readonly done: boolean;
};

export type ModerationEvidenceRoomRpc = {
  createModerationEvidencePlan(
    job: ModerationEvidenceJob,
  ): Promise<ModerationEvidencePlan>;
  moderationEvidenceEvents(
    evidenceId: string,
    afterRoomSeq: number,
    limit?: number,
  ): Promise<ModerationEvidenceEventChunk>;
  resumeRoomCleanupAfterEvidence(
    roomId: string,
  ): Promise<"not_closing" | "enqueued">;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PUBLIC_SLUG_PATTERN = /^[a-f0-9]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRoomReportRequest(
  value: unknown,
): asserts value is RoomReportRequest {
  if (!isRecord(value)) throw new TypeError("invalid room report request");
  if (
    value.v !== ROOM_REPORT_VERSION
    || typeof value.reportId !== "string"
    || !IDENTIFIER_PATTERN.test(value.reportId)
    || typeof value.evidenceId !== "string"
    || !IDENTIFIER_PATTERN.test(value.evidenceId)
    || typeof value.publicSlug !== "string"
    || !PUBLIC_SLUG_PATTERN.test(value.publicSlug)
    || (
      value.reporterSubjectKind !== "user"
      && value.reporterSubjectKind !== "guest"
    )
    || typeof value.reporterSubjectId !== "string"
    || !IDENTIFIER_PATTERN.test(value.reporterSubjectId)
    || typeof value.category !== "string"
    || !ROOM_REPORT_CATEGORIES.includes(value.category as RoomReportCategory)
    || (
      value.description !== undefined
      && (
        typeof value.description !== "string"
        || value.description.length < 1
        || value.description.length > 1_000
      )
    )
    || !Number.isSafeInteger(value.requestedAt)
    || (value.requestedAt as number) <= 0
    || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) <= (value.requestedAt as number)
  ) {
    throw new TypeError("invalid room report request");
  }
}

export function validateRoomModerationRequest(
  value: unknown,
): asserts value is RoomModerationRequest {
  if (!isRecord(value)) throw new TypeError("invalid room moderation request");
  if (
    value.v !== ROOM_MODERATION_VERSION
    || typeof value.actionId !== "string"
    || !IDENTIFIER_PATTERN.test(value.actionId)
    || typeof value.roomId !== "string"
    || !IDENTIFIER_PATTERN.test(value.roomId)
    || typeof value.actorAdminId !== "string"
    || !IDENTIFIER_PATTERN.test(value.actorAdminId)
    || typeof value.action !== "string"
    || !ROOM_MODERATION_ACTIONS.includes(value.action as RoomModerationAction)
    || typeof value.reason !== "string"
    || value.reason.trim() !== value.reason
    || value.reason.length < 1
    || value.reason.length > 500
    || !Number.isSafeInteger(value.requestedAt)
    || (value.requestedAt as number) <= 0
    || (
      ROOM_MEMBER_MODERATION_ACTIONS.includes(
        value.action as RoomMemberModerationAction,
      )
        ? (
            typeof value.targetActorId !== "string"
            || !IDENTIFIER_PATTERN.test(value.targetActorId)
          )
        : value.targetActorId !== undefined
    )
    || (
      value.action === "service_ban"
        ? ![24, 168, 720].includes(value.banDurationHours as number)
        : value.banDurationHours !== undefined
    )
  ) {
    throw new TypeError("invalid room moderation request");
  }
}

export function validateRoomModerationResult(
  value: unknown,
): asserts value is RoomModerationResult {
  if (!isRecord(value)) throw new TypeError("invalid room moderation result");
  if (
    (value.status !== "applied" && value.status !== "already_applied")
    || typeof value.actionId !== "string"
    || !IDENTIFIER_PATTERN.test(value.actionId)
    || typeof value.roomId !== "string"
    || !IDENTIFIER_PATTERN.test(value.roomId)
    || typeof value.action !== "string"
    || !ROOM_MODERATION_ACTIONS.includes(value.action as RoomModerationAction)
  ) {
    throw new TypeError("invalid room moderation result");
  }
  if (
    value.action === "suspend_room"
    || value.action === "close_room"
  ) {
    if (
      !isRecord(value.lifecycle)
      || typeof value.lifecycle.status !== "string"
      || !["waiting", "active", "idle", "closing", "suspended"].includes(
        value.lifecycle.status,
      )
    ) {
      throw new TypeError("invalid room moderation result");
    }
    return;
  }
  if (
    typeof value.targetActorId !== "string"
    || !IDENTIFIER_PATTERN.test(value.targetActorId)
    || !Number.isSafeInteger(value.disconnectedConnectionCount)
    || (value.disconnectedConnectionCount as number) < 0
    || (
      value.action === "room_ban" || value.action === "service_ban"
        ? (
            !Number.isSafeInteger(value.banExpiresAt)
            || (value.banExpiresAt as number) <= 0
          )
        : value.banExpiresAt !== undefined
    )
    || (
      value.action === "service_ban"
        ? (
            !Number.isSafeInteger(value.affectedRoomCount)
            || (value.affectedRoomCount as number) < 0
          )
        : value.affectedRoomCount !== undefined
    )
  ) {
    throw new TypeError("invalid room moderation result");
  }
}

export function validateActiveRoomMembersRequest(
  value: unknown,
): asserts value is ActiveRoomMembersRequest {
  if (
    !isRecord(value)
    || value.v !== ROOM_MODERATION_VERSION
    || typeof value.roomId !== "string"
    || !IDENTIFIER_PATTERN.test(value.roomId)
  ) {
    throw new TypeError("invalid active room members request");
  }
}

export function validateActiveRoomMembersResult(
  value: unknown,
): asserts value is ActiveRoomMembersResult {
  if (
    !isRecord(value)
    || !Array.isArray(value.members)
    || value.members.length > 120
    || value.members.some((member) => (
      !isRecord(member)
      || typeof member.actorId !== "string"
      || !IDENTIFIER_PATTERN.test(member.actorId)
      || (
        member.role !== "host"
        && member.role !== "participant"
        && member.role !== "viewer"
      )
    ))
  ) {
    throw new TypeError("invalid active room members result");
  }
}

export function validateRoomReportResult(
  value: unknown,
): asserts value is RoomReportResult {
  if (!isRecord(value)) throw new TypeError("invalid room report result");
  if (
    (value.status !== "created" && value.status !== "already_created")
    || typeof value.reportId !== "string"
    || !IDENTIFIER_PATTERN.test(value.reportId)
    || typeof value.evidenceId !== "string"
    || !IDENTIFIER_PATTERN.test(value.evidenceId)
    || (
      value.evidenceStatus !== "pending"
      && value.evidenceStatus !== "committed"
    )
  ) {
    throw new TypeError("invalid room report result");
  }
}

export function validateModerationEvidenceJob(
  value: unknown,
): asserts value is ModerationEvidenceJob {
  if (!isRecord(value)) {
    throw new TypeError("invalid moderation evidence job");
  }
  if (
    value.v !== MODERATION_EVIDENCE_JOB_VERSION
    || value.kind !== "moderation.evidence"
    || typeof value.jobId !== "string"
    || !IDENTIFIER_PATTERN.test(value.jobId)
    || typeof value.reportId !== "string"
    || !IDENTIFIER_PATTERN.test(value.reportId)
    || typeof value.evidenceId !== "string"
    || !IDENTIFIER_PATTERN.test(value.evidenceId)
    || value.jobId !== value.evidenceId
    || typeof value.roomId !== "string"
    || !IDENTIFIER_PATTERN.test(value.roomId)
    || !Number.isSafeInteger(value.requestedAt)
    || (value.requestedAt as number) <= 0
    || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) <= (value.requestedAt as number)
  ) {
    throw new TypeError("invalid moderation evidence job");
  }
}

export function validateModerationEvidenceDeleteJob(
  value: unknown,
): asserts value is ModerationEvidenceDeleteJob {
  if (!isRecord(value)) {
    throw new TypeError("invalid moderation evidence delete job");
  }
  if (
    value.v !== MODERATION_EVIDENCE_DELETE_JOB_VERSION
    || value.kind !== "moderation.evidence.delete"
    || typeof value.jobId !== "string"
    || !IDENTIFIER_PATTERN.test(value.jobId)
    || typeof value.evidenceId !== "string"
    || !IDENTIFIER_PATTERN.test(value.evidenceId)
    || value.jobId !== value.evidenceId
    || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) <= 0
  ) {
    throw new TypeError("invalid moderation evidence delete job");
  }
}
