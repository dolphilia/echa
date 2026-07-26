const textEncoder = new TextEncoder();

export const RAW_FIXTURE_VERSION = "echa.raw-strokes.v1";
export const EVENT_LOG_VERSION = "echa.event-log.v1";

export function encodedJsonBytes(value) {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function utf8Length(value) {
  return textEncoder.encode(value).byteLength;
}

function integerSize(value) {
  if (value >= 0) {
    if (value <= 0x7f) return 1;
    if (value <= 0xff) return 2;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
  }
  if (value >= -32) return 1;
  if (value >= -128) return 2;
  if (value >= -32768) return 3;
  if (value >= -2147483648) return 5;
  return 9;
}

function stringSize(value) {
  const length = utf8Length(value);
  if (length <= 31) return 1 + length;
  if (length <= 0xff) return 2 + length;
  if (length <= 0xffff) return 3 + length;
  return 5 + length;
}

function arrayHeaderSize(length) {
  if (length <= 15) return 1;
  if (length <= 0xffff) return 3;
  return 5;
}

function mapHeaderSize(length) {
  if (length <= 15) return 1;
  if (length <= 0xffff) return 3;
  return 5;
}

/**
 * MessagePackの標準的な最小表現を使ったサイズ見積もり。
 * 現時点ではwire library未採用のため、比較可能な暫定指標として使う。
 */
export function estimatedMessagePackBytes(value) {
  if (value === null || value === undefined) return 1;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? integerSize(value) : 9;
  }
  if (typeof value === "string") return stringSize(value);
  if (Array.isArray(value)) {
    return arrayHeaderSize(value.length)
      + value.reduce((total, item) => total + estimatedMessagePackBytes(item), 0);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return mapHeaderSize(entries.length)
      + entries.reduce(
        (total, [key, item]) =>
          total + stringSize(key) + estimatedMessagePackBytes(item),
        0
      );
  }
  throw new TypeError(`Unsupported MessagePack value: ${typeof value}`);
}

export function validateRawFixture(fixture) {
  const errors = [];
  if (fixture?.schema !== RAW_FIXTURE_VERSION) {
    errors.push(`schema must be ${RAW_FIXTURE_VERSION}`);
  }
  if (!Number.isFinite(fixture?.canvas?.width) || fixture.canvas.width <= 0) {
    errors.push("canvas.width must be a positive number");
  }
  if (!Number.isFinite(fixture?.canvas?.height) || fixture.canvas.height <= 0) {
    errors.push("canvas.height must be a positive number");
  }
  if (!Array.isArray(fixture?.strokes) || fixture.strokes.length === 0) {
    errors.push("strokes must contain at least one stroke");
  }

  for (const [strokeIndex, stroke] of (fixture?.strokes ?? []).entries()) {
    if (!["brush", "eraser"].includes(stroke.tool)) {
      errors.push(`strokes[${strokeIndex}].tool is invalid`);
    }
    if (!Array.isArray(stroke.points) || stroke.points.length === 0) {
      errors.push(`strokes[${strokeIndex}].points must not be empty`);
      continue;
    }
    for (const [pointIndex, point] of stroke.points.entries()) {
      if (![point.x, point.y, point.dt].every(Number.isFinite)) {
        errors.push(
          `strokes[${strokeIndex}].points[${pointIndex}] must have numeric x/y/dt`
        );
      }
    }
  }
  return errors;
}

