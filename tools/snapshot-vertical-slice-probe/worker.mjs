import {
  decodeServerMessage,
  decodeSnapshot,
  encodeClientRoomStartMessage,
  encodeEvent,
  PROTOCOL_LIMITS,
  ROOM_MAX_DURATION_MS,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_PROVISIONING_VERSION,
  ROOM_VIEWER_LIMIT,
  SNAPSHOT_CANVAS_GENERATION,
} from "@koge/protocol";

const ROOM_PATTERN = /^snapshot-probe-[a-f0-9]{16}$/;

async function socketBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (
    typeof data === "object"
    && data !== null
    && "arrayBuffer" in data
    && typeof data.arrayBuffer === "function"
  ) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new TypeError(
    `probe received unsupported message data: ${typeof data}`,
  );
}

function socketInbox(socket) {
  const messages = [];
  const waiters = [];
  socket.addEventListener("message", async (event) => {
    try {
      const message = decodeServerMessage(await socketBytes(event.data));
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    } catch (error) {
      const waiter = waiters.shift();
      if (waiter) waiter.reject(error);
    }
  });
  return () => {
    const message = messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("probe WebSocket timed out"));
      }, 10_000);
      waiters.push({
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  };
}

async function socketMessageOfType(nextMessage, type) {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- messages are ordered.
    const message = await nextMessage();
    if (message.type === type) return message;
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function connectProbeSocket(room, roomId, {
  actor,
  rendererVersion,
  snapshotRecovery,
}) {
  const connectionId =
    `snapshot_probe_${crypto.randomUUID().replaceAll("-", "")}`;
  const response = await room.fetch(new Request(
    "https://drawing-room.internal/connect",
    {
      headers: {
        Upgrade: "websocket",
        "x-koge-room-id": roomId,
        "x-koge-actor": actor,
        "x-koge-connection": connectionId,
        "x-koge-role": "host",
        "x-koge-last-room-seq": "0",
        "x-koge-renderer-version": String(rendererVersion),
        "x-koge-canvas-generation": String(SNAPSHOT_CANVAS_GENERATION),
        "x-koge-snapshot-recovery": snapshotRecovery ? "1" : "0",
        "x-koge-snapshot-exclude-jobs": "",
      },
    },
  ));
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`probe connection returned ${response.status}`);
  }
  const socket = response.webSocket;
  const nextMessage = socketInbox(socket);
  socket.accept();
  return { socket, nextMessage };
}

async function startProbeRoom(room, roomId) {
  const { socket, nextMessage } = await connectProbeSocket(room, roomId, {
    actor: "snapshot_probe_actor",
    rendererVersion: 1,
    snapshotRecovery: false,
  });
  const ready = await socketMessageOfType(nextMessage, "ready");
  const lifecycle = await room.roomLifecycleState();
  if (lifecycle.status === "waiting") {
    socket.send(encodeClientRoomStartMessage({
      v: 1,
      type: "room.start",
      requestId: `start_${crypto.randomUUID().replaceAll("-", "")}`,
    }));
    await socketMessageOfType(nextMessage, "room.updated");
  }
  return { socket, nextMessage, ready };
}

async function drawProbeStroke(room, roomId) {
  const { socket, nextMessage, ready } = await startProbeRoom(room, roomId);
  const strokeId =
    `stroke_probe_${crypto.randomUUID().replaceAll("-", "")}`;
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
      point: [100, 100, 0],
    },
    {
      v: 1,
      op: "stroke.append",
      clientSeq: 2,
      id: strokeId,
      points: [[500, 300, 50], [900, 900, 100]],
    },
    {
      v: 1,
      op: "stroke.end",
      clientSeq: 3,
      id: strokeId,
    },
  ];
  for (const event of events) {
    const accepted = socketMessageOfType(nextMessage, "accepted");
    socket.send(encodeEvent(event, "messagepack"));
    // oxlint-disable-next-line no-await-in-loop -- stroke order is required.
    await accepted;
  }
  socket.close(1000, "probe complete");
  return {
    firstRoomSeq: ready.roomSeq + 1,
    lastRoomSeq: ready.roomSeq + events.length,
    eventCount: events.length,
  };
}

