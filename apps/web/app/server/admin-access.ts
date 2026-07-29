import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

const ACCESS_TOKEN_MAX_LENGTH = 16_384;
const ACCESS_AUD_PATTERN = /^[a-f0-9]{64}$/;
const ACCESS_SUBJECT_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export type CloudflareAccessEnvironment = {
  CF_ACCESS_ISSUER: string;
  CF_ACCESS_AUD: string;
};

export type AdminAccessIdentity = {
  actorAdminId: string;
};

export type CloudflareAccessVerificationOptions = {
  key?: JWTVerifyGetKey;
};

function accessConfiguration(
  environment: CloudflareAccessEnvironment,
): { issuer: string; audience: string } {
  let issuer: URL;
  try {
    issuer = new URL(environment.CF_ACCESS_ISSUER);
  } catch {
    throw new CloudflareAccessConfigurationError(
      "CF_ACCESS_ISSUER must be an HTTPS origin",
    );
  }
  if (
    issuer.protocol !== "https:"
    || issuer.origin !== environment.CF_ACCESS_ISSUER
    || !issuer.hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new CloudflareAccessConfigurationError(
      "CF_ACCESS_ISSUER must be a Cloudflare Access HTTPS origin",
    );
  }
  if (!ACCESS_AUD_PATTERN.test(environment.CF_ACCESS_AUD)) {
    throw new CloudflareAccessConfigurationError(
      "CF_ACCESS_AUD must be a 64-character audience tag",
    );
  }
  return {
    issuer: issuer.origin,
    audience: environment.CF_ACCESS_AUD,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function verifyCloudflareAdminAccess(
  headers: Headers,
  environment: CloudflareAccessEnvironment,
  options: CloudflareAccessVerificationOptions = {},
): Promise<AdminAccessIdentity> {
  const { issuer, audience } = accessConfiguration(environment);
  const token = headers.get("cf-access-jwt-assertion");
  if (!token || token.length > ACCESS_TOKEN_MAX_LENGTH) {
    throw new CloudflareAccessAuthorizationError(
      "Cloudflare Access token is missing",
    );
  }
  const key = options.key ?? createRemoteJWKSet(
    new URL(`${issuer}/cdn-cgi/access/certs`),
  );
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "type", "exp", "iat"],
    });
    if (
      payload.type !== "app"
      || typeof payload.sub !== "string"
      || !ACCESS_SUBJECT_PATTERN.test(payload.sub)
    ) {
      throw new CloudflareAccessAuthorizationError(
        "Cloudflare Access identity is not an administrator identity",
      );
    }
    return {
      actorAdminId: `access_${await sha256Hex(payload.sub)}`,
    };
  } catch (error) {
    if (error instanceof CloudflareAccessAuthorizationError) throw error;
    throw new CloudflareAccessAuthorizationError(
      "Cloudflare Access token is invalid",
    );
  }
}

export class CloudflareAccessAuthorizationError extends Error {}
export class CloudflareAccessConfigurationError extends Error {}
