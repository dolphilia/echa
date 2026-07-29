import {
  ROOM_CLEANUP_JOB_VERSION,
  type RoomCleanupJob,
} from "@koge/protocol";
import { describe, expect, it, vi } from "vitest";
import { processRoomCleanupJob } from "../src/room-cleanup";

const job = {
  v: ROOM_CLEANUP_JOB_VERSION,
  jobId: "cleanup-job-test-0001",
  roomId: "room-cleanup-test-0001",
  closeRequestId: "cleanup-job-test-0001",
  requestedAt: 1_722_000_000_000,
  snapshotObjectKeys: [
    "rooms/room-cleanup-test-0001/snapshots/staging/snapshot-0001.kgs",
  ],
} as const satisfies RoomCleanupJob;

function fakeEnv(
  projection: {
    status: string;
    cleanup_job_id: string | null;
    evidence_required?: number;
    metrics_captured?: number;
  } | null,
  failure?: "metrics" | "r2" | "do" | "d1" | "remaining",
) {
  const order: string[] = [];
  const deleteObjects = vi.fn(async () => {
    order.push("r2");
    if (failure === "r2") throw new Error("injected R2 failure");
  });
  const finalizeRoomCleanup = vi.fn(async () => {
    order.push("do");
    if (failure === "do") throw new Error("injected DO failure");
    return { status: "deleted" as const };
  });
  const stats = vi.fn(async () => {
    order.push("metrics");
    return {
      acceptedCount: 10,
      rejectCount: 2,
      rateLimitedCount: 1,
      shortMuteCount: 0,
      abuseDisconnectCount: 0,
    };
  });
  const prepare = vi.fn((sql: string) => ({
    bind: (..._values: unknown[]) => ({
      first: async () => {
        if (sql.includes("AS evidence_required")) {
          order.push("projection");
          return projection && {
            evidence_required: 0,
            metrics_captured: 0,
            ...projection,
          };
        }
        order.push("remaining");
        return failure === "remaining" ? { present: 1 } : null;
      },
      run: async () => {
        order.push("metrics-write");
        if (failure === "metrics") {
          throw new Error("injected metrics failure");
        }
        return { success: true };
      },
    }),
  }));
  const batch = vi.fn(async () => {
    order.push("d1-delete");
    if (failure === "d1") throw new Error("injected D1 failure");
    return [];
  });
  const env = {
    DB: { prepare, batch },
    RUNTIME_SNAPSHOTS: { delete: deleteObjects },
    DRAWING_ROOM: {
      getByName: () => ({ stats, finalizeRoomCleanup }),
    },
  } as unknown as Env;
  return { env, order, deleteObjects, stats, finalizeRoomCleanup, batch };
}

describe("room cleanup queue processor", () => {
  it("deletes R2, Durable Object, then the D1 projection", async () => {
    const fixture = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
    });
    await expect(processRoomCleanupJob(job, fixture.env)).resolves.toEqual({
      status: "deleted",
      deletedSnapshotObjectCount: 1,
    });
    expect(fixture.order).toEqual([
      "projection",
      "metrics",
      "metrics-write",
      "r2",
      "do",
      "d1-delete",
      "remaining",
    ]);
  });

  it("acknowledges a duplicate after the D1 row is gone", async () => {
    const fixture = fakeEnv(null);
    await expect(processRoomCleanupJob(job, fixture.env)).resolves.toEqual({
      status: "already_deleted",
    });
    expect(fixture.deleteObjects).not.toHaveBeenCalled();
    expect(fixture.finalizeRoomCleanup).not.toHaveBeenCalled();
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("rejects object keys outside the room snapshot prefix", async () => {
    const fixture = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
    });
    await expect(processRoomCleanupJob({
      ...job,
      snapshotObjectKeys: ["rooms/another-room/snapshots/object.kgs"],
    }, fixture.env)).rejects.toThrow("invalid room cleanup object key");
    expect(fixture.order).toEqual([]);
  });

  it("captures metrics but leaves DO projection when R2 deletion fails", async () => {
    const fixture = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
    }, "r2");
    await expect(processRoomCleanupJob(job, fixture.env)).rejects.toThrow(
      "injected R2 failure",
    );
    expect(fixture.order).toEqual([
      "projection",
      "metrics",
      "metrics-write",
      "r2",
    ]);
    expect(fixture.finalizeRoomCleanup).not.toHaveBeenCalled();
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("does not delete room data when the final metric capture fails", async () => {
    const fixture = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
    }, "metrics");
    await expect(processRoomCleanupJob(job, fixture.env)).rejects.toThrow(
      "injected metrics failure",
    );
    expect(fixture.order).toEqual([
      "projection",
      "metrics",
      "metrics-write",
    ]);
    expect(fixture.deleteObjects).not.toHaveBeenCalled();
    expect(fixture.finalizeRoomCleanup).not.toHaveBeenCalled();
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("leaves the D1 fence for retry when DO deletion fails", async () => {
    const fixture = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
    }, "do");
    await expect(processRoomCleanupJob(job, fixture.env)).rejects.toThrow(
      "injected DO failure",
    );
    expect(fixture.order).toEqual([
      "projection",
      "metrics",
      "metrics-write",
      "r2",
      "do",
    ]);
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("retries D1 deletion after R2 and DO deletion completed", async () => {
    const failed = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
    }, "d1");
    await expect(processRoomCleanupJob(job, failed.env)).rejects.toThrow(
      "injected D1 failure",
    );
    expect(failed.order).toEqual([
      "projection",
      "metrics",
      "metrics-write",
      "r2",
      "do",
      "d1-delete",
    ]);

    const retry = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
      metrics_captured: 1,
    });
    await expect(processRoomCleanupJob(job, retry.env)).resolves.toMatchObject({
      status: "deleted",
    });
    expect(retry.order).toEqual([
      "projection",
      "r2",
      "do",
      "d1-delete",
      "remaining",
    ]);
  });

  it("fails closed when the D1 projection fence does not match", async () => {
    const fixture = fakeEnv({
      status: "closing",
      cleanup_job_id: "another-cleanup-job",
    });
    await expect(processRoomCleanupJob(job, fixture.env)).rejects.toThrow(
      "room cleanup projection fence mismatch",
    );
    expect(fixture.order).toEqual(["projection"]);
  });

  it("does not delete a reported room before evidence is committed", async () => {
    const fixture = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
      evidence_required: 1,
    });
    await expect(processRoomCleanupJob(job, fixture.env)).rejects.toThrow(
      "room cleanup blocked until evidence is committed",
    );
    expect(fixture.order).toEqual(["projection"]);
    expect(fixture.deleteObjects).not.toHaveBeenCalled();
    expect(fixture.finalizeRoomCleanup).not.toHaveBeenCalled();
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it("detects a D1 row that remains after the delete batch", async () => {
    const fixture = fakeEnv({
      status: "closing",
      cleanup_job_id: job.jobId,
    }, "remaining");
    await expect(processRoomCleanupJob(job, fixture.env)).rejects.toThrow(
      "room cleanup projection delete failed",
    );
    expect(fixture.order).toEqual([
      "projection",
      "metrics",
      "metrics-write",
      "r2",
      "do",
      "d1-delete",
      "remaining",
    ]);
  });
});
