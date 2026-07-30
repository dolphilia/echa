export const PROTOCOL_VERSION = 1 as const;

export const PROTOCOL_LIMITS = {
  canvasWidth: 1000,
  canvasHeight: 1000,
  appendIntervalMs: 50,
  maxPointsPerAppend: 12,
  maxPointsPerStroke: 4096,
  maxStrokeDurationMs: 120_000,
  maxFrameBytes: 65_536,
  maxRoomEvents: 100_000,
  maxRoomPayloadBytes: 64 * 1024 * 1024,
  // 20 actors × (ceil((4096 - 1) / 12) appends + 1 end) = 6,860.
  roomEventReserve: 7_000,
  // Covers the corresponding bounded append/end MessagePack frames.
  roomPayloadReserveBytes: 8 * 1024 * 1024,
  maxRoomConnections: 20,
  eventRatePerSecond: 80,
  eventRateBurst: 120,
  cursorRatePerSecond: 20,
  cursorRateBurst: 30,
  chatRatePerSecond: 2,
  chatRateBurst: 5,
  maxChatMessageCharacters: 500,
  maxChatDisplayNameCharacters: 40,
  maxChatAvatarUrlCharacters: 2_048,
  maxChatMessages: 100,
  chatMessageTtlMs: 24 * 60 * 60 * 1000,
  minBrushSize: 1,
  maxBrushSize: 60,
  minOpacity: 0.05,
  maxOpacity: 1,
} as const;

export const ROOM_ACTIVITY_EVENT_LIMIT =
  PROTOCOL_LIMITS.maxRoomEvents - PROTOCOL_LIMITS.roomEventReserve;
export const ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES =
  PROTOCOL_LIMITS.maxRoomPayloadBytes
  - PROTOCOL_LIMITS.roomPayloadReserveBytes;
export type RoomActivityLevel = 80 | 90 | 98 | 100;

export type Point = readonly [x: number, y: number, dt: number];
export type DrawingTool = "brush" | "eraser";
export type StrokeOpcode =
  | "stroke.begin"
  | "stroke.append"
  | "stroke.end"
  | "stroke.cancel";

type ClientEventBase = {
  readonly v: typeof PROTOCOL_VERSION;
  readonly clientSeq: number;
  readonly id: string;
};

export type StrokeBeginEvent = ClientEventBase & {
  readonly op: "stroke.begin";
  readonly tool: DrawingTool;
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
  readonly point: Point;
};

export type StrokeAppendEvent = ClientEventBase & {
  readonly op: "stroke.append";
  readonly points: readonly Point[];
};

export type StrokeEndEvent = ClientEventBase & {
  readonly op: "stroke.end";
};

export type StrokeCancelEvent = ClientEventBase & {
  readonly op: "stroke.cancel";
};

export type ClientStrokeEvent =
  | StrokeBeginEvent
  | StrokeAppendEvent
  | StrokeEndEvent
  | StrokeCancelEvent;

export type ClientCursorMessage =
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly type: "cursor";
      readonly visible: true;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly type: "cursor";
      readonly visible: false;
    };

export type ClientChatMessage = {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: "chat.send";
  readonly id: string;
  readonly text: string;
};

export type ClientRoomStartMessage = {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: "room.start";
  readonly requestId: string;
};

export type ClientRoomCloseMessage = {
  readonly v: typeof PROTOCOL_VERSION;
  readonly type: "room.close";
  readonly requestId: string;
};

export type ClientRealtimeMessage =
  | ClientCursorMessage
  | ClientChatMessage
  | ClientRoomStartMessage
  | ClientRoomCloseMessage;

export type AutoFinalizedStrokeEvent = {
  readonly v: typeof PROTOCOL_VERSION;
  readonly op: "stroke.end";
  readonly id: string;
  readonly serverGenerated: true;
};

export type RoomStrokeEvent = ClientStrokeEvent | AutoFinalizedStrokeEvent;

