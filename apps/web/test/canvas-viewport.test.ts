import { describe, expect, it } from "vitest";
import {
  canvasToScreen,
  normalizeAngle,
  screenToCanvas,
  touchGestureMetrics,
  viewportAroundAnchor,
  type CanvasViewport,
} from "../app/canvas-viewport";

const origin = { x: 500, y: 400 };
const viewport: CanvasViewport = {
  panX: 42,
  panY: -18,
  zoom: 1.75,
  rotation: 37,
};

describe("canvas viewport", () => {
  it("round-trips canvas points through a rotated viewport", () => {
    const canvasPoint = { x: 173, y: 821 };
    const screenPoint = canvasToScreen(
      canvasPoint,
      origin,
      viewport,
      1_000,
      1_000,
    );
    const restored = screenToCanvas(
      screenPoint,
      origin,
      viewport,
      1_000,
      1_000,
    );
    expect(restored.x).toBeCloseTo(canvasPoint.x, 8);
    expect(restored.y).toBeCloseTo(canvasPoint.y, 8);
  });

  it("keeps the gesture anchor under the current touch center", () => {
    const anchor = { x: 240, y: 670 };
    const center = { x: 430, y: 250 };
    const next = viewportAroundAnchor({
      anchor,
      center,
      stageOrigin: origin,
      zoom: 2.2,
      rotation: -28,
      canvasWidth: 1_000,
      canvasHeight: 1_000,
    });
    const projected = canvasToScreen(
      anchor,
      origin,
      next,
      1_000,
      1_000,
    );
    expect(projected.x).toBeCloseTo(center.x, 8);
    expect(projected.y).toBeCloseTo(center.y, 8);
  });

  it("measures a two-point gesture and normalizes angles", () => {
    expect(touchGestureMetrics(
      { x: 10, y: 20 },
      { x: 40, y: 60 },
    )).toEqual({
      center: { x: 25, y: 40 },
      distance: 50,
      angle: 53.13010235415598,
    });
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-190)).toBe(170);
  });
});
