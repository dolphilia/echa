const counterNames = [
  "acceptedCount",
  "rejectCount",
  "rateLimitedCount",
  "shortMuteCount",
  "abuseDisconnectCount",
];

function emptyCounters() {
  return Object.fromEntries(counterNames.map((name) => [name, 0]));
}

function validateCapture(value) {
  if (
    !value
    || typeof value !== "object"
    || value.schema !== "koge.rate-abuse-metrics-capture.v1"
    || typeof value.environment !== "string"
    || !Number.isSafeInteger(value.capturedAt)
    || value.retentionDays !== 30
    || !Array.isArray(value.liveRooms)
    || !Array.isArray(value.outcomes)
  ) {
    throw new TypeError("invalid rate abuse metrics capture");
  }
  for (const entry of [...value.liveRooms, ...value.outcomes]) {
    if (
      !entry
      || typeof entry !== "object"
      || !/^[a-f0-9]{64}$/.test(entry.roomDigest)
      || counterNames.some((name) =>
        !Number.isSafeInteger(entry[name]) || entry[name] < 0
      )
    ) {
      throw new TypeError("invalid rate abuse metrics entry");
    }
  }
  if (value.outcomes.some((entry) =>
    !/^[a-f0-9]{64}$/.test(entry.outcomeDigest)
  )) {
    throw new TypeError("invalid rate abuse outcome digest");
  }
}

function addDelta(target, current, baseline = emptyCounters()) {
  const deltas = counterNames.map((name) => current[name] - baseline[name]);
  if (deltas.some((delta) => delta < 0)) return false;
  for (const name of counterNames) {
    target[name] += current[name] - baseline[name];
  }
  return true;
}

export function compareRateAbuseCaptures(baseline, current) {
  validateCapture(baseline);
  validateCapture(current);
  if (
    baseline.environment !== current.environment
    || current.capturedAt < baseline.capturedAt
  ) {
    throw new TypeError("rate abuse capture environments or times do not match");
  }
  const retentionMs = current.retentionDays * 24 * 60 * 60 * 1_000;
  if (current.capturedAt - baseline.capturedAt >= retentionMs) {
    throw new RangeError("rate abuse comparison exceeds outcome retention");
  }

  const baselineLive = new Map(
    baseline.liveRooms.map((entry) => [entry.roomDigest, entry]),
  );
  const currentLive = new Map(
    current.liveRooms.map((entry) => [entry.roomDigest, entry]),
  );
  const baselineOutcomes = new Set(
    baseline.outcomes.map(({ outcomeDigest }) => outcomeDigest),
  );
  const newOutcomes = current.outcomes.filter(
    ({ outcomeDigest }) => !baselineOutcomes.has(outcomeDigest),
  );
  const outcomeRooms = new Set(newOutcomes.map(({ roomDigest }) => roomDigest));
  const delta = emptyCounters();
  let invalidCounterRoomCount = 0;

  for (const outcome of newOutcomes) {
    if (!addDelta(delta, outcome, baselineLive.get(outcome.roomDigest))) {
      invalidCounterRoomCount += 1;
    }
  }
  for (const live of current.liveRooms) {
    if (!addDelta(delta, live, baselineLive.get(live.roomDigest))) {
      invalidCounterRoomCount += 1;
    }
  }
  const missingFinalOutcomeCount = baseline.liveRooms.filter(({ roomDigest }) =>
    !currentLive.has(roomDigest) && !outcomeRooms.has(roomDigest)
  ).length;
  const accepted = delta.acceptedCount;
  return {
    schema: "koge.rate-abuse-metrics-comparison.v1",
    environment: current.environment,
    from: baseline.capturedAt,
    to: current.capturedAt,
    durationMs: current.capturedAt - baseline.capturedAt,
    delta,
    completedRoomCount: newOutcomes.length,
    liveRoomCount: current.liveRooms.length,
    missingFinalOutcomeCount,
    invalidCounterRoomCount,
    complete: missingFinalOutcomeCount === 0 && invalidCounterRoomCount === 0,
    rates: {
      rateLimitedPer10kAcceptedDrawingEvents: accepted === 0
        ? null
        : delta.rateLimitedCount / accepted * 10_000,
      shortMutePer100RateLimits: delta.rateLimitedCount === 0
        ? null
        : delta.shortMuteCount / delta.rateLimitedCount * 100,
      disconnectPer100ShortMutes: delta.shortMuteCount === 0
        ? null
        : delta.abuseDisconnectCount / delta.shortMuteCount * 100,
    },
  };
}
