import {
  decodeServerMessage,
  type ServerMessage,
  type SnapshotOfferMessage,
} from "@koge/protocol";
import { fetchVerifiedSnapshot } from "../../apps/web/app/snapshot-recovery";
import WebSocket, { type RawData } from "ws";

const ROOM_PATTERN = /^snapshot-probe-[a-f0-9]{16}$/;
const JOB_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const roomId = process.argv[2];
const option = process.argv[3];
if (!roomId || !ROOM_PATTERN.test(roomId)) {
  throw new TypeError(
    "usage: node --import tsx recover.mts snapshot-probe-<16 hex>"
      + " [excluded-current-job-id|disabled]",
  );
}
if (
  option !== undefined
  && option !== "disabled"
  && !JOB_PATTERN.test(option)
) {
  throw new TypeError("snapshot exclusion must be a valid job id");
}

const url = new URL(
  `wss://realtime-preview.koge.app/rooms/${roomId}/connect`,
);
url.searchParams.set("actor", "snapshot_recovery_probe_actor");
url.searchParams.set(
  "connection",
  `snapshot_recovery_probe_${crypto.randomUUID().replaceAll("-", "")}`,
);
url.searchParams.set("lastRoomSeq", "0");
url.searchParams.set("rendererVersion", option === "disabled" ? "0" : "1");
url.searchParams.set("snapshot", option === "disabled" ? "0" : "1");
if (option && option !== "disabled") {
  url.searchParams.set("snapshotExcludeJobs", option);
}

const socket = new WebSocket(url, {
  origin: "https://preview.koge.app",
  perMessageDeflate: false,
});

if (option === "disabled") {
  const status = await new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => reject(new Error("connection unexpectedly opened")));
    socket.once("error", reject);
  });
  if (status !== 409) {
    throw new Error(`expected HTTP 409, got ${status}`);
  }
  socket.terminate();
  console.log(JSON.stringify({ roomId, snapshotRecovery: false, status }));
} else {
  const messages: ServerMessage[] = [];
  const waiters: Array<(message: ServerMessage) => void> = [];
  socket.on("message", (data: RawData) => {
    const bytes = Array.isArray(data)
      ? new Uint8Array(Buffer.concat(data))
      : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const message = decodeServerMessage(bytes);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const nextMessage = (): Promise<ServerMessage> => {
    const message = messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WebSocket timeout")),
        30_000,
      );
      waiters.push((value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
  };
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const first = await nextMessage();
  if (first.type !== "snapshot") {
    throw new Error(`expected snapshot, got ${first.type}`);
  }
  const fetchWithOrigin: typeof fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Origin", "https://preview.koge.app");
    return fetch(input, { ...init, headers });
  };
  const verified = await fetchVerifiedSnapshot(
    first as SnapshotOfferMessage,
    "wss://realtime-preview.koge.app",
    fetchWithOrigin,
  );
  let replayEventCount = 0;
  let firstReplayRoomSeq: number | undefined;
  let lastReplayRoomSeq = verified.baseRoomSeq;
  let readyRoomSeq: number | undefined;
  while (readyRoomSeq === undefined) {
    // oxlint-disable-next-line no-await-in-loop -- replay order must be observed.
    const message = await nextMessage();
    if (message.type === "replay") {
      replayEventCount += message.events.length;
      firstReplayRoomSeq ??= message.events[0]?.roomSeq;
      lastReplayRoomSeq =
        message.events.at(-1)?.roomSeq ?? lastReplayRoomSeq;
    } else if (message.type === "ready") {
      readyRoomSeq = message.roomSeq;
    } else {
      throw new Error(`unexpected ${message.type} during recovery`);
    }
  }
  if (lastReplayRoomSeq !== readyRoomSeq) {
    throw new Error("snapshot tail did not reach the ready sequence");
  }
  socket.close(1000, "snapshot recovery probe complete");
  console.log(JSON.stringify({
    roomId,
    snapshotJobId: first.manifest.jobId,
    snapshotBaseRoomSeq: verified.baseRoomSeq,
    rgbaBytes: verified.rgba.byteLength,
    replayEventCount,
    firstReplayRoomSeq,
    lastReplayRoomSeq,
    readyRoomSeq,
  }));
}
