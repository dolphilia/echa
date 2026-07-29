import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { describe, expect, it } from "vitest";
import {
  CloudflareAccessAuthorizationError,
  CloudflareAccessConfigurationError,
  verifyCloudflareAdminAccess,
} from "../app/server/admin-access";

const ISSUER = "https://test.cloudflareaccess.com";
const AUDIENCE =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function accessToken(input: {
  audience?: string;
  subject?: string;
  expiresIn?: string;
} = {}): Promise<{ token: string; key: JWTVerifyGetKey }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(input.audience ?? AUDIENCE)
    .setSubject(input.subject ?? "12345678-1234-4123-8123-123456789abc")
    .setIssuedAt()
    .setExpirationTime(input.expiresIn ?? "5m")
    .sign(privateKey);
  return {
    token,
    key: async () => publicKey,
  };
}

describe("Cloudflare Access administrator boundary", () => {
  it("accepts a signed app token for the configured issuer and audience", async () => {
    const { token, key } = await accessToken();
    await expect(verifyCloudflareAdminAccess(
      new Headers({ "cf-access-jwt-assertion": token }),
      {
        CF_ACCESS_ISSUER: ISSUER,
        CF_ACCESS_AUD: AUDIENCE,
      },
      { key },
    )).resolves.toMatchObject({
      actorAdminId: expect.stringMatching(/^access_[a-f0-9]{64}$/),
    });
  });

  it("rejects missing, wrong-audience, and expired tokens", async () => {
    await expect(verifyCloudflareAdminAccess(new Headers(), {
      CF_ACCESS_ISSUER: ISSUER,
      CF_ACCESS_AUD: AUDIENCE,
    })).rejects.toBeInstanceOf(CloudflareAccessAuthorizationError);

    const wrongAudience = await accessToken({
      audience:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    await expect(verifyCloudflareAdminAccess(
      new Headers({ "cf-access-jwt-assertion": wrongAudience.token }),
      {
        CF_ACCESS_ISSUER: ISSUER,
        CF_ACCESS_AUD: AUDIENCE,
      },
      { key: wrongAudience.key },
    )).rejects.toBeInstanceOf(CloudflareAccessAuthorizationError);

    const expired = await accessToken({ expiresIn: "-1s" });
    await expect(verifyCloudflareAdminAccess(
      new Headers({ "cf-access-jwt-assertion": expired.token }),
      {
        CF_ACCESS_ISSUER: ISSUER,
        CF_ACCESS_AUD: AUDIENCE,
      },
      { key: expired.key },
    )).rejects.toBeInstanceOf(CloudflareAccessAuthorizationError);
  });

  it("fails closed for malformed Access configuration", async () => {
    await expect(verifyCloudflareAdminAccess(new Headers(), {
      CF_ACCESS_ISSUER: "http://test.cloudflareaccess.com/path",
      CF_ACCESS_AUD: "short",
    })).rejects.toBeInstanceOf(CloudflareAccessConfigurationError);
  });
});
