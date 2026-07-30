import { decode, encode } from "@msgpack/msgpack";
import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  ROOM_ACTIVITY_EVENT_LIMIT,
  ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES,
  ROOM_TIME_WARNING_MINUTES,
  type AcceptedStrokeEvent,
  type ChatHistoryMessage,
  type ChatMessage,
  type ChatMessageMessage,
  type PresenceMessage,
  type PresenceMember,
  type RemoteCursorMessage,
  type RoomActivityLevel,
  type RoomTimeWarningMinutes,
  type SnapshotOfferMessage,
  type RejectCode,
  type RoomStrokeEvent,
  type ServerMessage,
} from "./types";
import {
  ROOM_CLOSE_REASONS,
  type RoomCloseReason,
} from "./lifecycle";
import { validateClientEvent } from "./validation";
import { fromBinaryWireEvent, toBinaryWireEvent } from "./wire";

const REJECT_CODES = new Set<RejectCode>([
  "UNSUPPORTED_VERSION",
  "UNKNOWN_OPCODE",
  "UNAUTHORIZED",
  "ROLE_FORBIDDEN",
  "ROOM_NOT_ACTIVE",
  "RATE_LIMITED",
  "MESSAGE_TOO_LARGE",
  "INVALID_FIELD",
  "OUT_OF_ORDER",
  "DUPLICATE",
  "STROKE_NOT_FOUND",
  "STROKE_ALREADY_FINAL",
  "ROOM_LIMIT_REACHED",
  "SERVICE_EMERGENCY_STOP",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function parseRoomEvent(value: unknown): RoomStrokeEvent {
  const logical = fromBinaryWireEvent(value);
  const clientEvent = validateClientEvent(logical);
  if (clientEvent.success) return clientEvent.data;
  if (
    isRecord(logical)
    && hasExactKeys(logical, ["v", "op", "id", "serverGenerated"])
    && logical.v === PROTOCOL_VERSION
    && logical.op === "stroke.end"
    && typeof logical.id === "string"
    && /^[A-Za-z0-9_-]{20,128}$/.test(logical.id)
    && logical.serverGenerated === true
  ) {
    return {
      v: PROTOCOL_VERSION,
      op: "stroke.end",
      id: logical.id,
      serverGenerated: true,
    };
  }
  throw new TypeError("Invalid room event");
}

function acceptedToWire(message: AcceptedStrokeEvent): Record<string, unknown> {
  return {
    ...message,
    event: toBinaryWireEvent(message.event),
  };
}

function parseAccepted(value: unknown): AcceptedStrokeEvent {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["type", "roomSeq", "actor", "connectionId", "acceptedAt", "event"],
  )) {
    throw new TypeError("Invalid accepted message shape");
  }
  let event: RoomStrokeEvent;
  try {
    event = parseRoomEvent(value.event);
  } catch {
    throw new TypeError("Invalid accepted message");
  }
  if (
    value.type !== "accepted"
    || !isNonNegativeInteger(value.roomSeq)
    || value.roomSeq < 1
    || typeof value.actor !== "string"
    || value.actor.length < 1
    || value.actor.length > 128
    || typeof value.connectionId !== "string"
    || value.connectionId.length < 1
    || value.connectionId.length > 128
    || !isNonNegativeInteger(value.acceptedAt)
  ) {
    throw new TypeError("Invalid accepted message");
  }
  return {
    type: "accepted",
    roomSeq: value.roomSeq,
    actor: value.actor,
    connectionId: value.connectionId,
    acceptedAt: value.acceptedAt,
    event,
  };
}

