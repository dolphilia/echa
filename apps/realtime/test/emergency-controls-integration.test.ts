import {
  ROOM_MAX_DURATION_MS,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_PROVISIONING_VERSION,
  ROOM_VIEWER_LIMIT,
  decodeServerMessage,
  encodeClientRoomStartMessage,
  encodeEvent,
  type ClientStrokeEvent,
  type ServerMessage,
} from "@koge/protocol";
import {
  applyD1Migrations,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, inject, it } from "vitest";

type Inbox = {
  messages: ServerMessage[];
  waiters: Array<{
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
  }>;
  decoding: Promise<void>;
};

const inboxes = new WeakMap<WebSocket, Inbox>();

function attachInbox(socket: WebSocket): void {
  const inbox: Inbox = { messages: [], waiters: [], decoding: Promise.resolve() };
  inboxes.set(socket, inbox);
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
            : null;
      if (!bytes) throw new TypeError("expected a binary frame");
      const message = decodeServerMessage(bytes);
      const waiter = inbox.waiters.shift();
      if (waiter) waiter.resolve(message);
      else inbox.messages.push(message);
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of inbox.waiters.splice(0)) waiter.reject(failure);
    });
  });
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  const inbox = inboxes.get(socket);
  if (!inbox) return Promise.reject(new Error("socket inbox is not attached"));
  const message = inbox.messages.shift();
  if (message) return Promise.resolve(message);
  return new Promise((resolve, reject) => {
    inbox.waiters.push({ resolve, reject });
  });
}

async function nextMessageOfType<T extends ServerMessage["type"]>(
  socket: WebSocket,
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- ordered protocol scan.
    const message = await nextMessage(socket);
    if (message.type === type) {
      return message as Extract<ServerMessage, { type: T }>;
    }
  }
}

