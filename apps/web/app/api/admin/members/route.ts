import { env } from "cloudflare:workers";
import {
  CloudflareAccessAuthorizationError,
  verifyCloudflareAdminAccess,
} from "../../../server/admin-access";
import {
  AdminModerationSubmissionError,
  AdminModerationNotAvailableError,
  listAdminRoomMembers,
} from "../../../server/admin-moderation";

export async function GET(request: Request): Promise<Response> {
  try {
    await verifyCloudflareAdminAccess(request.headers, env);
    const roomId = new URL(request.url).searchParams.get("roomId");
    if (!roomId) throw new TypeError("roomId is required");
    const members = await listAdminRoomMembers(env.DB, env.REALTIME, roomId);
    return Response.json(
      { members },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof CloudflareAccessAuthorizationError) {
      return Response.json(
        { error: "ADMIN_AUTHENTICATION_REQUIRED" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof TypeError) {
      return Response.json(
        { error: "INVALID_REQUEST" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof AdminModerationNotAvailableError) {
      return Response.json(
        { error: "ROOM_MODERATION_NOT_AVAILABLE" },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }
    console.error(JSON.stringify({
      level: "error",
      message: "admin member request failed",
      error: error instanceof AdminModerationSubmissionError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error),
    }));
    return Response.json(
      { error: "ROOM_MEMBERS_FAILED", retryable: true },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
