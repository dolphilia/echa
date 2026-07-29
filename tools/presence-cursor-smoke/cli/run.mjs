import { decode } from "@msgpack/msgpack";
import process from "node:process";
import WebSocket from "ws";

function readArgument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new TypeError(`--${name} is required`);
  }
  return value;
}

function websocketOrigin(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

const inboxes = new WeakMap();

async function connect(url, origin) {
  const socket = new WebSocket(url, { origin });
  const inbox = { messages: [], waiters: [] };
  inboxes.set(socket, inbox);
  socket.on("message", (data) => {
    const message = decode(new Uint8Array(data));
    const waiter = inbox.waiters.shift();
    if (waiter) waiter.resolve(message);
    else inbox.messages.push(message);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket connection timed out"));
    }, 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`WebSocket upgrade returned ${response.statusCode}`));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

async function waitFor(socket, predicate) {
  const inbox = inboxes.get(socket);
  if (!inbox) throw new Error("WebSocket inbox is unavailable");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const queuedIndex = inbox.messages.findIndex(predicate);
    if (queuedIndex >= 0) return inbox.messages.splice(queuedIndex, 1)[0];
    const message = await new Promise((resolve, reject) => {
      const waiter = {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject,
      };
      const timer = setTimeout(() => {
        const index = inbox.waiters.indexOf(waiter);
        if (index >= 0) inbox.waiters.splice(index, 1);
        reject(new Error("WebSocket message timed out"));
      }, Math.max(1, deadline - Date.now()));
      inbox.waiters.push(waiter);
    });
    if (predicate(message)) return message;
    inbox.messages.push(message);
  }
  throw new Error("WebSocket message timed out");
}

const appOrigin = readArgument("app-origin");
const realtimeOrigin = readArgument("realtime-origin");
const roomSlug = readArgument("room");
if (!/^[a-f0-9]{32}$/.test(roomSlug)) {
  throw new TypeError("--room must be a 32-character lowercase hex slug");
}

async function issueTicket() {
  const response = await fetch(
    `${appOrigin}/api/rooms/${roomSlug}/tickets`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
      },
      body: JSON.stringify({ role: "viewer" }),
    },
  );
  if (response.status !== 201) {
    throw new Error(`ticket request returned ${response.status}`);
  }
  const ticket = await response.json();
  if (
    typeof ticket?.ticket !== "string"
    || typeof ticket?.actorId !== "string"
  ) {
    throw new TypeError("ticket response is invalid");
  }
  return ticket;
}

function connectionUrl(ticket) {
  const url = new URL(
    `/rooms/${roomSlug}/connect`,
    websocketOrigin(realtimeOrigin),
  );
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("lastRoomSeq", "0");
  url.searchParams.set("rendererVersion", "1");
  url.searchParams.set("snapshot", "1");
  return url;
}

const firstTicket = await issueTicket();
const secondTicket = await issueTicket();
const first = await connect(connectionUrl(firstTicket.ticket), appOrigin);
await waitFor(first, (message) => (
  message?.type === "presence" && message.members?.length === 1
));
const second = await connect(connectionUrl(secondTicket.ticket), appOrigin);
await Promise.all([
  waitFor(first, (message) => (
    message?.type === "presence" && message.members?.length === 2
  )),
  waitFor(second, (message) => (
    message?.type === "presence" && message.members?.length === 2
  )),
]);

second.send(JSON.stringify({
  v: 1,
  type: "cursor",
  visible: true,
  x: 120,
  y: 240,
}));
const cursor = await waitFor(first, (message) => (
  message?.type === "cursor"
  && message.actor === secondTicket.actorId
  && message.visible === true
));
const leave = waitFor(first, (message) => (
  message?.type === "presence" && message.members?.length === 1
));
second.close(1000, "smoke complete");
await leave;
first.close(1000, "smoke complete");

console.log(JSON.stringify({
  schema: "koge.presence-cursor-smoke.v1",
  roomSlug,
  twoMemberPresence: true,
  viewerCursorBroadcast: cursor.x === 120 && cursor.y === 240,
  leavePresence: true,
}, null, 2));
