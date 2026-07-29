import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import authMigration from "../../../migrations/d1/0002_better_auth.sql?raw";
import { createAuth, type AuthEnvironment } from "../app/server/auth";
import { applySqlMigration } from "./migrations";

beforeAll(async () => {
  await applySqlMigration(env.DB, authMigration);
});

describe("Better Auth on Cloudflare D1", () => {
  it("returns an unauthenticated session through the mounted handler", async () => {
    const response = await createAuth(env).handler(
      new Request("http://koge.test/api/auth/get-session", {
        headers: { Origin: "http://koge.test" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it("rejects a cross-origin social sign-in request", async () => {
    const response = await createAuth(env).handler(
      new Request("http://koge.test/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: "koge.session_token=invalid-test-token",
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "http://koge.test/",
        }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("fails closed when the auth secret is too short", () => {
    const invalid = {
      ...env,
      BETTER_AUTH_SECRET: "too-short",
    } satisfies AuthEnvironment;

    expect(() => createAuth(invalid)).toThrow(
      "BETTER_AUTH_SECRET must contain at least 32 characters",
    );
  });

  it("does not enable secure cookies for the local origin", () => {
    const auth = createAuth(env);
    expect(auth.options.advanced?.useSecureCookies).toBe(false);
    expect(auth.options.advanced?.defaultCookieAttributes).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    });
  });
});
