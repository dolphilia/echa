import { describe, expect, it, vi } from "vitest";
import {
  RoomReportNotAvailableError,
  RoomReportSubmissionError,
  parseRoomReportInput,
  submitRoomReport,
} from "../app/server/reporting";

describe("room reporting boundary", () => {
  it("normalizes a bounded report description", () => {
    expect(parseRoomReportInput({
      category: "harassment",
      description: "  report details  ",
    })).toEqual({
      category: "harassment",
      description: "report details",
    });
    expect(() => parseRoomReportInput({
      category: "unknown",
    })).toThrow("invalid room report input");
    expect(() => parseRoomReportInput({
      category: "other",
      description: "x".repeat(1_001),
    })).toThrow("invalid room report input");
  });

  it("submits only internal subject identity with provisional retention", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        v: 1,
        reportId: "report_12345678123441238123123456789abc",
        evidenceId: "evidence_12345678123441238123123456789abc",
        publicSlug: "abcdef0123456789abcdef0123456789",
        reporterSubjectKind: "guest",
        reporterSubjectId: "guest-reporting-test",
        category: "other",
        requestedAt: 1_785_300_000_000,
      });
      expect(body.expiresAt).toBe(
        1_785_300_000_000 + 30 * 24 * 60 * 60 * 1_000,
      );
      return Response.json({
        status: "created",
        reportId: body.reportId,
        evidenceId: body.evidenceId,
        evidenceStatus: "pending",
      });
    });
    await expect(submitRoomReport({ fetch }, {
      requestId: "12345678-1234-4123-8123-123456789abc",
      publicSlug: "abcdef0123456789abcdef0123456789",
      subject: { kind: "guest", id: "guest-reporting-test" },
      report: { category: "other" },
      retentionDays: 30,
      now: 1_785_300_000_000,
    })).resolves.toMatchObject({
      status: "created",
      evidenceStatus: "pending",
    });
  });

  it("maps unavailable and retryable service responses", async () => {
    await expect(submitRoomReport({
      fetch: async () => Response.json({}, { status: 404 }),
    }, {
      requestId: "12345678-1234-4123-8123-123456789abc",
      publicSlug: "abcdef0123456789abcdef0123456789",
      subject: { kind: "user", id: "user-reporting-test" },
      report: { category: "other" },
      retentionDays: 30,
    })).rejects.toBeInstanceOf(RoomReportNotAvailableError);
    await expect(submitRoomReport({
      fetch: async () => Response.json({}, { status: 503 }),
    }, {
      requestId: "12345678-1234-4123-8123-123456789abc",
      publicSlug: "abcdef0123456789abcdef0123456789",
      subject: { kind: "user", id: "user-reporting-test" },
      report: { category: "other" },
      retentionDays: 30,
    })).rejects.toBeInstanceOf(RoomReportSubmissionError);
  });
});
