import { describe, expect, it } from "vitest";
import {
  decideSnapshotAutomation,
  shouldArmSnapshotCompaction,
  snapshotAutomationConfig,
  type SnapshotAutomationConfig,
} from "../src/snapshot-automation";

const config: SnapshotAutomationConfig = {
  mode: "shadow",
  firstEventCount: 50_000,
  firstPayloadBytes: 16 * 1024 * 1024,
  minEventDelta: 10_000,
  minPayloadDeltaBytes: 4 * 1024 * 1024,
};

function decide(
  input: Partial<Parameters<typeof decideSnapshotAutomation>[1]> = {},
) {
  return decideSnapshotAutomation(config, {
    lifecycleActive: true,
    activeStrokeCount: 0,
    queuedJobCount: 0,
    totalEventCount: 0,
    totalPayloadBytes: 0,
    ...input,
  });
}

describe("snapshot automation policy", () => {
  it("validates the configured mode and thresholds", () => {
    expect(snapshotAutomationConfig({
      SNAPSHOT_AUTOMATION_MODE: "compact",
      SNAPSHOT_TRIGGER_EVENT_COUNT: 50_000,
      SNAPSHOT_TRIGGER_PAYLOAD_BYTES: 16 * 1024 * 1024,
      SNAPSHOT_MIN_EVENT_DELTA: 10_000,
      SNAPSHOT_MIN_PAYLOAD_DELTA_BYTES: 4 * 1024 * 1024,
    })).toMatchObject({ mode: "compact", minEventDelta: 10_000 });
    expect(() => snapshotAutomationConfig({
      SNAPSHOT_AUTOMATION_MODE: "invalid",
      SNAPSHOT_TRIGGER_EVENT_COUNT: 50_000,
      SNAPSHOT_TRIGGER_PAYLOAD_BYTES: 16 * 1024 * 1024,
      SNAPSHOT_MIN_EVENT_DELTA: 10_000,
      SNAPSHOT_MIN_PAYLOAD_DELTA_BYTES: 4 * 1024 * 1024,
    })).toThrow("SNAPSHOT_AUTOMATION_MODE is invalid");
  });

  it("stays disabled or waits for a safe completed-stroke boundary", () => {
    expect(decideSnapshotAutomation(
      { ...config, mode: "off" },
      {
        lifecycleActive: true,
        activeStrokeCount: 0,
        queuedJobCount: 0,
        totalEventCount: 60_000,
        totalPayloadBytes: 0,
      },
    ).status).toBe("disabled");
    expect(decide({ lifecycleActive: false, totalEventCount: 60_000 }).status)
      .toBe("room_inactive");
    expect(decide({ activeStrokeCount: 1, totalEventCount: 60_000 }).status)
      .toBe("stroke_active");
    expect(decide({ queuedJobCount: 1, totalEventCount: 60_000 }).status)
      .toBe("job_pending");
  });

  it("triggers the first snapshot by event count or payload size", () => {
    expect(decide({ totalEventCount: 50_000 })).toMatchObject({
      status: "trigger",
      trigger: "events",
    });
    expect(decide({ totalPayloadBytes: 16 * 1024 * 1024 })).toMatchObject({
      status: "trigger",
      trigger: "payload",
    });
  });

  it("uses deltas from the latest snapshot job after the first trigger", () => {
    expect(decide({
      totalEventCount: 59_999,
      totalPayloadBytes: 5 * 1024 * 1024,
      lastJobEventCount: 50_000,
      lastJobPayloadBytes: 2 * 1024 * 1024,
    }).status).toBe("below_threshold");
    expect(decide({
      totalEventCount: 60_000,
      totalPayloadBytes: 5 * 1024 * 1024,
      lastJobEventCount: 50_000,
      lastJobPayloadBytes: 2 * 1024 * 1024,
    })).toMatchObject({ status: "trigger", trigger: "events" });
    expect(decide({
      totalEventCount: 50_001,
      totalPayloadBytes: 6 * 1024 * 1024,
      lastJobEventCount: 50_000,
      lastJobPayloadBytes: 2 * 1024 * 1024,
    })).toMatchObject({ status: "trigger", trigger: "payload" });
  });

  it("arms event deletion only in compact mode with a previous base", () => {
    expect(shouldArmSnapshotCompaction("shadow", 100)).toBe(false);
    expect(shouldArmSnapshotCompaction("compact", undefined)).toBe(false);
    expect(shouldArmSnapshotCompaction("compact", 0)).toBe(false);
    expect(shouldArmSnapshotCompaction("compact", 100)).toBe(true);
  });
});