it("discards ordered drawing frames while emergency drawing stop is active", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  await env.DB.prepare(
    `UPDATE service_controls
     SET revision = revision + 1, drawing_enabled = 0, updated_at = ?
     WHERE singleton = 1`,
  ).bind(Date.now()).run();

  const now = Date.now();
  const roomId = "room-emergency-drawing-test";
  const room = env.DRAWING_ROOM.getByName(roomId);
  await room.initializeRoom({
    v: ROOM_PROVISIONING_VERSION,
    roomId,
    publicSlug: "e".repeat(32),
    ownerUserId: "owner-emergency-drawing-test",
    name: "Emergency drawing test",
    theme: null,
    visibility: "public",
    participantLimit: ROOM_PARTICIPANT_LIMIT,
    viewerLimit: ROOM_VIEWER_LIMIT,
    viewerChatEnabled: false,
    viewerStampEnabled: false,
    createdAt: now,
    maxEndsAt: now + ROOM_MAX_DURATION_MS,
  });
  const response = await room.fetch(new Request("http://internal.test/connect", {
    headers: {
      Upgrade: "websocket",
      "x-koge-room-id": roomId,
      "x-koge-actor": "actor-emergency-drawing-test",
      "x-koge-connection": "connection-emergency-drawing-test",
      "x-koge-role": "host",
    },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  attachInbox(socket);
  socket.accept();
  await nextMessageOfType(socket, "ready");
  const started = nextMessageOfType(socket, "room.updated");
  socket.send(encodeClientRoomStartMessage({
    v: 1,
    type: "room.start",
    requestId: "start-emergency-drawing-test",
  }));
  await expect(started).resolves.toMatchObject({ status: "active" });

  const events = [
    {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_emergency_drawing_01",
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
      id: "stroke_emergency_drawing_01",
      points: [[20, 30, 10]],
    },
    {
      v: 1,
      op: "stroke.end",
      clientSeq: 3,
      id: "stroke_emergency_drawing_01",
    },
  ] as const satisfies readonly ClientStrokeEvent[];
  const rejected = events.map(() => nextMessageOfType(socket, "reject"));
  for (const event of events) {
    socket.send(encodeEvent(event, "messagepack"));
  }
  await expect(Promise.all(rejected)).resolves.toEqual(events.map((event) =>
    expect.objectContaining({
      code: "SERVICE_EMERGENCY_STOP",
      clientSeq: event.clientSeq,
    })
  ));
  await expect(runInDurableObject(room, (_instance, state) =>
    state.storage.sql.exec<{ last_client_seq: number }>(
      `SELECT last_client_seq FROM connections
       WHERE connection_id = 'connection-emergency-drawing-test'`,
    ).one().last_client_seq
  )).resolves.toBe(3);
  socket.close(1000, "test complete");
});

it("preserves a cold-cache drawing burst across the D1 control read", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  await env.DB.prepare(
    `UPDATE service_controls
     SET revision = revision + 1, drawing_enabled = 1, updated_at = ?
     WHERE singleton = 1`,
  ).bind(Date.now()).run();

  const now = Date.now();
  const roomId = "room-emergency-cold-cache-order";
  const room = env.DRAWING_ROOM.getByName(roomId);
  await room.initializeRoom({
    v: ROOM_PROVISIONING_VERSION,
    roomId,
    publicSlug: "d".repeat(32),
    ownerUserId: "owner-emergency-cold-cache-order",
    name: "Emergency cold cache order",
    theme: null,
    visibility: "public",
    participantLimit: ROOM_PARTICIPANT_LIMIT,
    viewerLimit: ROOM_VIEWER_LIMIT,
    viewerChatEnabled: false,
    viewerStampEnabled: false,
    createdAt: now,
    maxEndsAt: now + ROOM_MAX_DURATION_MS,
  });
  const response = await room.fetch(new Request("http://internal.test/connect", {
    headers: {
      Upgrade: "websocket",
      "x-koge-room-id": roomId,
      "x-koge-actor": "actor-emergency-cold-cache-order",
      "x-koge-connection": "connection-emergency-cold-cache-order",
      "x-koge-role": "host",
    },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  attachInbox(socket);
  socket.accept();
  await nextMessageOfType(socket, "ready");
  const started = nextMessageOfType(socket, "room.updated");
  socket.send(encodeClientRoomStartMessage({
    v: 1,
    type: "room.start",
    requestId: "start-emergency-cold-cache-order",
  }));
  await expect(started).resolves.toMatchObject({ status: "active" });

  const events = [
    {
      v: 1,
      op: "stroke.begin",
      clientSeq: 1,
      id: "stroke_emergency_cold_cache_order_01",
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
      id: "stroke_emergency_cold_cache_order_01",
      points: [[20, 30, 10]],
    },
    {
      v: 1,
      op: "stroke.end",
      clientSeq: 3,
      id: "stroke_emergency_cold_cache_order_01",
    },
  ] as const satisfies readonly ClientStrokeEvent[];
  const accepted = events.map(() => nextMessageOfType(socket, "accepted"));
  for (const event of events) {
    socket.send(encodeEvent(event, "messagepack"));
  }
  await expect(Promise.all(accepted)).resolves.toEqual(events.map((event) =>
    expect.objectContaining({
      event: expect.objectContaining({
        op: event.op,
        clientSeq: event.clientSeq,
      }),
    })
  ));
  await expect(runInDurableObject(room, (_instance, state) =>
    state.storage.sql.exec<{ last_client_seq: number }>(
      `SELECT last_client_seq FROM connections
       WHERE connection_id = 'connection-emergency-cold-cache-order'`,
    ).one().last_client_seq
  )).resolves.toBe(3);
  socket.close(1000, "test complete");
});

it("finalizes an active stroke when a hibernated room observes drawing stop", async () => {
  await applyD1Migrations(env.DB, inject("D1_MIGRATIONS"));
  await env.DB.prepare(
    `UPDATE service_controls
     SET revision = revision + 1, drawing_enabled = 1, updated_at = ?
     WHERE singleton = 1`,
  ).bind(Date.now()).run();
  const now = Date.now();
  const roomId = "room-emergency-active-stroke";
  let room = env.DRAWING_ROOM.getByName(roomId);
  await room.initializeRoom({
    v: ROOM_PROVISIONING_VERSION,
    roomId,
    publicSlug: "f".repeat(32),
    ownerUserId: "owner-emergency-active-stroke",
    name: "Emergency active stroke",
    theme: null,
    visibility: "public",
    participantLimit: ROOM_PARTICIPANT_LIMIT,
    viewerLimit: ROOM_VIEWER_LIMIT,
    viewerChatEnabled: false,
    viewerStampEnabled: false,
    createdAt: now,
    maxEndsAt: now + ROOM_MAX_DURATION_MS,
  });
  const response = await room.fetch(new Request("http://internal.test/connect", {
    headers: {
      Upgrade: "websocket",
      "x-koge-room-id": roomId,
      "x-koge-actor": "actor-emergency-active-stroke",
      "x-koge-connection": "connection-emergency-active-stroke",
      "x-koge-role": "host",
    },
  }));
  const socket = response.webSocket!;
  attachInbox(socket);
  socket.accept();
  await nextMessageOfType(socket, "ready");
  const started = nextMessageOfType(socket, "room.updated");
  socket.send(encodeClientRoomStartMessage({
    v: 1,
    type: "room.start",
    requestId: "start-emergency-active-stroke",
  }));
  await started;

  const begin = nextMessageOfType(socket, "accepted");
  socket.send(encodeEvent({
    v: 1,
    op: "stroke.begin",
    clientSeq: 1,
    id: "stroke_emergency_active_01",
    tool: "brush",
    color: "#336699",
    size: 12,
    opacity: 1,
    point: [10, 20, 0],
  }, "messagepack"));
  await expect(begin).resolves.toMatchObject({
    event: { op: "stroke.begin", clientSeq: 1 },
  });

  await env.DB.prepare(
    `UPDATE service_controls
     SET revision = revision + 1, drawing_enabled = 0, updated_at = ?
     WHERE singleton = 1`,
  ).bind(Date.now()).run();
  await evictDurableObject(room);
  room = env.DRAWING_ROOM.getByName(roomId);

  socket.send(encodeEvent({
    v: 1,
    op: "stroke.append",
    clientSeq: 2,
    id: "stroke_emergency_active_01",
    points: [[20, 30, 10]],
  }, "messagepack"));
  const finalized = await nextMessageOfType(socket, "accepted");
  expect(finalized).toMatchObject({
    event: {
      op: "stroke.end",
      id: "stroke_emergency_active_01",
      serverGenerated: true,
    },
  });
  await expect(nextMessageOfType(socket, "reject")).resolves.toMatchObject({
    code: "SERVICE_EMERGENCY_STOP",
    clientSeq: 2,
  });
  await expect(runInDurableObject(room, (_instance, state) =>
    state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM strokes WHERE status = 'active'`,
    ).one().count
  )).resolves.toBe(0);
  socket.close(1000, "test complete");
});
