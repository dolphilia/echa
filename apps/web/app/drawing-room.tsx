"use client";

import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  SNAPSHOT_CANVAS_GENERATION,
  SNAPSHOT_RENDERER_VERSION,
  StrokeOutbox,
  decodeServerMessage,
  encodeClientChatMessage,
  encodeClientCursorMessage,
  encodeClientRoomCloseMessage,
  encodeClientRoomStartMessage,
  encodeEvent,
  type AcceptedStrokeEvent,
  type ChatMessage,
  type ClientStrokeEvent,
  type DrawingTool,
  type Point,
  type PresenceMember,
  type RoomActivityMessage,
  type RoomRole,
  type RoomStrokeEvent,
  type RoomTimeMessage,
  type StrokeStyle,
} from "@koge/protocol";
import {
  RendererSession,
  instantiateRenderer,
  type RendererFixture,
} from "@koge/renderer-core";
import {
  Brush,
  Download,
  Ellipsis,
  Eraser,
  House,
  Keyboard,
  MessageSquare,
  PanelRightClose,
  Pipette,
  Search,
  SendHorizontal,
  Share2,
  SlidersHorizontal,
  Square,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  nextSnapshotFallbackState,
  recoverSnapshotOrFallback,
  type VerifiedSnapshot,
} from "./snapshot-recovery";
import { shouldSendChatOnKeyDown } from "./chat-input";
import {
  canvasDownloadFilename,
  canvasPngBlob,
  downloadBlob,
} from "./canvas-download";
import {
  alternateModifierLabel,
  primaryModifierLabel,
  resolveDrawingShortcut,
} from "./drawing-shortcuts";
import { shouldAutoStartRoom } from "./room-auto-start";

type SelectedTool = DrawingTool | "eyedropper" | "zoom";
type ColorPickerView = "circle" | "square" | "sliders";
type ColorSliderMode = "hsb" | "rgb";
type HsvColor = { h: number; s: number; v: number };
type RgbColor = { r: number; g: number; b: number };
type RealtimeNoticeTone = "success" | "info" | "warning" | "error";
type RealtimeNoticePauseReason = "pointer" | "focus";
type RealtimeNotice = {
  id: number;
  message: string;
  tone: RealtimeNoticeTone;
  durationMs: number;
};
type SliderPreview = "size" | "opacity";
type ActiveDrawing = {
  id: string;
  style: StrokeStyle;
  points: Point[];
  pointerId: number;
  startedAt: number;
};
type DragState =
  | { mode: "pan"; pointerId: number; x: number; y: number }
  | { mode: "zoom"; pointerId: number; x: number; zoom: number };
type ReplayedStroke = {
  style: StrokeStyle;
  points: Point[];
};
type CanonicalStroke = RendererFixture["strokes"][number];
type DrawingMetrics = {
  provisionalMs: number[];
  canonicalMs: number[];
};
type BrowserRecoveryMetrics = {
  schema: "koge.browser-recovery.v1";
  source: "event-log" | "snapshot";
  startedAt: number;
  socketOpenMs?: number;
  snapshotOfferMs?: number;
  snapshotFetchMs?: number;
  snapshotBodyReadMs?: number;
  snapshotObjectHashMs?: number;
  snapshotDecodeMs?: number;
  snapshotRgbaHashMs?: number;
  snapshotVerificationMs?: number;
  snapshotApplyMs?: number;
  snapshotAppliedMs?: number;
  snapshotObjectBytes?: number;
  snapshotRgbaBytes?: number;
  snapshotBaseRoomSeq?: number;
  firstTailFrameMs?: number;
  tailFrameCount: number;
  tailEventCount: number;
  tailEncodedBytes: number;
  tailDecodeMs: number;
  tailApplyMs: number;
  readyMs?: number;
  readyPaintMs?: number;
  readyRoomSeq?: number;
  status: "connecting" | "recovering" | "ready" | "painted" | "fallback";
  fallbackReason?: string;
};
type RoomTicketResponse = {
  ticket: string;
  actorId: string;
  connectionId: string;
  role: "host" | "participant" | "viewer";
  canChat: boolean;
  expiresAt: number;
  realtimeOrigin: string;
};
type RequestedRoomRole = Exclude<RoomRole, "host">;

const REALTIME_NOTICE_DURATION: Record<RealtimeNoticeTone, number> = {
  success: 3_000,
  info: 4_000,
  warning: 6_000,
  error: 7_000,
};
type RemoteCursor = {
  x: number;
  y: number;
};

