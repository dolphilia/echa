import { env } from "cloudflare:workers";
import {
  CloudflareAccessAuthorizationError,
  verifyCloudflareAdminAccess,
} from "../../../server/admin-access";
import { listAdminRooms } from "../../../server/admin-moderation";

export async function GET(request: Request): Promise<Response> {
  try {
    await verifyCloudflareAdminAccess(request.headers, env);
    return Response.json(
      { rooms: await listAdminRooms(env.DB) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof CloudflareAccessAuthorizationError) {
      return Response.json(
        { error: "ADMIN_AUTHENTICATION_REQUIRED" },
        {
          status: 403,
          headers: { "cache-control": "no-store" },
        },
      );
    }
    console.error(JSON.stringify({
      level: "error",
      message: "admin room list failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json(
      { error: "INTERNAL_SERVER_ERROR" },
      {
        status: 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
