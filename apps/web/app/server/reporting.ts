import {
  ROOM_REPORT_CATEGORIES,
  ROOM_REPORT_VERSION,
  validateRoomReportResult,
  type RoomReportCategory,
  type RoomReportRequest,
  type RoomReportResult,
} from "@koge/protocol";
import type { RoomAccessSubject } from "./room-access";

export type RoomReportInput = {
  category: RoomReportCategory;
  description?: string;
};

export function parseRoomReportInput(value: unknown): RoomReportInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid room report input");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.category !== "string"
    || !ROOM_REPORT_CATEGORIES.includes(
      record.category as RoomReportCategory,
    )
  ) {
    throw new TypeError("invalid room report input");
  }
  const description = record.description;
  if (
    description !== undefined
    && (
      typeof description !== "string"
      || description.trim().length < 1
      || description.trim().length > 1_000
    )
  ) {
    throw new TypeError("invalid room report input");
  }
  return {
    category: record.category as RoomReportCategory,
    ...(typeof description === "string"
      ? { description: description.trim() }
      : {}),
  };
}

export async function submitRoomReport(
  realtime: Pick<Fetcher, "fetch">,
  input: {
    requestId: string;
    publicSlug: string;
    subject: RoomAccessSubject;
    report: RoomReportInput;
    retentionDays: number;
    now?: number;
  },
): Promise<RoomReportResult> {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      .test(input.requestId)
    || !Number.isSafeInteger(input.retentionDays)
    || input.retentionDays < 1
    || input.retentionDays > 365
  ) {
    throw new TypeError("invalid room report request metadata");
  }
  const requestId = input.requestId.replaceAll("-", "");
  const now = input.now ?? Date.now();
  const request = {
    v: ROOM_REPORT_VERSION,
    reportId: `report_${requestId}`,
    evidenceId: `evidence_${requestId}`,
    publicSlug: input.publicSlug,
    reporterSubjectKind: input.subject.kind,
    reporterSubjectId: input.subject.id,
    category: input.report.category,
    ...(input.report.description
      ? { description: input.report.description }
      : {}),
    requestedAt: now,
    expiresAt: now + input.retentionDays * 24 * 60 * 60 * 1_000,
  } as const satisfies RoomReportRequest;
  const response = await realtime.fetch(
    "https://room-control.internal/rooms/reports",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (response.status === 404) {
    throw new RoomReportNotAvailableError("room report is not available");
  }
  if (!response.ok) {
    throw new RoomReportSubmissionError(
      `room report service returned ${response.status}`,
    );
  }
  const result: unknown = await response.json();
  validateRoomReportResult(result);
  return result;
}

export class RoomReportNotAvailableError extends Error {}
export class RoomReportSubmissionError extends Error {}
