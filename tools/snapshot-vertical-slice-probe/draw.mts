import {
  decodeServerMessage,
  encodeEvent,
  SNAPSHOT_CANVAS_GENERATION,
  type ClientStrokeEvent,
  type ServerMessage,
} from "@koge/protocol";
import WebSocket, { type RawData } from "ws";

const roomId = process.argv[2];
const resumeAfterRoomSeq = Number(process.argv[3] ?? "0");
if (!roomId || !/^snapshot-probe-[a-f0-9]{16}$/.test(roomId)) {
  throw new TypeError(
    "usage: node --import tsx draw.mts snapshot-probe-<16 hex> [resumeAfterRoomSeq]",
  );
}
if (!Number.isSafeInteger(resumeAfterRoomSeq) || resumeAfterRoomSeq < 0) {
  throw new TypeError("resumeAfterRoomSeq must be a non-negative safe integer");
}

const actor = "snapshot_probe_actor";
const connection = `snapshot_probe_${crypto.randomUUID().replaceAll("-", "")}`;
const url = new URL(
  `wss://realtime-preview.koge.app/rooms/${roomId}/connect`,
);
url.searchParams.set("actor", actor);
url.searchParams.set("connection", connection);
url.searchParams.set("lastRoomSeq", String(resumeAfterRoomSeq));
url.searchParams.set("rendererVersion", "0");
url.searchParams.set("canvasGeneration", String(SNAPSHOT_CANVAS_GENERATION));
url.searchParams.set("snapshot", "0");

const socket = new WebSocket(url, {
  origin: "https://preview.koge.app",
});
const messages: ServerMessage[] = [];
const waiters: Array<(message: ServerMessage) => void> = [];

socket.on("message", (data: RawData) => {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const message = decodeServerMessage(bytes);
  const waiter = waiters.shift();
  if (waiter) waiter(message);
  else messages.push(message);
});

function nextMessage(): Promise<ServerMessage> {
  const message = messages.shift();
  if (message) return Promise.resolve(message);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket timeout")), 10_000);
    waiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

await new Promise<void>((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
let ready: Extract<ServerMessage, { type: "ready" }> | undefined;
while (!ready) {
  // oxlint-disable-next-line no-await-in-loop -- replay must finish before new input.
  const message = await nextMessage();
  if (message.type === "ready") {
    ready = message;
  } else if (message.type !== "replay") {
    throw new Error(`expected replay or ready, got ${message.type}`);
  }
}

const strokeId = `stroke_probe_${crypto.randomUUID().replaceAll("-", "")}`;
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
    points: [[150, 130, 50], [200, 180, 100]],
  },
  {
    v: 1,
    op: "stroke.end",
    clientSeq: 3,
    id: strokeId,
  },
] as const satisfies readonly ClientStrokeEvent[];

for (const event of events) {
  socket.send(encodeEvent(event, "messagepack"));
  // oxlint-disable-next-line no-await-in-loop -- stroke lifecycle order is required.
  const accepted = await nextMessage();
  if (accepted.type !== "accepted") {
    throw new Error(`event was not accepted: ${JSON.stringify(accepted)}`);
  }
}
socket.terminate();
console.log(JSON.stringify({
  roomId,
  firstRoomSeq: ready.roomSeq + 1,
  lastRoomSeq: ready.roomSeq + events.length,
  eventCount: events.length,
}));
