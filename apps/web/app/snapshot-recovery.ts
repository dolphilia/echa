import {
  PROTOCOL_LIMITS,
  SNAPSHOT_RENDERER_VERSION,
  decodeSnapshot,
  type SnapshotOfferMessage,
} from "@koge/protocol";

export const MAX_SNAPSHOT_BYTES =
  PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4 + 65_536;

export type VerifiedSnapshot = {
  readonly baseRoomSeq: number;
  readonly rgba: Uint8Array;
  readonly timings: SnapshotVerificationTimings;
};

export type SnapshotVerificationTimings = {
  readonly fetchMs: number;
  readonly bodyReadMs: number;
  readonly objectHashMs: number;
  readonly decodeMs: number;
  readonly rgbaHashMs: number;
  readonly totalMs: number;
  readonly objectBytes: number;
  readonly rgbaBytes: number;
};

export type SnapshotFallbackState = {
  readonly failedJobIds: readonly string[];
  readonly snapshotRecoveryDisabled: boolean;
};

type SnapshotRecoveryOptions = {
  readonly offer: SnapshotOfferMessage;
  readonly realtimeOrigin: string;
  readonly applySnapshot: (snapshot: VerifiedSnapshot) => void | Promise<void>;
  readonly fallbackToEventLog: (error: unknown) => void | Promise<void>;
  readonly fetchSnapshot?: typeof fetch;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function websocketToHttpOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  else throw new TypeError("realtime origin must use ws or wss");
  return url.origin;
}

export async function fetchVerifiedSnapshot(
  offer: SnapshotOfferMessage,
  realtimeOrigin: string,
  fetchSnapshot: typeof fetch = fetch,
): Promise<VerifiedSnapshot> {
  const startedAt = performance.now();
  const { manifest } = offer;
  if (
    manifest.rendererVersion !== SNAPSHOT_RENDERER_VERSION
    || manifest.width !== PROTOCOL_LIMITS.canvasWidth
    || manifest.height !== PROTOCOL_LIMITS.canvasHeight
    || manifest.objectBytes > MAX_SNAPSHOT_BYTES
  ) {
    throw new RangeError("snapshot offer is incompatible");
  }

  const snapshotUrl = new URL(
    `/rooms/${encodeURIComponent(manifest.roomId)}`
      + `/snapshots/${encodeURIComponent(manifest.jobId)}`,
    websocketToHttpOrigin(realtimeOrigin),
  );
  const fetchStartedAt = performance.now();
  const response = await fetchSnapshot(snapshotUrl, {
    headers: {
      Authorization: `KogeSnapshot ${offer.readToken}`,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`snapshot fetch failed: ${response.status}`);
  }
  const responseReceivedAt = performance.now();
  const contentLength = Number(response.headers.get("content-length"));
  if (
    !Number.isSafeInteger(contentLength)
    || contentLength !== manifest.objectBytes
  ) {
    throw new RangeError("snapshot content length mismatch");
  }
  const objectBytes = new Uint8Array(await response.arrayBuffer());
  const bodyReadAt = performance.now();
  const objectHashStartedAt = performance.now();
  const objectHash = await sha256Hex(objectBytes);
  const objectHashCompletedAt = performance.now();
  if (
    objectBytes.byteLength !== manifest.objectBytes
    || objectBytes.byteLength > MAX_SNAPSHOT_BYTES
    || objectHash !== manifest.objectHash
  ) {
    throw new Error("snapshot object integrity check failed");
  }
  const decodeStartedAt = performance.now();
  const decoded = await decodeSnapshot(objectBytes);
  const decodeCompletedAt = performance.now();
  const rgbaHashStartedAt = performance.now();
  const rgbaHash = await sha256Hex(decoded.rgba);
  const rgbaHashCompletedAt = performance.now();
  if (
    decoded.rendererVersion !== manifest.rendererVersion
    || decoded.width !== manifest.width
    || decoded.height !== manifest.height
    || rgbaHash !== manifest.rgbaHash
  ) {
    throw new Error("snapshot RGBA integrity check failed");
  }
  return {
    baseRoomSeq: manifest.baseRoomSeq,
    rgba: decoded.rgba,
    timings: {
      fetchMs: responseReceivedAt - fetchStartedAt,
      bodyReadMs: bodyReadAt - responseReceivedAt,
      objectHashMs: objectHashCompletedAt - objectHashStartedAt,
      decodeMs: decodeCompletedAt - decodeStartedAt,
      rgbaHashMs: rgbaHashCompletedAt - rgbaHashStartedAt,
      totalMs: rgbaHashCompletedAt - startedAt,
      objectBytes: objectBytes.byteLength,
      rgbaBytes: decoded.rgba.byteLength,
    },
  };
}

export async function recoverSnapshotOrFallback({
  offer,
  realtimeOrigin,
  applySnapshot,
  fallbackToEventLog,
  fetchSnapshot,
}: SnapshotRecoveryOptions): Promise<"snapshot" | "event-log"> {
  try {
    const snapshot = await fetchVerifiedSnapshot(
      offer,
      realtimeOrigin,
      fetchSnapshot,
    );
    await applySnapshot(snapshot);
    return "snapshot";
  } catch (error) {
    await fallbackToEventLog(error);
    return "event-log";
  }
}

export function nextSnapshotFallbackState(
  failedJobIds: readonly string[],
  failedJobId: string,
): SnapshotFallbackState {
  const repeatedFailure = failedJobIds.includes(failedJobId);
  const nextFailedJobIds = repeatedFailure
    ? [...failedJobIds]
    : [...failedJobIds, failedJobId].slice(0, 2);
  return {
    failedJobIds: nextFailedJobIds,
    snapshotRecoveryDisabled:
      repeatedFailure || nextFailedJobIds.length >= 2,
  };
}
