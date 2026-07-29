import { describe, expect, it } from "vitest";
import {
  normalizeAvatarUrl,
  normalizeDisplayName,
  parseAccountDeleteConfirmation,
  parseProfileSettingsInput,
} from "../app/server/account-settings";

describe("account settings input", () => {
  it("normalizes a display name and HTTPS avatar URL", () => {
    expect(parseProfileSettingsInput({
      name: "  こげ  ",
      image: "https://example.com/avatar.png",
    })).toEqual({
      name: "こげ",
      image: "https://example.com/avatar.png",
    });
  });

  it("accepts clearing the avatar", () => {
    expect(normalizeAvatarUrl("")).toBeNull();
  });

  it("rejects unsafe or oversized profile values", () => {
    expect(() => normalizeAvatarUrl("http://example.com/avatar.png")).toThrow();
    expect(() => normalizeDisplayName("")).toThrow();
    expect(() => normalizeDisplayName("あ".repeat(41))).toThrow();
  });

  it("requires the exact delete confirmation", () => {
    expect(() => parseAccountDeleteConfirmation({
      confirmation: "delete",
    })).not.toThrow();
    expect(() => parseAccountDeleteConfirmation({
      confirmation: "DELETE",
    })).toThrow();
    expect(() => parseAccountDeleteConfirmation({
      confirmation: "delete",
      extra: true,
    })).toThrow();
  });
});
