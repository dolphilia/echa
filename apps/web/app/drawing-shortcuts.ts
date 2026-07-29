export type DrawingShortcutAction =
  | { type: "tool"; tool: "brush" | "eraser" | "eyedropper" | "zoom" }
  | { type: "temporary-eyedropper"; active: boolean }
  | { type: "brush-size"; direction: -1 | 1 }
  | { type: "opacity"; value: number }
  | { type: "zoom"; mode: "in" | "out" | "fit" | "actual" }
  | { type: "color" }
  | { type: "chat" }
  | { type: "download" }
  | { type: "help" }
  | { type: "escape" };

export type DrawingShortcutEvent = {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  eventType: "keydown" | "keyup";
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
};

export function primaryModifierLabel(isApplePlatform: boolean): string {
  return isApplePlatform ? "⌘" : "Ctrl";
}

export function alternateModifierLabel(isApplePlatform: boolean): string {
  return isApplePlatform ? "Option" : "Alt";
}

export function resolveDrawingShortcut(
  event: DrawingShortcutEvent,
  isApplePlatform: boolean,
): DrawingShortcutAction | undefined {
  const primaryModifier = isApplePlatform ? event.metaKey : event.ctrlKey;
  const unexpectedPrimaryModifier = isApplePlatform
    ? event.ctrlKey
    : event.metaKey;

  if (
    event.code === "AltLeft"
    || event.code === "AltRight"
  ) {
    return {
      type: "temporary-eyedropper",
      active: event.eventType === "keydown" && event.key !== "AltGraph",
    };
  }

  if (primaryModifier && !unexpectedPrimaryModifier && !event.altKey) {
    if (!event.shiftKey && event.code === "KeyS") {
      return { type: "download" };
    }
    if (event.code === "Equal" || event.code === "NumpadAdd") {
      return { type: "zoom", mode: "in" };
    }
    if (!event.shiftKey && (event.code === "Minus" || event.code === "NumpadSubtract")) {
      return { type: "zoom", mode: "out" };
    }
    if (!event.shiftKey && (event.code === "Digit0" || event.code === "Numpad0")) {
      return { type: "zoom", mode: "fit" };
    }
    if (!event.shiftKey && (event.code === "Digit1" || event.code === "Numpad1")) {
      return { type: "zoom", mode: "actual" };
    }
    return undefined;
  }

  if (
    event.ctrlKey
    || event.metaKey
    || event.altKey
  ) return undefined;

  if (event.code === "KeyB") return { type: "tool", tool: "brush" };
  if (event.code === "KeyE") return { type: "tool", tool: "eraser" };
  if (event.code === "KeyI") return { type: "tool", tool: "eyedropper" };
  if (event.code === "KeyZ") return { type: "tool", tool: "zoom" };
  if (event.code === "BracketLeft") {
    return { type: "brush-size", direction: -1 };
  }
  if (event.code === "BracketRight") {
    return { type: "brush-size", direction: 1 };
  }
  if (/^Digit[0-9]$/.test(event.code)) {
    const digit = Number(event.code.slice(-1));
    return { type: "opacity", value: digit === 0 ? 1 : digit / 10 };
  }
  if (event.code === "F6") return { type: "color" };
  if (event.code === "KeyT") return { type: "chat" };
  if (event.code === "Slash" && event.shiftKey) return { type: "help" };
  if (event.code === "Escape") return { type: "escape" };
  return undefined;
}
