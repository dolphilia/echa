import { env } from "cloudflare:workers";
import {
  parseProfileSettingsInput,
  readBoundedJson,
} from "../../../server/account-settings";
import { createAuth } from "../../../server/auth";

export async function PATCH(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== env.PUBLIC_APP_ORIGIN) {
    return Response.json({ error: "ORIGIN_FORBIDDEN" }, { status: 403 });
  }

  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 });
  }
  if (session.user.status !== "active") {
    return Response.json({ error: "ACCOUNT_NOT_ACTIVE" }, { status: 403 });
  }

  try {
    const profile = parseProfileSettingsInput(await readBoundedJson(request));
    await auth.api.updateUser({
      headers: request.headers,
      body: profile,
    });
    return Response.json({ profile });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return Response.json({ error: "INVALID_PROFILE" }, { status: 400 });
    }
    console.error(JSON.stringify({
      level: "error",
      message: "profile update failed",
      userId: session.user.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return Response.json({ error: "PROFILE_UPDATE_FAILED" }, { status: 503 });
  }
}
