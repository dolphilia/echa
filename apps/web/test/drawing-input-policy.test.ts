import { describe, expect, it } from "vitest";
import { resolveSingleTouchAction } from "../app/drawing-input-policy";

describe("drawing input policy", () => {
  it("uses the selected tool when finger drawing is enabled", () => {
    expect(resolveSingleTouchAction({
      fingerDrawingEnabled: true,
      isViewer: false,
      tool: "brush",
    })).toBe("tool");
    expect(resolveSingleTouchAction({
      fingerDrawingEnabled: true,
      isViewer: false,
      tool: "hand",
    })).toBe("pan");
  });

  it("does nothing with one finger when finger drawing is disabled", () => {
    expect(resolveSingleTouchAction({
      fingerDrawingEnabled: false,
      isViewer: false,
      tool: "brush",
    })).toBe("none");
    expect(resolveSingleTouchAction({
      fingerDrawingEnabled: false,
      isViewer: false,
      tool: "hand",
    })).toBe("none");
  });

  it("lets viewers pan without enabling drawing", () => {
    expect(resolveSingleTouchAction({
      fingerDrawingEnabled: false,
      isViewer: true,
      tool: "brush",
    })).toBe("pan");
  });
});
