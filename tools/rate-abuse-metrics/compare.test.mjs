import assert from "node:assert/strict";
import test from "node:test";
import { compareRateAbuseCaptures } from "./compare.mjs";

const digest = (character) => character.repeat(64);
const counters = (
  acceptedCount,
  rejectCount,
  rateLimitedCount,
  shortMuteCount,
  abuseDisconnectCount,
) => ({
  acceptedCount,
  rejectCount,
  rateLimitedCount,
  shortMuteCount,
  abuseDisconnectCount,
});
const capture = (capturedAt, liveRooms, outcomes) => ({
  schema: "koge.rate-abuse-metrics-capture.v1",
  environment: "preview",
  capturedAt,
  retentionDays: 30,
  liveRooms,
  outcomes,
});

test("compares continuing, completed, and new rooms without double counting", () => {
  const baseline = capture(1_000, [
    { roomDigest: digest("a"), ...counters(100, 1, 1, 0, 0) },
    { roomDigest: digest("b"), ...counters(50, 0, 0, 0, 0) },
  ], []);
  const current = capture(2_000, [
    { roomDigest: digest("a"), ...counters(140, 4, 3, 1, 0) },
    { roomDigest: digest("c"), ...counters(20, 0, 0, 0, 0) },
  ], [{
    outcomeDigest: digest("d"),
    roomDigest: digest("b"),
    ...counters(80, 2, 2, 1, 1),
  }]);

  assert.deepEqual(compareRateAbuseCaptures(baseline, current), {
    schema: "koge.rate-abuse-metrics-comparison.v1",
    environment: "preview",
    from: 1_000,
    to: 2_000,
    durationMs: 1_000,
    delta: counters(90, 5, 4, 2, 1),
    completedRoomCount: 1,
    liveRoomCount: 2,
    missingFinalOutcomeCount: 0,
    invalidCounterRoomCount: 0,
    complete: true,
    rates: {
      rateLimitedPer10kAcceptedDrawingEvents: 4 / 90 * 10_000,
      shortMutePer100RateLimits: 50,
      disconnectPer100ShortMutes: 50,
    },
  });
});

test("marks a disappeared live room without a final outcome incomplete", () => {
  const result = compareRateAbuseCaptures(
    capture(1_000, [
      { roomDigest: digest("a"), ...counters(10, 0, 0, 0, 0) },
    ], []),
    capture(2_000, [], []),
  );
  assert.equal(result.complete, false);
  assert.equal(result.missingFinalOutcomeCount, 1);
});