export function validateEventLog(log) {
  const errors = [];
  if (log?.schema !== EVENT_LOG_VERSION) {
    errors.push(`schema must be ${EVENT_LOG_VERSION}`);
  }
  if (!Array.isArray(log?.events)) {
    errors.push("events must be an array");
    return errors;
  }
  let expectedRoomSeq = 1;
  const strokeActors = new Map();
  const lastClientSeqByActor = new Map();
  for (const [index, event] of log.events.entries()) {
    if (event.roomSeq !== expectedRoomSeq) {
      errors.push(
        `events[${index}].roomSeq must be ${expectedRoomSeq}, got ${event.roomSeq}`
      );
      expectedRoomSeq = event.roomSeq;
    }
    if (!Number.isSafeInteger(event.clientSeq) || event.clientSeq <= 0) {
      errors.push(
        `events[${index}].clientSeq must be a positive safe integer`
      );
    }
    if (event.op === "stroke.begin" && typeof event.actor === "string") {
      strokeActors.set(event.id, event.actor);
    }
    const actorId = event.actor ?? strokeActors.get(event.id);
    if (actorId) {
      const expectedClientSeq = (lastClientSeqByActor.get(actorId) ?? 0) + 1;
      if (event.clientSeq !== expectedClientSeq) {
        errors.push(
          `events[${index}].clientSeq for ${actorId} must be `
          + `${expectedClientSeq}, got ${event.clientSeq}`
        );
      }
      lastClientSeqByActor.set(actorId, event.clientSeq);
    }
    if (event.op === "stroke.end" || event.op === "stroke.cancel") {
      strokeActors.delete(event.id);
    }
    expectedRoomSeq += 1;
  }
  return errors;
}

function normalizedPoint(point) {
  return [
    Math.round(point.x * 100) / 100,
    Math.round(point.y * 100) / 100,
    Math.max(0, Math.round(point.dt))
  ];
}