export type RejectCode =
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_OPCODE"
  | "UNAUTHORIZED"
  | "ROLE_FORBIDDEN"
  | "ROOM_NOT_ACTIVE"
  | "RATE_LIMITED"
  | "MESSAGE_TOO_LARGE"
  | "INVALID_FIELD"
  | "OUT_OF_ORDER"
  | "DUPLICATE"
  | "STROKE_NOT_FOUND"
  | "STROKE_ALREADY_FINAL"
  | "ROOM_LIMIT_REACHED"
  | "SERVICE_EMERGENCY_STOP";

export type ValidationIssue = {
  readonly code: RejectCode;
  readonly path: string;
  readonly message: string;
};

export type ValidationResult =
  | {
      readonly success: true;
      readonly data: ClientStrokeEvent;
    }
  | {
      readonly success: false;
      readonly issues: readonly ValidationIssue[];
    };

export type CodecName = "json" | "messagepack";
export type CodecCandidateName = CodecName | "cbor";

export type AcceptedStrokeEvent = {
  readonly type: "accepted";
  readonly roomSeq: number;
  readonly actor: string;
  readonly connectionId: string;
  readonly acceptedAt: number;
  readonly event: RoomStrokeEvent;
};

export type ReadyMessage = {
  readonly type: "ready";
  readonly roomSeq: number;
};

export type RejectMessage = {
  readonly type: "reject";
  readonly clientSeq?: number;
  readonly code: RejectCode;
  readonly message: string;
};

export type ReplayMessage = {
  readonly type: "replay";
  readonly events: readonly AcceptedStrokeEvent[];
};

export type SnapshotOfferMessage = {
  readonly type: "snapshot";
  readonly manifest: import("./snapshot").PublicSnapshotManifest;
  readonly readToken: string;
  readonly expiresAt: number;
};

export type PresenceMember = {
  readonly actor: string;
  readonly role: "host" | "participant" | "viewer";
};

export type PresenceMessage = {
  readonly type: "presence";
  readonly members: readonly PresenceMember[];
};

export type RemoteCursorMessage =
  | {
      readonly type: "cursor";
      readonly actor: string;
      readonly visible: true;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "cursor";
      readonly actor: string;
      readonly visible: false;
    };

export type ChatMessage = {
  readonly id: string;
  readonly seq: number;
  readonly actor: string;
  readonly role: "host" | "participant" | "viewer";
  readonly displayName?: string | null;
  readonly avatarUrl?: string | null;
  readonly text: string;
  readonly createdAt: number;
};

export type ChatMessageMessage = {
  readonly type: "chat.message";
  readonly message: ChatMessage;
};

export type ChatHistoryMessage = {
  readonly type: "chat.history";
  readonly messages: readonly ChatMessage[];
};

export type RoomActivityMessage = {
  readonly type: "room.activity";
  readonly level: RoomActivityLevel;
  readonly eventCount: number;
  readonly eventLimit: typeof ROOM_ACTIVITY_EVENT_LIMIT;
  readonly payloadBytes: number;
  readonly payloadLimitBytes: typeof ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES;
  readonly acceptingNewStrokes: boolean;
};

export const ROOM_TIME_WARNING_MINUTES = [15, 5, 1] as const;

export type RoomTimeWarningMinutes =
  typeof ROOM_TIME_WARNING_MINUTES[number];

export type RoomTimeMessage = {
  readonly type: "room.time";
  readonly warningMinutes: RoomTimeWarningMinutes;
  readonly endsAt: number;
  readonly remainingMs: number;
};

export type RoomRemovedMessage = {
  readonly type: "room.removed";
  readonly reason: "kicked" | "room_banned" | "service_banned";
  readonly actionId: string;
};

export type ServerMessage =
  | AcceptedStrokeEvent
  | ReadyMessage
  | RejectMessage
  | ReplayMessage
  | SnapshotOfferMessage
  | PresenceMessage
  | RemoteCursorMessage
  | ChatMessageMessage
  | ChatHistoryMessage
  | RoomActivityMessage
  | RoomTimeMessage
  | RoomRemovedMessage
  | import("./lifecycle").RoomUpdatedMessage
  | import("./lifecycle").RoomClosedMessage;
