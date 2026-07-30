import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decode as decodeMessagePack } from "@msgpack/msgpack";
import {
  MODERATION_EVIDENCE_DELETE_JOB_VERSION,
  MODERATION_EVIDENCE_JOB_VERSION,
  ROOM_REPORT_VERSION,
  ROOM_MODERATION_VERSION,
  ROOM_TICKET_TTL_MS,
  ROOM_TICKET_VERSION,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  ROOM_MAX_DURATION_MS,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_PROVISIONING_VERSION,
  ROOM_VIEWER_LIMIT,
  SNAPSHOT_CANVAS_GENERATION,
  ProtocolDecodeError,
  StrokeOutbox,
  decodeEvent,
  decodeClientCursorMessage,
  decodeClientRealtimeMessage,
  decodeSnapshot,
  decodeServerMessage,
  encodeEvent,
  encodeClientCursorMessage,
  encodeClientChatMessage,
  encodeClientRoomCloseMessage,
  encodeClientRoomStartMessage,
  encodeServerMessage,
  encodeSnapshot,
  rawFixtureToClientEvents,
  validateClientEvent,
  validateModerationEvidenceDeleteJob,
  validateModerationEvidenceJob,
  validateRoomReportRequest,
  validateRoomReportResult,
  validateRoomModerationRequest,
  validateRoomModerationResult,
  validateRoomProvisioningRequest,
  validateRoomTicketRegistrationRequest,
  validateRoomTicketRegistrationResult,
  type CodecName,
  type RawStrokeFixture,
} from "../src";

const fixturePath = fileURLToPath(
  new URL("../../../tools/renderer-fixtures/v1/canonical-strokes.json", import.meta.url),
);
const measuredFixturePath = fileURLToPath(
  new URL(
    "../../../tools/event-log-benchmark/fixtures/echa-raw-strokes-2026-07-26T16-06-54-108Z.json",
    import.meta.url,
  ),
);

async function loadFixture(): Promise<RawStrokeFixture> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as RawStrokeFixture;
}