function splitAppendPoints(points, appendIntervalMs, maxPointsPerAppend) {
  const groups = [];
  let group = [];
  let groupStartedAt = points[0]?.dt ?? 0;

  for (const point of points) {
    if (
      group.length > 0
      && (
        group.length >= maxPointsPerAppend
        || point.dt - groupStartedAt >= appendIntervalMs
      )
    ) {
      groups.push(group);
      group = [];
      groupStartedAt = point.dt;
    }
    group.push(normalizedPoint(point));
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

export function strokeToEventTemplates(
  stroke,
  { appendIntervalMs = 50, maxPointsPerAppend = 12 } = {}
) {
  const [firstPoint, ...remainingPoints] = stroke.points;
  const events = [
    {
      v: 1,
      op: "stroke.begin",
      id: "",
      actor: "",
      tool: stroke.tool,
      color: stroke.color,
      size: stroke.size,
      opacity: stroke.opacity,
      point: normalizedPoint(firstPoint)
    }
  ];

  for (const points of splitAppendPoints(
    remainingPoints,
    appendIntervalMs,
    maxPointsPerAppend
  )) {
    events.push({
      v: 1,
      op: "stroke.append",
      id: "",
      points
    });
  }

  events.push({
    v: 1,
    op: stroke.cancelled ? "stroke.cancel" : "stroke.end",
    id: ""
  });
  return events;
}

function cloneEvent(
  template,
  { roomSeq, clientSeq, strokeId, actorId, offsetX, offsetY }
) {
  const event = structuredClone(template);
  event.roomSeq = roomSeq;
  event.clientSeq = clientSeq;
  event.id = strokeId;
  if (event.actor !== undefined) event.actor = actorId;

  if (event.point) {
    event.point[0] += offsetX;
    event.point[1] += offsetY;
  }
  if (event.points) {
    for (const point of event.points) {
      point[0] += offsetX;
      point[1] += offsetY;
    }
  }
  return event;
}

export function generateEventLog(
  fixture,
  {
    targetEvents = 10_000,
    targetBytes = null,
    actors = 3,
    appendIntervalMs = 50,
    maxPointsPerAppend = 12
  } = {}
) {
  const errors = validateRawFixture(fixture);
  if (errors.length > 0) {
    throw new Error(`Invalid raw fixture:\n- ${errors.join("\n- ")}`);
  }
  if (!Number.isFinite(targetEvents) || targetEvents <= 0) {
    throw new Error("targetEvents must be a positive number");
  }
  if (targetBytes !== null && (!Number.isFinite(targetBytes) || targetBytes <= 0)) {
    throw new Error("targetBytes must be null or a positive number");
  }

  const templates = fixture.strokes.map((stroke) =>
    strokeToEventTemplates(stroke, { appendIntervalMs, maxPointsPerAppend })
  );
  const events = [];
  const actorClientSeq = new Map();
  let packedBytes = 0;
  let repetition = 0;

  while (
    events.length < targetEvents
    || (targetBytes !== null && packedBytes < targetBytes)
  ) {
    const strokeIndex = repetition % templates.length;
    const cycle = Math.floor(repetition / templates.length);
    const actorId = `actor-${(repetition % actors) + 1}`;
    const strokeId = `stroke-${String(repetition + 1).padStart(8, "0")}`;
    const offsetX = (cycle * 17) % 83;
    const offsetY = (cycle * 11) % 61;

    for (const template of templates[strokeIndex]) {
      const clientSeq = (actorClientSeq.get(actorId) ?? 0) + 1;
      actorClientSeq.set(actorId, clientSeq);
      const event = cloneEvent(template, {
        roomSeq: events.length + 1,
        clientSeq,
        strokeId,
        actorId,
        offsetX,
        offsetY
      });
      events.push(event);
      packedBytes += estimatedMessagePackBytes(event);
    }
    repetition += 1;

    if (repetition > 2_000_000) {
      throw new Error("Generation safety limit exceeded");
    }
  }

  const log = {
    schema: EVENT_LOG_VERSION,
    generatedAt: new Date().toISOString(),
    canvas: { ...fixture.canvas },
    generator: {
      sourceSchema: fixture.schema,
      sourceStrokeCount: fixture.strokes.length,
      targetEvents,
      targetBytes,
      actors,
      appendIntervalMs,
      maxPointsPerAppend
    },
    events
  };
  return log;
}

export function rawFixtureToEventLog(
  fixture,
  {
    actorId = "recorded-actor",
    appendIntervalMs = 50,
    maxPointsPerAppend = 12
  } = {}
) {
  const errors = validateRawFixture(fixture);
  if (errors.length > 0) {
    throw new Error(`Invalid raw fixture:\n- ${errors.join("\n- ")}`);
  }

  const events = [];
  fixture.strokes.forEach((stroke, strokeIndex) => {
    const strokeId = `recorded-stroke-${String(strokeIndex + 1).padStart(6, "0")}`;
    const templates = strokeToEventTemplates(stroke, {
      appendIntervalMs,
      maxPointsPerAppend
    });
    for (const template of templates) {
      events.push(cloneEvent(template, {
        roomSeq: events.length + 1,
        clientSeq: events.length + 1,
        strokeId,
        actorId,
        offsetX: 0,
        offsetY: 0
      }));
    }
  });

  return {
    schema: EVENT_LOG_VERSION,
    generatedAt: new Date().toISOString(),
    canvas: { ...fixture.canvas },
    generator: {
      mode: "single-pass",
      sourceSchema: fixture.schema,
      sourceStrokeCount: fixture.strokes.length,
      actorId,
      appendIntervalMs,
      maxPointsPerAppend
    },
    events
  };
}

export function summarizeEventLog(log) {
  const counts = {};
  const actorIds = new Set();
  const strokeIds = new Set();
  let pointCount = 0;
  let estimatedWireBytes = 0;
  let largestEventBytes = 0;

  for (const event of log.events) {
    counts[event.op] = (counts[event.op] ?? 0) + 1;
    if (event.actor) actorIds.add(event.actor);
    if (event.id) strokeIds.add(event.id);
    pointCount += event.point ? 1 : 0;
    pointCount += event.points?.length ?? 0;
    const eventBytes = estimatedMessagePackBytes(event);
    estimatedWireBytes += eventBytes;
    largestEventBytes = Math.max(largestEventBytes, eventBytes);
  }

  return {
    schema: log.schema,
    eventCount: log.events.length,
    strokeCount: strokeIds.size,
    actorCount: actorIds.size,
    pointCount,
    eventsByType: counts,
    jsonBytes: encodedJsonBytes(log),
    estimatedMessagePackBytes: estimatedWireBytes,
    largestEstimatedEventBytes: largestEventBytes,
    averageEstimatedEventBytes:
      log.events.length === 0 ? 0 : estimatedWireBytes / log.events.length
  };
}

function perMinute(value, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  return value / (durationMs / 60_000);
}

export function analyzeRawFixture(
  fixture,
  {
    actorId = "recorded-actor",
    appendIntervalMs = 50,
    maxPointsPerAppend = 12
  } = {}
) {
  const log = rawFixtureToEventLog(fixture, {
    actorId,
    appendIntervalMs,
    maxPointsPerAppend
  });
  const eventSummary = summarizeEventLog(log);
  const strokeDurations = fixture.strokes.map(
    (stroke) => stroke.points.at(-1)?.dt ?? 0
  );
  const activeDrawingDurationMs = strokeDurations.reduce(
    (total, duration) => total + duration,
    0
  );
  const recordedDurationMs = Number.isFinite(fixture.session?.durationMs)
    ? fixture.session.durationMs
    : null;
  const appendEvents = log.events.filter(
    (event) => event.op === "stroke.append"
  );
  const appendPointCount = appendEvents.reduce(
    (total, event) => total + event.points.length,
    0
  );
  const cancelledStrokeCount = fixture.strokes.filter(
    (stroke) => stroke.cancelled
  ).length;

  return {
    schema: "echa.raw-stroke-analysis.v1",
    sourceSchema: fixture.schema,
    batching: {
      appendIntervalMs,
      maxPointsPerAppend
    },
    recordedDurationMs,
    activeDrawingDurationMs,
    idleDurationMs:
      recordedDurationMs === null
        ? null
        : Math.max(0, recordedDurationMs - activeDrawingDurationMs),
    activeDrawingRatio:
      recordedDurationMs && recordedDurationMs > 0
        ? activeDrawingDurationMs / recordedDurationMs
        : null,
    strokeCount: fixture.strokes.length,
    cancelledStrokeCount,
    pointCount: fixture.strokes.reduce(
      (total, stroke) => total + stroke.points.length,
      0
    ),
    beginCount: eventSummary.eventsByType["stroke.begin"] ?? 0,
    appendCount: eventSummary.eventsByType["stroke.append"] ?? 0,
    endCount: eventSummary.eventsByType["stroke.end"] ?? 0,
    cancelCount: eventSummary.eventsByType["stroke.cancel"] ?? 0,
    eventCount: eventSummary.eventCount,
    averagePointsPerStroke:
      fixture.strokes.length === 0
        ? 0
        : eventSummary.pointCount / fixture.strokes.length,
    averagePointsPerAppend:
      appendEvents.length === 0 ? 0 : appendPointCount / appendEvents.length,
    maximumPointsPerAppend: appendEvents.reduce(
      (maximum, event) => Math.max(maximum, event.points.length),
      0
    ),
    averageStrokeDurationMs:
      strokeDurations.length === 0
        ? 0
        : activeDrawingDurationMs / strokeDurations.length,
    maximumStrokeDurationMs: strokeDurations.reduce(
      (maximum, duration) => Math.max(maximum, duration),
      0
    ),
    eventsPerRecordedMinute: perMinute(
      eventSummary.eventCount,
      recordedDurationMs
    ),
    eventsPerActiveMinute: perMinute(
      eventSummary.eventCount,
      activeDrawingDurationMs
    ),
    pointsPerRecordedMinute: perMinute(
      eventSummary.pointCount,
      recordedDurationMs
    ),
    pointsPerActiveMinute: perMinute(
      eventSummary.pointCount,
      activeDrawingDurationMs
    ),
    jsonBytes: eventSummary.jsonBytes,
    estimatedMessagePackBytes: eventSummary.estimatedMessagePackBytes,
    estimatedMessagePackBytesPerRecordedMinute: perMinute(
      eventSummary.estimatedMessagePackBytes,
      recordedDurationMs
    ),
    estimatedMessagePackBytesPerActiveMinute: perMinute(
      eventSummary.estimatedMessagePackBytes,
      activeDrawingDurationMs
    ),
    largestEstimatedEventBytes: eventSummary.largestEstimatedEventBytes,
    averageEstimatedEventBytes: eventSummary.averageEstimatedEventBytes
  };
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}
