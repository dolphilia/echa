export type SingleTouchAction = "none" | "pan" | "tool";

export function resolveSingleTouchAction({
  fingerDrawingEnabled,
  isViewer,
  tool,
}: {
  fingerDrawingEnabled: boolean;
  isViewer: boolean;
  tool: string;
}): SingleTouchAction {
  if (isViewer) return "pan";
  if (!fingerDrawingEnabled) return "none";
  return tool === "hand" ? "pan" : "tool";
}
