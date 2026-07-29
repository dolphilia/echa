import {
  PROTOCOL_LIMITS,
  SNAPSHOT_CANVAS_GENERATION,
  SNAPSHOT_CODEC,
  SNAPSHOT_JOB_VERSION,
  SNAPSHOT_RENDERER_VERSION,
  encodeSnapshot,
  type SnapshotOfferMessage,
} from "@koge/protocol";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  fetchVerifiedSnapshot,
  nextSnapshotFallbackState,
  recoverSnapshotOrFallback,
} from "../app/snapshot-recovery";

let objectBytes: Uint8Array;
let rgba: Uint8Array;
let offer: SnapshotOfferMessage;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

function objectResponse(
  bytes: Uint8Array,
  status = 200,
): Response {
  return new Response(Uint8Array.from(bytes).buffer, {
    status,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": "application/vnd.koge.snapshot",
    },
  });
}

beforeAll(async () => {
  rgba = new Uint8Array(
    PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4,
  );
  rgba.fill(255);
  rgba[0] = 51;
  rgba[1] = 102;
  rgba[2] = 153;
  objectBytes = await encodeSnapshot(
    rgba,
    PROTOCOL_LIMITS.canvasWidth,
    PROTOCOL_LIMITS.canvasHeight,
    SNAPSHOT_RENDERER_VERSION,
  );
  offer = {
    type: "snapshot",
    manifest: {
      v: SNAPSHOT_JOB_VERSION,
      jobId: "snapshot-job-web-test-0001",
      roomId: "room-web-test-0001",
      baseRoomSeq: 12_345,
      protocolVersion: 1,
      rendererVersion: SNAPSHOT_RENDERER_VERSION,
      canvasGeneration: SNAPSHOT_CANVAS_GENERATION,
      generation: 1,
      codec: SNAPSHOT_CODEC,
      width: PROTOCOL_LIMITS.canvasWidth,
      height: PROTOCOL_LIMITS.canvasHeight,
      objectBytes: objectBytes.byteLength,
      objectHash: await sha256Hex(objectBytes),
      rgbaHash: await sha256Hex(rgba),
      createdAt: Date.now(),
    },
    readToken: "snapshot-read-token-test",
    expiresAt: Date.now() + 60_000,
  };
});

describe("browser snapshot recovery", () => {
  it("verifies and decodes a snapshot before applying it", async () => {
    const fetchSnapshot = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://realtime-preview.koge.app/rooms/room-web-test-0001"
          + "/snapshots/snapshot-job-web-test-0001",
      );
      expect(init).toMatchObject({
        cache: "no-store",
        headers: {
          Authorization: "KogeSnapshot snapshot-read-token-test",
        },
      });
      return objectResponse(objectBytes);
    });

    const snapshot = await fetchVerifiedSnapshot(
      offer,
      "wss://realtime-preview.koge.app",
      fetchSnapshot,
    );

    expect(snapshot.baseRoomSeq).toBe(12_345);
    expect(snapshot.rgba).toEqual(rgba);
    expect(snapshot.timings).toMatchObject({
      objectBytes: objectBytes.byteLength,
      rgbaBytes: rgba.byteLength,
    });
    for (const value of [
      snapshot.timings.fetchMs,
      snapshot.timings.bodyReadMs,
      snapshot.timings.objectHashMs,
      snapshot.timings.decodeMs,
      snapshot.timings.rgbaHashMs,
      snapshot.timings.totalMs,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(fetchSnapshot).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "R2 proxy failure",
      makeOffer: () => offer,
      fetchSnapshot: async () => new Response(null, { status: 503 }),
      reason: "snapshot fetch failed: 503",
    },
    {
      name: "corrupt object",
      makeOffer: () => offer,
      fetchSnapshot: async () => {
        const corrupt = Uint8Array.from(objectBytes);
        const lastIndex = corrupt.byteLength - 1;
        corrupt[lastIndex] = (corrupt[lastIndex] ?? 0) ^ 0xff;
        return objectResponse(corrupt);
      },
      reason: "snapshot object integrity check failed",
    },
    {
      name: "renderer version mismatch",
      makeOffer: () => ({
        ...offer,
        manifest: { ...offer.manifest, rendererVersion: 99 },
      }) as unknown as SnapshotOfferMessage,
      fetchSnapshot: async () => objectResponse(objectBytes),
      reason: "snapshot offer is incompatible",
    },
    {
      name: "RGBA hash mismatch",
      makeOffer: () => ({
        ...offer,
        manifest: { ...offer.manifest, rgbaHash: "0".repeat(64) },
      }),
      fetchSnapshot: async () => objectResponse(objectBytes),
      reason: "snapshot RGBA integrity check failed",
    },
  ])("falls back to a full event replay after $name", async ({
    makeOffer,
    fetchSnapshot,
    reason,
  }) => {
    const applySnapshot = vi.fn();
    const fallbackToEventLog = vi.fn();

    await expect(recoverSnapshotOrFallback({
      offer: makeOffer(),
      realtimeOrigin: "wss://realtime-preview.koge.app",
      applySnapshot,
      fallbackToEventLog,
      fetchSnapshot,
    })).resolves.toBe("event-log");

    expect(applySnapshot).not.toHaveBeenCalled();
    expect(fallbackToEventLog).toHaveBeenCalledOnce();
    expect(fallbackToEventLog.mock.calls[0]?.[0]).toMatchObject({
      message: reason,
    });
  });

  it("tries current, previous, then full replay without retrying a failed job", () => {
    const afterCurrent = nextSnapshotFallbackState(
      [],
      "snapshot-current-job-0001",
    );
    expect(afterCurrent).toEqual({
      failedJobIds: ["snapshot-current-job-0001"],
      snapshotRecoveryDisabled: false,
    });

    const afterPrevious = nextSnapshotFallbackState(
      afterCurrent.failedJobIds,
      "snapshot-previous-job-0001",
    );
    expect(afterPrevious).toEqual({
      failedJobIds: [
        "snapshot-current-job-0001",
        "snapshot-previous-job-0001",
      ],
      snapshotRecoveryDisabled: true,
    });

    expect(nextSnapshotFallbackState(
      afterCurrent.failedJobIds,
      "snapshot-current-job-0001",
    ).snapshotRecoveryDisabled).toBe(true);
  });
});
