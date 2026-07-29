export const DISPLAY_NAME_MAX_LENGTH = 40;
export const AVATAR_URL_MAX_LENGTH = 2_048;

export type ProfileSettingsInput = {
  name: string;
  image: string | null;
};

export async function readBoundedJson(
  request: Request,
  maximumBytes = 4_096,
): Promise<unknown> {
  if (!request.body) throw new TypeError("request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    // Stream reads must remain ordered to enforce the byte boundary.
    // oxlint-disable-next-line no-await-in-loop
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > maximumBytes) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePointLength(value: string): number {
  return [...value].length;
}

export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("display name must be a string");
  }
  const normalized = value.trim();
  if (
    normalized.length === 0
    || codePointLength(normalized) > DISPLAY_NAME_MAX_LENGTH
  ) {
    throw new RangeError("display name is outside the allowed length");
  }
  return normalized;
}

export function normalizeAvatarUrl(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > AVATAR_URL_MAX_LENGTH) {
    throw new TypeError("avatar URL is invalid");
  }
  const normalized = value.trim();
  if (!normalized) return null;
  const url = new URL(normalized);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.href.length > AVATAR_URL_MAX_LENGTH
  ) {
    throw new TypeError("avatar URL must be a public HTTPS URL");
  }
  return url.href;
}

export function parseProfileSettingsInput(
  value: unknown,
): ProfileSettingsInput {
  if (!isRecord(value)) throw new TypeError("profile input must be an object");
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.includes("name")
    || !keys.includes("image")
  ) {
    throw new TypeError("profile input has unexpected fields");
  }
  return {
    name: normalizeDisplayName(value.name),
    image: normalizeAvatarUrl(value.image),
  };
}

export function parseAccountDeleteConfirmation(value: unknown): void {
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || value.confirmation !== "delete"
  ) {
    throw new TypeError("account deletion confirmation is invalid");
  }
}
