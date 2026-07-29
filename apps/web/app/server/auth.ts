import { betterAuth } from "better-auth";

const MINIMUM_SECRET_LENGTH = 32;

export type AuthEnvironment = Pick<
  Env,
  | "APP_ENV"
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_TRUSTED_ORIGINS"
  | "BETTER_AUTH_URL"
  | "DB"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
>;

function requireNonEmpty(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${name} is required`);
  }
  return normalized;
}

function parseTrustedOrigins(value: string): string[] {
  const origins = value
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const parsed = new URL(candidate);
      if (
        !["http:", "https:"].includes(parsed.protocol)
        || parsed.origin !== candidate.replace(/\/$/, "")
      ) {
        throw new TypeError(
          "BETTER_AUTH_TRUSTED_ORIGINS must contain origins without paths",
        );
      }
      return parsed.origin;
    });

  if (origins.length === 0) {
    throw new TypeError("BETTER_AUTH_TRUSTED_ORIGINS is required");
  }
  return [...new Set(origins)];
}

export function createAuth(environment: AuthEnvironment) {
  const baseURL = new URL(
    requireNonEmpty("BETTER_AUTH_URL", environment.BETTER_AUTH_URL),
  );
  if (!["http:", "https:"].includes(baseURL.protocol) || baseURL.pathname !== "/") {
    throw new TypeError("BETTER_AUTH_URL must be an HTTP(S) origin");
  }

  const secret = requireNonEmpty(
    "BETTER_AUTH_SECRET",
    environment.BETTER_AUTH_SECRET,
  );
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new TypeError(
      `BETTER_AUTH_SECRET must contain at least ${MINIMUM_SECRET_LENGTH} characters`,
    );
  }

  const trustedOrigins = parseTrustedOrigins(
    environment.BETTER_AUTH_TRUSTED_ORIGINS,
  );
  if (!trustedOrigins.includes(baseURL.origin)) {
    throw new TypeError("BETTER_AUTH_URL must be included in trusted origins");
  }

  const secureCookies = environment.APP_ENV !== "local";
  return betterAuth({
    appName: "koge",
    database: environment.DB,
    baseURL: baseURL.origin,
    secret,
    trustedOrigins,
    socialProviders: {
      google: {
        clientId: requireNonEmpty(
          "GOOGLE_CLIENT_ID",
          environment.GOOGLE_CLIENT_ID,
        ),
        clientSecret: requireNonEmpty(
          "GOOGLE_CLIENT_SECRET",
          environment.GOOGLE_CLIENT_SECRET,
        ),
      },
    },
    emailAndPassword: {
      enabled: false,
    },
    user: {
      additionalFields: {
        status: {
          type: "string",
          required: true,
          defaultValue: "active",
          input: false,
        },
        deletionRequestedAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
      deleteUser: {
        enabled: false,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
    },
    advanced: {
      cookiePrefix: "koge",
      useSecureCookies: secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: secureCookies,
      },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
  });
}