async function fillProbeEvents(room, roomId, {
  eventCount,
  connectionCount,
  eventsPerSecond,
}) {
  if (
    !Number.isSafeInteger(eventCount)
    || eventCount < 3
    || eventCount > 60_000
    || eventCount % 3 !== 0
  ) {
    throw new TypeError("events must be a multiple of 3 from 3 to 60000");
  }
  if (
    !Number.isSafeInteger(connectionCount)
    || connectionCount < 1
    || connectionCount > 20
  ) {
    throw new TypeError("connections must be an integer from 1 to 20");
  }
  if (
    !Number.isFinite(eventsPerSecond)
    || eventsPerSecond < 1
    || eventsPerSecond > 70
  ) {
    throw new TypeError("rate must be from 1 to 70 events/s per connection");
  }

  const strokeCount = eventCount / 3;
  const baseStrokes = Math.floor(strokeCount / connectionCount);
  const extraStrokes = strokeCount % connectionCount;
  const startedAt = Date.now();
  const clients = await Promise.all(
    Array.from({ length: connectionCount }, async (_, index) => {
      const actor = `snapshot_fill_actor_${index}`;
      const { socket, nextMessage } = await connectProbeSocket(room, roomId, {
        actor,
        rendererVersion: 1,
        snapshotRecovery: false,
      });
      const ready = await socketMessageOfType(nextMessage, "ready");
      return { socket, nextMessage, ready, actor };
    }),
  );
  const eventIntervalMs = 1_000 / eventsPerSecond;
  const sentByConnection = await Promise.all(clients.map(async (
    client,
    connectionIndex,
  ) => {
    const assignedStrokes =
      baseStrokes + (connectionIndex < extraStrokes ? 1 : 0);
    const assignedEvents = assignedStrokes * 3;
    let clientSeq = 0;
    const acceptedAll = (async () => {
      let acceptedCount = 0;
      while (acceptedCount < assignedEvents) {
        // oxlint-disable-next-line no-await-in-loop -- acknowledgements are drained in protocol order.
        const message = await client.nextMessage();
        if (message.type === "reject") {
          throw new Error(
            `probe event rejected: ${message.code} ${message.message}`,
          );
        }
        if (
          message.type === "accepted"
          && message.actor === client.actor
        ) {
          acceptedCount += 1;
        }
      }
    })();
    for (let strokeIndex = 0; strokeIndex < assignedStrokes; strokeIndex += 1) {
      const strokeId =
        `fill_${connectionIndex}_${strokeIndex}_`
        + crypto.randomUUID().replaceAll("-", "");
      const offset = (strokeIndex + connectionIndex * 17) % 800;
      const events = [
        {
          v: 1,
          op: "stroke.begin",
          clientSeq: ++clientSeq,
          id: strokeId,
          tool: "brush",
          color: "#336699",
          size: 3,
          opacity: 1,
          point: [100 + offset, 100 + (offset % 700), 0],
        },
        {
          v: 1,
          op: "stroke.append",
          clientSeq: ++clientSeq,
          id: strokeId,
          points: [[101 + offset, 101 + (offset % 700), 16]],
        },
        {
          v: 1,
          op: "stroke.end",
          clientSeq: ++clientSeq,
          id: strokeId,
        },
      ];
      for (const event of events) {
        client.socket.send(encodeEvent(event, "messagepack"));
        // oxlint-disable-next-line no-await-in-loop -- explicit pacing avoids exercising abuse controls.
        await new Promise((resolve) => setTimeout(resolve, eventIntervalMs));
      }
    }
    await acceptedAll;
    client.socket.close(1000, "probe fill complete");
    return clientSeq;
  }));
  return {
    eventCount: sentByConnection.reduce((sum, count) => sum + count, 0),
    connectionCount,
    eventsPerSecond,
    startedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    initialRoomSeq: Math.min(...clients.map(({ ready }) => ready.roomSeq)),
    sentByConnection,
  };
}