function parseSnapshot(value: Record<string, unknown>): SnapshotOfferMessage {
  if (
    !hasExactKeys(value, ["type", "manifest", "readToken", "expiresAt"])
    || !isRecord(value.manifest)
    || !hasExactKeys(value.manifest, [
      "v",
      "jobId",
      "roomId",
      "baseRoomSeq",
      "protocolVersion",
      "rendererVersion",
      "canvasGeneration",
      "generation",
      "codec",
      "width",
      "height",
      "objectBytes",
      "objectHash",
      "rgbaHash",
      "createdAt",
    ])
    || value.manifest.v !== 1
    || typeof value.manifest.jobId !== "string"
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value.manifest.jobId)
    || typeof value.manifest.roomId !== "string"
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value.manifest.roomId)
    || !isNonNegativeInteger(value.manifest.baseRoomSeq)
    || value.manifest.protocolVersion !== PROTOCOL_VERSION
    || value.manifest.rendererVersion !== 1
    || value.manifest.canvasGeneration !== 2
    || !isNonNegativeInteger(value.manifest.generation)
    || value.manifest.generation < 1
    || value.manifest.codec !== "koge-rgba-deflate-v1"
    || value.manifest.width !== PROTOCOL_LIMITS.canvasWidth
    || value.manifest.height !== PROTOCOL_LIMITS.canvasHeight
    || !isNonNegativeInteger(value.manifest.objectBytes)
    || value.manifest.objectBytes < 1
    || value.manifest.objectBytes
      > PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4 + 65_536
    || typeof value.manifest.objectHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.manifest.objectHash)
    || typeof value.manifest.rgbaHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.manifest.rgbaHash)
    || !isNonNegativeInteger(value.manifest.createdAt)
    || typeof value.readToken !== "string"
    || !/^[a-f0-9]{64}$/.test(value.readToken)
    || !isNonNegativeInteger(value.expiresAt)
  ) {
    throw new TypeError("Invalid snapshot message");
  }
  return {
    type: "snapshot",
    manifest: {
      v: 1,
      jobId: value.manifest.jobId,
      roomId: value.manifest.roomId,
      baseRoomSeq: value.manifest.baseRoomSeq,
      protocolVersion: PROTOCOL_VERSION,
      rendererVersion: 1,
      canvasGeneration: 2,
      generation: value.manifest.generation,
      codec: "koge-rgba-deflate-v1",
      width: value.manifest.width,
      height: value.manifest.height,
      objectBytes: value.manifest.objectBytes,
      objectHash: value.manifest.objectHash,
      rgbaHash: value.manifest.rgbaHash,
      createdAt: value.manifest.createdAt,
    },
    readToken: value.readToken,
    expiresAt: value.expiresAt,
  };
}

function parsePresence(value: Record<string, unknown>): PresenceMessage {
  if (
    !hasExactKeys(value, ["type", "members"])
    || !Array.isArray(value.members)
    || value.members.length > PROTOCOL_LIMITS.maxRoomConnections
  ) {
    throw new TypeError("Invalid presence message");
  }
  const members = value.members.map((member): PresenceMember => {
    if (
      !isRecord(member)
      || !hasExactKeys(member, ["actor", "role"])
      || typeof member.actor !== "string"
      || member.actor.length < 1
      || member.actor.length > 128
      || (
        member.role !== "host"
        && member.role !== "participant"
        && member.role !== "viewer"
      )
    ) {
      throw new TypeError("Invalid presence message");
    }
    return { actor: member.actor, role: member.role };
  });
  return { type: "presence", members };
}

function parseRemoteCursor(
  value: Record<string, unknown>,
): RemoteCursorMessage {
  if (
    typeof value.actor !== "string"
    || value.actor.length < 1
    || value.actor.length > 128
  ) {
    throw new TypeError("Invalid cursor message");
  }
  if (
    value.visible === false
    && hasExactKeys(value, ["type", "actor", "visible"])
  ) {
    return { type: "cursor", actor: value.actor, visible: false };
  }
  if (
    value.visible !== true
    || !hasExactKeys(value, ["type", "actor", "visible", "x", "y"])
    || typeof value.x !== "number"
    || !Number.isFinite(value.x)
    || value.x < 0
    || value.x > PROTOCOL_LIMITS.canvasWidth
    || typeof value.y !== "number"
    || !Number.isFinite(value.y)
    || value.y < 0
    || value.y > PROTOCOL_LIMITS.canvasHeight
  ) {
    throw new TypeError("Invalid cursor message");
  }
  return {
    type: "cursor",
    actor: value.actor,
    visible: true,
    x: value.x,
    y: value.y,
  };
}

function parseChatMessage(value: unknown): ChatMessage {
  const oldKeys = ["id", "seq", "actor", "role", "text", "createdAt"];
  const profileKeys = [
    "id",
    "seq",
    "actor",
    "role",
    "displayName",
    "avatarUrl",
    "text",
    "createdAt",
  ];
  const hasProfile = isRecord(value) && hasExactKeys(value, profileKeys);
  if (
    !isRecord(value)
    || (!hasExactKeys(value, oldKeys) && !hasProfile)
    || typeof value.id !== "string"
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value.id)
    || !isNonNegativeInteger(value.seq)
    || value.seq < 1
    || typeof value.actor !== "string"
    || value.actor.length < 1
    || value.actor.length > 128
    || (
      value.role !== "host"
      && value.role !== "participant"
      && value.role !== "viewer"
    )
    || (
      hasProfile
      && value.displayName !== null
      && (
        typeof value.displayName !== "string"
        || value.displayName !== value.displayName.trim()
        || codePointLength(value.displayName) < 1
        || codePointLength(value.displayName)
          > PROTOCOL_LIMITS.maxChatDisplayNameCharacters
      )
    )
    || (
      hasProfile
      && value.avatarUrl !== null
      && (
        typeof value.avatarUrl !== "string"
        || value.avatarUrl.length > PROTOCOL_LIMITS.maxChatAvatarUrlCharacters
        || !value.avatarUrl.startsWith("https://")
      )
    )
    || typeof value.text !== "string"
    || codePointLength(value.text) < 1
    || codePointLength(value.text) > PROTOCOL_LIMITS.maxChatMessageCharacters
    || !isNonNegativeInteger(value.createdAt)
  ) {
    throw new TypeError("Invalid chat message");
  }
  return {
    id: value.id,
    seq: value.seq,
    actor: value.actor,
    role: value.role,
    ...(hasProfile
      ? {
          displayName: value.displayName as string | null,
          avatarUrl: value.avatarUrl as string | null,
        }
      : {}),
    text: value.text,
    createdAt: value.createdAt,
  };
}

