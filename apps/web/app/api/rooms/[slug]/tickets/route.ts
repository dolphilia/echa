import { env } from "cloudflare:workers";
import { createAuth } from "../../../../server/auth";
import {
  RoomAccessForbiddenError,
  RoomEntryDisabledError,
  RoomAccessNotFoundError,
  RoomCapacityReachedError,
  RoomTicketRegistrationError,
  issueRoomTicket,
  resolveRoomAccessSubject,
} from "../../../../server/room-access";
import { ServiceBanActiveError } from "../../../../server/service-bans";

const MAX_TICKET_BODY_BYTES = 1_024;

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
    if (byteLength > MAX_TICKET_BODY_BYTES) {
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

function ticketRequest(value: unknown): {
  role: "participant" | "viewer";
  inviteToken?: string;
} {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("role" in value)
    || (value.role !== "participant" && value.role !== "viewer")
  ) {
    throw new TypeError("invalid requested room role");
  }
  const inviteToken = "inviteToken" in value ? value.inviteToken : undefined;
  if (
    inviteToken !== undefined
    && (
      typeof inviteToken !== "string"
      || !/^[a-f0-9]{64}$/.test(inviteToken)
    )
  ) {
    throw new TypeError("invalid room invite token");
  }
  return {
    role: value.role,
    ...(inviteToken ? { inviteToken } : {}),
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  if (request.headers.get("origin") !== env.PUBLIC_APP_ORIGIN) {
    return Response.json({ error: "ORIGIN_FORBIDDEN" }, { status: 403 });
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
    const accessRequest = ticketRequest(await readBoundedJson(request));
    const ticket = await issueRoomTicket(env.DB, env.REALTIME, {
      publicSlug: slug,
      requestedRole: accessRequest.role,
      inviteToken: accessRequest.inviteToken,
      subject,
    });
    const headers = new Headers({
      "cache-control": "private, no-store",
      "content-type": "application/json",
    });
    if (subject.setCookie) headers.append("set-cookie", subject.setCookie);
    return new Response(JSON.stringify({
      ticket: ticket.ticket,
      actorId: ticket.actorId,
      connectionId: ticket.connectionId,
      role: ticket.role,
      canChat: ticket.canChat,
      expiresAt: ticket.expiresAt,
      realtimeOrigin: env.PUBLIC_REALTIME_ORIGIN,
    }), { status: 201, headers });
  } catch (error) {
    if (error instanceof RoomAccessNotFoundError) {
      return Response.json({ error: "ROOM_NOT_AVAILABLE" }, { status: 404 });
    }
    if (error instanceof RoomAccessForbiddenError) {
      return Response.json({ error: "ROOM_ACCESS_FORBIDDEN" }, { status: 403 });
    }
    if (error instanceof ServiceBanActiveError) {
      return Response.json({ error: "SERVICE_BANNED" }, { status: 403 });
    }
    if (error instanceof RoomEntryDisabledError) {
      return Response.json(
        { error: "ROOM_ENTRY_PAUSED", retryable: true },
        { status: 503 },
      );
    }
    if (error instanceof RoomCapacityReachedError) {
      return Response.json({ error: error.code }, { status: 429 });
    }
    if (error instanceof RoomTicketRegistrationError) {
      return Response.json(
        { error: "ROOM_TICKET_UNAVAILABLE", retryable: true },
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
      message: "room ticket request failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
