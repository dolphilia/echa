import { SNAPSHOT_CANVAS_GENERATION } from "@koge/protocol";
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

async function connectOnce(url, origin) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket connection timed out"));
    }, 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.terminate();
      resolve({ status: 101 });
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      resolve({ status: response.statusCode });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const appOrigin = readArgument("app-origin");
const realtimeOrigin = readArgument("realtime-origin");
const roomSlug = readArgument("room");
if (!/^[a-f0-9]{32}$/.test(roomSlug)) {
  throw new TypeError("--room must be a 32-character lowercase hex slug");
}

async function issueTicket(cookie) {
  const response = await fetch(
    `${appOrigin}/api/rooms/${roomSlug}/tickets`,
    {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: appOrigin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ role: "viewer" }),
  },
  );
  if (response.status !== 201) {
    throw new Error(`ticket request returned ${response.status}`);
  }
  const ticket = await response.json();
  if (
    typeof ticket !== "object"
    || ticket === null
    || typeof ticket.ticket !== "string"
    || !/^[a-f0-9]{64}$/.test(ticket.ticket)
    || typeof ticket.actorId !== "string"
    || typeof ticket.connectionId !== "string"
  ) {
    throw new TypeError("ticket response is invalid");
  }
  const setCookie = response.headers.get("set-cookie");
  return {
    ticket,
    cookie: setCookie?.split(";", 1)[0] ?? cookie,
  };
}

function ticketConnectUrl(ticket) {
  const url = new URL(
    `/rooms/${roomSlug}/connect`,
    websocketOrigin(realtimeOrigin),
  );
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("lastRoomSeq", "0");
  url.searchParams.set("rendererVersion", "1");
  url.searchParams.set("canvasGeneration", String(SNAPSHOT_CANVAS_GENERATION));
  url.searchParams.set("snapshot", "1");
  return url;
}

const first = await issueTicket();
const firstConnectUrl = ticketConnectUrl(first.ticket.ticket);
const accepted = await connectOnce(firstConnectUrl, appOrigin);
const replayed = await connectOnce(firstConnectUrl, appOrigin);
if (accepted.status !== 101 || replayed.status !== 401) {
  throw new Error(
    `unexpected ticket results: accepted=${accepted.status}, replayed=${replayed.status}`,
  );
}
if (!first.cookie) {
  throw new Error("guest session cookie was not issued");
}
const recovered = await issueTicket(first.cookie);
const recoveredConnection = await connectOnce(
  ticketConnectUrl(recovered.ticket.ticket),
  appOrigin,
);
const sameActor = first.ticket.actorId === recovered.ticket.actorId;
const newConnection = (
  first.ticket.connectionId !== recovered.ticket.connectionId
);
if (
  recoveredConnection.status !== 101
  || !sameActor
  || !newConnection
) {
  throw new Error(
    "short disconnect recovery did not preserve actor with a new connection",
  );
}

console.log(JSON.stringify({
  schema: "koge.room-ticket-smoke.v1",
  roomSlug,
  issuedRole: first.ticket.role,
  acceptedStatus: accepted.status,
  replayedStatus: replayed.status,
  singleUseEnforced: true,
  recoveredStatus: recoveredConnection.status,
  sameActor,
  newConnection,
}, null, 2));
