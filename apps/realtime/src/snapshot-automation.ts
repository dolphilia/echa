export type SnapshotAutomationMode = "off" | "shadow" | "compact";

export type SnapshotAutomationConfig = {
  readonly mode: SnapshotAutomationMode;
  readonly firstEventCount: number;
  readonly firstPayloadBytes: number;
  readonly minEventDelta: number;
  readonly minPayloadDeltaBytes: number;
};

export type SnapshotAutomationInput = {
  readonly lifecycleActive: boolean;
  readonly activeStrokeCount: number;
  readonly queuedJobCount: number;
  readonly totalEventCount: number;
  readonly totalPayloadBytes: number;
  readonly lastJobEventCount?: number;
  readonly lastJobPayloadBytes?: number;
};

export type SnapshotAutomationDecision = {
  readonly mode: SnapshotAutomationMode;
  readonly status:
    | "disabled"
    | "room_inactive"
    | "stroke_active"
    | "job_pending"
    | "below_threshold"
    | "trigger";
  readonly trigger?: "events" | "payload";
  readonly eventDelta: number;
  readonly payloadDeltaBytes: number;
};

type SnapshotAutomationEnv = {
  readonly SNAPSHOT_AUTOMATION_MODE: string;
  readonly SNAPSHOT_TRIGGER_EVENT_COUNT: number;
  readonly SNAPSHOT_TRIGGER_PAYLOAD_BYTES: number;
  readonly SNAPSHOT_MIN_EVENT_DELTA: number;
  readonly SNAPSHOT_MIN_PAYLOAD_DELTA_BYTES: number;
};

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function snapshotAutomationConfig(
  env: SnapshotAutomationEnv,
): SnapshotAutomationConfig {
  if (
    env.SNAPSHOT_AUTOMATION_MODE !== "off"
    && env.SNAPSHOT_AUTOMATION_MODE !== "shadow"
    && env.SNAPSHOT_AUTOMATION_MODE !== "compact"
  ) {
    throw new RangeError("SNAPSHOT_AUTOMATION_MODE is invalid");
  }
  return {
    mode: env.SNAPSHOT_AUTOMATION_MODE,
    firstEventCount: positiveSafeInteger(
      "SNAPSHOT_TRIGGER_EVENT_COUNT",
      env.SNAPSHOT_TRIGGER_EVENT_COUNT,
    ),
    firstPayloadBytes: positiveSafeInteger(
      "SNAPSHOT_TRIGGER_PAYLOAD_BYTES",
      env.SNAPSHOT_TRIGGER_PAYLOAD_BYTES,
    ),
    minEventDelta: positiveSafeInteger(
      "SNAPSHOT_MIN_EVENT_DELTA",
      env.SNAPSHOT_MIN_EVENT_DELTA,
    ),
    minPayloadDeltaBytes: positiveSafeInteger(
      "SNAPSHOT_MIN_PAYLOAD_DELTA_BYTES",
      env.SNAPSHOT_MIN_PAYLOAD_DELTA_BYTES,
    ),
  };
}

export function decideSnapshotAutomation(
  config: SnapshotAutomationConfig,
  input: SnapshotAutomationInput,
): SnapshotAutomationDecision {
  const hasPreviousJob = input.lastJobEventCount !== undefined
    && input.lastJobPayloadBytes !== undefined;
  const eventDelta = Math.max(
    0,
    input.totalEventCount - (input.lastJobEventCount ?? 0),
  );
  const payloadDeltaBytes = Math.max(
    0,
    input.totalPayloadBytes - (input.lastJobPayloadBytes ?? 0),
  );
  const base = { mode: config.mode, eventDelta, payloadDeltaBytes };
  if (config.mode === "off") return { ...base, status: "disabled" };
  if (!input.lifecycleActive) return { ...base, status: "room_inactive" };
  if (input.activeStrokeCount > 0) return { ...base, status: "stroke_active" };
  if (input.queuedJobCount > 0) return { ...base, status: "job_pending" };

  const eventThreshold = hasPreviousJob
    ? config.minEventDelta
    : config.firstEventCount;
  const payloadThreshold = hasPreviousJob
    ? config.minPayloadDeltaBytes
    : config.firstPayloadBytes;
  if (eventDelta >= eventThreshold) {
    return { ...base, status: "trigger", trigger: "events" };
  }
  if (payloadDeltaBytes >= payloadThreshold) {
    return { ...base, status: "trigger", trigger: "payload" };
  }
  return { ...base, status: "below_threshold" };
}

export function shouldArmSnapshotCompaction(
  mode: SnapshotAutomationMode,
  previousBaseRoomSeq: number | undefined,
): boolean {
  return mode === "compact"
    && previousBaseRoomSeq !== undefined
    && previousBaseRoomSeq > 0;
}

