import {
  PROTOCOL_LIMITS,
  ROOM_ACTIVITY_EVENT_LIMIT,
  SNAPSHOT_CODEC,
  SNAPSHOT_CANVAS_GENERATION,
  SNAPSHOT_JOB_VERSION,
  SNAPSHOT_RENDERER_VERSION,
  decodeServerMessage,
  encodeClientChatMessage,
  encodeClientRoomCloseMessage,
  encodeClientCursorMessage,
  encodeClientRoomStartMessage,
  encodeEvent,
  encodeRoomEvent,
  type ClientStrokeEvent,
  type ServerMessage,
  type SnapshotJob,
  type SnapshotManifest,
} from "@koge/protocol";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

const ROOM_ID = "room-phase2-test";
const ACTOR_ID = "actor-phase2-test";

type SocketInbox = {
  messages: ServerMessage[];
  waiters: Array<{
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
  }>;
  decoding: Promise<void>;
};

const socketInboxes = new WeakMap<WebSocket, SocketInbox>();

function attachInbox(socket: WebSocket): void {
  const inbox: SocketInbox = {
    messages: [],
    waiters: [],
    decoding: Promise.resolve(),
  };
  socketInboxes.set(socket, inbox);
  socket.addEventListener("message", (event) => {
    inbox.decoding = inbox.decoding.then(async () => {
      const bytes = event.data instanceof Blob
        ? new Uint8Array(await event.data.arrayBuffer())
        : event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : ArrayBuffer.isView(event.data)
            ? new Uint8Array(
                event.data.buffer,
                event.data.byteOffset,
                event.data.byteLength,
              )
            : undefined;
      if (!bytes) throw new TypeError("expected a binary WebSocket frame");
      const message = decodeServerMessage(bytes);
      const waiter = inbox.waiters.shift();
      if (waiter) waiter.resolve(message);
      else inbox.messages.push(message);
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of inbox.waiters.splice(0)) waiter.reject(failure);
    });
  });
  socket.addEventListener("error", () => {
    const failure = new Error("WebSocket emitted an error");
    for (const waiter of inbox.waiters.splice(0)) waiter.reject(failure);
  });
}

function nextRawMessage(socket: WebSocket): Promise<ServerMessage> {
  const inbox = socketInboxes.get(socket);
  if (!inbox) return Promise.reject(new Error("WebSocket inbox is not attached"));
  const message = inbox.messages.shift();
  if (message) return Promise.resolve(message);
  return new Promise((resolve, reject) => {
    inbox.waiters.push({ resolve, reject });
  });
}

async function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  while (true) {
    // Ephemeral frames do not change the ordered drawing/recovery stream.
    // oxlint-disable-next-line no-await-in-loop
    const message = await nextRawMessage(socket);
    if (message.type !== "presence" && message.type !== "cursor") {
      return message;
    }
  }
}

async function nextEphemeral(
  socket: WebSocket,
  type: "presence" | "cursor",
): Promise<ServerMessage> {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop
    const message = await nextRawMessage(socket);
    if (message.type === type) return message;
  }
}

async function nextMessageOfType<T extends ServerMessage["type"]>(
  socket: WebSocket,
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- scans an ordered socket inbox.
    const message = await nextRawMessage(socket);
    if (message.type === type) {
      return message as Extract<ServerMessage, { type: T }>;
    }
  }
}

async function connect(
  connectionId: string,
  lastRoomSeq = 0,
  roomId = ROOM_ID,
  snapshotRecovery = false,
  excludedSnapshotJobs: readonly string[] = [],
): Promise<WebSocket> {
  const response = await connectionResponse(
    connectionId,
    lastRoomSeq,
    roomId,
    snapshotRecovery,
    excludedSnapshotJobs,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  attachInbox(socket!);
  socket!.accept();
  return socket!;
}

function connectionResponse(
  connectionId: string,
  lastRoomSeq = 0,
  roomId = ROOM_ID,
  snapshotRecovery = false,
  excludedSnapshotJobs: readonly string[] = [],
): Promise<Response> {
  const url = new URL(`http://example.test/rooms/${roomId}/connect`);
  url.searchParams.set("actor", ACTOR_ID);
  url.searchParams.set("connection", connectionId);
  url.searchParams.set("lastRoomSeq", String(lastRoomSeq));
  url.searchParams.set("rendererVersion", snapshotRecovery ? "1" : "0");
  url.searchParams.set("canvasGeneration", String(SNAPSHOT_CANVAS_GENERATION));
  url.searchParams.set("snapshot", snapshotRecovery ? "1" : "0");
  if (excludedSnapshotJobs.length > 0) {
    url.searchParams.set(
      "snapshotExcludeJobs",
      excludedSnapshotJobs.join(","),
    );
  }
  return exports.default.fetch(
    url,
    {
      headers: {
        Origin: "http://localhost:3000",
        Upgrade: "websocket",
      },
    },
  );
}

function send(socket: WebSocket, event: ClientStrokeEvent): Promise<ServerMessage> {
  const response = nextMessage(socket);
  socket.send(encodeEvent(event, "messagepack"));
  return response;
}

async function startInitializedRoom(roomId: string): Promise<WebSocket> {
  const response = await env.DRAWING_ROOM.getByName(roomId).fetch(new Request(
    "http://internal.test/connect",
    {
      headers: {
        Upgrade: "websocket",
        "x-koge-room-id": roomId,
        "x-koge-actor": `actor-host-${roomId}`,
        "x-koge-connection": `connection-host-${roomId}`,
        "x-koge-role": "host",
      },
    },
  ));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  attachInbox(socket);
  socket.accept();
  await expect(nextMessage(socket)).resolves.toMatchObject({
    type: "room.updated",
    status: "waiting",
  });
  await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });
  const started = nextMessageOfType(socket, "room.updated");
  socket.send(encodeClientRoomStartMessage({
    v: 1,
    type: "room.start",
    requestId: `start-${roomId}`,
  }));
  await expect(started).resolves.toMatchObject({
    status: "active",
  });
  return socket;
}

