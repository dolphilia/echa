import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ClientStrokeEvent,
  type DrawingTool,
  type Point,
  type StrokeAppendEvent,
  type StrokeBeginEvent,
} from "./types";
import { normalizePoint } from "./validation";

export type StrokeStyle = {
  readonly tool: DrawingTool;
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
};

type ActiveStroke = {
  readonly id: string;
  readonly startedAt: number;
  lastFlushAt: number;
  pointCount: number;
  pending: Point[];
};

export class StrokeOutbox {
  #nextClientSeq = 1;
  #active: ActiveStroke | undefined;
  #lastAcknowledgedClientSeq = 0;
  #unsent = new Set<number>();
  #unacknowledged = new Map<number, ClientStrokeEvent>();

  constructor(private readonly createStrokeId: () => string = () => crypto.randomUUID()) {}

  get activeStrokeId(): string | undefined {
    return this.#active?.id;
  }

  get lastIssuedClientSeq(): number {
    return this.#nextClientSeq - 1;
  }

  get lastAcknowledgedClientSeq(): number {
    return this.#lastAcknowledgedClientSeq;
  }

  begin(style: StrokeStyle, x: number, y: number, nowMs: number): StrokeBeginEvent {
    if (this.#active) {
      throw new Error("A stroke is already active");
    }
    const id = this.createStrokeId();
    this.#active = {
      id,
      startedAt: nowMs,
      lastFlushAt: nowMs,
      pointCount: 1,
      pending: [],
    };
    return this.#remember({
      v: PROTOCOL_VERSION,
      op: "stroke.begin",
      clientSeq: this.#takeClientSeq(),
      id,
      ...style,
      point: normalizePoint(x, y, 0),
    });
  }

  append(x: number, y: number, nowMs: number): StrokeAppendEvent | undefined {
    const active = this.#requireActive();
    if (active.pointCount >= PROTOCOL_LIMITS.maxPointsPerStroke) {
      throw new RangeError("ROOM_LIMIT_REACHED");
    }
    active.pending.push(normalizePoint(x, y, nowMs - active.startedAt));
    active.pointCount += 1;

    if (
      active.pending.length >= PROTOCOL_LIMITS.maxPointsPerAppend
      || nowMs - active.lastFlushAt >= PROTOCOL_LIMITS.appendIntervalMs
    ) {
      return this.flush(nowMs);
    }
    return undefined;
  }

  flush(nowMs: number): StrokeAppendEvent | undefined {
    const active = this.#requireActive();
    if (active.pending.length === 0) return undefined;
    const points = active.pending.splice(0, PROTOCOL_LIMITS.maxPointsPerAppend);
    active.lastFlushAt = nowMs;
    return this.#remember({
      v: PROTOCOL_VERSION,
      op: "stroke.append",
      clientSeq: this.#takeClientSeq(),
      id: active.id,
      points,
    });
  }

  end(nowMs: number): ClientStrokeEvent[] {
    const active = this.#requireActive();
    const events: ClientStrokeEvent[] = [];
    while (active.pending.length > 0) {
      const append = this.flush(nowMs);
      if (append) events.push(append);
    }
    events.push(this.#remember({
      v: PROTOCOL_VERSION,
      op: "stroke.end",
      clientSeq: this.#takeClientSeq(),
      id: active.id,
    }));
    this.#active = undefined;
    return events;
  }

  cancel(): ClientStrokeEvent {
    const active = this.#requireActive();
    const event = this.#remember({
      v: PROTOCOL_VERSION,
      op: "stroke.cancel",
      clientSeq: this.#takeClientSeq(),
      id: active.id,
    });
    this.#active = undefined;
    return event;
  }

  acknowledge(clientSeq: number): void {
    if (clientSeq > this.lastIssuedClientSeq) {
      throw new RangeError("Cannot acknowledge a sequence that has not been issued");
    }
    this.#lastAcknowledgedClientSeq = Math.max(
      this.#lastAcknowledgedClientSeq,
      clientSeq,
    );
    for (const sequence of this.#unacknowledged.keys()) {
      if (sequence <= clientSeq) {
        this.#unacknowledged.delete(sequence);
        this.#unsent.delete(sequence);
      }
    }
  }

  eventsToSend(): ClientStrokeEvent[] {
    return [...this.#unsent]
      .sort((left, right) => left - right)
      .flatMap((sequence) => {
        const event = this.#unacknowledged.get(sequence);
        return event ? [event] : [];
      });
  }

  markSent(clientSeq: number): void {
    if (!this.#unacknowledged.has(clientSeq)) {
      throw new RangeError("Cannot mark an unknown sequence as sent");
    }
    this.#unsent.delete(clientSeq);
  }

  eventsToRetry(): ClientStrokeEvent[] {
    return [...this.#unacknowledged.values()].sort(
      (left, right) => left.clientSeq - right.clientSeq,
    );
  }

  #takeClientSeq(): number {
    const sequence = this.#nextClientSeq;
    this.#nextClientSeq += 1;
    return sequence;
  }

  #remember<T extends ClientStrokeEvent>(event: T): T {
    this.#unacknowledged.set(event.clientSeq, event);
    this.#unsent.add(event.clientSeq);
    return event;
  }

  #requireActive(): ActiveStroke {
    if (!this.#active) throw new Error("No stroke is active");
    return this.#active;
  }
}
