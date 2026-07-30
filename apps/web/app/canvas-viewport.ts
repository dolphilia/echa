export type ScreenPoint = {
  x: number;
  y: number;
};

export type CanvasViewport = {
  panX: number;
  panY: number;
  zoom: number;
  rotation: number;
};

export type TouchGestureMetrics = {
  center: ScreenPoint;
  distance: number;
  angle: number;
};

export function normalizeAngle(value: number): number {
  let normalized = value % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized <= -180) normalized += 360;
  return normalized;
}

export function screenToCanvas(
  point: ScreenPoint,
  stageOrigin: ScreenPoint,
  viewport: CanvasViewport,
  canvasWidth: number,
  canvasHeight: number,
): ScreenPoint {
  const translatedX = point.x - stageOrigin.x - viewport.panX;
  const translatedY = point.y - stageOrigin.y - viewport.panY;
  const radians = -viewport.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: (
      translatedX * cosine
      - translatedY * sine
    ) / viewport.zoom + canvasWidth / 2,
    y: (
      translatedX * sine
      + translatedY * cosine
    ) / viewport.zoom + canvasHeight / 2,
  };
}

export function canvasToScreen(
  point: ScreenPoint,
  stageOrigin: ScreenPoint,
  viewport: CanvasViewport,
  canvasWidth: number,
  canvasHeight: number,
): ScreenPoint {
  const localX = (point.x - canvasWidth / 2) * viewport.zoom;
  const localY = (point.y - canvasHeight / 2) * viewport.zoom;
  const radians = viewport.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: stageOrigin.x
      + viewport.panX
      + localX * cosine
      - localY * sine,
    y: stageOrigin.y
      + viewport.panY
      + localX * sine
      + localY * cosine,
  };
}

export function touchGestureMetrics(
  first: ScreenPoint,
  second: ScreenPoint,
): TouchGestureMetrics {
  const deltaX = second.x - first.x;
  const deltaY = second.y - first.y;
  return {
    center: {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    },
    distance: Math.hypot(deltaX, deltaY),
    angle: Math.atan2(deltaY, deltaX) * 180 / Math.PI,
  };
}

export function viewportAroundAnchor({
  anchor,
  center,
  stageOrigin,
  zoom,
  rotation,
  canvasWidth,
  canvasHeight,
}: {
  anchor: ScreenPoint;
  center: ScreenPoint;
  stageOrigin: ScreenPoint;
  zoom: number;
  rotation: number;
  canvasWidth: number;
  canvasHeight: number;
}): CanvasViewport {
  const localX = (anchor.x - canvasWidth / 2) * zoom;
  const localY = (anchor.y - canvasHeight / 2) * zoom;
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    panX: center.x
      - stageOrigin.x
      - localX * cosine
      + localY * sine,
    panY: center.y
      - stageOrigin.y
      - localX * sine
      - localY * cosine,
    zoom,
    rotation,
  };
}