declare global {
  interface Window {
    kogeDrawingMetrics?: DrawingMetrics;
    kogeSnapshotRecovery?: {
      status: "applied" | "fallback";
      baseRoomSeq?: number;
      reason?: string;
    };
    kogeBrowserRecoveryMetrics?: BrowserRecoveryMetrics;
  }
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hsvToRgb({ h, s, v }: HsvColor): RgbColor {
  const hue = ((h % 360) + 360) % 360;
  const saturation = s / 100;
  const brightness = v / 100;
  const chroma = brightness * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = brightness - chroma;
  let channels: [number, number, number];

  if (hue < 60) channels = [chroma, x, 0];
  else if (hue < 120) channels = [x, chroma, 0];
  else if (hue < 180) channels = [0, chroma, x];
  else if (hue < 240) channels = [0, x, chroma];
  else if (hue < 300) channels = [x, 0, chroma];
  else channels = [chroma, 0, x];

  return {
    r: Math.round((channels[0] + offset) * 255),
    g: Math.round((channels[1] + offset) * 255),
    b: Math.round((channels[2] + offset) * 255),
  };
}

function rgbToHsv({ r, g, b }: RgbColor): HsvColor {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;

  if (delta !== 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;

  return {
    h: hue,
    s: maximum === 0 ? 0 : (delta / maximum) * 100,
    v: maximum * 100,
  };
}

function rgbToHex({ r, g, b }: RgbColor): string {
  return `#${[r, g, b]
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToRgb(value: string): RgbColor | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  const hex = match?.[1];
  if (!hex) return undefined;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function cursorColor(actor: string): string {
  let hash = 0;
  for (const character of actor) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return `hsl(${hash % 360} 42% 48%)`;
}

function drawStroke(
  context: CanvasRenderingContext2D,
  points: readonly Point[],
  style: StrokeStyle,
): void {
  const first = points[0];
  if (!first) return;
  context.strokeStyle = style.tool === "eraser" ? "#ffffff" : style.color;
  context.fillStyle = context.strokeStyle;
  context.lineWidth = style.size;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (points.length === 1) {
    context.beginPath();
    context.arc(first[0], first[1], context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }

  context.beginPath();
  context.moveTo(first[0], first[1]);
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (!point || !next) continue;
    context.quadraticCurveTo(
      point[0],
      point[1],
      (point[0] + next[0]) / 2,
      (point[1] + next[1]) / 2,
    );
  }
  const last = points.at(-1);
  if (last) context.lineTo(last[0], last[1]);
  context.stroke();
}

function canonicalStroke(stroke: ReplayedStroke): CanonicalStroke {
  return {
    tool: stroke.style.tool,
    color: stroke.style.color,
    size: stroke.style.size,
    opacity: stroke.style.opacity,
    points: stroke.points.map(([x, y, dt]) => ({ x, y, dt })),
  };
}

function recordMetric(name: keyof DrawingMetrics, value: number): void {
  const metrics = window.kogeDrawingMetrics ?? {
    provisionalMs: [],
    canonicalMs: [],
  };
  metrics[name].push(value);
  if (metrics[name].length > 512) {
    metrics[name].splice(0, metrics[name].length - 512);
  }
  window.kogeDrawingMetrics = metrics;
}

function parseRoomTicketResponse(value: unknown): RoomTicketResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid room ticket response");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.ticket !== "string"
    || !/^[a-f0-9]{64}$/.test(record.ticket)
    || typeof record.actorId !== "string"
    || typeof record.connectionId !== "string"
    || (
      record.role !== "host"
      && record.role !== "participant"
      && record.role !== "viewer"
    )
    || typeof record.expiresAt !== "number"
    || !Number.isSafeInteger(record.expiresAt)
    || typeof record.canChat !== "boolean"
    || typeof record.realtimeOrigin !== "string"
  ) {
    throw new TypeError("invalid room ticket response");
  }
  return {
    ticket: record.ticket,
    actorId: record.actorId,
    connectionId: record.connectionId,
    role: record.role,
    canChat: record.canChat,
    expiresAt: record.expiresAt,
    realtimeOrigin: record.realtimeOrigin,
  };
}

function ToolIcon({ tool }: { tool: SelectedTool }) {
  const icons: Record<SelectedTool, LucideIcon> = {
    brush: Brush,
    eraser: Eraser,
    eyedropper: Pipette,
    zoom: Search,
  };
  const Icon = icons[tool];
  return <Icon aria-hidden="true" />;
}

const TOOL_LABELS: Record<SelectedTool, string> = {
  brush: "ブラシ",
  eraser: "消しゴム",
  eyedropper: "スポイト",
  zoom: "ズーム",
};

const TOOL_SHORTCUTS: Record<SelectedTool, string> = {
  brush: "B",
  eraser: "E",
  eyedropper: "I",
  zoom: "Z",
};

function isShortcutTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (
      target.isContentEditable
      || target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
    );
}

export default function DrawingRoom({
  isAuthenticated = false,
  roomSlug,
  roomName = "お絵描きルーム",
}: {
  isAuthenticated?: boolean;
  roomSlug?: string;
  roomName?: string;
}) {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const remoteCanvasRef = useRef<HTMLCanvasElement>(null);
  const provisionalCanvasRef = useRef<HTMLCanvasElement>(null);
  const eyedropperPreviewRef = useRef<HTMLCanvasElement>(null);
  const colorDialogRef = useRef<HTMLDivElement>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const outboxRef = useRef(new StrokeOutbox());
  const drawingRef = useRef<ActiveDrawing | undefined>(undefined);
  const dragRef = useRef<DragState | undefined>(undefined);
  const colorDragRef = useRef<
    { pointerId: number; offsetX: number; offsetY: number } | undefined
  >(undefined);
  const pickerDragRef = useRef<
    { pointerId: number; target: "circle-hue" | "circle-sv" | "square-sv" }
    | undefined
  >(undefined);
  const lastDrawingToolRef = useRef<DrawingTool>("brush");
  const zoomHudTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const realtimeNoticeTimerRef = useRef<number | undefined>(undefined);
  const realtimeNoticeSequenceRef = useRef(0);
  const realtimeNoticeStartedAtRef = useRef(0);
  const realtimeNoticeRemainingRef = useRef(0);
  const realtimeNoticePauseRef = useRef({ pointer: false, focus: false });
  const autoStartRequestedRef = useRef(false);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const ownConnectionIdsRef = useRef(new Set<string>());
  const lastRoomSeqRef = useRef(0);
  const replayedStrokesRef = useRef(new Map<string, ReplayedStroke>());
  const ownStrokeIdsRef = useRef(new Set<string>());
  const canonicalSessionRef = useRef<RendererSession | undefined>(undefined);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshotRecoveryDisabledRef = useRef(false);
  const recoveryMetricsRef = useRef<BrowserRecoveryMetrics | undefined>(
    undefined,
  );
  const failedSnapshotJobIdsRef = useRef<readonly string[]>([]);
  const inviteTokenRef = useRef<string | undefined>(undefined);
  const reportRequestIdRef = useRef<string | undefined>(undefined);
  const currentActorRef = useRef<string | undefined>(undefined);
  const lastCursorSentAtRef = useRef(0);
  const chatComposingRef = useRef(false);
  const chatOpenRef = useRef(Boolean(roomSlug));
  const chatMessageIdsRef = useRef(new Set<string>());
  const remoteCursorTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const temporaryToolRef = useRef<SelectedTool | undefined>(undefined);
  const sliderPreviewPointerRef = useRef<number | undefined>(undefined);
  const [tool, setTool] = useState<SelectedTool>("brush");
  const [color, setColor] = useState("#574f43");
  const [pickerHsv, setPickerHsv] = useState<HsvColor>(() =>
    rgbToHsv(hexToRgb("#574f43")!)
  );
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [colorPickerView, setColorPickerView] =
    useState<ColorPickerView>("circle");
  const [colorSliderMode, setColorSliderMode] =
    useState<ColorSliderMode>("hsb");
  const [hexInput, setHexInput] = useState("#574F43");
  const [colorDialogPosition, setColorDialogPosition] = useState({
    left: 76,
    top: 92,
  });
  const [eyedropperCursor, setEyedropperCursor] = useState({
    visible: false,
    left: 0,
    top: 0,
    sampledColor: "#ffffff",
  });
  const [brushSize, setBrushSize] = useState(3);
  const [eraserSize, setEraserSize] = useState(6);
  const [opacity, setOpacity] = useState(1);
  const [sliderPreview, setSliderPreview] =
    useState<SliderPreview | undefined>();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [zooming, setZooming] = useState(false);
  const [, setEventCount] = useState(0);
  const [syncEnabled, setSyncEnabled] = useState(Boolean(roomSlug));
  const [requestedRole, setRequestedRole] = useState<
    RequestedRoomRole | undefined
  >(roomSlug ? undefined : "participant");
  const [assignedRole, setAssignedRole] = useState<RoomRole | undefined>();
  const [realtimeNotice, setRealtimeNotice] =
    useState<RealtimeNotice | undefined>();
  const [downloadPending, setDownloadPending] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [isApplePlatform, setIsApplePlatform] = useState(false);
  const [presenceMembers, setPresenceMembers] = useState<
    readonly PresenceMember[]
  >([]);
  const [remoteCursors, setRemoteCursors] = useState<
    ReadonlyMap<string, RemoteCursor>
  >(new Map());
  const [chatMessages, setChatMessages] = useState<readonly ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const [chatOpen, setChatOpen] = useState(Boolean(roomSlug));
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [canChat, setCanChat] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState("other");
  const [reportDescription, setReportDescription] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [roomLifecycleStatus, setRoomLifecycleStatus] = useState<
    "waiting" | "active" | "idle" | "closing" | "suspended" | undefined
  >();
  const [roomActivity, setRoomActivity] = useState<
    RoomActivityMessage | undefined
  >();
  const [, setRoomTime] = useState<RoomTimeMessage | undefined>();
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererError, setRendererError] = useState(false);
  const [recoverySource, setRecoverySource] = useState<"event-log" | "snapshot">(
    "event-log",
  );
  const [connectionStatus, setConnectionStatus] = useState<
    | "local"
    | "choosing"
    | "connecting"
    | "recovering"
    | "connected"
    | "disconnected"
  >(roomSlug ? "choosing" : "local");

  useEffect(() => {
    setIsApplePlatform(
      /Mac|iPhone|iPad|iPod/.test(
        navigator.platform || navigator.userAgent,
      ),
    );
  }, []);

  useEffect(() => {
    const finishSliderPreview = (event: PointerEvent) => {
      if (event.pointerId !== sliderPreviewPointerRef.current) return;
      sliderPreviewPointerRef.current = undefined;
      setSliderPreview(undefined);
    };
    const hideSliderPreview = () => {
      sliderPreviewPointerRef.current = undefined;
      setSliderPreview(undefined);
    };
    window.addEventListener("pointerup", finishSliderPreview);
    window.addEventListener("pointercancel", finishSliderPreview);
    window.addEventListener("blur", hideSliderPreview);
    return () => {
      window.removeEventListener("pointerup", finishSliderPreview);
      window.removeEventListener("pointercancel", finishSliderPreview);
      window.removeEventListener("blur", hideSliderPreview);
    };
  }, []);

  const clearRealtimeNoticeTimer = useCallback(() => {
    if (realtimeNoticeTimerRef.current !== undefined) {
      window.clearTimeout(realtimeNoticeTimerRef.current);
      realtimeNoticeTimerRef.current = undefined;
    }
  }, []);

  const dismissRealtimeNotice = useCallback(() => {
    clearRealtimeNoticeTimer();
    realtimeNoticePauseRef.current = { pointer: false, focus: false };
    setRealtimeNotice(undefined);
  }, [clearRealtimeNoticeTimer]);

  const scheduleRealtimeNoticeDismiss = useCallback((durationMs: number) => {
    clearRealtimeNoticeTimer();
    realtimeNoticeRemainingRef.current = durationMs;
    realtimeNoticeStartedAtRef.current = performance.now();
    realtimeNoticeTimerRef.current = window.setTimeout(() => {
      realtimeNoticeTimerRef.current = undefined;
      setRealtimeNotice(undefined);
    }, durationMs);
  }, [clearRealtimeNoticeTimer]);

  const showRealtimeNotice = useCallback((
    message: string | undefined,
    tone: RealtimeNoticeTone = "info",
    durationMs = REALTIME_NOTICE_DURATION[tone],
  ) => {
    clearRealtimeNoticeTimer();
    realtimeNoticePauseRef.current = { pointer: false, focus: false };
    if (!message) {
      setRealtimeNotice(undefined);
      return;
    }
    setRealtimeNotice({
      id: ++realtimeNoticeSequenceRef.current,
      message,
      tone,
      durationMs,
    });
  }, [clearRealtimeNoticeTimer]);

  const pauseRealtimeNotice = useCallback((
    reason: RealtimeNoticePauseReason,
  ) => {
    realtimeNoticePauseRef.current[reason] = true;
    if (realtimeNoticeTimerRef.current === undefined) return;
    realtimeNoticeRemainingRef.current = Math.max(
      0,
      realtimeNoticeRemainingRef.current
        - (performance.now() - realtimeNoticeStartedAtRef.current),
    );
    clearRealtimeNoticeTimer();
  }, [clearRealtimeNoticeTimer]);

  const resumeRealtimeNotice = useCallback((
    reason: RealtimeNoticePauseReason,
  ) => {
    realtimeNoticePauseRef.current[reason] = false;
    if (
      realtimeNoticePauseRef.current.pointer
      || realtimeNoticePauseRef.current.focus
      || realtimeNoticeTimerRef.current !== undefined
    ) return;
    if (realtimeNoticeRemainingRef.current <= 0) {
      dismissRealtimeNotice();
      return;
    }
    scheduleRealtimeNoticeDismiss(realtimeNoticeRemainingRef.current);
  }, [dismissRealtimeNotice, scheduleRealtimeNoticeDismiss]);

  useEffect(() => {
    if (!realtimeNotice) return;
    scheduleRealtimeNoticeDismiss(realtimeNotice.durationMs);
    return clearRealtimeNoticeTimer;
  }, [
    clearRealtimeNoticeTimer,
    realtimeNotice?.id,
    scheduleRealtimeNoticeDismiss,
  ]);
  const canDraw = !roomSlug
    || (
      roomLifecycleStatus !== "waiting"
      && roomLifecycleStatus !== "closing"
      && roomLifecycleStatus !== "suspended"
      && roomActivity?.acceptingNewStrokes !== false
      && (
        assignedRole === "host"
        || assignedRole === "participant"
      )
    );
  const canSendChat = canChat
    && roomLifecycleStatus !== "waiting"
    && roomLifecycleStatus !== "closing"
    && roomLifecycleStatus !== "suspended";
  const sizeTool = tool === "brush" || tool === "eraser"
    ? tool
    : lastDrawingToolRef.current;
  const size = sizeTool === "eraser" ? eraserSize : brushSize;
  const beginSliderPreview = (
    preview: SliderPreview,
    event: ReactPointerEvent<HTMLInputElement>,
  ) => {
    sliderPreviewPointerRef.current = event.pointerId;
    setSliderPreview(preview);
  };

  const canvasPoint = useCallback((
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.round(
        ((event.clientX - rect.left) / rect.width)
        * PROTOCOL_LIMITS.canvasWidth
        * 100,
      ) / 100,
      Math.round(
        ((event.clientY - rect.top) / rect.height)
        * PROTOCOL_LIMITS.canvasHeight
        * 100,
      ) / 100,
      0,
    ];
  }, []);

  const applyPickerHsv = useCallback((next: HsvColor) => {
    const normalized = {
      h: clamp(next.h, 0, 360),
      s: clamp(next.s, 0, 100),
      v: clamp(next.v, 0, 100),
    };
    const nextColor = rgbToHex(hsvToRgb(normalized));
    setPickerHsv(normalized);
    setColor(nextColor);
    setHexInput(nextColor.toUpperCase());
  }, []);

  const applyRgbColor = useCallback((next: RgbColor) => {
    applyPickerHsv(rgbToHsv({
      r: clamp(Math.round(next.r), 0, 255),
      g: clamp(Math.round(next.g), 0, 255),
      b: clamp(Math.round(next.b), 0, 255),
    }));
  }, [applyPickerHsv]);

  const applyHexColor = useCallback((next: string): boolean => {
    const rgb = hexToRgb(next);
    if (!rgb) return false;
    applyRgbColor(rgb);
    return true;
  }, [applyRgbColor]);

  const selectTool = useCallback((next: SelectedTool) => {
    if (next === "brush" || next === "eraser") {
      lastDrawingToolRef.current = next;
    }
    setTool(next);
    if (next !== "eyedropper") {
      setEyedropperCursor((current) => ({ ...current, visible: false }));
    }
  }, []);

  const updateEyedropperPreview = useCallback((
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): string | undefined => {
    const preview = eyedropperPreviewRef.current;
    const previewContext = preview?.getContext("2d", {
      willReadFrequently: true,
    });
    const base = baseCanvasRef.current;
    if (!preview || !previewContext || !base) return undefined;

    const point = canvasPoint(event);
    const x = clamp(Math.floor(point[0]), 0, base.width - 1);
    const y = clamp(Math.floor(point[1]), 0, base.height - 1);
    const layers = [
      { canvas: base, opacity: 1 },
      { canvas: remoteCanvasRef.current, opacity: 1 },
      {
        canvas: provisionalCanvasRef.current,
        opacity: Number(provisionalCanvasRef.current?.style.opacity || 1),
      },
    ] as const;

    const basePixel = base
      .getContext("2d", { willReadFrequently: true })
      ?.getImageData(x, y, 1, 1).data;
    if (!basePixel) return undefined;
    let red = basePixel[0] ?? 255;
    let green = basePixel[1] ?? 255;
    let blue = basePixel[2] ?? 255;
    for (const layer of layers.slice(1)) {
      const context = layer.canvas?.getContext("2d", {
        willReadFrequently: true,
      });
      const pixel = context?.getImageData(x, y, 1, 1).data;
      if (!pixel) continue;
      const alpha = ((pixel[3] ?? 0) / 255) * layer.opacity;
      red = (pixel[0] ?? 0) * alpha + red * (1 - alpha);
      green = (pixel[1] ?? 0) * alpha + green * (1 - alpha);
      blue = (pixel[2] ?? 0) * alpha + blue * (1 - alpha);
    }
    const sampledColor = rgbToHex({ r: red, g: green, b: blue });

    const sampleSize = 11;
    const sourceX = clamp(
      Math.floor(point[0]) - Math.floor(sampleSize / 2),
      0,
      base.width - sampleSize,
    );
    const sourceY = clamp(
      Math.floor(point[1]) - Math.floor(sampleSize / 2),
      0,
      base.height - sampleSize,
    );
    previewContext.clearRect(0, 0, preview.width, preview.height);
    previewContext.imageSmoothingEnabled = false;
    for (const layer of layers) {
      if (!layer.canvas) continue;
      previewContext.save();
      previewContext.globalAlpha = layer.opacity;
      previewContext.drawImage(
        layer.canvas,
        sourceX,
        sourceY,
        sampleSize,
        sampleSize,
        0,
        0,
        preview.width,
        preview.height,
      );
      previewContext.restore();
    }

    const workspaceRect = workspaceRef.current?.getBoundingClientRect();
    if (workspaceRect) {
      setEyedropperCursor({
        visible: true,
        left: event.clientX - workspaceRect.left,
        top: event.clientY - workspaceRect.top,
        sampledColor,
      });
    }
    return sampledColor;
  }, [canvasPoint]);

  const updateSvFromPointer = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    applyPickerHsv({
      h: pickerHsv.h,
      s: clamp((event.clientX - rect.left) / rect.width, 0, 1) * 100,
      v: (1 - clamp((event.clientY - rect.top) / rect.height, 0, 1)) * 100,
    });
  }, [applyPickerHsv, pickerHsv.h]);

  const updateCircleHueFromPointer = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (rect.left + rect.width / 2);
    const y = event.clientY - (rect.top + rect.height / 2);
    applyPickerHsv({
      ...pickerHsv,
      h: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360,
    });
  }, [applyPickerHsv, pickerHsv]);

  const beginPickerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    target: "circle-hue" | "circle-sv" | "square-sv",
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pickerDragRef.current = { pointerId: event.pointerId, target };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (target === "circle-hue") updateCircleHueFromPointer(event);
    else updateSvFromPointer(event);
  };

  const movePickerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    target: "circle-hue" | "circle-sv" | "square-sv",
  ) => {
    const drag = pickerDragRef.current;
    if (drag?.pointerId !== event.pointerId || drag.target !== target) return;
    if (target === "circle-hue") updateCircleHueFromPointer(event);
    else updateSvFromPointer(event);
  };

  const endPickerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pickerDragRef.current?.pointerId !== event.pointerId) return;
    pickerDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const beginColorDialogDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0
      || (event.target instanceof Element && event.target.closest("button"))
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = colorDialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    colorDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveColorDialog = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = colorDragRef.current;
    const dialog = colorDialogRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !dialog) return;
    const rect = dialog.getBoundingClientRect();
    const margin = 8;
    setColorDialogPosition({
      left: clamp(
        event.clientX - drag.offsetX,
        margin,
        Math.max(margin, window.innerWidth - rect.width - margin),
      ),
      top: clamp(
        event.clientY - drag.offsetY,
        margin,
        Math.max(margin, window.innerHeight - rect.height - margin),
      ),
    });
  };

  const endColorDialogDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (colorDragRef.current?.pointerId !== event.pointerId) return;
    colorDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    if (!colorPickerOpen) return;
    const constrain = () => {
      const rect = colorDialogRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8;
      setColorDialogPosition((current) => ({
        left: clamp(
          current.left,
          margin,
          Math.max(margin, window.innerWidth - rect.width - margin),
        ),
        top: clamp(
          current.top,
          margin,
          Math.max(margin, window.innerHeight - rect.height - margin),
        ),
      }));
    };
    constrain();
    window.addEventListener("resize", constrain);
    return () => window.removeEventListener("resize", constrain);
  }, [colorPickerOpen, colorPickerView]);

  useEffect(() => {
    const element = chatMessagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chatMessages, chatOpen]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
    if (chatOpen) setUnreadChatCount(0);
  }, [chatOpen]);

  const attachBaseCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    baseCanvasRef.current = canvas;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;
    const session = canonicalSessionRef.current;
    if (!session) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    context.putImageData(new ImageData(
      new Uint8ClampedArray(session.pixels()),
      PROTOCOL_LIMITS.canvasWidth,
      PROTOCOL_LIMITS.canvasHeight,
    ), 0, 0);
  }, []);

  useEffect(() => {
    let stopped = false;
    let session: RendererSession | undefined;
    void fetch("/generated/koge-renderer-v1.wasm")
      .then((response) => {
        if (!response.ok) throw new Error(`renderer fetch failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then(instantiateRenderer)
      .then((renderer) => {
        if (stopped) return;
        session = new RendererSession(
          renderer,
          PROTOCOL_LIMITS.canvasWidth,
          PROTOCOL_LIMITS.canvasHeight,
        );
        canonicalSessionRef.current = session;
        setRendererReady(true);
      })
      .catch((error: unknown) => {
        console.error("koge canonical renderer failed to initialize", error);
        if (!stopped) setRendererError(true);
      });
    return () => {
      stopped = true;
      session?.dispose();
      canonicalSessionRef.current = undefined;
    };
  }, []);

  useEffect(() => () => {
    for (const timer of remoteCursorTimersRef.current.values()) {
      clearTimeout(timer);
    }
    remoteCursorTimersRef.current.clear();
  }, []);

  const clearProvisional = useCallback(() => {
    const canvas = provisionalCanvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) canvas.style.opacity = "1";
  }, []);

  const presentCanonical = useCallback(() => {
    const session = canonicalSessionRef.current;
    const canvas = baseCanvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!session || !canvas || !context) return;
    const pixels = session.pixels();
    context.putImageData(new ImageData(
      new Uint8ClampedArray(pixels),
      PROTOCOL_LIMITS.canvasWidth,
      PROTOCOL_LIMITS.canvasHeight,
    ), 0, 0);
  }, []);

  const applyCanonical = useCallback((strokes: readonly CanonicalStroke[]) => {
    if (strokes.length === 0) return;
    const session = canonicalSessionRef.current;
    if (!session) throw new Error("canonical renderer is not ready");
    const startedAt = performance.now();
    session.apply(strokes);
    presentCanonical();
    recordMetric("canonicalMs", performance.now() - startedAt);
  }, [presentCanonical]);

  const resetCanonicalForFullReplay = useCallback(() => {
    const session = canonicalSessionRef.current;
    if (!session) return;
    const white = new Uint8Array(
      PROTOCOL_LIMITS.canvasWidth * PROTOCOL_LIMITS.canvasHeight * 4,
    );
    white.fill(255);
    session.loadPixels(white);
    replayedStrokesRef.current.clear();
    remoteCanvasRef.current?.getContext("2d")?.clearRect(
      0,
      0,
      PROTOCOL_LIMITS.canvasWidth,
      PROTOCOL_LIMITS.canvasHeight,
    );
    lastRoomSeqRef.current = 0;
    setEventCount(0);
    presentCanonical();
  }, [presentCanonical]);

  const applyVerifiedSnapshot = useCallback((snapshot: VerifiedSnapshot) => {
    const session = canonicalSessionRef.current;
    if (!session) throw new Error("canonical renderer is not ready");
    const applyStartedAt = performance.now();
    session.loadPixels(snapshot.rgba);
    replayedStrokesRef.current.clear();
    remoteCanvasRef.current?.getContext("2d")?.clearRect(
      0,
      0,
      PROTOCOL_LIMITS.canvasWidth,
      PROTOCOL_LIMITS.canvasHeight,
    );
    lastRoomSeqRef.current = snapshot.baseRoomSeq;
    setEventCount(snapshot.baseRoomSeq);
    presentCanonical();
    window.kogeSnapshotRecovery = {
      status: "applied",
      baseRoomSeq: snapshot.baseRoomSeq,
    };
    setRecoverySource("snapshot");
    const applyCompletedAt = performance.now();
    const metrics = recoveryMetricsRef.current;
    if (metrics) {
      metrics.source = "snapshot";
      metrics.snapshotFetchMs = snapshot.timings.fetchMs;
      metrics.snapshotBodyReadMs = snapshot.timings.bodyReadMs;
      metrics.snapshotObjectHashMs = snapshot.timings.objectHashMs;
      metrics.snapshotDecodeMs = snapshot.timings.decodeMs;
      metrics.snapshotRgbaHashMs = snapshot.timings.rgbaHashMs;
      metrics.snapshotVerificationMs = snapshot.timings.totalMs;
      metrics.snapshotApplyMs = applyCompletedAt - applyStartedAt;
      metrics.snapshotAppliedMs = applyCompletedAt - metrics.startedAt;
      metrics.snapshotObjectBytes = snapshot.timings.objectBytes;
      metrics.snapshotRgbaBytes = snapshot.timings.rgbaBytes;
      metrics.snapshotBaseRoomSeq = snapshot.baseRoomSeq;
      window.kogeBrowserRecoveryMetrics = metrics;
      performance.mark("koge-recovery-snapshot-applied");
    }
  }, [presentCanonical]);

  const redrawRemoteProvisional = useCallback(() => {
    const canvas = remoteCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const [strokeId, stroke] of replayedStrokesRef.current) {
      if (ownStrokeIdsRef.current.has(strokeId)) continue;
      context.save();
      context.globalAlpha = stroke.style.tool === "eraser" ? 1 : stroke.style.opacity;
      drawStroke(context, stroke.points, stroke.style);
      context.restore();
    }
  }, []);

  const applyAcceptedEvents = useCallback((
    acceptedEvents: readonly AcceptedStrokeEvent[],
  ) => {
    const completed: CanonicalStroke[] = [];
    let newestRoomSeq = lastRoomSeqRef.current;
    for (const accepted of acceptedEvents) {
      if (accepted.roomSeq <= lastRoomSeqRef.current) continue;
      lastRoomSeqRef.current = accepted.roomSeq;
      newestRoomSeq = accepted.roomSeq;
      const event: RoomStrokeEvent = accepted.event;
      if (event.op === "stroke.begin") {
        replayedStrokesRef.current.set(event.id, {
          style: {
            tool: event.tool,
            color: event.color,
            size: event.size,
            opacity: event.opacity,
          },
          points: [event.point],
        });
      } else if (event.op === "stroke.append") {
        replayedStrokesRef.current.get(event.id)?.points.push(...event.points);
      } else {
        const stroke = replayedStrokesRef.current.get(event.id);
        if (event.op === "stroke.end" && stroke) {
          completed.push(canonicalStroke(stroke));
        }
        replayedStrokesRef.current.delete(event.id);
        if (ownStrokeIdsRef.current.has(event.id)) {
          clearProvisional();
          ownStrokeIdsRef.current.delete(event.id);
        }
      }

      if (
        ownConnectionIdsRef.current.has(accepted.connectionId)
        && "clientSeq" in event
        && event.clientSeq <= outboxRef.current.lastIssuedClientSeq
      ) {
        outboxRef.current.acknowledge(event.clientSeq);
      }
    }
    applyCanonical(completed);
    redrawRemoteProvisional();
    setEventCount(newestRoomSeq);
  }, [applyCanonical, clearProvisional, redrawRemoteProvisional]);

  const sendEvents = useCallback((events: readonly ClientStrokeEvent[]) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const event of events) {
      socket.send(encodeEvent(event, "messagepack"));
      outboxRef.current.markSent(event.clientSeq);
    }
  }, []);

  useEffect(() => {
    if (roomSlug) {
      setSyncEnabled(true);
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const fragmentInvite = fragment.get("invite");
      if (fragmentInvite && /^[a-f0-9]{64}$/.test(fragmentInvite)) {
        inviteTokenRef.current = fragmentInvite;
        sessionStorage.setItem(`koge-room-invite:${roomSlug}`, fragmentInvite);
      } else {
        const storedInvite = sessionStorage.getItem(
          `koge-room-invite:${roomSlug}`,
        );
        inviteTokenRef.current = storedInvite
          && /^[a-f0-9]{64}$/.test(storedInvite)
          ? storedInvite
          : undefined;
      }
      if (fragment.has("invite")) {
        history.replaceState(
          history.state,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
      }
      const storedRole = sessionStorage.getItem(`koge-room-role:${roomSlug}`);
      if (
        storedRole === "viewer"
        || (isAuthenticated && storedRole === "participant")
      ) {
        setRequestedRole(storedRole);
      } else {
        if (storedRole === "participant") {
          sessionStorage.removeItem(`koge-room-role:${roomSlug}`);
        }
        setConnectionStatus("choosing");
      }
      return;
    }
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.get("sync") !== "1") return;
    setSyncEnabled(true);
  }, [isAuthenticated, roomSlug]);

  useEffect(() => {
    if (
      !syncEnabled
      || !rendererReady
      || (roomSlug && requestedRole === undefined)
    ) return;
    let stopped = false;
    let terminal = false;
    setAssignedRole(undefined);
    setRoomLifecycleStatus(undefined);
    showRealtimeNotice(undefined);
    const parameters = new URLSearchParams(window.location.search);
    const roomId = roomSlug
      ?? parameters.get("room")
      ?? "room-phase2-demo";
    const actorKey = "koge-phase2-actor";
    const actor = sessionStorage.getItem(actorKey)
      ?? `actor_${crypto.randomUUID().replaceAll("-", "")}`;
    sessionStorage.setItem(actorKey, actor);
    currentActorRef.current = actor;
    const defaultRealtimeOrigin = window.location.hostname === "preview.koge.app"
      ? "wss://realtime-preview.koge.app"
      : window.location.hostname === "koge.app"
        || window.location.hostname === "www.koge.app"
        ? "wss://realtime.koge.app"
        : "ws://localhost:8787";
    const realtimeOrigin = process.env.NEXT_PUBLIC_REALTIME_WS_ORIGIN
      ?? defaultRealtimeOrigin;

    const connect = async () => {
      if (stopped) return;
      setConnectionStatus("connecting");
      let connectionId = `connection_${crypto.randomUUID().replaceAll("-", "")}`;
      let ticket: string | undefined;
      let connectionRole: RoomRole = "participant";
      let selectedRealtimeOrigin = realtimeOrigin;
      if (roomSlug) {
        try {
          const response = await fetch(
            `/api/rooms/${encodeURIComponent(roomSlug)}/tickets`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                role: requestedRole ?? "viewer",
                ...(inviteTokenRef.current
                  ? { inviteToken: inviteTokenRef.current }
                  : {}),
              }),
            },
          );
          if (!response.ok) {
            const errorBody = await response.json().catch(() => null) as {
              error?: string;
            } | null;
            if (response.status === 403) {
              terminal = true;
              setConnectionStatus("disconnected");
              showRealtimeNotice(
                errorBody?.error === "SERVICE_BANNED"
                  ? "現在、このサービスのルームには入室できません。"
                  : "このルームには入室できません。招待リンクまたは参加権限を確認してください。",
                "error",
              );
              return;
            }
            if (response.status === 404) {
              setConnectionStatus("disconnected");
              showRealtimeNotice(
                "このルームは終了したか、見つかりません。",
                "error",
              );
              return;
            }
            if (
              response.status === 503
              && errorBody?.error === "ROOM_ENTRY_PAUSED"
            ) {
              setConnectionStatus("disconnected");
              showRealtimeNotice(
                "現在、緊急対応のため新しい入室を一時停止しています。自動的に再試行します。",
                "warning",
              );
            }
            throw new Error(`room ticket request failed: ${response.status}`);
          }
          const access = parseRoomTicketResponse(await response.json());
          connectionId = access.connectionId;
          currentActorRef.current = access.actorId;
          ticket = access.ticket;
          connectionRole = access.role;
          setAssignedRole(access.role);
          setCanChat(access.canChat);
          if (access.role === "viewer") setTool("zoom");
          selectedRealtimeOrigin = access.realtimeOrigin.replace(/^http/, "ws");
        } catch (error) {
          console.error("koge room ticket request failed", error);
          if (!stopped) {
            setConnectionStatus("disconnected");
            reconnectTimerRef.current = setTimeout(() => {
              void connect();
            }, 1_000);
          }
          return;
        }
      } else {
        setCanChat(true);
      }
      ownConnectionIdsRef.current.add(connectionId);
      const url = new URL(
        `/rooms/${encodeURIComponent(roomId)}/connect`,
        selectedRealtimeOrigin,
      );
      if (ticket) {
        url.searchParams.set("ticket", ticket);
      } else {
        url.searchParams.set("actor", actor);
        url.searchParams.set("connection", connectionId);
      }
      url.searchParams.set("lastRoomSeq", String(lastRoomSeqRef.current));
      url.searchParams.set("rendererVersion", String(SNAPSHOT_RENDERER_VERSION));
      url.searchParams.set(
        "canvasGeneration",
        String(SNAPSHOT_CANVAS_GENERATION),
      );
      url.searchParams.set(
        "snapshot",
        snapshotRecoveryDisabledRef.current ? "0" : "1",
      );
      if (failedSnapshotJobIdsRef.current.length > 0) {
        url.searchParams.set(
          "snapshotExcludeJobs",
          failedSnapshotJobIdsRef.current.join(","),
        );
      }
      const recoveryStartedAt = performance.now();
      const socket = new WebSocket(url);
      const recoveryMetrics: BrowserRecoveryMetrics = {
        schema: "koge.browser-recovery.v1",
        source: "event-log",
        startedAt: recoveryStartedAt,
        tailFrameCount: 0,
        tailEventCount: 0,
        tailEncodedBytes: 0,
        tailDecodeMs: 0,
        tailApplyMs: 0,
        status: "connecting",
      };
      recoveryMetricsRef.current = recoveryMetrics;
      window.kogeBrowserRecoveryMetrics = recoveryMetrics;
      for (const mark of [
        "koge-recovery-start",
        "koge-recovery-socket-open",
        "koge-recovery-snapshot-offer",
        "koge-recovery-snapshot-applied",
        "koge-recovery-first-tail",
        "koge-recovery-ready",
        "koge-recovery-painted",
      ]) {
        performance.clearMarks(mark);
      }
      performance.clearMeasures("koge-recovery-total");
      performance.mark("koge-recovery-start");
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      let ignoreMessages = false;
      let processing = Promise.resolve();
      socket.addEventListener("open", () => {
        recoveryMetrics.socketOpenMs = performance.now() - recoveryStartedAt;
        window.kogeBrowserRecoveryMetrics = recoveryMetrics;
        performance.mark("koge-recovery-socket-open");
      });
      socket.addEventListener("message", (message) => {
        if (!(message.data instanceof ArrayBuffer)) return;
        const frame = message.data;
        processing = processing.then(async () => {
          if (ignoreMessages) return;
          const decodeStartedAt = performance.now();
          const serverMessage = decodeServerMessage(new Uint8Array(frame));
          const decodeMs = performance.now() - decodeStartedAt;
          if (serverMessage.type === "presence") {
            setPresenceMembers(serverMessage.members);
            const activeActors = new Set(
              serverMessage.members.map((member) => member.actor),
            );
            setRemoteCursors((current) => new Map(
              Array.from(current).filter(([actorId]) => (
                activeActors.has(actorId)
              )),
            ));
          } else if (serverMessage.type === "cursor") {
            if (serverMessage.actor === currentActorRef.current) return;
            const existingTimer = remoteCursorTimersRef.current.get(
              serverMessage.actor,
            );
            if (existingTimer) clearTimeout(existingTimer);
            if (!serverMessage.visible) {
              remoteCursorTimersRef.current.delete(serverMessage.actor);
              setRemoteCursors((current) => {
                const next = new Map(current);
                next.delete(serverMessage.actor);
                return next;
              });
              return;
            }
            setRemoteCursors((current) => new Map(current).set(
              serverMessage.actor,
              { x: serverMessage.x, y: serverMessage.y },
            ));
            remoteCursorTimersRef.current.set(
              serverMessage.actor,
              setTimeout(() => {
                remoteCursorTimersRef.current.delete(serverMessage.actor);
                setRemoteCursors((current) => {
                  const next = new Map(current);
                  next.delete(serverMessage.actor);
                  return next;
                });
              }, 2_000),
            );
          } else if (serverMessage.type === "chat.history") {
            chatMessageIdsRef.current = new Set(
              serverMessage.messages.map(({ id }) => id),
            );
            setChatMessages(serverMessage.messages);
          } else if (serverMessage.type === "chat.message") {
            if (!chatMessageIdsRef.current.has(serverMessage.message.id)) {
              chatMessageIdsRef.current.add(serverMessage.message.id);
              setChatMessages((current) => [
                ...current,
                serverMessage.message,
              ].slice(-PROTOCOL_LIMITS.maxChatMessages));
              if (
                !chatOpenRef.current
                && serverMessage.message.actor !== currentActorRef.current
              ) {
                setUnreadChatCount((current) => current + 1);
              }
            }
          } else if (serverMessage.type === "snapshot") {
            setConnectionStatus("recovering");
            recoveryMetrics.source = "snapshot";
            recoveryMetrics.status = "recovering";
            recoveryMetrics.snapshotOfferMs =
              performance.now() - recoveryStartedAt;
            window.kogeBrowserRecoveryMetrics = recoveryMetrics;
            performance.mark("koge-recovery-snapshot-offer");
            const recoveryResult = await recoverSnapshotOrFallback({
              offer: serverMessage,
              realtimeOrigin: selectedRealtimeOrigin,
              applySnapshot: applyVerifiedSnapshot,
              fallbackToEventLog(error) {
                const reason = error instanceof Error
                  ? error.message
                  : String(error);
                console.error("koge snapshot recovery failed", error);
                const fallbackState = nextSnapshotFallbackState(
                  failedSnapshotJobIdsRef.current,
                  serverMessage.manifest.jobId,
                );
                failedSnapshotJobIdsRef.current =
                  fallbackState.failedJobIds;
                snapshotRecoveryDisabledRef.current =
                  fallbackState.snapshotRecoveryDisabled;
                resetCanonicalForFullReplay();
                window.kogeSnapshotRecovery = {
                  status: "fallback",
                  reason,
                };
                recoveryMetrics.source = "event-log";
                recoveryMetrics.status = "fallback";
                recoveryMetrics.fallbackReason = reason;
                window.kogeBrowserRecoveryMetrics = recoveryMetrics;
                setRecoverySource("event-log");
              },
            });
            if (recoveryResult === "event-log") {
              ignoreMessages = true;
              socket.close(1011, "snapshot recovery failed");
            }
          } else if (serverMessage.type === "accepted") {
            applyAcceptedEvents([serverMessage]);
          } else if (serverMessage.type === "replay") {
            if (recoveryMetrics.tailFrameCount === 0) {
              recoveryMetrics.firstTailFrameMs =
                performance.now() - recoveryStartedAt;
              performance.mark("koge-recovery-first-tail");
            }
            const applyStartedAt = performance.now();
            applyAcceptedEvents(serverMessage.events);
            recoveryMetrics.tailFrameCount += 1;
            recoveryMetrics.tailEventCount += serverMessage.events.length;
            recoveryMetrics.tailEncodedBytes += frame.byteLength;
            recoveryMetrics.tailDecodeMs += decodeMs;
            recoveryMetrics.tailApplyMs +=
              performance.now() - applyStartedAt;
            window.kogeBrowserRecoveryMetrics = recoveryMetrics;
          } else if (serverMessage.type === "ready") {
            lastRoomSeqRef.current = Math.max(
              lastRoomSeqRef.current,
              serverMessage.roomSeq,
            );
            setConnectionStatus("connected");
            recoveryMetrics.readyMs = performance.now() - recoveryStartedAt;
            recoveryMetrics.readyRoomSeq = serverMessage.roomSeq;
            recoveryMetrics.status = "ready";
            window.kogeBrowserRecoveryMetrics = recoveryMetrics;
            performance.mark("koge-recovery-ready");
            performance.measure(
              "koge-recovery-total",
              "koge-recovery-start",
              "koge-recovery-ready",
            );
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                recoveryMetrics.readyPaintMs =
                  performance.now() - recoveryStartedAt;
                recoveryMetrics.status = "painted";
                window.kogeBrowserRecoveryMetrics = recoveryMetrics;
                performance.mark("koge-recovery-painted");
              });
            });
            if (connectionRole !== "viewer") {
              sendEvents(outboxRef.current.eventsToRetry());
            }
          } else if (serverMessage.type === "room.activity") {
            setRoomActivity(serverMessage);
            showRealtimeNotice(
              serverMessage.acceptingNewStrokes
                ? `このルームで描ける量は残り約${100 - serverMessage.level}%です。`
                : "描画量の上限に達しました。今の線を描き終えるとルームが終了します。",
              "warning",
            );
          } else if (serverMessage.type === "room.time") {
            setRoomTime(serverMessage);
            showRealtimeNotice(
              `ルーム終了まで約${serverMessage.warningMinutes}分です。`,
              "warning",
            );
          } else if (serverMessage.type === "reject") {
            if (
              (
                serverMessage.code === "SERVICE_EMERGENCY_STOP"
                || serverMessage.code === "RATE_LIMITED"
              )
              && serverMessage.clientSeq !== undefined
              && serverMessage.clientSeq
                <= outboxRef.current.lastIssuedClientSeq
            ) {
              outboxRef.current.acknowledge(serverMessage.clientSeq);
              clearProvisional();
            }
            const notice = serverMessage.code === "ROLE_FORBIDDEN"
              ? "見る人はキャンバスを動かしたり拡大して楽しめます。描画はできません。"
              : serverMessage.code === "RATE_LIMITED"
                ? "操作が速すぎるため、少し待ってから続けてください。"
                : serverMessage.code === "ROOM_LIMIT_REACHED"
                  ? "描画量の上限に達したため、新しい線は始められません。"
                : serverMessage.code === "ROOM_NOT_ACTIVE"
                  ? "このルームでは現在描画できません。"
                  : serverMessage.code === "SERVICE_EMERGENCY_STOP"
                    ? "現在、緊急対応のため描画を一時停止しています。"
                  : "操作を受け付けられませんでした。";
            showRealtimeNotice(notice, "warning");
          } else if (serverMessage.type === "room.removed") {
            terminal = true;
            showRealtimeNotice(
              serverMessage.reason === "service_banned"
                ? "管理者によりサービスから退出となりました。現在は再入室できません。"
                : serverMessage.reason === "room_banned"
                ? "このルームから退出となり、ルーム終了まで再入室できません。"
                : "このルームから退出となりました。必要であれば再入室できます。",
              "error",
            );
          } else if (serverMessage.type === "room.closed") {
            terminal = true;
            setRoomLifecycleStatus("closing");
            showRealtimeNotice(
              "ルームは終了しました。このルームには再入室できません。",
              "warning",
            );
          } else if (serverMessage.status === "closing") {
            setRoomLifecycleStatus("closing");
            showRealtimeNotice(
              "ルームが終了処理に入りました。新しい描画はできません。",
              "warning",
            );
          } else if (serverMessage.status === "suspended") {
            terminal = true;
            setRoomLifecycleStatus("suspended");
            showRealtimeNotice(
              "このルームは管理者により停止されました。描画やチャットはできません。",
              "error",
            );
          } else {
            setRoomLifecycleStatus(serverMessage.status);
            showRealtimeNotice(
              serverMessage.status === "waiting"
                ? "ルームを開始する準備をしています。"
                : serverMessage.status === "idle"
                  ? "しばらく活動がなかったため休止中です。描画やチャットですぐ再開できます。"
                  : undefined,
            );
          }
        }).catch((error: unknown) => {
          ignoreMessages = true;
          console.error("koge realtime frame processing failed", error);
          socket.close(1011, "realtime frame processing failed");
        });
      });
      socket.addEventListener("close", () => {
        if (stopped) return;
        setPresenceMembers([]);
        setRemoteCursors(new Map());
        setConnectionStatus("disconnected");
        setCanChat(false);
        if (terminal) return;
        reconnectTimerRef.current = setTimeout(() => {
          void connect();
        }, 1_000);
      });
      socket.addEventListener("error", () => socket.close());
    };

    void connect();
    return () => {
      stopped = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close(1000, "component unmounted");
      socketRef.current = undefined;
    };
  }, [
    applyAcceptedEvents,
    applyVerifiedSnapshot,
    rendererReady,
    requestedRole,
    roomSlug,
    resetCanonicalForFullReplay,
    sendEvents,
    syncEnabled,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.code === "Space"
        && !isShortcutTypingTarget(event.target)
      ) {
        event.preventDefault();
        setSpacePressed(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePressed(false);
    };
    const onBlur = () => setSpacePressed(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!headerMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !headerMenuRef.current?.contains(event.target)
      ) {
        setHeaderMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHeaderMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [headerMenuOpen]);

  const showZoomHud = useCallback(() => {
    setZooming(true);
    if (zoomHudTimerRef.current) clearTimeout(zoomHudTimerRef.current);
    zoomHudTimerRef.current = setTimeout(() => setZooming(false), 700);
  }, []);

  useEffect(() => () => {
    if (zoomHudTimerRef.current) clearTimeout(zoomHudTimerRef.current);
  }, []);

  const sendCursor = useCallback((
    message:
      | { visible: true; x: number; y: number }
      | { visible: false },
  ) => {
    const socket = socketRef.current;
    if (!roomSlug || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeClientCursorMessage({
      v: PROTOCOL_VERSION,
      type: "cursor",
      ...message,
    }));
  }, [roomSlug]);

  const sendCursorPosition = useCallback((
    event: ReactPointerEvent<HTMLCanvasElement>,
  ) => {
    const now = performance.now();
    if (now - lastCursorSentAtRef.current < 50) return;
    lastCursorSentAtRef.current = now;
    const point = canvasPoint(event);
    sendCursor({ visible: true, x: point[0], y: point[1] });
  }, [canvasPoint, sendCursor]);

  const sendChat = () => {
    const text = chatText.trim();
    const socket = socketRef.current;
    if (
      !canSendChat
      || !text
      || [...text].length > PROTOCOL_LIMITS.maxChatMessageCharacters
      || !socket
      || socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    socket.send(encodeClientChatMessage({
      v: PROTOCOL_VERSION,
      type: "chat.send",
      id: `chat_${crypto.randomUUID().replaceAll("-", "")}`,
      text,
    }));
    setChatText("");
  };

  const redrawProvisional = useCallback(() => {
    const canvas = provisionalCanvasRef.current;
    const drawing = drawingRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !drawing) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawStroke(context, drawing.points, drawing.style);
    canvas.style.opacity = String(
      drawing.style.tool === "eraser" ? 1 : drawing.style.opacity,
    );
  }, []);

  const beginDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (spacePressed || event.button !== 0) return;
    if (tool === "zoom") {
      dragRef.current = { mode: "zoom", pointerId: event.pointerId, x: event.clientX, zoom };
      event.currentTarget.setPointerCapture(event.pointerId);
      setZooming(true);
      return;
    }
    const point = canvasPoint(event);
    if (tool === "eyedropper") {
      const sampledColor = updateEyedropperPreview(event);
      if (sampledColor) applyHexColor(sampledColor);
      selectTool(lastDrawingToolRef.current);
      return;
    }
    if (!rendererReady || !canDraw) return;

    const style: StrokeStyle = { tool, color, size, opacity };
    const now = performance.now();
    const begin = outboxRef.current.begin(style, point[0], point[1], now);
    ownStrokeIdsRef.current.add(begin.id);
    sendEvents([begin]);
    drawingRef.current = {
      id: begin.id,
      style,
      points: [[point[0], point[1], 0]],
      pointerId: event.pointerId,
      startedAt: now,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    const provisionalStartedAt = performance.now();
    redrawProvisional();
    recordMetric("provisionalMs", performance.now() - provisionalStartedAt);
    setEventCount(outboxRef.current.lastIssuedClientSeq);
  };

  const moveDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    sendCursorPosition(event);
    if (tool === "eyedropper" && !spacePressed) {
      updateEyedropperPreview(event);
    }
    const drag = dragRef.current;
    if (drag?.mode === "zoom" && drag.pointerId === event.pointerId) {
      setZoom(clampZoom(drag.zoom * 2 ** ((event.clientX - drag.x) / 160)));
      showZoomHud();
      return;
    }
    const drawing = drawingRef.current;
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    const point = canvasPoint(event);
    const now = performance.now();
    const normalized: Point = [
      point[0],
      point[1],
      Math.round(now - drawing.startedAt),
    ];
    drawing.points.push(normalized);
    const append = outboxRef.current.append(point[0], point[1], now);
    if (append) sendEvents([append]);
    const provisionalStartedAt = performance.now();
    redrawProvisional();
    recordMetric("provisionalMs", performance.now() - provisionalStartedAt);
    setEventCount(outboxRef.current.lastIssuedClientSeq);
  };

  const finishDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      setZooming(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const drawing = drawingRef.current;
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    if (!syncEnabled) {
      applyCanonical([canonicalStroke(drawing)]);
      clearProvisional();
      ownStrokeIdsRef.current.delete(drawing.id);
    }
    const endEvents = outboxRef.current.end(performance.now());
    sendEvents(endEvents);
    drawingRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setEventCount(outboxRef.current.lastIssuedClientSeq);
  };

  const cancelDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      setZooming(false);
      return;
    }
    if (!drawingRef.current || drawingRef.current.pointerId !== event.pointerId) return;
    const cancel = outboxRef.current.cancel();
    sendEvents([cancel]);
    if (!syncEnabled) ownStrokeIdsRef.current.delete(drawingRef.current.id);
    drawingRef.current = undefined;
    const provisional = provisionalCanvasRef.current;
    provisional?.getContext("2d")?.clearRect(
      0,
      0,
      provisional.width,
      provisional.height,
    );
    setEventCount(outboxRef.current.lastIssuedClientSeq);
  };

  const beginWorkspaceDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!spacePressed || event.button !== 0) return;
    dragRef.current = {
      mode: "pan",
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveWorkspaceDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.mode !== "pan" || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setPan((current) => ({ x: current.x + deltaX, y: current.y + deltaY }));
  };

  const endWorkspaceDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.mode !== "pan" || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoom((current) => clampZoom(current * 2 ** (-event.deltaY / 480)));
    showZoomHud();
  };

  const chooseRole = (role: RequestedRoomRole) => {
    if (roomSlug) {
      sessionStorage.setItem(`koge-room-role:${roomSlug}`, role);
    }
    setAssignedRole(undefined);
    showRealtimeNotice(undefined);
    setRequestedRole(role);
  };

  const reopenRolePicker = () => {
    if (!roomSlug) return;
    sessionStorage.removeItem(`koge-room-role:${roomSlug}`);
    setRequestedRole(undefined);
    setAssignedRole(undefined);
    setConnectionStatus("choosing");
  };

  const copyInviteLink = async () => {
    if (!roomSlug) return;
    const inviteUrl = new URL(
      `/rooms/${encodeURIComponent(roomSlug)}`,
      window.location.origin,
    );
    if (inviteTokenRef.current) {
      inviteUrl.hash = `invite=${inviteTokenRef.current}`;
    }
    try {
      await navigator.clipboard.writeText(inviteUrl.toString());
      showRealtimeNotice("招待リンクをコピーしました。", "success");
    } catch (error) {
      console.error("koge invite link copy failed", error);
      showRealtimeNotice("招待リンクをコピーできませんでした。", "error");
    }
  };

  const downloadCanvasImage = async () => {
    const source = baseCanvasRef.current;
    const hasPendingStroke = Boolean(
      drawingRef.current
      || outboxRef.current.activeStrokeId
      || outboxRef.current.eventsToRetry().length > 0
    );
    if (!rendererReady || rendererError || !source) {
      showRealtimeNotice(
        "描画の準備が完了してからもう一度お試しください。",
        "warning",
      );
      return;
    }
    if (roomSlug && connectionStatus !== "connected") {
      showRealtimeNotice(
        "ルームへ再接続してから画像をダウンロードしてください。",
        "warning",
      );
      return;
    }
    if (hasPendingStroke) {
      showRealtimeNotice(
        "描画の同期が完了してからもう一度お試しください。",
        "warning",
      );
      return;
    }
    if (downloadPending) return;
    setDownloadPending(true);
    try {
      const blob = await canvasPngBlob(source);
      downloadBlob(blob, canvasDownloadFilename(roomName));
      showRealtimeNotice("画像をダウンロードしました。", "success");
    } catch (error) {
      console.error("koge canvas download failed", error);
      showRealtimeNotice(
        "画像を作成できませんでした。時間をおいてもう一度お試しください。",
        "error",
      );
    } finally {
      setDownloadPending(false);
    }
  };

  const startRoom = useCallback((): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(encodeClientRoomStartMessage({
      v: PROTOCOL_VERSION,
      type: "room.start",
      requestId: `start_${crypto.randomUUID().replaceAll("-", "")}`,
    }));
    return true;
  }, []);

  useEffect(() => {
    if (
      roomLifecycleStatus !== "waiting"
      || connectionStatus !== "connected"
    ) {
      autoStartRequestedRef.current = false;
    }
    if (
      autoStartRequestedRef.current
      || !shouldAutoStartRoom({
        roomSlug,
        assignedRole,
        lifecycleStatus: roomLifecycleStatus,
        connectionStatus,
        rendererReady,
        rendererFailed: Boolean(rendererError),
      })
    ) return;
    if (startRoom()) autoStartRequestedRef.current = true;
  }, [
    assignedRole,
    connectionStatus,
    rendererError,
    rendererReady,
    roomLifecycleStatus,
    roomSlug,
    startRoom,
  ]);

  const closeRoom = () => {
    const socket = socketRef.current;
    if (
      !socket
      || socket.readyState !== WebSocket.OPEN
      || !window.confirm(
        "このルームを終了しますか？終了後は再入室や再開ができません。",
      )
    ) {
      return;
    }
    socket.send(encodeClientRoomCloseMessage({
      v: PROTOCOL_VERSION,
      type: "room.close",
      requestId: `close_${crypto.randomUUID().replaceAll("-", "")}`,
    }));
  };

  const submitReport = async () => {
    if (!roomSlug || reportSubmitting) return;
    const requestId = reportRequestIdRef.current ?? crypto.randomUUID();
    reportRequestIdRef.current = requestId;
    setReportSubmitting(true);
    try {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(roomSlug)}/reports`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": requestId,
          },
          body: JSON.stringify({
            category: reportCategory,
            ...(reportDescription.trim()
              ? { description: reportDescription.trim() }
              : {}),
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`room report failed: ${response.status}`);
      }
      setReportOpen(false);
      showRealtimeNotice(
        "通報を受け付けました。確認用データを安全に保存しています。",
        "success",
      );
    } catch (error) {
      console.error("koge room report failed", error);
      showRealtimeNotice(
        "通報を送信できませんでした。時間をおいてもう一度お試しください。",
        "error",
      );
    } finally {
      setReportSubmitting(false);
    }
  };

  const pickerRgb = hsvToRgb(pickerHsv);
  const hueRadians = pickerHsv.h * Math.PI / 180;
  const assignedRoleLabel = assignedRole === "host"
    ? "ホスト"
    : assignedRole === "participant"
      ? "描く人"
      : assignedRole === "viewer"
        ? "見る人"
        : undefined;
  let connectionNotice: string | undefined;
  if (rendererError) {
    connectionNotice = "描画を準備できません";
  } else if (!rendererReady) {
    connectionNotice = "描画を準備中";
  } else if (roomLifecycleStatus === "suspended") {
    connectionNotice = "管理対応中";
  } else if (roomLifecycleStatus === "closing") {
    connectionNotice = "終了処理中";
  } else if (connectionStatus === "recovering") {
    connectionNotice = "描画を復元中";
  } else if (connectionStatus === "connecting") {
    connectionNotice = "接続中";
  } else if (connectionStatus === "disconnected") {
    connectionNotice = "再接続中";
  } else if (roomLifecycleStatus === "waiting") {
    connectionNotice = "開始準備中";
  }
  const connectionNoticeLevel = rendererError ? "error" : "progress";
  const hasPendingLocalStroke = Boolean(
    drawingRef.current
    || outboxRef.current.activeStrokeId
    || outboxRef.current.eventsToRetry().length > 0
  );
  const canDownloadCanvas = rendererReady
    && !rendererError
    && !downloadPending
    && !hasPendingLocalStroke
    && (!roomSlug || connectionStatus === "connected");
  const primaryShortcut = primaryModifierLabel(isApplePlatform);
  const alternateShortcut = alternateModifierLabel(isApplePlatform);
  const shortcutGroups = [
    {
      title: "ツール",
      items: [
        { keys: ["B"], label: "ブラシ" },
        { keys: ["E"], label: "消しゴム" },
        { keys: ["I"], label: "スポイト" },
        {
          keys: [alternateShortcut],
          label: "押している間だけスポイト",
        },
        { keys: ["Z"], label: "スクラブズーム" },
        { keys: ["Space"], label: "押している間だけ手のひら" },
      ],
    },
    {
      title: "ブラシ",
      items: [
        { keys: ["["], label: "サイズを1px小さくする" },
        { keys: ["]"], label: "サイズを1px大きくする" },
        { keys: ["0–9"], label: "濃度（0は100%）" },
      ],
    },
    {
      title: "表示・パネル",
      items: [
        { keys: [`${primaryShortcut} + +`], label: "拡大" },
        { keys: [`${primaryShortcut} + −`], label: "縮小" },
        { keys: [`${primaryShortcut} + 0`], label: "キャンバス全体を表示" },
        { keys: [`${primaryShortcut} + 1`], label: "100%表示" },
        { keys: ["F6"], label: "カラーを開く・閉じる" },
        { keys: ["T"], label: "チャットを開いて入力" },
        { keys: ["Esc"], label: "開いているパネルを閉じる" },
      ],
    },
    {
      title: "その他",
      items: [
        { keys: [`${primaryShortcut} + S`], label: "画像をダウンロード" },
        { keys: ["?"], label: "ショートカット一覧" },
      ],
    },
  ] as const;

  useEffect(() => {
    const handleShortcut = (
      event: KeyboardEvent,
      eventType: "keydown" | "keyup",
    ) => {
      const action = resolveDrawingShortcut({
        altKey: event.altKey,
        code: event.code,
        ctrlKey: event.ctrlKey,
        eventType,
        key: event.key,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      }, isApplePlatform);
      if (!action) return;

      if (action.type === "temporary-eyedropper") {
        if (isShortcutTypingTarget(event.target)) return;
        event.preventDefault();
        if (action.active) {
          if (event.repeat || temporaryToolRef.current !== undefined) return;
          temporaryToolRef.current = tool;
          selectTool("eyedropper");
        } else {
          const previousTool = temporaryToolRef.current;
          temporaryToolRef.current = undefined;
          if (previousTool) selectTool(previousTool);
        }
        return;
      }
      if (eventType !== "keydown") return;

      if (action.type === "escape") {
        if (shortcutHelpOpen) {
          event.preventDefault();
          setShortcutHelpOpen(false);
        } else if (reportOpen) {
          event.preventDefault();
          setReportOpen(false);
        } else if (colorPickerOpen) {
          event.preventDefault();
          setColorPickerOpen(false);
        } else if (headerMenuOpen) {
          event.preventDefault();
          setHeaderMenuOpen(false);
        } else if (chatOpen && roomSlug) {
          event.preventDefault();
          setChatOpen(false);
        }
        return;
      }

      if (
        isShortcutTypingTarget(event.target)
        && action.type !== "download"
        && action.type !== "zoom"
      ) return;
      if (
        reportOpen
        || shortcutHelpOpen
        || (roomSlug && requestedRole === undefined)
      ) {
        if (action.type === "help") {
          event.preventDefault();
          setShortcutHelpOpen((open) => !open);
        }
        return;
      }

      if (action.type === "tool") {
        if (
          (action.tool === "brush" || action.tool === "eraser")
          && !canDraw
        ) return;
        event.preventDefault();
        selectTool(action.tool);
        return;
      }
      if (action.type === "brush-size") {
        if (!canDraw) return;
        event.preventDefault();
        const updateSize = (current: number) => clamp(
          current + action.direction,
          PROTOCOL_LIMITS.minBrushSize,
          PROTOCOL_LIMITS.maxBrushSize,
        );
        if (sizeTool === "eraser") {
          setEraserSize(updateSize);
        } else {
          setBrushSize(updateSize);
        }
        return;
      }
      if (action.type === "opacity") {
        if (!canDraw) return;
        event.preventDefault();
        setOpacity(action.value);
        return;
      }
      if (action.type === "zoom") {
        event.preventDefault();
        if (action.mode === "fit") {
          const workspace = workspaceRef.current?.getBoundingClientRect();
          if (!workspace) return;
          const chatWidth = roomSlug && chatOpen
            ? Math.min(286, Math.max(0, workspace.width - 58))
            : 0;
          const availableWidth = Math.max(
            240,
            workspace.width - chatWidth - 96,
          );
          const availableHeight = Math.max(160, workspace.height - 48);
          setZoom(clampZoom(Math.min(
            availableWidth / PROTOCOL_LIMITS.canvasWidth,
            availableHeight / PROTOCOL_LIMITS.canvasHeight,
          )));
          setPan({ x: 0, y: 0 });
        } else if (action.mode === "actual") {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        } else {
          setZoom((current) => clampZoom(
            current * (action.mode === "in" ? 1.25 : 0.8),
          ));
        }
        showZoomHud();
        return;
      }
      if (action.type === "color") {
        if (!canDraw) return;
        event.preventDefault();
        setColorPickerOpen((open) => !open);
        return;
      }
      if (action.type === "chat") {
        if (!roomSlug || requestedRole === undefined || !canChat) return;
        event.preventDefault();
        setChatOpen(true);
        requestAnimationFrame(() => chatInputRef.current?.focus());
        return;
      }
      if (action.type === "download") {
        event.preventDefault();
        void downloadCanvasImage();
        return;
      }
      if (action.type === "help") {
        event.preventDefault();
        setShortcutHelpOpen((open) => !open);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      handleShortcut(event, "keydown");
    };
    const onKeyUp = (event: KeyboardEvent) => {
      handleShortcut(event, "keyup");
    };
    const onBlur = () => {
      const previousTool = temporaryToolRef.current;
      temporaryToolRef.current = undefined;
      if (previousTool) selectTool(previousTool);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    canChat,
    canDraw,
    chatOpen,
    colorPickerOpen,
    downloadCanvasImage,
    headerMenuOpen,
    isApplePlatform,
    reportOpen,
    requestedRole,
    roomSlug,
    selectTool,
    shortcutHelpOpen,
    showZoomHud,
    sizeTool,
    tool,
  ]);

  return (
    <main className="drawing-app" data-recovery-source={recoverySource}>
      <section
        ref={workspaceRef}
        className={`drawing-workspace${spacePressed ? " is-hand" : ""}${
          roomSlug && requestedRole !== undefined && chatOpen
            ? " is-chat-open"
            : ""
        }${connectionNotice ? " has-status-hud" : ""}`}
        aria-label="お絵描きエリア"
        onPointerDown={beginWorkspaceDrag}
        onPointerMove={moveWorkspaceDrag}
        onPointerUp={endWorkspaceDrag}
        onPointerCancel={endWorkspaceDrag}
        onWheel={onWheel}
      >
        <a
          className="workspace-home-link"
          href="/"
          aria-label="ルーム一覧へ戻る"
          title="ルーム一覧へ戻る"
        >
          <House aria-hidden="true" />
        </a>
        <nav className="tool-switcher" aria-label="描画ツール">
          {(["brush", "eraser", "eyedropper", "zoom"] as const).map((candidate) => (
            <button
              key={candidate}
              className={tool === candidate ? "is-selected" : ""}
              type="button"
              aria-label={TOOL_LABELS[candidate]}
              aria-pressed={tool === candidate}
              aria-keyshortcuts={TOOL_SHORTCUTS[candidate]}
              title={candidate === "eyedropper"
                ? `スポイト (I / ${alternateShortcut}長押し)`
                : `${TOOL_LABELS[candidate]} (${TOOL_SHORTCUTS[candidate]})`}
              disabled={
                (candidate === "brush" || candidate === "eraser")
                && !canDraw
              }
              onClick={() => selectTool(candidate)}
            >
              <ToolIcon tool={candidate} />
            </button>
          ))}
          <span className="tool-switcher-separator" aria-hidden="true" />
          <button
            className={`tool-color-control${
              colorPickerOpen ? " is-selected" : ""
            }`}
            type="button"
            aria-label="カラー"
            aria-keyshortcuts="F6"
            title="カラー (F6)"
            aria-expanded={colorPickerOpen}
            aria-controls="drawing-color-picker"
            disabled={!canDraw}
            onClick={() => setColorPickerOpen((current) => !current)}
          >
            <span style={{ background: color }} />
          </button>
          {roomSlug && assignedRole ? (
            <>
              <span className="tool-switcher-separator" aria-hidden="true" />
              <div className="header-menu" ref={headerMenuRef}>
                <button
                  className="header-icon-button"
                  type="button"
                  aria-label="ルームメニュー"
                  aria-haspopup="menu"
                  aria-expanded={headerMenuOpen}
                  onClick={() => setHeaderMenuOpen((open) => !open)}
                >
                  <Ellipsis aria-hidden="true" />
                </button>
                {headerMenuOpen ? (
                  <div className="header-menu-popover" role="menu">
                    <button
                      disabled={!canDownloadCanvas}
                      type="button"
                      role="menuitem"
                      title={!canDownloadCanvas
                        ? "描画の同期または再接続が完了すると保存できます"
                        : undefined}
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        void downloadCanvasImage();
                      }}
                    >
                      <span>
                        <Download aria-hidden="true" />
                        {downloadPending ? "PNGを準備中…" : "画像をダウンロード"}
                      </span>
                      <strong>{primaryShortcut}+S</strong>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        setShortcutHelpOpen(true);
                      }}
                    >
                      <span>
                        <Keyboard aria-hidden="true" />
                        ショートカット一覧
                      </span>
                      <strong>?</strong>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        reopenRolePicker();
                      }}
                    >
                      <span>参加方法を変更</span>
                      <strong>{assignedRoleLabel}</strong>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        void copyInviteLink();
                      }}
                    >
                      <span>
                        <Share2 aria-hidden="true" />
                        招待リンクをコピー
                      </span>
                    </button>
                    {connectionStatus === "connected" ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setHeaderMenuOpen(false);
                          setReportOpen(true);
                        }}
                      >
                        通報する
                      </button>
                    ) : null}
                    {assignedRole === "host"
                      && connectionStatus === "connected"
                      && roomLifecycleStatus !== undefined
                      && roomLifecycleStatus !== "closing" ? (
                      <>
                        <span className="header-menu-separator" />
                        <button
                          className="is-destructive"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setHeaderMenuOpen(false);
                            closeRoom();
                          }}
                        >
                          ルームを終了
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </nav>

        {connectionNotice ? (
          <div
            className={`workspace-status-hud is-${connectionNoticeLevel}`}
            role={rendererError ? "alert" : "status"}
            aria-live={rendererError ? "assertive" : "polite"}
          >
            <span aria-hidden="true" />
            {connectionNotice}
          </div>
        ) : null}

        <aside className="brush-rail" aria-label="描画調整">
          <label className="brush-slider-control">
            <span className="sr-only">
              {sizeTool === "eraser" ? "消しゴムサイズ" : "ブラシサイズ"}
            </span>
            <input
              type="range"
              min={PROTOCOL_LIMITS.minBrushSize}
              max={PROTOCOL_LIMITS.maxBrushSize}
              value={size}
              disabled={!canDraw}
              aria-keyshortcuts="[ ]"
              title={`${
                sizeTool === "eraser" ? "消しゴム" : "ブラシ"
              }サイズ ([ / ])`}
              onPointerDown={(event) => beginSliderPreview("size", event)}
              onFocus={() => {
                if (sliderPreviewPointerRef.current === undefined) {
                  setSliderPreview("size");
                }
              }}
              onBlur={() => {
                if (sliderPreviewPointerRef.current === undefined) {
                  setSliderPreview(undefined);
                }
              }}
              onInput={(event) => {
                const nextSize = Number(event.currentTarget.value);
                if (sizeTool === "eraser") {
                  setEraserSize(nextSize);
                } else {
                  setBrushSize(nextSize);
                }
                setSliderPreview("size");
              }}
            />
            {sliderPreview === "size" ? (
              <span
                className="brush-slider-preview is-size"
                aria-hidden="true"
              >
                <span className="brush-slider-preview-header">
                  <strong>
                    {sizeTool === "eraser" ? "消しゴムサイズ" : "サイズ"}
                  </strong>
                  <span>{Math.round(size)} px</span>
                </span>
                <span className="brush-slider-preview-stage">
                  <span
                    className={`brush-slider-preview-dot${
                      sizeTool === "eraser" ? " is-eraser" : ""
                    }`}
                    style={{
                      width: `${size}px`,
                      height: `${size}px`,
                      backgroundColor: sizeTool === "eraser" ? "#fff" : color,
                    }}
                  />
                </span>
              </span>
            ) : null}
          </label>
          <button
            type="button"
            className={tool === "eyedropper" ? "is-selected" : ""}
            aria-label="スポイト"
            title="スポイト (I)"
            onClick={() => selectTool("eyedropper")}
          >
            <Square aria-hidden="true" />
          </button>
          <label className="brush-slider-control">
            <span className="sr-only">濃度</span>
            <input
              type="range"
              min={5}
              max={100}
              value={Math.round(opacity * 100)}
              disabled={!canDraw}
              aria-keyshortcuts="0 1 2 3 4 5 6 7 8 9"
              title="濃度 (0–9)"
              onPointerDown={(event) => beginSliderPreview("opacity", event)}
              onFocus={() => {
                if (sliderPreviewPointerRef.current === undefined) {
                  setSliderPreview("opacity");
                }
              }}
              onBlur={() => {
                if (sliderPreviewPointerRef.current === undefined) {
                  setSliderPreview(undefined);
                }
              }}
              onInput={(event) => {
                setOpacity(Number(event.currentTarget.value) / 100);
                setSliderPreview("opacity");
              }}
            />
            {sliderPreview === "opacity" ? (
              <span
                className="brush-slider-preview is-opacity"
                aria-hidden="true"
              >
                <span className="brush-slider-preview-header">
                  <strong>濃度</strong>
                  <span>{Math.round(opacity * 100)}%</span>
                </span>
                <span className="brush-slider-preview-stage is-opacity">
                  <span
                    className="brush-slider-preview-dot is-opacity"
                    style={{
                      backgroundColor: color,
                      opacity,
                    }}
                  />
                </span>
              </span>
            ) : null}
          </label>
        </aside>

        <div
          className={`canvas-stage tool-${tool}`}
          style={{
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <canvas
            ref={attachBaseCanvas}
            width={PROTOCOL_LIMITS.canvasWidth}
            height={PROTOCOL_LIMITS.canvasHeight}
          />
          <canvas
            ref={remoteCanvasRef}
            width={PROTOCOL_LIMITS.canvasWidth}
            height={PROTOCOL_LIMITS.canvasHeight}
          />
          <canvas
            ref={provisionalCanvasRef}
            width={PROTOCOL_LIMITS.canvasWidth}
            height={PROTOCOL_LIMITS.canvasHeight}
            onPointerDown={beginDrawing}
            onPointerMove={moveDrawing}
            onPointerUp={finishDrawing}
            onPointerCancel={cancelDrawing}
            onPointerLeave={() => {
              sendCursor({ visible: false });
              setEyedropperCursor((current) => ({
                ...current,
                visible: false,
              }));
            }}
          />
          {Array.from(remoteCursors, ([actor, cursor]) => (
            <span
              key={actor}
              className="remote-cursor"
              aria-hidden="true"
              style={{
                left: `${(cursor.x / PROTOCOL_LIMITS.canvasWidth) * 100}%`,
                top: `${(cursor.y / PROTOCOL_LIMITS.canvasHeight) * 100}%`,
                color: cursorColor(actor),
                transform: `translate(-50%, -50%) scale(${1 / zoom})`,
              }}
            />
          ))}
        </div>

        <div
          className="eyedropper-preview"
          aria-hidden="true"
          hidden={!eyedropperCursor.visible || tool !== "eyedropper"}
          style={{
            left: eyedropperCursor.left,
            top: eyedropperCursor.top,
          } as CSSProperties}
        >
          <span className="eyedropper-preview-lens">
            <canvas ref={eyedropperPreviewRef} width={64} height={64} />
          </span>
          <span
            className="eyedropper-preview-ring"
            style={{
              "--eyedropper-sampled-color": eyedropperCursor.sampledColor,
              "--eyedropper-current-color": color,
            } as CSSProperties}
          />
          <span className="eyedropper-reticle" />
        </div>

        {colorPickerOpen ? (
          <div
            ref={colorDialogRef}
            id="drawing-color-picker"
            className="drawing-color-picker"
            role="dialog"
            aria-label="カラー"
            style={{
              left: colorDialogPosition.left,
              top: colorDialogPosition.top,
              "--picker-hue": pickerHsv.h,
              "--current-color": color,
            } as CSSProperties}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <header
              className="drawing-color-picker-header"
              onPointerDown={beginColorDialogDrag}
              onPointerMove={moveColorDialog}
              onPointerUp={endColorDialogDrag}
              onPointerCancel={endColorDialogDrag}
            >
              <strong>カラー</strong>
              <span className="drawing-color-picker-current" />
              <button
                type="button"
                aria-label="カラーダイアログを閉じる"
                onClick={() => setColorPickerOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </header>

            <div className="drawing-color-picker-body">
              {colorPickerView === "circle" ? (
                <div className="color-picker-circle-panel">
                  <div
                    className="color-picker-wheel"
                    aria-label="色相環"
                    onPointerDown={(event) =>
                      beginPickerDrag(event, "circle-hue")}
                    onPointerMove={(event) =>
                      movePickerDrag(event, "circle-hue")}
                    onPointerUp={endPickerDrag}
                    onPointerCancel={endPickerDrag}
                  >
                    <span
                      className="color-picker-handle color-picker-hue-handle"
                      style={{
                        left: `${50 + Math.cos(hueRadians) * 43}%`,
                        top: `${50 + Math.sin(hueRadians) * 43}%`,
                      }}
                    />
                    <div
                      className="color-picker-sv color-picker-circle-sv"
                      aria-label="彩度と明度"
                      onPointerDown={(event) =>
                        beginPickerDrag(event, "circle-sv")}
                      onPointerMove={(event) =>
                        movePickerDrag(event, "circle-sv")}
                      onPointerUp={endPickerDrag}
                      onPointerCancel={endPickerDrag}
                    >
                      <span
                        className="color-picker-handle"
                        style={{
                          left: `${pickerHsv.s}%`,
                          top: `${100 - pickerHsv.v}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {colorPickerView === "square" ? (
                <div className="color-picker-square-panel">
                  <div
                    className="color-picker-sv color-picker-square-sv"
                    aria-label="彩度と明度"
                    onPointerDown={(event) =>
                      beginPickerDrag(event, "square-sv")}
                    onPointerMove={(event) =>
                      movePickerDrag(event, "square-sv")}
                    onPointerUp={endPickerDrag}
                    onPointerCancel={endPickerDrag}
                  >
                    <span
                      className="color-picker-handle"
                      style={{
                        left: `${pickerHsv.s}%`,
                        top: `${100 - pickerHsv.v}%`,
                      }}
                    />
                  </div>
                  <input
                    className="color-picker-hue-range"
                    type="range"
                    min={0}
                    max={360}
                    value={pickerHsv.h}
                    aria-label="色相"
                    onChange={(event) => applyPickerHsv({
                      ...pickerHsv,
                      h: Number(event.currentTarget.value),
                    })}
                  />
                </div>
              ) : null}

              {colorPickerView === "sliders" ? (
                <div className="color-picker-sliders-panel">
                  <div
                    className="color-picker-mode-tabs"
                    aria-label="カラーモード"
                  >
                    {(["hsb", "rgb"] as const).map((mode) => (
                      <button
                        key={mode}
                        className={colorSliderMode === mode ? "is-selected" : ""}
                        type="button"
                        aria-pressed={colorSliderMode === mode}
                        onClick={() => setColorSliderMode(mode)}
                      >
                        {mode.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  {colorSliderMode === "hsb" ? (
                    <div className="color-picker-channels">
                      <label>
                        <span>H</span>
                        <input
                          className="channel-hue"
                          type="range"
                          min={0}
                          max={360}
                          value={pickerHsv.h}
                          onChange={(event) => applyPickerHsv({
                            ...pickerHsv,
                            h: Number(event.currentTarget.value),
                          })}
                        />
                        <output>{Math.round(pickerHsv.h)}°</output>
                      </label>
                      <label>
                        <span>S</span>
                        <input
                          className="channel-saturation"
                          type="range"
                          min={0}
                          max={100}
                          value={pickerHsv.s}
                          onChange={(event) => applyPickerHsv({
                            ...pickerHsv,
                            s: Number(event.currentTarget.value),
                          })}
                        />
                        <output>{Math.round(pickerHsv.s)}%</output>
                      </label>
                      <label>
                        <span>B</span>
                        <input
                          className="channel-brightness"
                          type="range"
                          min={0}
                          max={100}
                          value={pickerHsv.v}
                          onChange={(event) => applyPickerHsv({
                            ...pickerHsv,
                            v: Number(event.currentTarget.value),
                          })}
                        />
                        <output>{Math.round(pickerHsv.v)}%</output>
                      </label>
                    </div>
                  ) : (
                    <div className="color-picker-channels">
                      {([
                        ["R", "red", pickerRgb.r],
                        ["G", "green", pickerRgb.g],
                        ["B", "blue", pickerRgb.b],
                      ] as const).map(([label, channel, value]) => (
                        <label key={channel}>
                          <span>{label}</span>
                          <input
                            className={`channel-${channel}`}
                          type="range"
                          min={0}
                          max={255}
                          value={value}
                          aria-label={`${label}値`}
                          onChange={(event) => applyRgbColor({
                            ...pickerRgb,
                            [channel]: Number(event.currentTarget.value),
                          })}
                          />
                          <output>{value}</output>
                        </label>
                      ))}
                    </div>
                  )}
                  <label className="color-picker-hex">
                    <span>HEX</span>
                    <input
                      value={hexInput}
                      maxLength={7}
                      spellCheck={false}
                      aria-label="HEXカラー"
                      onChange={(event) => setHexInput(event.currentTarget.value)}
                      onBlur={() => {
                        if (!applyHexColor(hexInput)) {
                          setHexInput(color.toUpperCase());
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        if (!applyHexColor(hexInput)) {
                          setHexInput(color.toUpperCase());
                        }
                        event.currentTarget.blur();
                      }}
                    />
                  </label>
                </div>
              ) : null}
            </div>

            <nav
              className="drawing-color-picker-tabs"
              aria-label="カラー選択方式"
            >
              <button
                className={colorPickerView === "circle" ? "is-selected" : ""}
                type="button"
                title="サークル"
                aria-label="サークル"
                aria-pressed={colorPickerView === "circle"}
                onClick={() => setColorPickerView("circle")}
              >
                <span className="color-picker-circle-icon" />
              </button>
              <button
                className={colorPickerView === "square" ? "is-selected" : ""}
                type="button"
                title="スクエア"
                aria-label="スクエア"
                aria-pressed={colorPickerView === "square"}
                onClick={() => setColorPickerView("square")}
              >
                <Square aria-hidden="true" />
              </button>
              <button
                className={colorPickerView === "sliders" ? "is-selected" : ""}
                type="button"
                title="スライダー"
                aria-label="スライダー"
                aria-pressed={colorPickerView === "sliders"}
                onClick={() => setColorPickerView("sliders")}
              >
                <SlidersHorizontal aria-hidden="true" />
              </button>
            </nav>
          </div>
        ) : null}

        {roomSlug && requestedRole !== undefined && !chatOpen ? (
          <button
            className="room-chat-toggle"
            type="button"
            aria-label={unreadChatCount > 0
              ? `チャットを開く（未読${unreadChatCount}件）`
              : "チャットを開く"}
            aria-keyshortcuts="T"
            title="チャットを開いて入力 (T)"
            onClick={() => setChatOpen(true)}
          >
            <MessageSquare aria-hidden="true" />
            {unreadChatCount > 0 ? (
              <span className="room-chat-unread" aria-hidden="true">
                {unreadChatCount > 99 ? "99+" : unreadChatCount}
              </span>
            ) : null}
          </button>
        ) : null}

        {roomSlug && requestedRole !== undefined && chatOpen ? (
          <aside className="room-chat" aria-label="チャット">
            <header>
              <strong title={roomName}>{roomName}</strong>
              <span className="room-chat-presence" aria-label="入室人数">
                <Users aria-hidden="true" />
                <span>{presenceMembers.length}人</span>
              </span>
              <button
                type="button"
                aria-label="チャットを閉じる"
                aria-keyshortcuts="Escape"
                title="チャットを閉じる (Esc)"
                onClick={() => setChatOpen(false)}
              >
                <PanelRightClose aria-hidden="true" />
              </button>
            </header>
            <div className="room-chat-messages" ref={chatMessagesRef}>
              {chatMessages.length === 0 ? (
                <p className="room-chat-empty">まだメッセージはありません</p>
              ) : chatMessages.map((message) => {
                const mine = message.actor === currentActorRef.current;
                const fallbackLabel = mine
                  ? "あなた"
                  : message.role === "host"
                    ? "ホスト"
                    : message.role === "viewer"
                      ? "見る人"
                      : "描く人";
                const label = message.displayName ?? fallbackLabel;
                const initials = [...label].slice(0, 2).join("").toUpperCase();
                return (
                  <article
                    className={`room-chat-message${mine ? " is-mine" : ""}`}
                    key={message.id}
                  >
                    <span className="room-chat-avatar" aria-hidden="true">
                      <span>{initials}</span>
                      {message.avatarUrl ? (
                        <img
                          alt=""
                          decoding="async"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          src={message.avatarUrl}
                          onError={(event) => {
                            event.currentTarget.hidden = true;
                          }}
                        />
                      ) : null}
                    </span>
                    <div className="room-chat-message-content">
                      <div className="room-chat-message-meta">
                        <strong>{label}</strong>
                        <time dateTime={new Date(message.createdAt).toISOString()}>
                          {new Date(message.createdAt).toLocaleTimeString(
                            "ja-JP",
                            { hour: "2-digit", minute: "2-digit" },
                          )}
                        </time>
                      </div>
                      <p>{message.text}</p>
                    </div>
                  </article>
                );
              })}
            </div>
            <form
              className="room-chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                sendChat();
              }}
            >
              <textarea
                ref={chatInputRef}
                aria-label="チャットメッセージ"
                disabled={!canSendChat || connectionStatus !== "connected"}
                placeholder={roomLifecycleStatus === "waiting"
                  ? "準備完了後に送信できます"
                  : canChat
                  ? "メッセージを送る…"
                  : isAuthenticated
                    ? "チャットを利用できません"
                    : "チャットにはログインが必要です"}
                rows={1}
                value={chatText}
                onChange={(event) => setChatText(event.currentTarget.value)}
                onCompositionStart={() => {
                  chatComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  chatComposingRef.current = false;
                }}
                onKeyDown={(event) => {
                  if (shouldSendChatOnKeyDown({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: chatComposingRef.current
                      || event.nativeEvent.isComposing,
                    keyCode: event.keyCode,
                  })) {
                    event.preventDefault();
                    sendChat();
                  }
                }}
              />
              <button
                type="submit"
                disabled={!canSendChat || !chatText.trim()}
                aria-label="送信"
              >
                <SendHorizontal aria-hidden="true" />
              </button>
            </form>
          </aside>
        ) : null}

        {roomSlug && requestedRole === undefined ? (
          <div className="room-entry-backdrop">
            <section
              className="room-entry-dialog"
              aria-labelledby="room-entry-title"
              aria-describedby="room-entry-description"
            >
              <p className="room-entry-kicker">ルームに入る</p>
              <h1 id="room-entry-title">どのように参加しますか？</h1>
              <p id="room-entry-description">
                {isAuthenticated
                  ? "描く人はキャンバスに参加できます。見る人は閲覧しながらチャットにも参加できます。"
                  : "ゲストは見る人として参加できます。描画とチャットにはログインが必要です。"}
              </p>
              <div className="room-entry-actions">
                {isAuthenticated ? (
                  <button
                    className="room-entry-choice is-drawing"
                    type="button"
                    onClick={() => chooseRole("participant")}
                  >
                    <strong>描く人として参加</strong>
                    <span>ブラシと消しゴム、チャットを使う</span>
                  </button>
                ) : null}
                <button
                  className="room-entry-choice"
                  type="button"
                  onClick={() => chooseRole("viewer")}
                >
                  <strong>見る人として参加</strong>
                  <span>
                    {isAuthenticated
                      ? "閲覧とチャット・あとから変更できます"
                      : "閲覧のみ"}
                  </span>
                </button>
              </div>
              <a href="/">ルーム一覧へ戻る</a>
            </section>
          </div>
        ) : null}

        {shortcutHelpOpen ? (
          <div
            className="room-entry-backdrop"
            onPointerDown={(event) => {
              event.stopPropagation();
              if (event.target === event.currentTarget) {
                setShortcutHelpOpen(false);
              }
            }}
          >
            <section
              className="drawing-shortcuts-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="drawing-shortcuts-title"
            >
              <header>
                <div>
                  <p className="room-entry-kicker">
                    {isApplePlatform ? "macOS" : "Windows・Linux"}
                  </p>
                  <h1 id="drawing-shortcuts-title">キーボードショートカット</h1>
                </div>
                <button
                  type="button"
                  aria-label="ショートカット一覧を閉じる"
                  onClick={() => setShortcutHelpOpen(false)}
                >
                  <X aria-hidden="true" />
                </button>
              </header>
              <div className="drawing-shortcuts-groups">
                {shortcutGroups.map((group) => (
                  <section key={group.title}>
                    <h2>{group.title}</h2>
                    <dl>
                      {group.items.map((item) => (
                        <div key={item.label}>
                          <dt>
                            {item.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                          </dt>
                          <dd>{item.label}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
            </section>
          </div>
        ) : null}

        {roomSlug && reportOpen ? (
          <div
            className="room-entry-backdrop"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <section
              className="room-report-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="room-report-title"
            >
              <p className="room-entry-kicker">ルームを通報</p>
              <h1 id="room-report-title">問題の内容を教えてください</h1>
              <p>
                確認に必要な範囲の描画・チャット情報を期限付きで保存します。
              </p>
              <label>
                <span>種類</span>
                <select
                  value={reportCategory}
                  onChange={(event) => setReportCategory(event.currentTarget.value)}
                >
                  <option value="harassment">嫌がらせ・迷惑行為</option>
                  <option value="sexual">性的な内容</option>
                  <option value="violence">暴力的な内容</option>
                  <option value="copyright">著作権に関する問題</option>
                  <option value="other">その他</option>
                </select>
              </label>
              <label>
                <span>補足（任意）</span>
                <textarea
                  maxLength={1_000}
                  rows={4}
                  value={reportDescription}
                  onChange={(event) =>
                    setReportDescription(event.currentTarget.value)}
                />
              </label>
              <div className="room-report-actions">
                <button
                  type="button"
                  disabled={reportSubmitting}
                  onClick={() => setReportOpen(false)}
                >
                  キャンセル
                </button>
                <button
                  className="is-primary"
                  type="button"
                  disabled={reportSubmitting}
                  onClick={() => void submitReport()}
                >
                  {reportSubmitting ? "送信中…" : "通報する"}
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {realtimeNotice ? (
          <div
            className={`realtime-notice is-${realtimeNotice.tone}`}
            role={
              realtimeNotice.tone === "warning"
                || realtimeNotice.tone === "error"
                ? "alert"
                : "status"
            }
            aria-atomic="true"
            onPointerEnter={() => pauseRealtimeNotice("pointer")}
            onPointerLeave={() => resumeRealtimeNotice("pointer")}
            onFocusCapture={() => pauseRealtimeNotice("focus")}
            onBlurCapture={() => resumeRealtimeNotice("focus")}
          >
            <span>{realtimeNotice.message}</span>
            {realtimeNotice.tone === "warning"
                || realtimeNotice.tone === "error" ? (
              <button
                type="button"
                aria-label="通知を閉じる"
                onClick={dismissRealtimeNotice}
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}

        {(tool === "zoom" || zooming) && (
          <output className="zoom-hud" aria-live="polite">
            {Math.round(zoom * 100)}%
          </output>
        )}
      </section>
    </main>
  );
}