function parseChatMessageFrame(
  value: Record<string, unknown>,
): ChatMessageMessage {
  if (!hasExactKeys(value, ["type", "message"])) {
    throw new TypeError("Invalid chat message frame");
  }
  return { type: "chat.message", message: parseChatMessage(value.message) };
}

function parseChatHistory(value: Record<string, unknown>): ChatHistoryMessage {
  if (
    !hasExactKeys(value, ["type", "messages"])
    || !Array.isArray(value.messages)
    || value.messages.length > PROTOCOL_LIMITS.maxChatMessages
  ) {
    throw new TypeError("Invalid chat history");
  }
  return {
    type: "chat.history",
    messages: value.messages.map(parseChatMessage),
  };
}

export function encodeRoomEvent(event: RoomStrokeEvent): Uint8Array {
  const encoded = encode(toBinaryWireEvent(event));
  if (encoded.byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
    throw new RangeError("MESSAGE_TOO_LARGE");
  }
  return encoded;
}

export function decodeRoomEvent(frame: Uint8Array): RoomStrokeEvent {
  if (frame.byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
    throw new RangeError("MESSAGE_TOO_LARGE");
  }
  return parseRoomEvent(decode(frame));
}

function parseServerMessage(value: unknown): ServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new TypeError("Server message must be an object with a type");
  }
  if (value.type === "accepted") return parseAccepted(value);
  if (value.type === "snapshot") return parseSnapshot(value);
  if (value.type === "presence") return parsePresence(value);
  if (value.type === "cursor") return parseRemoteCursor(value);
  if (value.type === "chat.message") return parseChatMessageFrame(value);
  if (value.type === "chat.history") return parseChatHistory(value);
  if (value.type === "room.activity") {
    if (
      !hasExactKeys(value, [
        "type",
        "level",
        "eventCount",
        "eventLimit",
        "payloadBytes",
        "payloadLimitBytes",
        "acceptingNewStrokes",
      ])
      || ![80, 90, 98, 100].includes(value.level as number)
      || !isNonNegativeInteger(value.eventCount)
      || value.eventLimit !== ROOM_ACTIVITY_EVENT_LIMIT
      || !isNonNegativeInteger(value.payloadBytes)
      || value.payloadLimitBytes !== ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES
      || typeof value.acceptingNewStrokes !== "boolean"
      || value.acceptingNewStrokes !== (value.level !== 100)
    ) {
      throw new TypeError("Invalid room.activity message");
    }
    return {
      type: "room.activity",
      level: value.level as RoomActivityLevel,
      eventCount: value.eventCount,
      eventLimit: ROOM_ACTIVITY_EVENT_LIMIT,
      payloadBytes: value.payloadBytes,
      payloadLimitBytes: ROOM_ACTIVITY_PAYLOAD_LIMIT_BYTES,
      acceptingNewStrokes: value.acceptingNewStrokes,
    };
  }
  if (value.type === "room.time") {
    if (
      !hasExactKeys(value, [
        "type",
        "warningMinutes",
        "endsAt",
        "remainingMs",
      ])
      || !ROOM_TIME_WARNING_MINUTES.includes(
        value.warningMinutes as RoomTimeWarningMinutes,
      )
      || !isNonNegativeInteger(value.endsAt)
      || !isNonNegativeInteger(value.remainingMs)
      || value.remainingMs
        > (value.warningMinutes as number) * 60 * 1_000
    ) {
      throw new TypeError("Invalid room.time message");
    }
    return {
      type: "room.time",
      warningMinutes: value.warningMinutes as RoomTimeWarningMinutes,
      endsAt: value.endsAt,
      remainingMs: value.remainingMs,
    };
  }
  if (value.type === "room.closed") {
    if (
      !hasExactKeys(
        value,
        ["type", "closeRequestId", "reason", "closedAt"],
      )
      || typeof value.closeRequestId !== "string"
      || !/^[A-Za-z0-9_-]{8,128}$/.test(value.closeRequestId)
      || typeof value.reason !== "string"
      || !ROOM_CLOSE_REASONS.includes(value.reason as RoomCloseReason)
      || !isNonNegativeInteger(value.closedAt)
    ) {
      throw new TypeError("Invalid room.closed message");
    }
    return {
      type: "room.closed",
      closeRequestId: value.closeRequestId,
      reason: value.reason as RoomCloseReason,
      closedAt: value.closedAt,
    };
  }
  if (value.type === "room.removed") {
    if (
      !hasExactKeys(value, ["type", "reason", "actionId"])
      || (
        value.reason !== "kicked"
        && value.reason !== "room_banned"
        && value.reason !== "service_banned"
      )
      || typeof value.actionId !== "string"
      || !/^[A-Za-z0-9_-]{8,128}$/.test(value.actionId)
    ) {
      throw new TypeError("Invalid room.removed message");
    }
    return {
      type: "room.removed",
      reason: value.reason,
      actionId: value.actionId,
    };
  }
  if (value.type === "room.updated") {
    if (
      value.status === "waiting"
      && hasExactKeys(value, ["type", "status", "changedAt"])
      && isNonNegativeInteger(value.changedAt)
    ) {
      return {
        type: "room.updated",
        status: "waiting",
        changedAt: value.changedAt,
      };
    }
    if (
      value.status === "suspended"
      && hasExactKeys(value, ["type", "status", "changedAt"])
      && isNonNegativeInteger(value.changedAt)
    ) {
      return {
        type: "room.updated",
        status: "suspended",
        changedAt: value.changedAt,
      };
    }
    if (
      (value.status === "active" || value.status === "idle")
      && hasExactKeys(
        value,
        ["type", "status", "changedAt", "lastActivityAt"],
      )
      && isNonNegativeInteger(value.changedAt)
      && (
        value.lastActivityAt === null
        || isNonNegativeInteger(value.lastActivityAt)
      )
    ) {
      return {
        type: "room.updated",
        status: value.status,
        changedAt: value.changedAt,
        lastActivityAt: value.lastActivityAt,
      };
    }
    if (
      !hasExactKeys(
        value,
        ["type", "status", "closeRequestId", "reason", "startedAt"],
      )
      || value.status !== "closing"
      || typeof value.closeRequestId !== "string"
      || !/^[A-Za-z0-9_-]{8,128}$/.test(value.closeRequestId)
      || typeof value.reason !== "string"
      || !ROOM_CLOSE_REASONS.includes(value.reason as RoomCloseReason)
      || !isNonNegativeInteger(value.startedAt)
    ) {
      throw new TypeError("Invalid room.updated message");
    }
    return {
      type: "room.updated",
      status: "closing",
      closeRequestId: value.closeRequestId,
      reason: value.reason as RoomCloseReason,
      startedAt: value.startedAt,
    };
  }
  if (value.type === "ready") {
    if (!hasExactKeys(value, ["type", "roomSeq"]) || !isNonNegativeInteger(value.roomSeq)) {
      throw new TypeError("Invalid ready message");
    }
    return { type: "ready", roomSeq: value.roomSeq };
  }
  if (value.type === "reject") {
    const keys = value.clientSeq === undefined
      ? ["type", "code", "message"]
      : ["type", "clientSeq", "code", "message"];
    if (
      !hasExactKeys(value, keys)
      || typeof value.code !== "string"
      || !REJECT_CODES.has(value.code as RejectCode)
      || typeof value.message !== "string"
      || value.message.length < 1
      || value.message.length > 256
      || (value.clientSeq !== undefined
        && (!Number.isSafeInteger(value.clientSeq) || (value.clientSeq as number) < 1))
    ) {
      throw new TypeError("Invalid reject message");
    }
    return {
      type: "reject",
      code: value.code as RejectCode,
      message: value.message,
      ...(value.clientSeq === undefined ? {} : { clientSeq: value.clientSeq as number }),
    };
  }
  if (value.type === "replay") {
    if (
      !hasExactKeys(value, ["type", "events"])
      || !Array.isArray(value.events)
      || value.events.length > 500
    ) {
      throw new TypeError("Invalid replay message");
    }
    return { type: "replay", events: value.events.map(parseAccepted) };
  }
  throw new TypeError("Unknown server message type");
}

export function encodeServerMessage(message: ServerMessage): Uint8Array {
  const wire = message.type === "accepted"
    ? acceptedToWire(message)
    : message.type === "replay"
      ? { ...message, events: message.events.map(acceptedToWire) }
      : message;
  const encoded = encode(wire);
  if (encoded.byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
    throw new RangeError("MESSAGE_TOO_LARGE");
  }
  return encoded;
}

export function decodeServerMessage(frame: Uint8Array): ServerMessage {
  if (frame.byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
    throw new RangeError("MESSAGE_TOO_LARGE");
  }
  const decoded = decode(frame);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new TypeError("Server message must be an object");
  }
  return parseServerMessage(decoded);
}
