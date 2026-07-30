import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ClientStrokeEvent,
  type DrawingTool,
} from "./types";
import { normalizePoint } from "./validation";

export type RawStrokeFixture = {
  readonly schema: string;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
  };
  readonly strokes: readonly {
    readonly caseId?: string;
    readonly tool: DrawingTool;
    readonly color: string;
    readonly size: number;
    readonly opacity: number;
    readonly cancelled?: boolean;
    readonly points: readonly {
      readonly x: number;
      readonly y: number;
      readonly dt: number;
    }[];
  }[];
};

function batchPoints(
  points: RawStrokeFixture["strokes"][number]["points"],
): RawStrokeFixture["strokes"][number]["points"][] {
  const batches: RawStrokeFixture["strokes"][number]["points"][] = [];
  let current: RawStrokeFixture["strokes"][number]["points"][number][] = [];
  let batchStartedAt = points[0]?.dt ?? 0;

  for (const point of points) {
    if (
      current.length > 0
      && (
        current.length >= PROTOCOL_LIMITS.maxPointsPerAppend
        || point.dt - batchStartedAt >= PROTOCOL_LIMITS.appendIntervalMs
      )
    ) {
      batches.push(current);
      current = [];
      batchStartedAt = point.dt;
    }
    current.push(point);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function rawFixtureToClientEvents(fixture: RawStrokeFixture): ClientStrokeEvent[] {
  if (
    fixture.canvas.width !== PROTOCOL_LIMITS.canvasWidth
    || fixture.canvas.height !== PROTOCOL_LIMITS.canvasHeight
  ) {
    throw new RangeError(
      `Fixture canvas does not match protocol v${PROTOCOL_VERSION}`,
    );
  }

  const events: ClientStrokeEvent[] = [];
  let clientSeq = 1;
  fixture.strokes.forEach((stroke, strokeIndex) => {
    const firstPoint = stroke.points[0];
    if (!firstPoint) throw new RangeError(`Stroke ${strokeIndex} has no points`);
    const id = `fixture-stroke-${String(strokeIndex).padStart(6, "0")}`;
    events.push({
      v: PROTOCOL_VERSION,
      op: "stroke.begin",
      clientSeq: clientSeq++,
      id,
      tool: stroke.tool,
      color: stroke.color.toLowerCase(),
      size: stroke.size,
      opacity: stroke.opacity,
      point: normalizePoint(firstPoint.x, firstPoint.y, 0),
    });

    for (const points of batchPoints(stroke.points.slice(1))) {
      events.push({
        v: PROTOCOL_VERSION,
        op: "stroke.append",
        clientSeq: clientSeq++,
        id,
        points: points.map(
          (point) => normalizePoint(point.x, point.y, point.dt),
        ),
      });
    }

    events.push({
      v: PROTOCOL_VERSION,
      op: stroke.cancelled ? "stroke.cancel" : "stroke.end",
      clientSeq: clientSeq++,
      id,
    });
  });
  return events;
}
