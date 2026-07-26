import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EVENT_LOG_VERSION,
  analyzeRawFixture,
  estimatedMessagePackBytes,
  generateEventLog,
  rawFixtureToEventLog,
  strokeToEventTemplates,
  summarizeEventLog,
  validateEventLog,
  validateRawFixture
} from "../src/core.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/sample-raw-strokes.json", import.meta.url),
    "utf8"
  )
);

test("sample raw fixture is valid", () => {
  assert.deepEqual(validateRawFixture(fixture), []);
});

test("stroke templates preserve begin/append/end boundaries", () => {
  const events = strokeToEventTemplates(fixture.strokes[0], {
    appendIntervalMs: 50,
    maxPointsPerAppend: 3
  });
  assert.equal(events[0].op, "stroke.begin");
  assert.equal(events.at(-1).op, "stroke.end");
  assert.ok(events.some((event) => event.op === "stroke.append"));
  assert.equal(
    events.reduce(
      (total, event) =>
        total + (event.point ? 1 : 0) + (event.points?.length ?? 0),
      0
    ),
    fixture.strokes[0].points.length
  );
});

test("generator emits complete strokes until the target is reached", () => {
  const log = generateEventLog(fixture, {
    targetEvents: 1_000,
    actors: 4
  });
  assert.equal(log.schema, EVENT_LOG_VERSION);
  assert.ok(log.events.length >= 1_000);
  assert.deepEqual(validateEventLog(log), []);
  assert.equal(log.events[0].roomSeq, 1);
  assert.equal(log.events.at(-1).roomSeq, log.events.length);
  assert.equal(log.events[0].clientSeq, 1);
  assert.ok(log.events.every((event) => Number.isInteger(event.clientSeq)));

  const summary = summarizeEventLog(log);
  assert.equal(summary.eventCount, log.events.length);
  assert.equal(summary.actorCount, 4);
  assert.ok(summary.strokeCount > 0);
  assert.ok(summary.pointCount > summary.strokeCount);
  assert.ok(summary.estimatedMessagePackBytes > 0);
});

test("single-pass analysis uses every recorded stroke exactly once", () => {
  const log = rawFixtureToEventLog(fixture, {
    appendIntervalMs: 50,
    maxPointsPerAppend: 12
  });
  const analysis = analyzeRawFixture(fixture, {
    appendIntervalMs: 50,
    maxPointsPerAppend: 12
  });

  assert.equal(log.events.length, 18);
  assert.equal(analysis.recordedDurationMs, 1640);
  assert.equal(analysis.activeDrawingDurationMs, 549);
  assert.equal(analysis.strokeCount, 4);
  assert.equal(analysis.pointCount, 28);
  assert.equal(analysis.beginCount, 4);
  assert.equal(analysis.appendCount, 10);
  assert.equal(analysis.endCount, 4);
  assert.equal(analysis.eventCount, 18);
  assert.equal(analysis.maximumPointsPerAppend, 3);
  assert.equal(log.events.at(-1).clientSeq, log.events.length);
  assert.ok(analysis.eventsPerRecordedMinute > 0);
  assert.ok(analysis.eventsPerActiveMinute > analysis.eventsPerRecordedMinute);
});

test("byte target uses estimated MessagePack bytes", () => {
  const log = generateEventLog(fixture, {
    targetEvents: 10,
    targetBytes: 64 * 1024
  });
  const summary = summarizeEventLog(log);
  assert.ok(summary.eventCount >= 10);
  assert.ok(summary.estimatedMessagePackBytes >= 64 * 1024);
});

test("MessagePack estimator handles protocol value types", () => {
  assert.equal(estimatedMessagePackBytes(null), 1);
  assert.equal(estimatedMessagePackBytes(true), 1);
  assert.equal(estimatedMessagePackBytes(1), 1);
  assert.equal(estimatedMessagePackBytes(-1), 1);
  assert.equal(estimatedMessagePackBytes("a"), 2);
  assert.ok(
    estimatedMessagePackBytes({ op: "stroke.end", roomSeq: 1 })
      > estimatedMessagePackBytes("stroke.end")
  );
});

test("event log validator finds a sequence gap", () => {
  const log = generateEventLog(fixture, { targetEvents: 20 });
  log.events[3].roomSeq = 10;
  assert.ok(validateEventLog(log).length > 0);
});

test("event log validator finds an actor clientSeq gap", () => {
  const log = generateEventLog(fixture, {
    targetEvents: 20,
    actors: 1
  });
  log.events[3].clientSeq += 1;
  assert.ok(
    validateEventLog(log).some((error) => error.includes("clientSeq"))
  );
});
