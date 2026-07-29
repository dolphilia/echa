import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ClientStrokeEvent,
  type Point,
  type ValidationIssue,
  type ValidationResult,
} from "./types";

const STROKE_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const KNOWN_OPCODES = new Set([
  "stroke.begin",
  "stroke.append",
  "stroke.end",
  "stroke.cancel",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}

function issue(path: string, message: string): ValidationIssue {
  return { code: "INVALID_FIELD", path, message };
}

function validateExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  issues: ValidationIssue[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(issue(key, "unknown field"));
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      issues.push(issue(key, "required field is missing"));
    }
  }
}

function validatePoint(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.push(issue(path, "point must be [x, y, dt]"));
    return;
  }

  const [x, y, dt] = value;
  if (
    typeof x !== "number"
    || !Number.isFinite(x)
    || x < 0
    || x > PROTOCOL_LIMITS.canvasWidth
    || !hasAtMostTwoDecimals(x)
  ) {
    issues.push(issue(`${path}[0]`, "x must be a canvas coordinate with at most 2 decimals"));
  }
  if (
    typeof y !== "number"
    || !Number.isFinite(y)
    || y < 0
    || y > PROTOCOL_LIMITS.canvasHeight
    || !hasAtMostTwoDecimals(y)
  ) {
    issues.push(issue(`${path}[1]`, "y must be a canvas coordinate with at most 2 decimals"));
  }
  if (
    typeof dt !== "number"
    || !Number.isSafeInteger(dt)
    || dt < 0
    || dt > PROTOCOL_LIMITS.maxStrokeDurationMs
  ) {
    issues.push(issue(`${path}[2]`, "dt must be an integer within the stroke duration limit"));
  }
}

function validateCommon(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  if (value.v !== PROTOCOL_VERSION) {
    issues.push({
      code: "UNSUPPORTED_VERSION",
      path: "v",
      message: `protocol version must be ${PROTOCOL_VERSION}`,
    });
  }
  if (!Number.isSafeInteger(value.clientSeq) || (value.clientSeq as number) < 1) {
    issues.push(issue("clientSeq", "clientSeq must be a positive safe integer"));
  }
  if (typeof value.id !== "string" || !STROKE_ID_PATTERN.test(value.id)) {
    issues.push(issue("id", "id must contain 20-128 URL-safe characters"));
  }
}

export function validateClientEvent(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { success: false, issues: [issue("$", "event must be an object")] };
  }
  if (typeof value.op !== "string" || !KNOWN_OPCODES.has(value.op)) {
    return {
      success: false,
      issues: [{
        code: "UNKNOWN_OPCODE",
        path: "op",
        message: "unsupported stroke opcode",
      }],
    };
  }

  const issues: ValidationIssue[] = [];
  validateCommon(value, issues);

  switch (value.op) {
    case "stroke.begin": {
      validateExactKeys(
        value,
        ["v", "op", "clientSeq", "id", "tool", "color", "size", "opacity", "point"],
        issues,
      );
      if (value.tool !== "brush" && value.tool !== "eraser") {
        issues.push(issue("tool", "tool must be brush or eraser"));
      }
      if (typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)) {
        issues.push(issue("color", "color must be lowercase #rrggbb"));
      }
      if (
        typeof value.size !== "number"
        || !Number.isFinite(value.size)
        || value.size < PROTOCOL_LIMITS.minBrushSize
        || value.size > PROTOCOL_LIMITS.maxBrushSize
      ) {
        issues.push(issue("size", "size is outside the allowed range"));
      }
      if (
        typeof value.opacity !== "number"
        || !Number.isFinite(value.opacity)
        || value.opacity < PROTOCOL_LIMITS.minOpacity
        || value.opacity > PROTOCOL_LIMITS.maxOpacity
        || !hasAtMostTwoDecimals(value.opacity)
      ) {
        issues.push(issue("opacity", "opacity must be 0.05-1 with at most 2 decimals"));
      }
      validatePoint(value.point, "point", issues);
      if (Array.isArray(value.point) && value.point[2] !== 0) {
        issues.push(issue("point[2]", "begin point dt must be 0"));
      }
      break;
    }
    case "stroke.append": {
      validateExactKeys(value, ["v", "op", "clientSeq", "id", "points"], issues);
      if (
        !Array.isArray(value.points)
        || value.points.length < 1
        || value.points.length > PROTOCOL_LIMITS.maxPointsPerAppend
      ) {
        issues.push(issue(
          "points",
          `points must contain 1-${PROTOCOL_LIMITS.maxPointsPerAppend} items`,
        ));
      } else {
        let previousDt = -1;
        value.points.forEach((point, index) => {
          validatePoint(point, `points[${index}]`, issues);
          if (Array.isArray(point) && typeof point[2] === "number") {
            if (point[2] < previousDt) {
              issues.push(issue(`points[${index}][2]`, "dt must be non-decreasing"));
            }
            previousDt = point[2];
          }
        });
      }
      break;
    }
    case "stroke.end":
    case "stroke.cancel":
      validateExactKeys(value, ["v", "op", "clientSeq", "id"], issues);
      break;
  }

  return issues.length === 0
    ? { success: true, data: value as ClientStrokeEvent }
    : { success: false, issues };
}

export function normalizePoint(x: number, y: number, dt: number): Point {
  return [
    Math.round(Math.min(PROTOCOL_LIMITS.canvasWidth, Math.max(0, x)) * 100) / 100,
    Math.round(Math.min(PROTOCOL_LIMITS.canvasHeight, Math.max(0, y)) * 100) / 100,
    Math.min(PROTOCOL_LIMITS.maxStrokeDurationMs, Math.max(0, Math.round(dt))),
  ];
}