async function recoverProbeSnapshot(room, roomId) {
  const { socket, nextMessage } = await connectProbeSocket(room, roomId, {
    actor: "snapshot_recovery_probe_actor",
    rendererVersion: 1,
    snapshotRecovery: true,
  });
  const offer = await socketMessageOfType(nextMessage, "snapshot");
  const snapshotUrl =
    `https://realtime-preview.koge.app/rooms/${roomId}`
    + `/snapshots/${offer.manifest.jobId}`;
  const response = await fetch(snapshotUrl, {
    headers: {
      Authorization: `KogeSnapshot ${offer.readToken}`,
      Origin: "https://preview.koge.app",
    },
  });
  if (!response.ok) {
    throw new Error(`snapshot fetch returned ${response.status}`);
  }
  const objectBytes = new Uint8Array(await response.arrayBuffer());
  const objectHash = await sha256Hex(objectBytes);
  if (
    objectBytes.byteLength !== offer.manifest.objectBytes
    || objectHash !== offer.manifest.objectHash
  ) {
    throw new Error("snapshot object integrity mismatch");
  }
  const decoded = await decodeSnapshot(objectBytes);
  const rgbaHash = await sha256Hex(decoded.rgba);
  if (
    decoded.width !== PROTOCOL_LIMITS.canvasWidth
    || decoded.height !== PROTOCOL_LIMITS.canvasHeight
    || rgbaHash !== offer.manifest.rgbaHash
  ) {
    throw new Error("snapshot RGBA integrity mismatch");
  }
  let replayEventCount = 0;
  let readyRoomSeq;
  while (readyRoomSeq === undefined) {
    // oxlint-disable-next-line no-await-in-loop -- replay order is required.
    const message = await nextMessage();
    if (message.type === "replay") {
      replayEventCount += message.events.length;
    } else if (message.type === "ready") {
      readyRoomSeq = message.roomSeq;
    }
  }
  socket.close(1000, "probe recovery complete");
  return {
    snapshotJobId: offer.manifest.jobId,
    snapshotBaseRoomSeq: offer.manifest.baseRoomSeq,
    width: decoded.width,
    height: decoded.height,
    objectBytes: objectBytes.byteLength,
    rgbaBytes: decoded.rgba.byteLength,
    objectHash,
    rgbaHash,
    replayEventCount,
    readyRoomSeq,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("room");
    if (!roomId || !ROOM_PATTERN.test(roomId)) {
      return Response.json({ error: "INVALID_PROBE_ROOM" }, { status: 400 });
    }
    const room = env.DRAWING_ROOM.getByName(roomId);
    if (request.method === "POST" && url.pathname === "/run") {
      return Response.json(await room.requestSnapshot(roomId), { status: 202 });
    }
    if (request.method === "POST" && url.pathname === "/initialize") {
      const publicSlug = url.searchParams.get("slug");
      const visibility = url.searchParams.get("visibility") ?? "public";
      if (!publicSlug || !/^[a-f0-9]{32}$/.test(publicSlug)) {
        return Response.json({ error: "INVALID_PUBLIC_SLUG" }, { status: 400 });
      }
      if (visibility !== "public" && visibility !== "unlisted") {
        return Response.json({ error: "INVALID_VISIBILITY" }, { status: 400 });
      }
      const createdAt = Date.now();
      return Response.json(await room.initializeRoom({
        v: ROOM_PROVISIONING_VERSION,
        roomId,
        publicSlug,
        ownerUserId: "snapshot_probe_owner",
        name: "thumbnail timing probe",
        visibility,
        participantLimit: ROOM_PARTICIPANT_LIMIT,
        viewerLimit: ROOM_VIEWER_LIMIT,
        viewerChatEnabled: false,
        viewerStampEnabled: false,
        createdAt,
        maxEndsAt: createdAt + ROOM_MAX_DURATION_MS,
      }), { status: 201 });
    }
    if (request.method === "POST" && url.pathname === "/start") {
      const { socket, ready } = await startProbeRoom(room, roomId);
      socket.close(1000, "probe start complete");
      return Response.json({ roomSeq: ready.roomSeq }, { status: 201 });
    }
    if (request.method === "POST" && url.pathname === "/run-close") {
      const job = await room.requestSnapshot(roomId);
      const close = await room.beginRoomClose({
        closeRequestId: `close_${crypto.randomUUID().replaceAll("-", "")}`,
        reason: "probe",
      });
      return Response.json({ job, close }, { status: 202 });
    }
    if (request.method === "POST" && url.pathname === "/draw") {
      try {
        return Response.json(await drawProbeStroke(room, roomId), {
          status: 201,
        });
      } catch (error) {
        return Response.json({
          error: "PROBE_DRAW_FAILED",
          message: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/fill") {
      try {
        return Response.json(await fillProbeEvents(room, roomId, {
          eventCount: Number(url.searchParams.get("events")),
          connectionCount: Number(url.searchParams.get("connections") ?? "20"),
          eventsPerSecond: Number(url.searchParams.get("rate") ?? "30"),
        }), { status: 201 });
      } catch (error) {
        return Response.json({
          error: "PROBE_FILL_FAILED",
          message: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/recover") {
      try {
        return Response.json(await recoverProbeSnapshot(room, roomId));
      } catch (error) {
        return Response.json({
          error: "PROBE_RECOVERY_FAILED",
          message: error instanceof Error ? error.message : String(error),
        }, { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        lifecycle: await room.roomLifecycleState(),
        manifest: await room.currentSnapshot() ?? null,
        compaction: await room.snapshotCompactionState(),
        automation: await room.snapshotAutomationState(),
        stats: await room.stats(),
      });
    }
    if (request.method === "GET" && url.pathname === "/thumbnail-objects") {
      const page = await env.ROOM_THUMBNAILS.list({
        prefix: `rooms/${roomId}/thumbnails/`,
      });
      return Response.json({
        truncated: page.truncated,
        objects: page.objects.map(({ key, size }) => ({ key, size })),
      });
    }
    if (request.method === "GET" && url.pathname === "/runtime-objects") {
      const page = await env.RUNTIME_SNAPSHOTS.list({
        prefix: `rooms/${roomId}/snapshots/`,
      });
      return Response.json({
        truncated: page.truncated,
        objects: page.objects.map(({ key, size }) => ({ key, size })),
      });
    }
    if (request.method === "GET" && url.pathname === "/thumbnail-head") {
      const sequence = Number(url.searchParams.get("seq"));
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        return Response.json({ error: "INVALID_SEQUENCE" }, { status: 400 });
      }
      const key = `rooms/${roomId}/thumbnails/${sequence}.png`;
      const object = await env.ROOM_THUMBNAILS.head(key);
      return Response.json({
        key,
        exists: object !== null,
        ...(object ? { size: object.size, etag: object.etag } : {}),
      });
    }
    if (request.method === "POST" && url.pathname === "/compact") {
      const manifest = await room.currentSnapshot();
      if (!manifest) {
        return Response.json({ error: "SNAPSHOT_NOT_READY" }, { status: 409 });
      }
      const limit = Number(url.searchParams.get("limit") ?? "500");
      return Response.json(
        await room.compactSnapshotEvents(manifest.jobId, limit),
      );
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
};
