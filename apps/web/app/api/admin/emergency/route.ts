import { env } from "cloudflare:workers";
import {
  CloudflareAccessAuthorizationError,
  verifyCloudflareAdminAccess,
} from "../../../server/admin-access";
import {
  ServiceControlConflictError,
  applyServiceControls,
  parseServiceControlInput,
  readServiceControls,
} from "../../../server/service-controls";

const MAX_BODY_BYTES = 2_048;
const IDEMPOTENCY_KEY_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new TypeError("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- preserves the exact boundary.
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
      { controls: await readServiceControls(env.DB) },
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
      message: "service controls read failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      { error: "SERVICE_CONTROLS_FAILED", retryable: true },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== env.PUBLIC_APP_ORIGIN) {
    return Response.json(
      { error: "ORIGIN_FORBIDDEN" },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return Response.json(
      { error: "INVALID_IDEMPOTENCY_KEY" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const identity = await verifyCloudflareAdminAccess(request.headers, env);
    const result = await applyServiceControls(env.DB, {
      actionId: `emergency_${idempotencyKey}`,
      actorAdminId: identity.actorAdminId,
      controls: parseServiceControlInput(await readBoundedJson(request)),
    });
    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof CloudflareAccessAuthorizationError) {
      return Response.json(
        { error: "ADMIN_AUTHENTICATION_REQUIRED" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof ServiceControlConflictError) {
      return Response.json(
        { error: "SERVICE_CONTROL_CONFLICT" },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return Response.json(
        { error: "INVALID_REQUEST" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof RangeError) {
      return Response.json(
        { error: "REQUEST_TOO_LARGE" },
        { status: 413, headers: { "cache-control": "no-store" } },
      );
    }
    console.error(JSON.stringify({
      level: "error",
      message: "service controls update failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      { error: "SERVICE_CONTROLS_FAILED", retryable: true },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
