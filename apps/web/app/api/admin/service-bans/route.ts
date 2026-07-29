import { env } from "cloudflare:workers";
import {
  CloudflareAccessAuthorizationError,
  verifyCloudflareAdminAccess,
} from "../../../server/admin-access";
import {
  ServiceBanConflictError,
  ServiceBanNotFoundError,
  listAdminServiceBans,
  revokeServiceBan,
} from "../../../server/service-bans";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const IDEMPOTENCY_KEY_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_BODY_BYTES = 2_048;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new TypeError("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    // Stream reads are ordered so the byte boundary remains exact.
    // oxlint-disable-next-line no-await-in-loop
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
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

export async function GET(request: Request): Promise<Response> {
  try {
    await verifyCloudflareAdminAccess(request.headers, env);
    return Response.json(
      { bans: await listAdminServiceBans(env.DB) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof CloudflareAccessAuthorizationError) {
      return Response.json(
        { error: "ADMIN_AUTHENTICATION_REQUIRED" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    console.error(JSON.stringify({
      level: "error",
      message: "admin service ban list failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      { error: "SERVICE_BAN_LIST_FAILED" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== env.PUBLIC_APP_ORIGIN) {
    return Response.json({ error: "ORIGIN_FORBIDDEN" }, { status: 403 });
  }
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return Response.json(
      { error: "INVALID_IDEMPOTENCY_KEY" },
      { status: 400 },
    );
  }
  try {
    const identity = await verifyCloudflareAdminAccess(request.headers, env);
    const body = await readBoundedJson(request);
    if (
      typeof body !== "object"
      || body === null
      || !("banId" in body)
      || typeof body.banId !== "string"
      || !IDENTIFIER_PATTERN.test(body.banId)
      || !("reason" in body)
      || typeof body.reason !== "string"
      || body.reason.trim() !== body.reason
      || body.reason.length < 1
      || body.reason.length > 500
    ) {
      throw new TypeError("invalid service ban revocation");
    }
    const status = await revokeServiceBan(env.DB, {
      banId: body.banId,
      actionId: `unban_${idempotencyKey}`,
      actorAdminId: identity.actorAdminId,
      reason: body.reason,
    });
    return Response.json(
      { status, banId: body.banId },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof CloudflareAccessAuthorizationError) {
      return Response.json(
        { error: "ADMIN_AUTHENTICATION_REQUIRED" },
        { status: 403 },
      );
    }
    if (error instanceof ServiceBanNotFoundError) {
      return Response.json({ error: "SERVICE_BAN_NOT_FOUND" }, { status: 404 });
    }
    if (error instanceof ServiceBanConflictError) {
      return Response.json({ error: "SERVICE_BAN_CONFLICT" }, { status: 409 });
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    if (error instanceof RangeError) {
      return Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    }
    console.error(JSON.stringify({
      level: "error",
      message: "admin service ban revocation failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      { error: "SERVICE_BAN_REVOCATION_FAILED" },
      { status: 503 },
    );
  }
}
