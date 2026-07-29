import { describe, expect, it } from "vitest";
import {
  alternateModifierLabel,
  primaryModifierLabel,
  resolveDrawingShortcut,
  type DrawingShortcutEvent,
} from "../app/drawing-shortcuts";

function keyboardEvent(
  code: string,
  overrides: Partial<DrawingShortcutEvent> = {},
): DrawingShortcutEvent {
  return {
    altKey: false,
    code,
    ctrlKey: false,
    eventType: "keydown",
    key: code,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("drawing shortcuts", () => {
  it("uses familiar painting tool keys", () => {
    expect(resolveDrawingShortcut(keyboardEvent("KeyB"), false))
      .toEqual({ type: "tool", tool: "brush" });
    expect(resolveDrawingShortcut(keyboardEvent("KeyE"), false))
      .toEqual({ type: "tool", tool: "eraser" });
    expect(resolveDrawingShortcut(keyboardEvent("KeyI"), false))
      .toEqual({ type: "tool", tool: "eyedropper" });
    expect(resolveDrawingShortcut(keyboardEvent("KeyZ"), false))
      .toEqual({ type: "tool", tool: "zoom" });
  });

  it("maps brush size and opacity controls", () => {
    expect(resolveDrawingShortcut(keyboardEvent("BracketLeft"), false))
      .toEqual({ type: "brush-size", direction: -1 });
    expect(resolveDrawingShortcut(keyboardEvent("BracketRight"), false))
      .toEqual({ type: "brush-size", direction: 1 });
    expect(resolveDrawingShortcut(keyboardEvent("Digit4"), false))
      .toEqual({ type: "opacity", value: 0.4 });
    expect(resolveDrawingShortcut(keyboardEvent("Digit0"), false))
      .toEqual({ type: "opacity", value: 1 });
  });

  it("temporarily selects the eyedropper while Alt or Option is held", () => {
    expect(resolveDrawingShortcut(
      keyboardEvent("AltLeft", { altKey: true, key: "Alt" }),
      false,
    )).toEqual({ type: "temporary-eyedropper", active: true });
    expect(resolveDrawingShortcut(
      keyboardEvent("AltLeft", {
        eventType: "keyup",
        key: "Alt",
      }),
      true,
    )).toEqual({ type: "temporary-eyedropper", active: false });
  });

  it("uses the platform-native primary modifier", () => {
    expect(resolveDrawingShortcut(
      keyboardEvent("KeyS", { ctrlKey: true }),
      false,
    )).toEqual({ type: "download" });
    expect(resolveDrawingShortcut(
      keyboardEvent("KeyS", { metaKey: true }),
      true,
    )).toEqual({ type: "download" });
    expect(resolveDrawingShortcut(
      keyboardEvent("KeyS", { ctrlKey: true }),
      true,
    )).toBeUndefined();
  });

  it("maps display zoom commands", () => {
    expect(resolveDrawingShortcut(
      keyboardEvent("Equal", { ctrlKey: true, shiftKey: true }),
      false,
    )).toEqual({ type: "zoom", mode: "in" });
    expect(resolveDrawingShortcut(
      keyboardEvent("Digit0", { metaKey: true }),
      true,
    )).toEqual({ type: "zoom", mode: "fit" });
    expect(resolveDrawingShortcut(
      keyboardEvent("Digit1", { metaKey: true }),
      true,
    )).toEqual({ type: "zoom", mode: "actual" });
  });

  it("formats modifier labels for the active OS", () => {
    expect(primaryModifierLabel(true)).toBe("⌘");
    expect(primaryModifierLabel(false)).toBe("Ctrl");
    expect(alternateModifierLabel(true)).toBe("Option");
    expect(alternateModifierLabel(false)).toBe("Alt");
  });
});
