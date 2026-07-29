import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ClientChatMessage,
  type ClientCursorMessage,
  type ClientRealtimeMessage,
  type ClientRoomCloseMessage,
  type ClientRoomStartMessage,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === keys.length
    && actual.every((key) => keys.includes(key))
  );
}

function isCanvasCoordinate(
  value: unknown,
  maximum: number,
): value is number {
  return (
    typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= maximum
  );
}

function codePointLength(value: string): number {
  return [...value].length;
}

function parseClientCursorMessage(value: unknown): ClientCursorMessage {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION) {
    throw new TypeError("Invalid cursor message");
  }
  if (
    value.type === "cursor"
    && value.visible === false
    && hasExactKeys(value, ["v", "type", "visible"])
  ) {
    return { v: PROTOCOL_VERSION, type: "cursor", visible: false };
  }
  if (
    value.type !== "cursor"
    || value.visible !== true
    || !hasExactKeys(value, ["v", "type", "visible", "x", "y"])
    || !isCanvasCoordinate(value.x, PROTOCOL_LIMITS.canvasWidth)
    || !isCanvasCoordinate(value.y, PROTOCOL_LIMITS.canvasHeight)
  ) {
    throw new TypeError("Invalid cursor message");
  }
  return {
    v: PROTOCOL_VERSION,
    type: "cursor",
    visible: true,
    x: value.x,
    y: value.y,
  };
}

function parseClientChatMessage(value: unknown): ClientChatMessage {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["v", "type", "id", "text"])
    || value.v !== PROTOCOL_VERSION
    || value.type !== "chat.send"
    || typeof value.id !== "string"
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value.id)
    || typeof value.text !== "string"
  ) {
    throw new TypeError("Invalid chat message");
  }
  const text = value.text.trim();
  if (
    codePointLength(text) < 1
    || codePointLength(text) > PROTOCOL_LIMITS.maxChatMessageCharacters
  ) {
    throw new TypeError("Invalid chat message");
  }
  return {
    v: PROTOCOL_VERSION,
    type: "chat.send",
    id: value.id,
    text,
  };
}

function parseClientRoomStartMessage(value: unknown): ClientRoomStartMessage {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["v", "type", "requestId"])
    || value.v !== PROTOCOL_VERSION
    || value.type !== "room.start"
    || typeof value.requestId !== "string"
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)
  ) {
    throw new TypeError("Invalid room start message");
  }
  return {
    v: PROTOCOL_VERSION,
    type: "room.start",
    requestId: value.requestId,
  };
}

function parseClientRoomCloseMessage(value: unknown): ClientRoomCloseMessage {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["v", "type", "requestId"])
    || value.v !== PROTOCOL_VERSION
    || value.type !== "room.close"
    || typeof value.requestId !== "string"
    || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)
  ) {
    throw new TypeError("Invalid room close message");
  }
  return {
    v: PROTOCOL_VERSION,
    type: "room.close",
    requestId: value.requestId,
  };
}

function parseClientRealtimeMessage(value: unknown): ClientRealtimeMessage {
  if (isRecord(value) && value.type === "cursor") {
    return parseClientCursorMessage(value);
  }
  if (isRecord(value) && value.type === "chat.send") {
    return parseClientChatMessage(value);
  }
  if (isRecord(value) && value.type === "room.start") {
    return parseClientRoomStartMessage(value);
  }
  if (isRecord(value) && value.type === "room.close") {
    return parseClientRoomCloseMessage(value);
  }
  throw new TypeError("Invalid realtime message");
}

function encodeClientRealtimeMessage(message: ClientRealtimeMessage): string {
  const parsed = message.type === "cursor"
    ? parseClientCursorMessage(message)
    : message.type === "chat.send"
      ? parseClientChatMessage(message)
      : message.type === "room.start"
        ? parseClientRoomStartMessage(message)
        : parseClientRoomCloseMessage(message);
  const encoded = JSON.stringify(parsed);
  if (new TextEncoder().encode(encoded).byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
    throw new RangeError("MESSAGE_TOO_LARGE");
  }
  return encoded;
}

export function encodeClientCursorMessage(
  message: ClientCursorMessage,
): string {
  return encodeClientRealtimeMessage(message);
}

export function decodeClientCursorMessage(
  frame: string,
): ClientCursorMessage {
  const message = decodeClientRealtimeMessage(frame);
  if (message.type !== "cursor") throw new TypeError("Invalid cursor message");
  return message;
}

export function encodeClientChatMessage(message: ClientChatMessage): string {
  return encodeClientRealtimeMessage(message);
}

export function encodeClientRoomStartMessage(
  message: ClientRoomStartMessage,
): string {
  return encodeClientRealtimeMessage(message);
}

export function encodeClientRoomCloseMessage(
  message: ClientRoomCloseMessage,
): string {
  return encodeClientRealtimeMessage(message);
}

export function decodeClientRealtimeMessage(
  frame: string,
): ClientRealtimeMessage {
  if (new TextEncoder().encode(frame).byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
    throw new RangeError("MESSAGE_TOO_LARGE");
  }
  return parseClientRealtimeMessage(JSON.parse(frame) as unknown);
}
