import { env } from "cloudflare:workers";
import {
  parseAccountDeleteConfirmation,
  readBoundedJson,
} from "../../../server/account-settings";
import { createAuth } from "../../../server/auth";

const FRESH_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function expiredSessionCookieHeaders(): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
  });
  const attributes = [
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(env.APP_ENV === "local" ? [] : ["Secure"]),
  ].join("; ");
  const names = env.APP_ENV === "local"
    ? ["koge.session_token", "koge.session_data"]
    : ["__Secure-koge.session_token", "__Secure-koge.session_data"];
  for (const name of names) {
    headers.append("set-cookie", `${name}=; ${attributes}`);
  }
  return headers;
}

export async function DELETE(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== env.PUBLIC_APP_ORIGIN) {
    return Response.json({ error: "ORIGIN_FORBIDDEN" }, { status: 403 });
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
    parseAccountDeleteConfirmation(await readBoundedJson(request, 128));
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return Response.json(
        { error: "INVALID_DELETE_CONFIRMATION" },
        { status: 400 },
      );
    }
    throw error;
  }

  const sessionCreatedAt = new Date(session.session.createdAt).getTime();
  if (
    !Number.isFinite(sessionCreatedAt)
    || Date.now() - sessionCreatedAt > FRESH_SESSION_MAX_AGE_MS
  ) {
    return Response.json(
      { error: "REAUTHENTICATION_REQUIRED" },
      { status: 403 },
    );
  }

  const requestedAt = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE user
       SET status = 'deleting', deletionRequestedAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'active'`,
    ).bind(requestedAt, requestedAt, session.user.id),
    env.DB.prepare("DELETE FROM session WHERE userId = ?")
      .bind(session.user.id),
    env.DB.prepare("DELETE FROM account WHERE userId = ?")
      .bind(session.user.id),
  ]);

  let cleanupScheduled = false;
  try {
    const response = await env.REALTIME.fetch(
      new Request("https://realtime.internal/accounts/deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: session.user.id,
          requestId: `account_${crypto.randomUUID().replaceAll("-", "")}`,
        }),
      }),
    );
    cleanupScheduled = response.ok;
    if (!response.ok) {
      console.error(JSON.stringify({
        level: "error",
        message: "account deletion scheduling failed",
        userId: session.user.id,
        status: response.status,
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "account deletion scheduling unavailable",
      userId: session.user.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  return Response.json(
    {
      status: cleanupScheduled ? "deleting" : "deletion_queued",
    },
    {
      status: 202,
      headers: expiredSessionCookieHeaders(),
    },
  );
}
