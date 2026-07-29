import { env } from "cloudflare:workers";
import { createAuth } from "../../../../server/auth";
import { resolveRoomAccessSubject } from "../../../../server/room-access";
import {
  RoomReportNotAvailableError,
  RoomReportSubmissionError,
  parseRoomReportInput,
  submitRoomReport,
} from "../../../../server/reporting";

const MAX_REPORT_BODY_BYTES = 2_048;
const IDEMPOTENCY_KEY_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new TypeError("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    // Stream reads are ordered; parallel reads would lose the byte boundary.
    // oxlint-disable-next-line no-await-in-loop
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_REPORT_BODY_BYTES) {
      // oxlint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw new RangeError("request body is too large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  if (request.headers.get("origin") !== env.PUBLIC_APP_ORIGIN) {
    return Response.json({ error: "ORIGIN_FORBIDDEN" }, { status: 403 });
  }
  const requestId = request.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(requestId)) {
    return Response.json(
      { error: "INVALID_IDEMPOTENCY_KEY" },
      { status: 400 },
    );
  }

  try {
    const session = await createAuth(env).api.getSession({
      headers: request.headers,
    });
    if (session && session.user.status !== "active") {
      return Response.json({ error: "ACCOUNT_NOT_ACTIVE" }, { status: 403 });
    }
    const subject = await resolveRoomAccessSubject(env.DB, {
      appEnvironment: env.APP_ENV,
      cookieHeader: request.headers.get("cookie"),
      userId: session?.user.id,
    });
    const { slug } = await context.params;
    const result = await submitRoomReport(env.REALTIME, {
      requestId,
      publicSlug: slug,
      subject,
      report: parseRoomReportInput(await readBoundedJson(request)),
      retentionDays: env.MODERATION_EVIDENCE_RETENTION_DAYS,
    });
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-type": "application/json",
    });
    if (subject.setCookie) headers.append("set-cookie", subject.setCookie);
    return new Response(JSON.stringify({
      reportId: result.reportId,
      status: result.evidenceStatus,
    }), {
      status: result.status === "created" ? 201 : 200,
      headers,
    });
  } catch (error) {
    if (error instanceof RoomReportNotAvailableError) {
      return Response.json(
        { error: "ROOM_REPORT_NOT_AVAILABLE" },
        { status: 404 },
      );
    }
    if (error instanceof RoomReportSubmissionError) {
      return Response.json(
        { error: "ROOM_REPORT_UNAVAILABLE", retryable: true },
        { status: 503 },
      );
    }
    if (error instanceof RangeError) {
      return Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    console.error(JSON.stringify({
      level: "error",
      message: "room report request failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