describe(`protocol v${PROTOCOL_VERSION} validation and codecs`, () => {
  it("round-trips canonical renderer events through every candidate codec", async () => {
    const events = rawFixtureToClientEvents(await loadFixture());
    const codecs: CodecName[] = ["json", "messagepack"];

    for (const codec of codecs) {
      for (const event of events) {
        expect(decodeEvent(encodeEvent(event, codec), codec)).toEqual(event);
      }
    }
  });

  it("uses numeric opcodes on the binary wire without changing logical events", async () => {
    const event = rawFixtureToClientEvents(await loadFixture())[0];
    expect(event?.op).toBe("stroke.begin");
    const wire = decodeMessagePack(encodeEvent(event!, "messagepack")) as { op: unknown };
    expect(wire.op).toBe(0);
    expect(decodeEvent(encodeEvent(event!, "messagepack"), "messagepack")).toEqual(event);
  });

  it("round-trips accepted server messages with nested numeric wire opcodes", async () => {
    const event = rawFixtureToClientEvents(await loadFixture())[0]!;
    const message = {
      type: "accepted",
      roomSeq: 1,
      actor: "actor-00000000000001",
      connectionId: "connection-000000000001",
      acceptedAt: 1_000,
      event,
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("round-trips server-generated timeout finalization events", () => {
    const message = {
      type: "accepted",
      roomSeq: 2,
      actor: "actor-00000000000001",
      connectionId: "server_timeout",
      acceptedAt: 3_000,
      event: {
        v: PROTOCOL_VERSION,
        op: "stroke.end",
        id: "stroke_timeout_0000000001",
        serverGenerated: true,
      },
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("round-trips a private snapshot offer without exposing an R2 key", () => {
    const message = {
      type: "snapshot",
      manifest: {
        v: 1,
        jobId: "snapshot-job-00000001",
        roomId: "snapshot-room-0000001",
        baseRoomSeq: 120,
        protocolVersion: PROTOCOL_VERSION,
        rendererVersion: 1,
        canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
        generation: 2,
        codec: "koge-rgba-deflate-v1",
        width: PROTOCOL_LIMITS.canvasWidth,
        height: PROTOCOL_LIMITS.canvasHeight,
        objectBytes: 2_428,
        objectHash: "a".repeat(64),
        rgbaHash: "b".repeat(64),
        createdAt: 1_000,
      },
      readToken: "c".repeat(64),
      expiresAt: 61_000,
    } as const;
    const decoded = decodeServerMessage(encodeServerMessage(message));
    expect(decoded).toEqual(message);
    expect(decoded.type === "snapshot" && "objectKey" in decoded.manifest).toBe(false);
  });

  it("rejects a legacy 960 x 640 snapshot offer", () => {
    const legacy = {
      type: "snapshot",
      manifest: {
        v: 1,
        jobId: "snapshot-job-legacy-0001",
        roomId: "snapshot-room-legacy-001",
        baseRoomSeq: 120,
        protocolVersion: PROTOCOL_VERSION,
        rendererVersion: 1,
        canvasGeneration: 1,
        generation: 2,
        codec: "koge-rgba-deflate-v1",
        width: 960,
        height: 640,
        objectBytes: 2_428,
        objectHash: "a".repeat(64),
        rgbaHash: "b".repeat(64),
        createdAt: 1_000,
      },
      readToken: "c".repeat(64),
      expiresAt: 61_000,
    };
    expect(() => decodeServerMessage(
      encodeServerMessage(legacy as never),
    )).toThrow("Invalid snapshot message");
  });

  it("round-trips a room closing lifecycle message", () => {
    const message = {
      type: "room.updated",
      status: "closing",
      closeRequestId: "close-request-00000001",
      reason: "host",
      startedAt: 1_000,
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("round-trips a room closed lifecycle message", () => {
    const message = {
      type: "room.closed",
      closeRequestId: "close-request-codec-0001",
      reason: "host",
      closedAt: 1_722_000_000_000,
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("round-trips a suspended room lifecycle message", () => {
    const message = {
      type: "room.updated",
      status: "suspended",
      changedAt: 1_722_000_000_000,
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("validates idempotent room moderation requests and results", () => {
    const request = {
      v: ROOM_MODERATION_VERSION,
      actionId: "moderation-suspend-0001",
      roomId: "room-moderation-0001",
      actorAdminId: "admin-moderation-0001",
      action: "suspend_room",
      reason: "Safety review",
      requestedAt: 1_722_000_000_000,
    } as const;
    expect(() => validateRoomModerationRequest(request)).not.toThrow();
    expect(() => validateRoomModerationResult({
      status: "applied",
      actionId: request.actionId,
      roomId: request.roomId,
      action: request.action,
      lifecycle: {
        status: "suspended",
        changedAt: request.requestedAt,
      },
    })).not.toThrow();
    const kick = {
      ...request,
      actionId: "moderation-kick-0000001",
      action: "kick",
      targetActorId: "actor-target-000000001",
    } as const;
    expect(() => validateRoomModerationRequest(kick)).not.toThrow();
    expect(() => validateRoomModerationResult({
      status: "applied",
      actionId: kick.actionId,
      roomId: kick.roomId,
      action: kick.action,
      targetActorId: kick.targetActorId,
      disconnectedConnectionCount: 1,
    })).not.toThrow();
    const serviceBan = {
      ...request,
      actionId: "moderation-service-ban-01",
      action: "service_ban",
      targetActorId: "actor-target-000000001",
      banDurationHours: 168,
    } as const;
    expect(() => validateRoomModerationRequest(serviceBan)).not.toThrow();
    expect(() => validateRoomModerationResult({
      status: "applied",
      actionId: serviceBan.actionId,
      roomId: serviceBan.roomId,
      action: serviceBan.action,
      targetActorId: serviceBan.targetActorId,
      disconnectedConnectionCount: 2,
      affectedRoomCount: 2,
      banExpiresAt: request.requestedAt + 168 * 60 * 60 * 1_000,
    })).not.toThrow();
  });

  it("round-trips an administrative room removal", () => {
    const message = {
      type: "room.removed",
      reason: "room_banned",
      actionId: "moderation-ban-00000001",
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("round-trips an emergency drawing rejection", () => {
    const message = {
      type: "reject",
      code: "SERVICE_EMERGENCY_STOP",
      message: "drawing is paused by emergency control",
      clientSeq: 42,
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("round-trips a room activity warning", () => {
    const message = {
      type: "room.activity",
      level: 98,
      eventCount: 91_140,
      eventLimit: 93_000,
      payloadBytes: 50_000_000,
      payloadLimitBytes: 56 * 1024 * 1024,
      acceptingNewStrokes: true,
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("round-trips a room time warning", () => {
    const message = {
      type: "room.time",
      warningMinutes: 5,
      endsAt: 1_722_000_300_000,
      remainingMs: 299_500,
    } as const;
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  it("round-trips room start and live lifecycle messages", () => {
    const start = {
      v: PROTOCOL_VERSION,
      type: "room.start",
      requestId: "start-request-00000001",
    } as const;
    expect(decodeClientRealtimeMessage(encodeClientRoomStartMessage(start)))
      .toEqual(start);
    const close = {
      v: PROTOCOL_VERSION,
      type: "room.close",
      requestId: "close-request-00000002",
    } as const;
    expect(decodeClientRealtimeMessage(encodeClientRoomCloseMessage(close)))
      .toEqual(close);
    for (const message of [
      {
        type: "room.updated",
        status: "waiting",
        changedAt: 1_000,
      },
      {
        type: "room.updated",
        status: "active",
        changedAt: 2_000,
        lastActivityAt: 2_000,
      },
      {
        type: "room.updated",
        status: "idle",
        changedAt: 3_000,
        lastActivityAt: 2_000,
      },
    ] as const) {
      expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
    }
  });

  it("round-trips bounded cursor and presence messages", () => {
    const cursor = {
      v: PROTOCOL_VERSION,
      type: "cursor",
      visible: true,
      x: 120.5,
      y: 80.25,
    } as const;
    expect(decodeClientCursorMessage(encodeClientCursorMessage(cursor)))
      .toEqual(cursor);
    expect(decodeServerMessage(encodeServerMessage({
      type: "cursor",
      actor: "actor-00000000000001",
      visible: true,
      x: cursor.x,
      y: cursor.y,
    }))).toEqual({
      type: "cursor",
      actor: "actor-00000000000001",
      visible: true,
      x: cursor.x,
      y: cursor.y,
    });
    expect(decodeServerMessage(encodeServerMessage({
      type: "presence",
      members: [
        { actor: "actor-00000000000001", role: "participant" },
        { actor: "actor-00000000000002", role: "viewer" },
      ],
    }))).toEqual({
      type: "presence",
      members: [
        { actor: "actor-00000000000001", role: "participant" },
        { actor: "actor-00000000000002", role: "viewer" },
      ],
    });
  });

  it("rejects cursor coordinates outside the canvas", () => {
    expect(() => encodeClientCursorMessage({
      v: PROTOCOL_VERSION,
      type: "cursor",
      visible: true,
      x: PROTOCOL_LIMITS.canvasWidth + 1,
      y: 0,
    })).toThrow("Invalid cursor message");
  });

  it("round-trips bounded chat messages and history", () => {
    const outbound = {
      v: PROTOCOL_VERSION,
      type: "chat.send",
      id: "chat-message-00000001",
      text: "  こんにちは  ",
    } as const;
    expect(decodeClientRealtimeMessage(encodeClientChatMessage(outbound)))
      .toEqual({ ...outbound, text: "こんにちは" });

    const message = {
      id: outbound.id,
      seq: 1,
      actor: "actor-00000000000001",
      role: "participant",
      displayName: "こげ",
      avatarUrl: "https://example.test/avatar.png",
      text: "こんにちは",
      createdAt: 1_000,
    } as const;
    expect(decodeServerMessage(encodeServerMessage({
      type: "chat.message",
      message,
    }))).toEqual({ type: "chat.message", message });
    expect(decodeServerMessage(encodeServerMessage({
      type: "chat.history",
      messages: [message],
    }))).toEqual({ type: "chat.history", messages: [message] });
  });

  it("rejects empty and overlong chat messages", () => {
    expect(() => encodeClientChatMessage({
      v: PROTOCOL_VERSION,
      type: "chat.send",
      id: "chat-message-00000002",
      text: "   ",
    })).toThrow("Invalid chat message");
    expect(() => encodeClientChatMessage({
      v: PROTOCOL_VERSION,
      type: "chat.send",
      id: "chat-message-00000003",
      text: "a".repeat(PROTOCOL_LIMITS.maxChatMessageCharacters + 1),
    })).toThrow("Invalid chat message");
  });

  it("encodes and decodes the shared lossless snapshot container", async () => {
    const rgba = new Uint8Array([
      255, 255, 255, 255,
      10, 20, 30, 255,
    ]);
    const encoded = await encodeSnapshot(rgba, 2, 1, 1);
    const decoded = await decodeSnapshot(encoded);
    expect(decoded).toEqual({
      rendererVersion: 1,
      width: 2,
      height: 1,
      rgba,
    });
  });

  it("reconstructs the measured dt fixture as exactly 4112 events", async () => {
    const fixture = JSON.parse(
      await readFile(measuredFixturePath, "utf8"),
    ) as RawStrokeFixture;
    expect(rawFixtureToClientEvents({
      ...fixture,
      canvas: {
        width: PROTOCOL_LIMITS.canvasWidth,
        height: PROTOCOL_LIMITS.canvasHeight,
      },
    })).toHaveLength(4_112);
  });

  it("rejects unknown fields and untrusted server fields", () => {
    const result = validateClientEvent({
      v: PROTOCOL_VERSION,
      op: "stroke.end",
      clientSeq: 1,
      id: "fixture-stroke-000000",
      actor: "forged",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual({
        code: "INVALID_FIELD",
        path: "actor",
        message: "unknown field",
      });
    }
  });

  it("rejects append batches over the point limit", () => {
    const result = validateClientEvent({
      v: PROTOCOL_VERSION,
      op: "stroke.append",
      clientSeq: 2,
      id: "fixture-stroke-000000",
      points: Array.from(
        { length: PROTOCOL_LIMITS.maxPointsPerAppend + 1 },
        (_, index) => [index, index, index],
      ),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a frame before decoding when it exceeds 64 KiB", () => {
    expect(() => decodeEvent(
      new Uint8Array(PROTOCOL_LIMITS.maxFrameBytes + 1),
      "messagepack",
    )).toThrow("MESSAGE_TOO_LARGE");
  });

  it("reports invalid encoded data as a protocol error", () => {
    expect(() => decodeEvent(new Uint8Array([0xc1]), "messagepack"))
      .toThrow(ProtocolDecodeError);
  });
});

describe("stroke outbox", () => {
  it("batches by 50ms and retains unacknowledged events in sequence", () => {
    const outbox = new StrokeOutbox(() => "outbox-stroke-000001");
    const begin = outbox.begin({
      tool: "brush",
      color: "#151515",
      size: 8,
      opacity: 0.35,
    }, 10, 20, 1_000);

    expect(outbox.append(11, 21, 1_020)).toBeUndefined();
    const append = outbox.append(12, 22, 1_050);
    expect(append?.points).toEqual([[11, 21, 20], [12, 22, 50]]);
    const ending = outbox.end(1_060);

    expect([begin, append, ...ending].map((event) => event?.clientSeq))
      .toEqual([1, 2, 3]);
    expect(outbox.eventsToSend().map((event) => event.clientSeq)).toEqual([1, 2, 3]);
    outbox.markSent(1);
    expect(outbox.eventsToSend().map((event) => event.clientSeq)).toEqual([2, 3]);
    expect(outbox.eventsToRetry().map((event) => event.clientSeq)).toEqual([1, 2, 3]);
    outbox.acknowledge(2);
    expect(outbox.lastAcknowledgedClientSeq).toBe(2);
    expect(outbox.eventsToRetry().map((event) => event.clientSeq)).toEqual([3]);
  });

  it("flushes all pending points before ending", () => {
    const outbox = new StrokeOutbox(() => "outbox-stroke-000002");
    outbox.begin({
      tool: "eraser",
      color: "#ffffff",
      size: 14,
      opacity: 1,
    }, 50, 50, 0);
    outbox.append(60, 60, 10);
    const events = outbox.end(20);
    expect(events.map((event) => event.op)).toEqual(["stroke.append", "stroke.end"]);
  });
});

describe("room provisioning contract", () => {
  it("accepts the fixed MVP room limits and rejects metadata drift", () => {
    const createdAt = 1_785_200_000_000;
    const request = {
      v: ROOM_PROVISIONING_VERSION,
      roomId: "room-provisioning-contract",
      publicSlug: "abcdef0123456789abcdef0123456789",
      ownerUserId: "owner-provisioning-contract",
      name: "共同お絵描き",
      visibility: "public",
      participantLimit: ROOM_PARTICIPANT_LIMIT,
      viewerLimit: ROOM_VIEWER_LIMIT,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + ROOM_MAX_DURATION_MS,
    } as const;

    expect(() => validateRoomProvisioningRequest(request)).not.toThrow();
    expect(() => validateRoomProvisioningRequest({
      ...request,
      maxEndsAt: request.maxEndsAt + 1,
    })).toThrow("invalid room provisioning request");
  });
});

describe("room ticket contract", () => {
  it("accepts a 60 second single-use ticket registration", () => {
    const issuedAt = 1_785_200_000_000;
    const request = {
      v: ROOM_TICKET_VERSION,
      roomId: "room-ticket-contract",
      actorId: "actor_ticket_contract",
      connectionId: "connection_ticket_contract",
      role: "viewer",
      canChat: true,
      displayName: "閲覧ユーザー",
      avatarUrl: "https://example.test/avatar.png",
      sessionBindingHash: "a".repeat(64),
      issuedAt,
      expiresAt: issuedAt + ROOM_TICKET_TTL_MS,
    } as const;
    expect(() => validateRoomTicketRegistrationRequest(request)).not.toThrow();
    expect(() => validateRoomTicketRegistrationRequest({
      ...request,
      expiresAt: request.expiresAt + 1,
    })).toThrow("invalid room ticket registration request");
    expect(() => validateRoomTicketRegistrationResult({
      ticket: "b".repeat(64),
      actorId: request.actorId,
      connectionId: request.connectionId,
      role: request.role,
      expiresAt: request.expiresAt,
    })).not.toThrow();
  });
});

describe("moderation report contract", () => {
  it("validates report intake, result, and evidence Queue jobs", () => {
    const requestedAt = 1_785_300_000_000;
    const request = {
      v: ROOM_REPORT_VERSION,
      reportId: "report_contract_0001",
      evidenceId: "evidence_contract_0001",
      publicSlug: "abcdef0123456789abcdef0123456789",
      reporterSubjectKind: "guest",
      reporterSubjectId: "guest_contract_0001",
      category: "harassment",
      description: "contract fixture",
      requestedAt,
      expiresAt: requestedAt + 30 * 24 * 60 * 60 * 1_000,
    } as const;
    expect(() => validateRoomReportRequest(request)).not.toThrow();
    expect(() => validateRoomReportRequest({
      ...request,
      description: "x".repeat(1_001),
    })).toThrow("invalid room report request");
    expect(() => validateRoomReportResult({
      status: "created",
      reportId: request.reportId,
      evidenceId: request.evidenceId,
      evidenceStatus: "pending",
    })).not.toThrow();

    const job = {
      v: MODERATION_EVIDENCE_JOB_VERSION,
      kind: "moderation.evidence",
      jobId: request.evidenceId,
      reportId: request.reportId,
      evidenceId: request.evidenceId,
      roomId: "room_contract_0001",
      requestedAt,
      expiresAt: request.expiresAt,
    } as const;
    expect(() => validateModerationEvidenceJob(job)).not.toThrow();
    expect(() => validateModerationEvidenceJob({
      ...job,
      jobId: "evidence_contract_other",
    })).toThrow("invalid moderation evidence job");

    const deleteJob = {
      v: MODERATION_EVIDENCE_DELETE_JOB_VERSION,
      kind: "moderation.evidence.delete",
      jobId: request.evidenceId,
      evidenceId: request.evidenceId,
      expiresAt: request.expiresAt,
    } as const;
    expect(() => validateModerationEvidenceDeleteJob(deleteJob)).not.toThrow();
    expect(() => validateModerationEvidenceDeleteJob({
      ...deleteJob,
      jobId: "delete_wrong_evidence",
    })).toThrow("invalid moderation evidence delete job");
  });
});
