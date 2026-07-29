import { env } from "cloudflare:workers";
import { createAuth } from "../../server/auth";
import {
  RoomCreationConflictError,
  RoomCreationDisabledError,
  RoomCreationLimitError,
  RoomProvisioningError,
  createRoom,
  listPublicRooms,
  parseCreateRoomInput,
} from "../../server/rooms";
import { ServiceBanActiveError } from "../../server/service-bans";

const MAX_CREATE_BODY_BYTES = 4_096;
const IDEMPOTENCY_KEY_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new TypeError("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    // Stream reads are ordered; parallel reads would lose the byte-limit boundary.
    // oxlint-disable-next-line no-await-in-loop
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_CREATE_BODY_BYTES) {
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

export async function GET(): Promise<Response> {
  const rooms = await listPublicRooms(env.DB);
  return Response.json(
    { rooms },
    {
      headers: {
        "cache-control": "public, max-age=5, s-maxage=10",
      },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== env.PUBLIC_APP_ORIGIN) {
    return Response.json({ error: "ORIGIN_FORBIDDEN" }, { status: 403 });
  }
  const createRequestId = request.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(createRequestId)) {
    return Response.json(
      { error: "INVALID_IDEMPOTENCY_KEY" },
      { status: 400 },
    );
  }

  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  if (!session) {
    return Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 });
  }
  if (session.user.status !== "active") {
    return Response.json({ error: "ACCOUNT_NOT_ACTIVE" }, { status: 403 });
  }

  try {
    const input = parseCreateRoomInput(await readBoundedJson(request));
    const room = await createRoom(
      env.DB,
      env.REALTIME,
      session.user.id,
      createRequestId,
      input,
    );
    return Response.json(
      {
        room: {
          publicSlug: room.publicSlug,
          name: room.name,
          visibility: room.visibility,
          status: room.status,
          createdAt: room.createdAt,
          maxEndsAt: room.maxEndsAt,
        },
      },
      {
        status: room.reused ? 200 : 201,
        headers: {
          location: room.visibility === "unlisted" && input.inviteToken
            ? `/rooms/${encodeURIComponent(room.publicSlug)}`
              + `#invite=${encodeURIComponent(input.inviteToken)}`
            : `/rooms/${encodeURIComponent(room.publicSlug)}`,
        },
      },
    );
  } catch (error) {
    if (error instanceof RoomCreationConflictError) {
      return Response.json(
        { error: "IDEMPOTENCY_CONFLICT" },
        { status: 409 },
      );
    }
    if (error instanceof RoomCreationLimitError) {
      return Response.json(
        { error: "LIVE_ROOM_LIMIT_REACHED" },
        { status: 429 },
      );
    }
    if (error instanceof ServiceBanActiveError) {
      return Response.json({ error: "SERVICE_BANNED" }, { status: 403 });
    }
    if (error instanceof RoomCreationDisabledError) {
      return Response.json(
        { error: "ROOM_CREATION_PAUSED", retryable: true },
        { status: 503 },
      );
    }
    if (error instanceof RoomProvisioningError) {
      return Response.json(
        { error: "ROOM_PROVISIONING_FAILED", retryable: true },
        { status: 503 },
      );
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    if (error instanceof RangeError) {
      return Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    }
    console.error(JSON.stringify({
      level: "error",
      message: "room creation request failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ error: "INTERNAL_SERVER_ERROR" }, { status: 500 });
  }
}