describe("phase 2 room synchronization", () => {
  it("rejects non-WebSocket and cross-origin connection attempts", async () => {
    const plain = await exports.default.fetch(
      `http://example.test/rooms/${ROOM_ID}/connect`,
    );
    expect(plain.status).toBe(426);

    const crossOrigin = await exports.default.fetch(
      `http://example.test/rooms/${ROOM_ID}/connect`
        + `?actor=${ACTOR_ID}&connection=connection-origin-test`,
      { headers: { Origin: "https://attacker.example", Upgrade: "websocket" } },
    );
    expect(crossOrigin.status).toBe(403);

    const missingCanvasGeneration = await exports.default.fetch(
      `http://example.test/rooms/${ROOM_ID}/connect`
        + `?actor=${ACTOR_ID}&connection=connection-canvas-missing`,
      {
        headers: {
          Origin: "http://localhost:3000",
          Upgrade: "websocket",
        },
      },
    );
    expect(missingCanvasGeneration.status).toBe(400);

    const staleCanvasGeneration = await exports.default.fetch(
      `http://example.test/rooms/${ROOM_ID}/connect`
        + `?actor=${ACTOR_ID}&connection=connection-canvas-stale`
        + `&canvasGeneration=${SNAPSHOT_CANVAS_GENERATION - 1}`,
      {
        headers: {
          Origin: "http://localhost:3000",
          Upgrade: "websocket",
        },
      },
    );
    expect(staleCanvasGeneration.status).toBe(400);
  });

  it("allows a viewer to recover room state but rejects drawing frames", async () => {
    const roomId = "room-phase5-viewer-role";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const response = await room.fetch(new Request(
      "http://internal.test/connect",
      {
        headers: {
          Upgrade: "websocket",
          "x-koge-room-id": roomId,
          "x-koge-actor": "actor-phase5-viewer",
          "x-koge-connection": "connection-phase5-viewer",
          "x-koge-role": "viewer",
        },
      },
    ));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    attachInbox(socket!);
    socket!.accept();
    await expect(nextMessage(socket!)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    await expect(send(socket!, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_phase5_viewer_000001",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({
      type: "reject",
      code: "ROLE_FORBIDDEN",
    });
    await expect(room.stats()).resolves.toMatchObject({
      eventCount: 0,
      rejectCount: 1,
    });
    socket!.close(1000, "test complete");
  });

  it("broadcasts non-persistent presence and rate-limited cursors", async () => {
    const roomId = "room-phase5-presence-cursor";
    const first = await connect(
      "connection-presence-first",
      0,
      roomId,
    );
    await expect(nextMessage(first)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    await expect(nextEphemeral(first, "presence")).resolves.toMatchObject({
      type: "presence",
      members: [{ actor: ACTOR_ID, role: "participant" }],
    });

    const secondResponse = await env.DRAWING_ROOM.getByName(roomId).fetch(
      new Request("http://internal.test/connect", {
        headers: {
          Upgrade: "websocket",
          "x-koge-room-id": roomId,
          "x-koge-actor": "actor-presence-viewer",
          "x-koge-connection": "connection-presence-second",
          "x-koge-role": "viewer",
        },
      }),
    );
    expect(secondResponse.status).toBe(101);
    const second = secondResponse.webSocket!;
    attachInbox(second);
    second.accept();
    await expect(nextMessage(second)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    await expect(nextEphemeral(first, "presence")).resolves.toMatchObject({
      type: "presence",
      members: [
        { actor: ACTOR_ID, role: "participant" },
        { actor: "actor-presence-viewer", role: "viewer" },
      ],
    });
    await expect(nextEphemeral(second, "presence")).resolves.toMatchObject({
      type: "presence",
      members: [
        { actor: ACTOR_ID, role: "participant" },
        { actor: "actor-presence-viewer", role: "viewer" },
      ],
    });

    const viewerCursor = nextEphemeral(first, "cursor");
    second.send(encodeClientCursorMessage({
      v: 1,
      type: "cursor",
      visible: true,
      x: 120,
      y: 240,
    }));
    await expect(viewerCursor).resolves.toEqual({
      type: "cursor",
      actor: "actor-presence-viewer",
      visible: true,
      x: 120,
      y: 240,
    });

    const participantCursor = nextEphemeral(second, "cursor");
    first.send(encodeClientCursorMessage({
      v: 1,
      type: "cursor",
      visible: true,
      x: 10,
      y: 20,
    }));
    await participantCursor;
    for (let index = 0; index < 40; index += 1) {
      first.send(encodeClientCursorMessage({
        v: 1,
        type: "cursor",
        visible: true,
        x: index,
        y: index,
      }));
    }
    for (let index = 0; index < PROTOCOL_LIMITS.cursorRateBurst - 1; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- verifies the burst boundary.
      await nextEphemeral(second, "cursor");
    }
    await vi.waitFor(async () => {
      const cursorDrops = await runInDurableObject(
        env.DRAWING_ROOM.getByName(roomId),
        (_instance, state) => state.storage.sql
          .exec<{ value: number }>(
            "SELECT value FROM room_metrics WHERE name = 'cursor_dropped'",
          )
          .one().value,
      );
      expect(cursorDrops).toBeGreaterThan(0);
    });

    const viewerLeft = nextEphemeral(first, "presence");
    second.close(1000, "test complete");
    await expect(viewerLeft).resolves.toMatchObject({
      type: "presence",
      members: [{ actor: ACTOR_ID, role: "participant" }],
    });
    first.close(1000, "test complete");
  });

  it("persists bounded chat separately and enforces viewer permission and rate", async () => {
    const roomId = "room-phase5-chat-policy";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "1".repeat(32),
      ownerUserId: "owner-phase5-chat-policy",
      name: "Chat policy",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const participant = await connect(
      "connection-chat-participant",
      0,
      roomId,
    );
    await expect(nextMessage(participant)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(participant)).resolves.toMatchObject({ type: "ready" });
    const viewerResponse = await room.fetch(new Request(
      "http://internal.test/connect",
      {
        headers: {
          Upgrade: "websocket",
          "x-koge-room-id": roomId,
          "x-koge-actor": "actor-phase5-chat-viewer",
          "x-koge-connection": "connection-chat-viewer",
          "x-koge-role": "viewer",
        },
      },
    ));
    const viewer = viewerResponse.webSocket!;
    attachInbox(viewer);
    viewer.accept();
    await expect(nextMessage(viewer)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(viewer)).resolves.toMatchObject({ type: "ready" });
    const host = await startInitializedRoom(roomId);

    const participantChat = nextMessageOfType(participant, "chat.message");
    const viewerChat = nextMessageOfType(viewer, "chat.message");
    participant.send(encodeClientChatMessage({
      v: 1,
      type: "chat.send",
      id: "chat-message-policy-0001",
      text: "  hello room  ",
    }));
    await expect(participantChat).resolves.toMatchObject({
      type: "chat.message",
      message: {
        id: "chat-message-policy-0001",
        actor: ACTOR_ID,
        role: "participant",
        text: "hello room",
      },
    });
    await expect(viewerChat).resolves.toMatchObject({
      type: "chat.message",
      message: { text: "hello room" },
    });

    const forbidden = nextMessageOfType(viewer, "reject");
    viewer.send(encodeClientChatMessage({
      v: 1,
      type: "chat.send",
      id: "chat-message-policy-0002",
      text: "viewer blocked",
    }));
    await expect(forbidden).resolves.toMatchObject({
      code: "ROLE_FORBIDDEN",
    });

    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE connections
         SET chat_rate_tokens = 0, chat_rate_updated_at = ?
         WHERE connection_id = ?`,
        Date.now(),
        "connection-chat-participant",
      );
    });
    const limited = nextMessageOfType(participant, "reject");
    participant.send(encodeClientChatMessage({
      v: 1,
      type: "chat.send",
      id: "chat-message-policy-0003",
      text: "too fast",
    }));
    await expect(limited).resolves.toMatchObject({
      code: "RATE_LIMITED",
    });

    participant.close(1000, "reconnect for history");
    const recovered = await connect(
      "connection-chat-recovered",
      0,
      roomId,
    );
    await expect(nextMessageOfType(recovered, "chat.history")).resolves
      .toMatchObject({
        messages: [{ id: "chat-message-policy-0001", text: "hello room" }],
      });
    await expect(nextMessage(recovered)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    viewer.close(1000, "test complete");
    recovered.close(1000, "test complete");
    host.close(1000, "test complete");
  });

  it("allows chat-enabled viewers and preserves their profile", async () => {
    const roomId = "room-phase5-viewer-chat-enabled";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "2".repeat(32),
      ownerUserId: "owner-viewer-chat-enabled",
      name: "Viewer chat",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: true,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const response = await room.fetch(new Request(
      "http://internal.test/connect",
      {
        headers: {
          Upgrade: "websocket",
          "x-koge-room-id": roomId,
          "x-koge-actor": "actor-viewer-chat-enabled",
          "x-koge-connection": "connection-viewer-chat-enabled",
          "x-koge-role": "viewer",
          "x-koge-can-chat": "1",
          "x-koge-display-name": "Viewer profile",
          "x-koge-avatar-url": "https://example.test/viewer.png",
        },
      },
    ));
    const viewer = response.webSocket!;
    attachInbox(viewer);
    viewer.accept();
    await expect(nextMessage(viewer)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(viewer)).resolves.toMatchObject({ type: "ready" });
    const host = await startInitializedRoom(roomId);
    const accepted = nextMessageOfType(viewer, "chat.message");
    viewer.send(encodeClientChatMessage({
      v: 1,
      type: "chat.send",
      id: "chat-message-viewer-0001",
      text: "viewer allowed",
    }));
    await expect(accepted).resolves.toMatchObject({
      message: {
        role: "viewer",
        displayName: "Viewer profile",
        avatarUrl: "https://example.test/viewer.png",
        text: "viewer allowed",
      },
    });
    viewer.close(1000, "test complete");
    host.close(1000, "test complete");
  });

  it("requires host start and moves active rooms through idle and back", async () => {
    const roomId = "room-phase6-lifecycle";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "3".repeat(32),
      ownerUserId: "owner-phase6-lifecycle",
      name: "Lifecycle",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const participant = await connect(
      "connection-lifecycle-participant",
      0,
      roomId,
    );
    await expect(nextMessage(participant)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(participant)).resolves.toMatchObject({ type: "ready" });

    const forbiddenStart = nextMessageOfType(participant, "reject");
    participant.send(encodeClientRoomStartMessage({
      v: 1,
      type: "room.start",
      requestId: "start-lifecycle-forbidden",
    }));
    await expect(forbiddenStart).resolves.toMatchObject({
      code: "ROLE_FORBIDDEN",
    });
    await expect(send(participant, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_lifecycle_waiting_001",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({
      code: "ROOM_NOT_ACTIVE",
    });

    const host = await startInitializedRoom(roomId);
    await expect(nextMessageOfType(participant, "room.updated")).resolves
      .toMatchObject({ status: "active" });
    await runInDurableObject(room, (_instance, state) => {
      const dueAt = Date.now() - 1;
      state.storage.sql.exec(
        `UPDATE room_lifecycle
         SET last_activity_at = ?
         WHERE singleton = 1`,
        dueAt - 30 * 60 * 1_000,
      );
      state.storage.sql.exec(
        `UPDATE scheduled_tasks SET due_at = ?
         WHERE kind = 'idle_timeout'`,
        dueAt,
      );
    });
    const idle = nextMessageOfType(participant, "room.updated");
    await runDurableObjectAlarm(room);
    await expect(idle).resolves.toMatchObject({ status: "idle" });

    const cursor = nextEphemeral(host, "cursor");
    participant.send(encodeClientCursorMessage({
      v: 1,
      type: "cursor",
      visible: true,
      x: 40,
      y: 50,
    }));
    await cursor;
    await expect(room.roomLifecycleState()).resolves.toMatchObject({
      status: "idle",
    });

    const active = nextMessageOfType(participant, "room.updated");
    participant.send(encodeClientChatMessage({
      v: 1,
      type: "chat.send",
      id: "chat-lifecycle-resume-001",
      text: "resume",
    }));
    await expect(active).resolves.toMatchObject({ status: "active" });
    await expect(room.roomLifecycleState()).resolves.toMatchObject({
      status: "active",
    });
    participant.close(1000, "test complete");
    host.close(1000, "test complete");
  });

  it("cancels and rearms the empty-room grace period before closing", async () => {
    const roomId = "room-phase6-empty-timeout";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "4".repeat(32),
      ownerUserId: "owner-phase6-empty-timeout",
      name: "Empty timeout",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const first = await connect("connection-empty-first", 0, roomId);
    await expect(nextMessage(first)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(first)).resolves.toMatchObject({ type: "ready" });
    first.close(1000, "start empty grace");
    await vi.waitFor(async () => {
      const task = await runInDurableObject(room, (_instance, state) =>
        state.storage.sql
          .exec<{ due_at: number }>(
            "SELECT due_at FROM scheduled_tasks WHERE kind = 'empty_timeout'",
          )
          .toArray()[0]
      );
      expect(task?.due_at).toBeGreaterThan(Date.now());
    });

    const resumed = await connect("connection-empty-resumed", 0, roomId);
    await expect(nextMessage(resumed)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(resumed)).resolves.toMatchObject({ type: "ready" });
    await expect(runInDurableObject(room, (_instance, state) =>
      state.storage.sql
        .exec("SELECT due_at FROM scheduled_tasks WHERE kind = 'empty_timeout'")
        .toArray()
    )).resolves.toHaveLength(0);

    resumed.close(1000, "rearm empty grace");
    await vi.waitFor(async () => {
      const count = await runInDurableObject(room, (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM scheduled_tasks WHERE kind = 'empty_timeout'",
          )
          .one().count
      );
      expect(count).toBe(1);
    });
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE scheduled_tasks SET due_at = ?
         WHERE kind = 'empty_timeout'`,
        Date.now() - 1,
      );
    });
    await runDurableObjectAlarm(room);
    await expect(room.roomLifecycleState()).resolves.toMatchObject({
      status: "closing",
      reason: "empty_timeout",
    });
    const rejected = await connectionResponse(
      "connection-empty-after-close",
      0,
      roomId,
    );
    expect(rejected.status).toBe(410);
  });

  it("closes at the maximum duration even while clients are connected", async () => {
    const roomId = "room-phase6-max-duration";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "5".repeat(32),
      ownerUserId: "owner-phase6-max-duration",
      name: "Maximum duration",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const socket = await connect("connection-max-duration", 0, roomId);
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE scheduled_tasks SET due_at = ?
         WHERE kind = 'max_duration'`,
        Date.now() - 1,
      );
    });
    const closing = nextMessageOfType(socket, "room.updated");
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    await runDurableObjectAlarm(room);
    await expect(closing).resolves.toMatchObject({
      status: "closing",
      reason: "max_duration",
    });
    await closed;
    await expect(room.roomLifecycleState()).resolves.toMatchObject({
      status: "closing",
      reason: "max_duration",
    });
    await expect(runInDurableObject(room, (_instance, state) =>
      state.storage.sql.exec("SELECT kind FROM scheduled_tasks").toArray()
    )).resolves.toHaveLength(0);
  });

  it("warns 15, 5, and 1 minute before maximum duration and restores the latest warning", async () => {
    const roomId = "room-phase6-max-duration-warnings";
    let room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    const maxEndsAt = createdAt + 2 * 60 * 60 * 1_000;
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "a".repeat(32),
      ownerUserId: "owner-phase6-time-warning",
      name: "Maximum duration warnings",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt,
    });
    await runInDurableObject(room, async (_instance, state) => {
      state.storage.sql.exec(
        `DROP TABLE room_time_limit;
         DROP TABLE room_bans;
         DROP TABLE actor_abuse_state;
         ALTER TABLE room_tickets DROP COLUMN can_chat;
         ALTER TABLE room_tickets DROP COLUMN display_name;
         ALTER TABLE room_tickets DROP COLUMN avatar_url;
         ALTER TABLE connections DROP COLUMN can_chat;
         ALTER TABLE connections DROP COLUMN display_name;
         ALTER TABLE connections DROP COLUMN avatar_url;
         ALTER TABLE chat_messages DROP COLUMN display_name;
         ALTER TABLE chat_messages DROP COLUMN avatar_url;
         ALTER TABLE snapshot_automation DROP COLUMN initial_thumbnail_state;
         ALTER TABLE snapshot_automation DROP COLUMN initial_thumbnail_due_at;
         ALTER TABLE snapshot_automation DROP COLUMN initial_thumbnail_job_id;
         DELETE FROM room_metrics
         WHERE name IN ('rate_limited', 'short_mute', 'abuse_disconnect');
         DELETE FROM _sql_schema_migrations
         WHERE id IN (24, 25, 26, 27, 28, 29);`,
      );
      await state.storage.setAlarm(maxEndsAt);
    });
    await evictDurableObject(room);
    room = env.DRAWING_ROOM.getByName(roomId);
    await expect(room.health()).resolves.toEqual({
      ok: true,
      schemaVersion: 29,
    });
    await expect(runInDurableObject(
      room,
      (_instance, state) => state.storage.getAlarm(),
    )).resolves.toBe(maxEndsAt - 15 * 60 * 1_000);

    const socket = await connect("connection-time-warning", 0, roomId);
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });

    for (const warningMinutes of [15, 5, 1] as const) {
      // oxlint-disable-next-line no-await-in-loop -- each stage depends on the previous persisted warning.
      await runInDurableObject(room, async (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE scheduled_tasks SET due_at = ?
           WHERE kind = 'max_duration'`,
          Date.now() + warningMinutes * 60 * 1_000 - 100,
        );
        await state.storage.setAlarm(Date.now());
      });
      // oxlint-disable-next-line no-await-in-loop -- alarm delivery advances one persisted stage at a time.
      await runDurableObjectAlarm(room);
      // oxlint-disable-next-line no-await-in-loop -- consume each ordered warning before advancing the clock.
      const warning = await nextMessageOfType(socket, "room.time");
      expect(warning).toMatchObject({
        type: "room.time",
        warningMinutes,
      });
      expect(warning.remainingMs).toBeGreaterThan(0);
      expect(warning.remainingMs).toBeLessThanOrEqual(
        warningMinutes * 60 * 1_000,
      );
    }

    await expect(runInDurableObject(room, (_instance, state) =>
      state.storage.sql.exec<{ warning_stage: number }>(
        "SELECT warning_stage FROM room_time_limit WHERE singleton = 1",
      ).one()
    )).resolves.toEqual({ warning_stage: 3 });

    const restored = await connect(
      "connection-time-warning-restored",
      0,
      roomId,
    );
    await expect(nextMessage(restored)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(restored)).resolves.toMatchObject({
      type: "room.time",
      warningMinutes: 1,
    });
    await expect(nextMessage(restored)).resolves.toMatchObject({
      type: "ready",
    });
  });

  it("allows only the host to close a room from the realtime protocol", async () => {
    const roomId = "room-phase6-host-close";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "6".repeat(32),
      ownerUserId: "owner-phase6-host-close",
      name: "Host close",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const participant = await connect(
      "connection-host-close-participant",
      0,
      roomId,
    );
    await expect(nextMessage(participant)).resolves.toMatchObject({
      type: "room.updated",
      status: "waiting",
    });
    await expect(nextMessage(participant)).resolves.toMatchObject({ type: "ready" });
    const forbidden = nextMessageOfType(participant, "reject");
    participant.send(encodeClientRoomCloseMessage({
      v: 1,
      type: "room.close",
      requestId: "close-host-forbidden-001",
    }));
    await expect(forbidden).resolves.toMatchObject({
      code: "ROLE_FORBIDDEN",
    });

    const host = await startInitializedRoom(roomId);
    const closing = nextMessageOfType(host, "room.updated");
    const closed = new Promise<void>((resolve) => {
      host.addEventListener("close", () => resolve(), { once: true });
    });
    host.send(encodeClientRoomCloseMessage({
      v: 1,
      type: "room.close",
      requestId: "close-host-accepted-001",
    }));
    await expect(closing).resolves.toMatchObject({
      status: "closing",
      reason: "host",
      closeRequestId: "close-host-accepted-001",
    });
    await closed;
    await expect(room.roomLifecycleState()).resolves.toMatchObject({
      status: "closing",
      reason: "host",
    });
    const reconnect = await connectionResponse(
      "connection-host-close-reconnect",
      0,
      roomId,
    );
    expect(reconnect.status).toBe(410);
    participant.close(1000, "test complete");
  });

  it("suspends an active room, finalizes strokes, and permits an admin close", async () => {
    const roomId = "room-phase6-admin-suspend";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "7".repeat(32),
      ownerUserId: "owner-phase6-admin-suspend",
      name: "Admin suspend",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const host = await startInitializedRoom(roomId);
    await expect(send(host, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_admin_suspend_0001",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({ type: "accepted" });

    const suspendedMessage = nextMessageOfType(host, "room.updated");
    const closed = new Promise<void>((resolve) => {
      host.addEventListener("close", () => resolve(), { once: true });
    });
    const suspended = await room.suspendRoom({
      v: 1,
      actionId: "admin-suspend-action-0001",
      roomId,
      actorAdminId: "admin-phase6-suspend",
      action: "suspend_room",
      reason: "Safety review",
      requestedAt: Date.now(),
    });
    expect(suspended).toMatchObject({ status: "suspended" });
    await expect(suspendedMessage).resolves.toMatchObject({
      status: "suspended",
    });
    await closed;
    await expect(room.stats()).resolves.toMatchObject({
      activeStrokeCount: 0,
      eventCount: 2,
    });
    await expect(runInDurableObject(room, (_instance, state) =>
      state.storage.sql.exec("SELECT kind FROM scheduled_tasks").toArray()
    )).resolves.toHaveLength(0);
    const reconnect = await connectionResponse(
      "connection-admin-suspend-reconnect",
      0,
      roomId,
    );
    expect(reconnect.status).toBe(410);

    await expect(room.beginRoomClose({
      closeRequestId: "admin-close-suspended-0001",
      reason: "admin",
    })).resolves.toMatchObject({
      status: "closing",
      reason: "admin",
    });
    await expect(room.roomLifecycleState()).resolves.toMatchObject({
      status: "closing",
      reason: "admin",
    });
  });

  it("persists ordered strokes, rejects duplicates, and replays after reconnect", async () => {
    const socket = await connect("connection-phase2-first");
    await expect(nextMessage(socket)).resolves.toEqual({ type: "ready", roomSeq: 0 });
    const observer = await connect("connection-phase2-observer");
    await expect(nextMessage(observer)).resolves.toEqual({ type: "ready", roomSeq: 0 });

    const strokeId = "stroke_phase2_000000000001";
    const begin = {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: strokeId,
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 0.35,
      point: [10, 20, 0],
    } as const satisfies ClientStrokeEvent;
    const append = {
      v: 1,
      op: "stroke.append",
      clientSeq: 2,
      id: strokeId,
      points: [[20, 30, 50], [30, 40, 100]],
    } as const satisfies ClientStrokeEvent;
    const end = {
      v: 1,
      op: "stroke.end",
      clientSeq: 3,
      id: strokeId,
    } as const satisfies ClientStrokeEvent;

    const observerBegin = nextMessage(observer);
    await expect(send(socket, begin)).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 1,
      actor: ACTOR_ID,
      event: begin,
    });
    await expect(observerBegin).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 1,
      event: begin,
    });
    const observerAppend = nextMessage(observer);
    await expect(send(socket, append)).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 2,
      event: append,
    });
    await expect(observerAppend).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 2,
      event: append,
    });
    const observerEnd = nextMessage(observer);
    await expect(send(socket, end)).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 3,
      event: end,
    });
    await expect(observerEnd).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 3,
      event: end,
    });
    await expect(send(socket, end)).resolves.toEqual({
      type: "reject",
      code: "DUPLICATE",
      message: "clientSeq was already accepted",
      clientSeq: 3,
    });

    await expect(env.DRAWING_ROOM.getByName(ROOM_ID).stats()).resolves.toMatchObject({
      eventCount: 3,
      activeStrokeCount: 0,
      connectionCount: 2,
      lastRoomSeq: 3,
      acceptedCount: 3,
      rejectCount: 1,
      broadcastCount: 3,
      replayEventCount: 0,
      totalPayloadBytes: expect.any(Number),
    });
    socket.close(1000, "test complete");
    observer.close(1000, "test complete");

    await evictDurableObject(env.DRAWING_ROOM.getByName(ROOM_ID), {
      webSockets: "close",
    });
    const reconnect = await connect("connection-phase2-second", 1);
    await expect(nextMessage(reconnect)).resolves.toMatchObject({
      type: "replay",
      events: [
        { type: "accepted", roomSeq: 2, event: append },
        { type: "accepted", roomSeq: 3, event: end },
      ],
    });
    await expect(nextMessage(reconnect)).resolves.toEqual({ type: "ready", roomSeq: 3 });
    reconnect.close(1000, "test complete");
  });

  it("automatically finalizes an unfinished stroke through the DO alarm", async () => {
    const roomId = "room-phase2-timeout";
    const socket = await connect("connection-timeout-test", 0, roomId);
    await nextMessage(socket);

    const begin = {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_phase2_timeout_0001",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 0.35,
      point: [10, 20, 0],
    } as const satisfies ClientStrokeEvent;
    await expect(send(socket, begin)).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 1,
    });

    const stub = env.DRAWING_ROOM.getByName(roomId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE strokes SET last_append_at = ? WHERE stroke_id = ?",
        Date.now() - 2_001,
        begin.id,
      );
    });
    const timeoutMessage = nextMessage(socket);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(timeoutMessage).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 2,
      actor: ACTOR_ID,
      connectionId: "server_timeout",
      event: {
        v: 1,
        op: "stroke.end",
        id: begin.id,
        serverGenerated: true,
      },
    });
    await expect(stub.stats()).resolves.toMatchObject({
      eventCount: 2,
      activeStrokeCount: 0,
      lastRoomSeq: 2,
      acceptedCount: 2,
      broadcastCount: 2,
      totalPayloadBytes: expect.any(Number),
    });
    socket.close(1000, "test complete");
  });

  it("exposes bounded snapshot chunks and commits a manifest idempotently", async () => {
    const roomId = "room-phase3-snapshot";
    const socket = await connect("connection-phase3-snapshot", 0, roomId);
    await nextMessage(socket);
    const strokeId = "stroke_phase3_snapshot_0001";
    const events = [
      {
        v: 1,
        op: "stroke.begin",
        clientSeq: 1,
        id: strokeId,
        tool: "brush",
        color: "#336699",
        size: 12,
        opacity: 0.35,
        point: [10, 20, 0],
      },
      {
        v: 1,
        op: "stroke.append",
        clientSeq: 2,
        id: strokeId,
        points: [[20, 30, 50], [30, 40, 100]],
      },
      {
        v: 1,
        op: "stroke.end",
        clientSeq: 3,
        id: strokeId,
      },
    ] as const satisfies readonly ClientStrokeEvent[];
    for (const event of events) {
      // oxlint-disable-next-line no-await-in-loop -- lifecycle order is required.
      await expect(send(socket, event)).resolves.toMatchObject({
        type: "accepted",
      });
    }

    const stub = env.DRAWING_ROOM.getByName(roomId);
    const job = await stub.requestSnapshot(roomId);
    expect(job).toMatchObject({
      v: SNAPSHOT_JOB_VERSION,
      roomId,
      targetRoomSeq: 3,
      protocolVersion: 1,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: 1,
    });
    await expect(stub.requestSnapshot(roomId)).resolves.toEqual(job);

    const first = await stub.snapshotEvents(job.jobId, 0, 2);
    expect(first.events.map((event) => event.roomSeq)).toEqual([1, 2]);
    expect(first.done).toBe(false);
    const second = await stub.snapshotEvents(job.jobId, first.nextAfterRoomSeq, 2);
    expect(second.events.map((event) => event.roomSeq)).toEqual([3]);
    expect(second.done).toBe(true);

    const manifest = {
      v: SNAPSHOT_JOB_VERSION,
      jobId: job.jobId,
      roomId,
      baseRoomSeq: 3,
      protocolVersion: 1,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: 1,
      codec: SNAPSHOT_CODEC,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectKey: `rooms/${roomId}/snapshots/staging/${job.jobId}.kgs`,
      objectBytes: 4,
      objectHash: "a".repeat(64),
      rgbaHash: "b".repeat(64),
      createdAt: Date.now(),
    } as const satisfies SnapshotManifest;
    const snapshotBytes = new Uint8Array([1, 2, 3, 4]);
    await env.RUNTIME_SNAPSHOTS.put(manifest.objectKey, snapshotBytes, {
      customMetadata: {
        jobId: manifest.jobId,
        roomId: manifest.roomId,
        baseRoomSeq: String(manifest.baseRoomSeq),
        objectHash: manifest.objectHash,
        rgbaHash: manifest.rgbaHash,
      },
    });
    await expect(stub.commitSnapshot(manifest)).resolves.toEqual({
      status: "committed",
      manifest,
    });
    await expect(stub.commitSnapshot(manifest)).resolves.toEqual({
      status: "already_committed",
      manifest,
    });
    await expect(stub.snapshotEvents(job.jobId, 0, 500)).resolves.toMatchObject({
      done: true,
      nextAfterRoomSeq: 3,
    });
    await expect(stub.currentSnapshot()).resolves.toEqual(manifest);
    socket.close(1000, "test complete");

    const recovering = await connect(
      "connection-phase3-recovery",
      0,
      roomId,
      true,
    );
    const offer = await nextMessage(recovering);
    expect(offer).toMatchObject({
      type: "snapshot",
      manifest: {
        jobId: manifest.jobId,
        baseRoomSeq: 3,
      },
      readToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(offer.type === "snapshot" && "objectKey" in offer.manifest).toBe(false);
    await expect(nextMessage(recovering)).resolves.toEqual({
      type: "ready",
      roomSeq: 3,
    });
    expect(offer.type).toBe("snapshot");
    if (offer.type !== "snapshot") throw new Error("expected snapshot offer");
    const snapshotUrl =
      `http://example.test/rooms/${roomId}/snapshots/${manifest.jobId}`;
    const downloaded = await exports.default.fetch(snapshotUrl, {
      headers: {
        Authorization: `KogeSnapshot ${offer.readToken}`,
        Origin: "http://localhost:3000",
      },
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("cache-control")).toBe("private, no-store");
    await expect(downloaded.arrayBuffer()).resolves.toEqual(snapshotBytes.buffer);
    const reused = await exports.default.fetch(snapshotUrl, {
      headers: {
        Authorization: `KogeSnapshot ${offer.readToken}`,
        Origin: "http://localhost:3000",
      },
    });
    expect(reused.status).toBe(403);
    recovering.close(1000, "test complete");
  });

  it("queues an automatic snapshot once and cancels pending deletion in shadow mode", async () => {
    const roomId = "room-phase3-snapshot-auto";
    let stub = env.DRAWING_ROOM.getByName(roomId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_metrics SET value = 50000 WHERE name = 'accepted'",
      );
    });

    await expect(stub.reconcileSnapshotAutomation(roomId)).resolves
      .toMatchObject({
        mode: "shadow",
        status: "trigger",
        trigger: "events",
        eventCount: 50_000,
        job: { roomId, targetRoomSeq: 0 },
      });
    await expect(stub.reconcileSnapshotAutomation(roomId)).resolves
      .toMatchObject({
        mode: "shadow",
        status: "job_pending",
        eventCount: 50_000,
      });

    const jobs = await runInDurableObject(stub, (_instance, state) => (
      state.storage.sql.exec<{
        job_id: string;
        trigger_kind: string;
        trigger_event_count: number;
      }>(
        `SELECT job_id, trigger_kind, trigger_event_count
         FROM snapshot_jobs`,
      ).toArray()
    ));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      trigger_kind: "events",
      trigger_event_count: 50_000,
    });

    await evictDurableObject(stub);
    stub = env.DRAWING_ROOM.getByName(roomId);
    await expect(stub.reconcileSnapshotAutomation(roomId)).resolves
      .toMatchObject({
        mode: "shadow",
        status: "job_pending",
        eventCount: 50_000,
      });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE snapshot_automation
         SET pending_compaction_job_id = ?, compaction_due_at = 0
         WHERE singleton = 1`,
        jobs[0]!.job_id,
      );
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    await expect(stub.snapshotAutomationState()).resolves.toMatchObject({
      config: { mode: "shadow" },
      lastEvaluationStatus: "job_pending",
    });
    await expect(stub.snapshotAutomationState()).resolves.not.toHaveProperty(
      "pendingCompactionJobId",
    );
  });

  it("queues the one-shot initial thumbnail snapshot after the first completed stroke", async () => {
    const roomId = "room-initial-thumbnail";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "8".repeat(32),
      ownerUserId: "owner-initial-thumbnail",
      name: "Initial thumbnail",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const host = await startInitializedRoom(roomId);
    await expect(room.snapshotAutomationState()).resolves.toMatchObject({
      initialThumbnailState: "scheduled",
    });

    await runInDurableObject(room, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE snapshot_automation
         SET initial_thumbnail_due_at = ?
         WHERE singleton = 1`,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(room);
    await expect(room.snapshotAutomationState()).resolves.toMatchObject({
      initialThumbnailState: "waiting_for_stroke",
    });

    await expect(send(host, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_initial_thumbnail_001",
      tool: "brush",
      color: "#336699",
      size: 3,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({ type: "accepted" });
    await expect(send(host, {
      v: 1,
      op: "stroke.end",
      clientSeq: 2,
      id: "stroke_initial_thumbnail_001",
    })).resolves.toMatchObject({ type: "accepted" });
    await Promise.all(
      Array.from(
        { length: 20 },
        () => room.reconcileSnapshotAutomation(roomId),
      ),
    );

    const state = await room.snapshotAutomationState();
    expect(state).toMatchObject({
      initialThumbnailState: "queued",
    });
    expect(state.initialThumbnailJobId).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    const jobs = await runInDurableObject(room, (_instance, durableState) =>
      durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM snapshot_jobs",
      ).one().count
    );
    expect(jobs).toBe(1);
    await room.reconcileSnapshotAutomation(roomId);
    await expect(runInDurableObject(room, (_instance, durableState) =>
      durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM snapshot_jobs",
      ).one().count
    )).resolves.toBe(1);
    host.close(1000, "test complete");
  });

  it("satisfies the initial thumbnail task when a normal snapshot commits before its deadline", async () => {
    const roomId = "room-initial-thumbnail-early";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "9".repeat(32),
      ownerUserId: "owner-initial-thumbnail-early",
      name: "Early thumbnail",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const host = await startInitializedRoom(roomId);
    await expect(send(host, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_initial_thumbnail_early",
      tool: "brush",
      color: "#336699",
      size: 3,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({ type: "accepted" });
    await expect(send(host, {
      v: 1,
      op: "stroke.end",
      clientSeq: 2,
      id: "stroke_initial_thumbnail_early",
    })).resolves.toMatchObject({ type: "accepted" });

    const job = await room.requestSnapshot(roomId);
    await expect(room.commitSnapshot({
      v: SNAPSHOT_JOB_VERSION,
      jobId: job.jobId,
      roomId,
      baseRoomSeq: job.targetRoomSeq,
      protocolVersion: 1,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: job.generation,
      codec: SNAPSHOT_CODEC,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectKey: `rooms/${roomId}/snapshots/staging/${job.jobId}.kgs`,
      objectBytes: 4,
      objectHash: "1".repeat(64),
      rgbaHash: "2".repeat(64),
      createdAt: Date.now(),
    })).resolves.toMatchObject({ status: "committed" });
    await expect(room.snapshotAutomationState()).resolves.toMatchObject({
      initialThumbnailState: "satisfied",
      initialThumbnailJobId: job.jobId,
    });

    await runInDurableObject(room, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE snapshot_automation
         SET initial_thumbnail_due_at = ?
         WHERE singleton = 1`,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(room);
    await room.reconcileSnapshotAutomation(roomId);
    await expect(runInDurableObject(room, (_instance, durableState) =>
      durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM snapshot_jobs",
      ).one().count
    )).resolves.toBe(1);
    host.close(1000, "test complete");
  });

  it("waits for the active stroke boundary before queuing the initial thumbnail", async () => {
    const roomId = "room-initial-thumbnail-active";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const createdAt = Date.now();
    await room.initializeRoom({
      v: 1,
      roomId,
      publicSlug: "a".repeat(32),
      ownerUserId: "owner-initial-thumbnail-active",
      name: "Active stroke thumbnail",
      visibility: "public",
      participantLimit: 20,
      viewerLimit: 100,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + 2 * 60 * 60 * 1_000,
    });
    const host = await startInitializedRoom(roomId);
    await expect(send(host, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_initial_thumbnail_active",
      tool: "brush",
      color: "#336699",
      size: 3,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({ type: "accepted" });

    await runInDurableObject(room, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE snapshot_automation
         SET initial_thumbnail_due_at = ?
         WHERE singleton = 1`,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(room);
    await expect(room.snapshotAutomationState()).resolves.toMatchObject({
      initialThumbnailState: "waiting_for_stroke",
    });
    await expect(runInDurableObject(room, (_instance, durableState) =>
      durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM snapshot_jobs",
      ).one().count
    )).resolves.toBe(0);

    await expect(send(host, {
      v: 1,
      op: "stroke.end",
      clientSeq: 2,
      id: "stroke_initial_thumbnail_active",
    })).resolves.toMatchObject({ type: "accepted" });
    await room.reconcileSnapshotAutomation(roomId);
    await expect(room.snapshotAutomationState()).resolves.toMatchObject({
      initialThumbnailState: "queued",
    });
    await expect(runInDurableObject(room, (_instance, durableState) =>
      durableState.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM snapshot_jobs",
      ).one().count
    )).resolves.toBe(1);
    host.close(1000, "test complete");
  });

  it("falls back from current to previous snapshot, then to the full event log", async () => {
    const roomId = "room-phase3-snapshot-chain";
    const stub = env.DRAWING_ROOM.getByName(roomId);
    const firstJob = await stub.requestSnapshot(roomId);
    expect(firstJob).toMatchObject({ sourceBaseRoomSeq: 0 });
    expect(firstJob.sourceSnapshotJobId).toBeUndefined();
    const firstManifest = {
      v: SNAPSHOT_JOB_VERSION,
      jobId: firstJob.jobId,
      roomId,
      baseRoomSeq: 0,
      protocolVersion: 1,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: 1,
      codec: SNAPSHOT_CODEC,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectKey: `rooms/${roomId}/snapshots/staging/${firstJob.jobId}.kgs`,
      objectBytes: 4,
      objectHash: "1".repeat(64),
      rgbaHash: "2".repeat(64),
      createdAt: Date.now(),
    } as const satisfies SnapshotManifest;
    await expect(stub.commitSnapshot(firstManifest)).resolves.toMatchObject({
      status: "committed",
    });

    const drawing = await connect(
      "connection-snapshot-chain-drawing",
      0,
      roomId,
    );
    await expect(nextMessage(drawing)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    const strokeId = "stroke_snapshot_chain_0001";
    for (const event of [
      {
        v: 1,
        op: "stroke.begin",
        clientSeq: 1,
        id: strokeId,
        tool: "brush",
        color: "#336699",
        size: 12,
        opacity: 1,
        point: [10, 20, 0],
      },
      {
        v: 1,
        op: "stroke.append",
        clientSeq: 2,
        id: strokeId,
        points: [[20, 30, 50]],
      },
      {
        v: 1,
        op: "stroke.end",
        clientSeq: 3,
        id: strokeId,
      },
    ] as const satisfies readonly ClientStrokeEvent[]) {
      // oxlint-disable-next-line no-await-in-loop -- lifecycle order is required.
      await expect(send(drawing, event)).resolves.toMatchObject({
        type: "accepted",
      });
    }
    drawing.close(1000, "events committed");

    const secondJob = await stub.requestSnapshot(roomId);
    expect(secondJob).toMatchObject({
      sourceSnapshotJobId: firstJob.jobId,
      sourceBaseRoomSeq: 0,
    });
    await expect(stub.snapshotSource(secondJob.jobId)).resolves.toEqual(
      firstManifest,
    );
    const secondManifest = {
      ...firstManifest,
      jobId: secondJob.jobId,
      baseRoomSeq: 3,
      generation: 2,
      objectKey:
        `rooms/${roomId}/snapshots/staging/${secondJob.jobId}.kgs`,
      objectHash: "3".repeat(64),
      rgbaHash: "4".repeat(64),
      createdAt: Date.now() + 1,
    } as const satisfies SnapshotManifest;
    await expect(stub.commitSnapshot(secondManifest)).resolves.toMatchObject({
      status: "committed",
    });
    await expect(stub.currentSnapshot()).resolves.toEqual(secondManifest);
    await expect(stub.previousSnapshot()).resolves.toEqual(firstManifest);

    const currentRecovery = await connect(
      "connection-snapshot-chain-current",
      0,
      roomId,
      true,
    );
    await expect(nextMessage(currentRecovery)).resolves.toMatchObject({
      type: "snapshot",
      manifest: { jobId: secondManifest.jobId, baseRoomSeq: 3 },
    });
    await expect(nextMessage(currentRecovery)).resolves.toEqual({
      type: "ready",
      roomSeq: 3,
    });
    currentRecovery.close(1000, "current selected");

    const previousRecovery = await connect(
      "connection-snapshot-chain-previous",
      0,
      roomId,
      true,
      [secondManifest.jobId],
    );
    await expect(nextMessage(previousRecovery)).resolves.toMatchObject({
      type: "snapshot",
      manifest: { jobId: firstManifest.jobId, baseRoomSeq: 0 },
    });
    await expect(nextMessage(previousRecovery)).resolves.toMatchObject({
      type: "replay",
      events: expect.arrayContaining([
        expect.objectContaining({ roomSeq: 1 }),
        expect.objectContaining({ roomSeq: 3 }),
      ]),
    });
    await expect(nextMessage(previousRecovery)).resolves.toEqual({
      type: "ready",
      roomSeq: 3,
    });
    previousRecovery.close(1000, "previous selected");

    const fullReplay = await connect(
      "connection-snapshot-chain-full-replay",
      0,
      roomId,
      true,
      [secondManifest.jobId, firstManifest.jobId],
    );
    await expect(nextMessage(fullReplay)).resolves.toMatchObject({
      type: "replay",
      events: expect.arrayContaining([
        expect.objectContaining({ roomSeq: 1 }),
        expect.objectContaining({ roomSeq: 3 }),
      ]),
    });
    await expect(nextMessage(fullReplay)).resolves.toEqual({
      type: "ready",
      roomSeq: 3,
    });
    fullReplay.close(1000, "full replay selected");
  });

  it("compacts through the previous snapshot in resumable chunks and fails closed", async () => {
    const roomId = "room-phase3-snapshot-compaction";
    const stub = env.DRAWING_ROOM.getByName(roomId);
    const manifestFor = (
      job: SnapshotJob,
      hashDigit: string,
    ): SnapshotManifest => ({
      v: SNAPSHOT_JOB_VERSION,
      jobId: job.jobId,
      roomId,
      baseRoomSeq: job.targetRoomSeq,
      protocolVersion: 1,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: job.generation,
      codec: SNAPSHOT_CODEC,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectKey: `rooms/${roomId}/snapshots/staging/${job.jobId}.kgs`,
      objectBytes: 4,
      objectHash: hashDigit.repeat(64),
      rgbaHash: (hashDigit === "f" ? "e" : "f").repeat(64),
      createdAt: Date.now() + job.generation,
    });
    const firstJob = await stub.requestSnapshot(roomId);
    const firstManifest = manifestFor(firstJob, "1");
    await stub.commitSnapshot(firstManifest);
    await expect(stub.compactSnapshotEvents(firstJob.jobId, 2)).resolves
      .toMatchObject({
        status: "not_ready",
        mode: "shadow",
        deletedEventCount: 0,
      });

    const drawing = await connect(
      "connection-snapshot-compaction-drawing",
      0,
      roomId,
    );
    await expect(nextMessage(drawing)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    const strokeEvents = (
      strokeId: string,
      firstClientSeq: number,
      offset: number,
    ) => [
      {
        v: 1,
        op: "stroke.begin",
        clientSeq: firstClientSeq,
        id: strokeId,
        tool: "brush",
        color: "#336699",
        size: 12,
        opacity: 1,
        point: [10 + offset, 20 + offset, 0],
      },
      {
        v: 1,
        op: "stroke.append",
        clientSeq: firstClientSeq + 1,
        id: strokeId,
        points: [[20 + offset, 30 + offset, 50]],
      },
      {
        v: 1,
        op: "stroke.end",
        clientSeq: firstClientSeq + 2,
        id: strokeId,
      },
    ] as const satisfies readonly ClientStrokeEvent[];
    for (const event of strokeEvents("stroke_compaction_0001", 1, 0)) {
      // oxlint-disable-next-line no-await-in-loop -- lifecycle order is required.
      await expect(send(drawing, event)).resolves.toMatchObject({
        type: "accepted",
      });
    }
    const secondJob = await stub.requestSnapshot(roomId);
    const secondManifest = manifestFor(secondJob, "2");
    await stub.commitSnapshot(secondManifest);

    for (const event of strokeEvents("stroke_compaction_0002", 4, 40)) {
      // oxlint-disable-next-line no-await-in-loop -- lifecycle order is required.
      await expect(send(drawing, event)).resolves.toMatchObject({
        type: "accepted",
      });
    }
    const thirdJob = await stub.requestSnapshot(roomId);
    const thirdManifest = manifestFor(thirdJob, "3");
    await stub.commitSnapshot(thirdManifest);
    drawing.close(1000, "snapshot generations committed");
    await expect(stub.compactSnapshotEvents(secondJob.jobId, 2)).resolves
      .toMatchObject({
        status: "stale",
        mode: "shadow",
        deletedEventCount: 0,
      });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO snapshot_jobs (
          job_id, room_id, target_room_seq, protocol_version, renderer_version,
          canvas_generation, generation, requested_at, source_job_id,
          source_base_room_seq, status
        ) VALUES (?, ?, 5, 1, 1, 1, 99, ?, ?, 0, 'queued')`,
        "snapshot-job-compaction-blocker",
        roomId,
        Date.now(),
        firstManifest.jobId,
      );
    });
    await expect(stub.compactSnapshotEvents(thirdJob.jobId, 2)).resolves
      .toMatchObject({
        status: "blocked",
        mode: "shadow",
        compactedThroughRoomSeq: 0,
        safeThroughRoomSeq: 0,
        blockedByQueuedJobId: "snapshot-job-compaction-blocker",
        deletedEventCount: 0,
        done: false,
      });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE snapshot_jobs SET status = 'superseded' WHERE job_id = ?",
        "snapshot-job-compaction-blocker",
      );
    });

    await expect(stub.compactSnapshotEvents(thirdJob.jobId, 2)).resolves
      .toMatchObject({
        status: "compacted",
        mode: "snapshot_compacted",
        compactedThroughRoomSeq: 2,
        previousBaseRoomSeq: 3,
        deletedEventCount: 2,
        done: false,
      });
    const coldWithoutSnapshot = await connectionResponse(
      "connection-compaction-full-replay-forbidden",
      0,
      roomId,
      false,
    );
    expect(coldWithoutSnapshot.status).toBe(409);
    await expect(coldWithoutSnapshot.json()).resolves.toEqual({
      error: "SNAPSHOT_RECOVERY_REQUIRED",
    });

    await expect(stub.compactSnapshotEvents(thirdJob.jobId, 2)).resolves
      .toMatchObject({
        status: "compacted",
        compactedThroughRoomSeq: 3,
        deletedEventCount: 1,
        done: true,
      });
    await expect(stub.compactSnapshotEvents(thirdJob.jobId, 2)).resolves
      .toMatchObject({
        status: "compacted",
        compactedThroughRoomSeq: 3,
        deletedEventCount: 0,
        done: true,
      });
    expect((await stub.eventsAfter(0)).map((event) => event.roomSeq)).toEqual([
      4,
      5,
      6,
    ]);
    expect((await stub.stats()).eventCount).toBe(3);

    const currentRecovery = await connect(
      "connection-compaction-current",
      0,
      roomId,
      true,
    );
    await expect(nextMessage(currentRecovery)).resolves.toMatchObject({
      type: "snapshot",
      manifest: { jobId: thirdManifest.jobId, baseRoomSeq: 6 },
    });
    await expect(nextMessage(currentRecovery)).resolves.toEqual({
      type: "ready",
      roomSeq: 6,
    });
    currentRecovery.close(1000, "current recovery complete");

    const previousRecovery = await connect(
      "connection-compaction-previous",
      0,
      roomId,
      true,
      [thirdManifest.jobId],
    );
    await expect(nextMessage(previousRecovery)).resolves.toMatchObject({
      type: "snapshot",
      manifest: { jobId: secondManifest.jobId, baseRoomSeq: 3 },
    });
    await expect(nextMessage(previousRecovery)).resolves.toMatchObject({
      type: "replay",
      events: [
        expect.objectContaining({ roomSeq: 4 }),
        expect.objectContaining({ roomSeq: 5 }),
        expect.objectContaining({ roomSeq: 6 }),
      ],
    });
    await expect(nextMessage(previousRecovery)).resolves.toEqual({
      type: "ready",
      roomSeq: 6,
    });
    previousRecovery.close(1000, "previous recovery complete");

    const noValidSnapshot = await connectionResponse(
      "connection-compaction-no-snapshot",
      0,
      roomId,
      true,
      [thirdManifest.jobId, secondManifest.jobId],
    );
    expect(noValidSnapshot.status).toBe(409);

    const tailResume = await connect(
      "connection-compaction-tail-resume",
      3,
      roomId,
      false,
    );
    await expect(nextMessage(tailResume)).resolves.toMatchObject({
      type: "replay",
      events: [
        expect.objectContaining({ roomSeq: 4 }),
        expect.objectContaining({ roomSeq: 5 }),
        expect.objectContaining({ roomSeq: 6 }),
      ],
    });
    await expect(nextMessage(tailResume)).resolves.toEqual({
      type: "ready",
      roomSeq: 6,
    });
    tailResume.close(1000, "tail resume complete");

    const continued = await connect(
      "connection-compaction-continued-drawing",
      6,
      roomId,
      false,
    );
    await expect(nextMessage(continued)).resolves.toEqual({
      type: "ready",
      roomSeq: 6,
    });
    for (const event of strokeEvents("stroke_compaction_0003", 1, 80)) {
      // oxlint-disable-next-line no-await-in-loop -- lifecycle order is required.
      await expect(send(continued, event)).resolves.toMatchObject({
        type: "accepted",
      });
    }
    continued.close(1000, "post-compaction events committed");
    const fourthJob = await stub.requestSnapshot(roomId);
    expect(fourthJob).toMatchObject({
      targetRoomSeq: 9,
      sourceSnapshotJobId: thirdManifest.jobId,
      sourceBaseRoomSeq: 6,
    });
    const fourthChunk = await stub.snapshotEvents(fourthJob.jobId, 6, 500);
    expect(fourthChunk.events.map((event) => event.roomSeq)).toEqual([7, 8, 9]);
    expect(fourthChunk.done).toBe(true);
  });

  it("compacts a 500-event chunk without exceeding SQLite binding limits", async () => {
    const roomId = "room-phase3-compaction-binding-limit";
    const stub = env.DRAWING_ROOM.getByName(roomId);
    const drawing = await connect(
      "connection-compaction-binding-limit",
      0,
      roomId,
    );
    await expect(nextMessage(drawing)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    let clientSeq = 1;
    const sendStroke = async (strokeIndex: number): Promise<void> => {
      const id = `stroke_binding_limit_${String(strokeIndex).padStart(4, "0")}`;
      const events = [
        {
          v: 1,
          op: "stroke.begin",
          clientSeq: clientSeq++,
          id,
          tool: "brush",
          color: "#336699",
          size: 8,
          opacity: 1,
          point: [10 + strokeIndex, 20, 0],
        },
        {
          v: 1,
          op: "stroke.append",
          clientSeq: clientSeq++,
          id,
          points: [[20 + strokeIndex, 30, 10]],
        },
        {
          v: 1,
          op: "stroke.end",
          clientSeq: clientSeq++,
          id,
        },
      ] as const satisfies readonly ClientStrokeEvent[];
      for (const event of events) {
        // oxlint-disable-next-line no-await-in-loop -- protocol order is required.
        await expect(send(drawing, event)).resolves.toMatchObject({
          type: "accepted",
        });
      }
    };
    const commit = async (
      job: SnapshotJob,
      hashDigit: string,
    ): Promise<void> => {
      await stub.commitSnapshot({
        v: SNAPSHOT_JOB_VERSION,
        jobId: job.jobId,
        roomId,
        baseRoomSeq: job.targetRoomSeq,
        protocolVersion: 1,
        rendererVersion: SNAPSHOT_RENDERER_VERSION,
        canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
        generation: job.generation,
        codec: SNAPSHOT_CODEC,
        width: PROTOCOL_LIMITS.canvasWidth,
        height: PROTOCOL_LIMITS.canvasHeight,
        objectKey: `rooms/${roomId}/snapshots/staging/${job.jobId}.kgs`,
        objectBytes: 4,
        objectHash: hashDigit.repeat(64),
        rgbaHash: (hashDigit === "a" ? "b" : "a").repeat(64),
        createdAt: Date.now() + job.generation,
      });
    };

    for (let strokeIndex = 0; strokeIndex < 34; strokeIndex += 1) {
      // oxlint-disable-next-line no-await-in-loop -- 102 ordered events build the boundary.
      await sendStroke(strokeIndex);
    }
    const firstJob = await stub.requestSnapshot(roomId);
    await commit(firstJob, "1");
    await sendStroke(34);
    const secondJob = await stub.requestSnapshot(roomId);
    await commit(secondJob, "2");
    await sendStroke(35);
    const thirdJob = await stub.requestSnapshot(roomId);
    await commit(thirdJob, "3");
    drawing.close(1000, "binding limit fixture complete");

    await expect(stub.compactSnapshotEvents(thirdJob.jobId, 500)).resolves
      .toMatchObject({
        status: "compacted",
        compactedThroughRoomSeq: 105,
        previousBaseRoomSeq: 105,
        deletedEventCount: 105,
        done: true,
      });
    await expect(stub.stats()).resolves.toMatchObject({
      eventCount: 3,
      lastRoomSeq: 108,
    });
  });

  it("fences snapshot work and connections when room closing begins", async () => {
    const roomId = "room-phase3-close-fence";
    const stub = env.DRAWING_ROOM.getByName(roomId);
    const job = await stub.requestSnapshot(roomId);
    await expect(stub.snapshotJobDisposition(job.jobId)).resolves.toBe("run");

    const socket = await connect(
      "connection-room-close-fence",
      0,
      roomId,
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    const begin = {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_room_close_fence_0001",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 0.5,
      point: [10, 20, 0],
    } as const satisfies ClientStrokeEvent;
    await expect(send(socket, begin)).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 1,
      event: begin,
    });

    const socketClosed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });
    const closingMessage = nextMessage(socket);
    const result = await stub.beginRoomClose({
      closeRequestId: "close-request-phase3-0001",
      reason: "probe",
    });
    expect(result).toMatchObject({
      status: "closing",
      closeRequestId: "close-request-phase3-0001",
      reason: "probe",
      finalizedStrokeCount: 1,
      supersededSnapshotJobCount: 1,
      snapshotObjectKeys: [
        `rooms/${roomId}/snapshots/staging/${job.jobId}.kgs`,
      ],
    });
    await expect(closingMessage).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 2,
      connectionId: "server_room_close",
      event: {
        op: "stroke.end",
        id: begin.id,
        serverGenerated: true,
      },
    });
    await expect(nextMessage(socket)).resolves.toEqual({
      type: "room.updated",
      status: "closing",
      closeRequestId: "close-request-phase3-0001",
      reason: "probe",
      startedAt: result.startedAt,
    });
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "room.closed",
      closeRequestId: "close-request-phase3-0001",
      reason: "probe",
    });
    await expect(socketClosed).resolves.toMatchObject({
      code: 1001,
      reason: "room is closing",
    });

    await expect(stub.roomLifecycleState()).resolves.toEqual({
      status: "closing",
      closeRequestId: "close-request-phase3-0001",
      reason: "probe",
      startedAt: result.startedAt,
      finalizedStrokeCount: 1,
      supersededSnapshotJobCount: 1,
    });
    await expect(stub.snapshotJobDisposition(job.jobId)).resolves.toBe(
      "discard",
    );
    await expect(stub.compactSnapshotEvents(job.jobId, 2)).resolves
      .toMatchObject({
        status: "room_closing",
        deletedEventCount: 0,
      });

    const manifest = {
      v: SNAPSHOT_JOB_VERSION,
      jobId: job.jobId,
      roomId,
      baseRoomSeq: job.targetRoomSeq,
      protocolVersion: 1,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: job.generation,
      codec: SNAPSHOT_CODEC,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectKey: `rooms/${roomId}/snapshots/staging/${job.jobId}.kgs`,
      objectBytes: 4,
      objectHash: "a".repeat(64),
      rgbaHash: "b".repeat(64),
      createdAt: Date.now(),
    } as const satisfies SnapshotManifest;
    await expect(stub.commitSnapshot(manifest)).resolves.toEqual({
      status: "superseded",
    });
    await expect(stub.currentSnapshot()).resolves.toBeUndefined();

    const reconnect = await connectionResponse(
      "connection-room-close-reconnect",
      0,
      roomId,
    );
    expect(reconnect.status).toBe(410);
    await expect(reconnect.json()).resolves.toEqual({
      error: "ROOM_NOT_ACTIVE",
      status: "closing",
    });

    const repeated = await stub.beginRoomClose({
      closeRequestId: "close-request-phase3-0002",
      reason: "admin",
    });
    expect(repeated).toEqual(result);
    expect((await stub.eventsAfter(0)).map((event) => event.roomSeq)).toEqual([
      1,
      2,
    ]);
    await expect(stub.stats()).resolves.toMatchObject({
      eventCount: 2,
      activeStrokeCount: 0,
    });
  });

  it.each([
    { failure: "missing R2 object", status: 404, seedObject: false },
    { failure: "corrupt R2 metadata", status: 502, seedObject: true },
  ])("fails closed for a $failure", async ({ status, seedObject }) => {
    const roomId = seedObject
      ? "room-phase3-corrupt-snapshot"
      : "room-phase3-missing-snapshot";
    const stub = env.DRAWING_ROOM.getByName(roomId);
    const job = await stub.requestSnapshot(roomId);
    const manifest = {
      v: SNAPSHOT_JOB_VERSION,
      jobId: job.jobId,
      roomId,
      baseRoomSeq: 0,
      protocolVersion: 1,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: 1,
      codec: SNAPSHOT_CODEC,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectKey: `rooms/${roomId}/snapshots/staging/${job.jobId}.kgs`,
      objectBytes: 4,
      objectHash: "c".repeat(64),
      rgbaHash: "d".repeat(64),
      createdAt: Date.now(),
    } as const satisfies SnapshotManifest;
    if (seedObject) {
      await env.RUNTIME_SNAPSHOTS.put(
        manifest.objectKey,
        new Uint8Array([1, 2, 3, 4]),
        {
          customMetadata: {
            jobId: manifest.jobId,
            roomId: manifest.roomId,
            baseRoomSeq: "0",
            objectHash: "wrong-object-hash",
            rgbaHash: manifest.rgbaHash,
          },
        },
      );
    }
    await expect(stub.commitSnapshot(manifest)).resolves.toMatchObject({
      status: "committed",
    });

    const recovering = await connect(
      `connection-${seedObject ? "corrupt" : "missing"}-snapshot`,
      0,
      roomId,
      true,
    );
    const offer = await nextMessage(recovering);
    expect(offer.type).toBe("snapshot");
    if (offer.type !== "snapshot") throw new Error("expected snapshot offer");
    await expect(nextMessage(recovering)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    const downloaded = await exports.default.fetch(
      `http://example.test/rooms/${roomId}/snapshots/${manifest.jobId}`,
      {
        headers: {
          Authorization: `KogeSnapshot ${offer.readToken}`,
          Origin: "http://localhost:3000",
        },
      },
    );
    expect(downloaded.status).toBe(status);
    recovering.close(1000, "test complete");
  });

  it("rejects missing, out-of-order, and post-cancel events without advancing sequence", async () => {
    const roomId = "room-phase2-ordering";
    const socket = await connect("connection-ordering-test", 0, roomId);
    await nextMessage(socket);
    const strokeId = "stroke_phase2_ordering_001";

    await expect(send(socket, {
      v: 1,
      op: "stroke.append",
      clientSeq: 1,
      id: strokeId,
      points: [[20, 30, 50]],
    })).resolves.toMatchObject({ type: "reject", code: "STROKE_NOT_FOUND" });

    await expect(send(socket, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: strokeId,
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({ type: "accepted", roomSeq: 1 });

    await expect(send(socket, {
      v: 1,
      op: "stroke.end",
      clientSeq: 3,
      id: strokeId,
    })).resolves.toMatchObject({ type: "reject", code: "OUT_OF_ORDER" });

    await expect(send(socket, {
      v: 1,
      op: "stroke.cancel",
      clientSeq: 2,
      id: strokeId,
    })).resolves.toMatchObject({ type: "accepted", roomSeq: 2 });

    await expect(send(socket, {
      v: 1,
      op: "stroke.append",
      clientSeq: 3,
      id: strokeId,
      points: [[30, 40, 100]],
    })).resolves.toMatchObject({ type: "reject", code: "STROKE_ALREADY_FINAL" });

    await expect(env.DRAWING_ROOM.getByName(roomId).stats()).resolves.toMatchObject({
      eventCount: 2,
      acceptedCount: 2,
      rejectCount: 3,
      activeStrokeCount: 0,
    });
    socket.close(1000, "test complete");
  });

  it("restores serialized attachment state after WebSocket hibernation", async () => {
    const roomId = "room-phase2-hibernation";
    const socket = await connect("connection-hibernation-test", 0, roomId);
    await nextMessage(socket);
    const stub = env.DRAWING_ROOM.getByName(roomId);
    await evictDurableObject(stub, { webSockets: "hibernate" });

    await expect(send(socket, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_phase2_hibernate_001",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 1,
      connectionId: "connection-hibernation-test",
    });
    await expect(stub.stats()).resolves.toMatchObject({
      eventCount: 1,
      activeStrokeCount: 1,
      connectionCount: 1,
    });
    socket.close(1000, "test complete");
  });

  it("keeps replay frames ordered ahead of a live event", async () => {
    const roomId = "room-phase2-live-catchup";
    const sender = await connect("connection-live-sender", 0, roomId);
    await nextMessage(sender);
    const stub = env.DRAWING_ROOM.getByName(roomId);

    await runInDurableObject(stub, (_instance, state) => {
      let totalBytes = 0;
      for (let index = 1; index <= 600; index += 1) {
        const event = {
          v: 1,
          op: "stroke.end",
          clientSeq: 1,
          id: `stroke_replay_${String(index).padStart(12, "0")}`,
        } as const satisfies ClientStrokeEvent;
        const encoded = encodeRoomEvent(event);
        const payload = new Uint8Array(encoded).buffer;
        totalBytes += payload.byteLength;
        state.storage.sql.exec(
          `INSERT INTO stroke_events (
            actor, connection_id, client_seq, stroke_id, op, payload,
            payload_bytes, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ACTOR_ID,
          `seed_connection_${String(index).padStart(8, "0")}`,
          1,
          event.id,
          event.op,
          payload,
          payload.byteLength,
          Date.now(),
        );
      }
      state.storage.sql.exec(
        "UPDATE room_metrics SET value = 600 WHERE name = 'accepted'",
      );
      state.storage.sql.exec(
        "UPDATE room_metrics SET value = ? WHERE name = 'payload_bytes'",
        totalBytes,
      );
    });

    const receiver = await connect("connection-live-receiver", 0, roomId);
    const firstReplay = nextMessage(receiver);
    const liveAck = send(sender, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_live_after_replay_01",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    });
    await expect(liveAck).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 601,
    });

    const replayedRoomSeqs: number[] = [];
    let message = await firstReplay;
    while (message.type !== "ready") {
      expect(message.type).toBe("replay");
      if (message.type === "replay") {
        replayedRoomSeqs.push(...message.events.map((event) => event.roomSeq));
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- replay order is the assertion.
      message = await nextMessage(receiver);
    }
    expect(message).toEqual({ type: "ready", roomSeq: 600 });
    expect(replayedRoomSeqs).toHaveLength(600);
    expect(replayedRoomSeqs[0]).toBe(1);
    expect(replayedRoomSeqs.at(-1)).toBe(600);
    await expect(nextMessage(receiver)).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 601,
    });
    sender.close(1000, "test complete");
    receiver.close(1000, "test complete");
  });

  it("enforces connection, event-rate, and room-activity safety limits", async () => {
    const capacityRoom = "room-phase2-capacity";
    const sockets = await Promise.all(
      Array.from({ length: 20 }, (_, index) => connect(
        `connection-capacity-${String(index).padStart(3, "0")}`,
        0,
        capacityRoom,
      )),
    );
    await Promise.all(sockets.map(nextMessage));
    const overCapacity = await exports.default.fetch(
      `http://example.test/rooms/${capacityRoom}/connect`
        + `?actor=${ACTOR_ID}&connection=connection-capacity-overflow`
        + `&canvasGeneration=${SNAPSHOT_CANVAS_GENERATION}`,
      {
        headers: {
          Origin: "http://localhost:3000",
          Upgrade: "websocket",
        },
      },
    );
    expect(overCapacity.status).toBe(429);
    await expect(overCapacity.json()).resolves.toEqual({
      error: "ROOM_CAPACITY_REACHED",
    });
    sockets.forEach((socket) => socket.close(1000, "test complete"));

    const rateRoom = "room-phase2-rate-limit";
    const rateSocket = await connect("connection-rate-limit", 0, rateRoom);
    await nextMessage(rateSocket);
    const rateStub = env.DRAWING_ROOM.getByName(rateRoom);
    await runInDurableObject(rateStub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE connections
         SET rate_tokens = 0, rate_updated_at = ?
         WHERE connection_id = ?`,
        Date.now(),
        "connection-rate-limit",
      );
    });
    const begin = {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_phase2_rate_limit_01",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    } as const satisfies ClientStrokeEvent;
    await expect(send(rateSocket, begin)).resolves.toMatchObject({
      type: "reject",
      code: "RATE_LIMITED",
      clientSeq: 1,
    });
    await runInDurableObject(rateStub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE connections
         SET rate_tokens = 0, rate_updated_at = ?
         WHERE connection_id = ?`,
        Date.now() - 1_000,
        "connection-rate-limit",
      );
    });
    await expect(send(rateSocket, {
      ...begin,
      clientSeq: 2,
      id: "stroke_phase2_rate_limit_02",
    })).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 1,
    });
    rateSocket.close(1000, "test complete");

    const activityRoom = "room-phase2-activity-limit";
    const activitySocket = await connect("connection-activity-limit", 0, activityRoom);
    await nextMessage(activitySocket);
    const activityStub = env.DRAWING_ROOM.getByName(activityRoom);
    await runInDurableObject(activityStub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_metrics SET value = 93000 WHERE name = 'accepted'",
      );
    });
    await expect(send(activitySocket, {
      ...begin,
      id: "stroke_phase2_activity_001",
    })).resolves.toMatchObject({
      type: "reject",
      code: "ROOM_LIMIT_REACHED",
      clientSeq: 1,
    });
    activitySocket.close(1000, "test complete");
  }, 15_000);

  it("escalates repeated rate violations from short mute to disconnect", async () => {
    const roomId = "room-phase6-rate-abuse";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const socket = await connect("connection-rate-abuse", 0, roomId);
    await nextMessage(socket);
    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE connections
         SET rate_tokens = 0, rate_updated_at = ?,
             chat_rate_tokens = 0, chat_rate_updated_at = ?
         WHERE connection_id = ?`,
        Date.now() + 60_000,
        Date.now() + 60_000,
        "connection-rate-abuse",
      );
    });
    const begin = {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_phase6_rate_abuse_01",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    } as const satisfies ClientStrokeEvent;

    const disconnected = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event), { once: true });
    });
    for (let index = 0; index < 2; index += 1) {
      const limited = nextMessageOfType(socket, "reject");
      socket.send(encodeClientChatMessage({
        v: 1,
        type: "chat.send",
        id: `chat-rate-abuse-${index}`,
        text: "rate abuse",
      }));
      // oxlint-disable-next-line no-await-in-loop -- combines chat and drawing strikes.
      await expect(limited).resolves.toMatchObject({
        code: "RATE_LIMITED",
      });
    }
    for (let index = 0; index < 6; index += 1) {
      const limited = nextMessageOfType(socket, "reject");
      socket.send(encodeEvent({
        ...begin,
        clientSeq: index + 1,
        id: `stroke_phase6_rate_abuse_${String(index).padStart(2, "0")}`,
      }, "messagepack"));
      // oxlint-disable-next-line no-await-in-loop -- verifies each escalation step.
      await expect(limited).resolves.toMatchObject({
        code: "RATE_LIMITED",
        clientSeq: index + 1,
      });
    }
    await expect(disconnected).resolves.toMatchObject({ code: 1008 });
    await expect(runInDurableObject(room, (_instance, state) => ({
      abuse: state.storage.sql.exec<{
        violation_count: number;
        muted_until: number;
        disconnected_at: number | null;
      }>(
        `SELECT violation_count, muted_until, disconnected_at
         FROM actor_abuse_state WHERE actor_id = ?`,
        ACTOR_ID,
      ).one(),
      metrics: Object.fromEntries(
        state.storage.sql.exec<{ name: string; value: number }>(
          `SELECT name, value FROM room_metrics
           WHERE name IN ('rate_limited', 'short_mute', 'abuse_disconnect')`,
        ).toArray().map((row) => [row.name, row.value]),
      ),
    }))).resolves.toMatchObject({
      abuse: {
        violation_count: 8,
        muted_until: expect.any(Number),
        disconnected_at: expect.any(Number),
      },
      metrics: {
        rate_limited: 8,
        short_mute: 1,
        abuse_disconnect: 1,
      },
    });

    const resumed = await connect("connection-rate-abuse-resumed", 0, roomId);
    await nextMessage(resumed);
    const resumedClose = new Promise<CloseEvent>((resolve) => {
      resumed.addEventListener(
        "close",
        (event) => resolve(event),
        { once: true },
      );
    });
    const stillMuted = nextMessageOfType(resumed, "reject");
    resumed.send(encodeEvent(begin, "messagepack"));
    await expect(stillMuted).resolves.toMatchObject({
      code: "RATE_LIMITED",
      clientSeq: 1,
    });
    await expect(resumedClose).resolves.toMatchObject({ code: 1008 });

    await runInDurableObject(room, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE actor_abuse_state
         SET violation_count = 0, window_started_at = 0,
             muted_until = 0, disconnected_at = NULL
         WHERE actor_id = ?`,
        ACTOR_ID,
      );
    });
    const recovered = await connect("connection-rate-abuse-recovered", 0, roomId);
    await nextMessage(recovered);
    await expect(send(recovered, begin)).resolves.toMatchObject({
      type: "accepted",
      roomSeq: 1,
    });
    recovered.close(1000, "test complete");
  });

  it("kicks an actor, permits manual re-entry, then room-bans that actor", async () => {
    const roomId = "room-member-removal-test";
    const actorId = "actor-member-removal-test";
    const room = env.DRAWING_ROOM.getByName(roomId);
    const open = async (connectionId: string): Promise<Response> => room.fetch(
      new Request("http://internal.test/connect", {
        headers: {
          Upgrade: "websocket",
          "x-koge-room-id": roomId,
          "x-koge-actor": actorId,
          "x-koge-connection": connectionId,
          "x-koge-role": "participant",
        },
      }),
    );
    const firstResponse = await open("connection-member-removal-first");
    expect(firstResponse.status).toBe(101);
    const first = firstResponse.webSocket!;
    attachInbox(first);
    first.accept();
    await expect(nextMessageOfType(first, "ready")).resolves.toMatchObject({
      roomSeq: 0,
    });
    await expect(room.activeRoomMembers()).resolves.toContainEqual({
      actorId,
      role: "participant",
    });

    const kicked = nextMessageOfType(first, "room.removed");
    await expect(room.moderateMember({
      v: 1,
      actionId: "moderation-kick-member-test",
      roomId,
      actorAdminId: "admin-member-removal-test",
      action: "kick",
      targetActorId: actorId,
      reason: "Temporary removal",
      requestedAt: Date.now(),
    })).resolves.toEqual({ disconnectedConnectionCount: 1 });
    await expect(kicked).resolves.toMatchObject({
      reason: "kicked",
      actionId: "moderation-kick-member-test",
    });

    const secondResponse = await open("connection-member-removal-second");
    expect(secondResponse.status).toBe(101);
    const second = secondResponse.webSocket!;
    attachInbox(second);
    second.accept();
    await expect(nextMessageOfType(second, "ready")).resolves.toMatchObject({
      roomSeq: 0,
    });
    const banned = nextMessageOfType(second, "room.removed");
    await expect(room.moderateMember({
      v: 1,
      actionId: "moderation-ban-member-test",
      roomId,
      actorAdminId: "admin-member-removal-test",
      action: "room_ban",
      targetActorId: actorId,
      reason: "Room safety",
      requestedAt: Date.now(),
    })).resolves.toEqual({ disconnectedConnectionCount: 1 });
    await expect(banned).resolves.toMatchObject({
      reason: "room_banned",
      actionId: "moderation-ban-member-test",
    });
    const blocked = await open("connection-member-removal-third");
    expect(blocked.status).toBe(403);
  });

  it("warns at activity thresholds and drains the active stroke before closing", async () => {
    const roomId = "room-phase6-activity-drain";
    const socket = await connect("connection-activity-drain", 0, roomId);
    await expect(nextMessage(socket)).resolves.toEqual({
      type: "ready",
      roomSeq: 0,
    });
    const room = env.DRAWING_ROOM.getByName(roomId);
    const setAcceptedBeforeThreshold = (level: 80 | 90 | 98 | 100) =>
      runInDurableObject(room, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE room_metrics SET value = ? WHERE name = 'accepted'",
          (ROOM_ACTIVITY_EVENT_LIMIT * level) / 100 - 1,
        );
      });

    await setAcceptedBeforeThreshold(80);
    await expect(send(socket, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_phase6_activity_drain_01",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [10, 20, 0],
    })).resolves.toMatchObject({ type: "accepted" });
    await expect(nextMessageOfType(socket, "room.activity")).resolves
      .toMatchObject({
        level: 80,
        eventCount: ROOM_ACTIVITY_EVENT_LIMIT * 0.8,
        acceptingNewStrokes: true,
      });

    for (const [level, clientSeq, dt] of [
      [90, 2, 10],
      [98, 3, 20],
      [100, 4, 30],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- verifies ordered thresholds.
      await setAcceptedBeforeThreshold(level);
      // oxlint-disable-next-line no-await-in-loop -- verifies ordered thresholds.
      await expect(send(socket, {
        v: 1,
        op: "stroke.append",
        clientSeq,
        id: "stroke_phase6_activity_drain_01",
        points: [[10 + clientSeq, 20 + clientSeq, dt]],
      })).resolves.toMatchObject({ type: "accepted" });
      // oxlint-disable-next-line no-await-in-loop -- verifies ordered thresholds.
      await expect(nextMessageOfType(socket, "room.activity")).resolves
        .toMatchObject({
          level,
          acceptingNewStrokes: level !== 100,
        });
    }

    await expect(send(socket, {
      v: 1,
      op: "stroke.begin",
      clientSeq: 5,
      id: "stroke_phase6_activity_drain_02",
      tool: "brush",
      color: "#336699",
      size: 12,
      opacity: 1,
      point: [30, 40, 0],
    })).resolves.toMatchObject({
      type: "reject",
      code: "ROOM_LIMIT_REACHED",
    });

    await expect(send(socket, {
      v: 1,
      op: "stroke.end",
      clientSeq: 5,
      id: "stroke_phase6_activity_drain_01",
    })).resolves.toMatchObject({ type: "accepted" });
    await expect(nextMessageOfType(socket, "room.updated")).resolves
      .toMatchObject({
      status: "closing",
      reason: "activity_limit",
    });
    await expect(nextMessageOfType(socket, "room.closed")).resolves.toMatchObject({
      reason: "activity_limit",
    });
    await expect(room.roomLifecycleState()).resolves.toMatchObject({
      status: "closing",
      reason: "activity_limit",
      finalizedStrokeCount: 0,
    });
  });
});
