import type { RoomStrokeEvent, StrokeOpcode } from "./types";

const OPCODE_TO_WIRE: Record<StrokeOpcode, number> = {
  "stroke.begin": 0,
  "stroke.append": 1,
  "stroke.end": 2,
  "stroke.cancel": 3,
};

const WIRE_TO_OPCODE: Record<number, StrokeOpcode> = {
  0: "stroke.begin",
  1: "stroke.append",
  2: "stroke.end",
  3: "stroke.cancel",
};

export function toBinaryWireEvent(
  event: RoomStrokeEvent,
): Record<string, unknown> & { readonly op: number } {
  return {
    ...event,
    op: OPCODE_TO_WIRE[event.op],
  };
}

export function fromBinaryWireEvent(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.op !== "number") return value;
  return {
    ...record,
    op: WIRE_TO_OPCODE[record.op] ?? record.op,
  };
}
