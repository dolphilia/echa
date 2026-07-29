import { describe, expect, it } from "vitest";
import { shouldSendChatOnKeyDown } from "../app/chat-input";

describe("shouldSendChatOnKeyDown", () => {
  it("sends on an unmodified Enter key", () => {
    expect(shouldSendChatOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
    })).toBe(true);
  });

  it.each([
    {
      name: "IME composition",
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 13,
    },
    {
      name: "IME fallback key code",
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 229,
    },
    {
      name: "Shift+Enter",
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      keyCode: 13,
    },
    {
      name: "a non-Enter key",
      key: "Space",
      shiftKey: false,
      isComposing: false,
      keyCode: 32,
    },
  ])("does not send for $name", (input) => {
    expect(shouldSendChatOnKeyDown(input)).toBe(false);
  });
});
