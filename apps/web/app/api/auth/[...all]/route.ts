import { env } from "cloudflare:workers";
import { createAuth } from "../../../server/auth";

async function handleAuthRequest(request: Request): Promise<Response> {
  try {
    return await createAuth(env).handler(request);
  } catch (error) {
    console.error(JSON.stringify({
      message: "auth request failed",
      error: error instanceof Error ? error.message : "unknown error",
      path: new URL(request.url).pathname,
    }));
    return Response.json(
      { code: "AUTH_UNAVAILABLE", message: "Authentication is unavailable" },
      { status: 503 },
    );
  }
}

export {
  handleAuthRequest as DELETE,
  handleAuthRequest as GET,
  handleAuthRequest as PATCH,
  handleAuthRequest as POST,
  handleAuthRequest as PUT,
};
