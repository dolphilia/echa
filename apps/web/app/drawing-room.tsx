"use client";

import {
  PROTOCOL_LIMITS,
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

type SelectedTool = DrawingTool | "eyedropper" | "zoom";
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
  const paths: Record<SelectedTool, string> = {
    brush: "M5 19c4 0 6-2 6-6l8-8-4-4-8 8c-4 0-6 2-6 6 0 2 1 4 4 4Z",
    eraser: "m4 14 8-8 6 6-7 7H7l-3-3a1.4 1.4 0 0 1 0-2Z",
    eyedropper: "m7 17 9-9m-6-3 9 9M5 19l4-1-3-3-1 4Z",
    zoom: "m15 15 5 5m-3-11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={paths[tool]} />
    </svg>
  );
}

export default function DrawingRoom({ roomSlug }: { roomSlug?: string }) {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const remoteCanvasRef = useRef<HTMLCanvasElement>(null);
  const provisionalCanvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const outboxRef = useRef(new StrokeOutbox());
  const drawingRef = useRef<ActiveDrawing | undefined>(undefined);
  const dragRef = useRef<DragState | undefined>(undefined);
  const zoomHudTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
  const remoteCursorTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<SelectedTool>("brush");
  const [color, setColor] = useState("#574f43");
  const [size, setSize] = useState(8);
  const [opacity, setOpacity] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);
  const [zooming, setZooming] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const [syncEnabled, setSyncEnabled] = useState(Boolean(roomSlug));
  const [requestedRole, setRequestedRole] = useState<
    RequestedRoomRole | undefined
  >(roomSlug ? undefined : "participant");
  const [assignedRole, setAssignedRole] = useState<RoomRole | undefined>();
  const [realtimeNotice, setRealtimeNotice] = useState<string | undefined>();
  const [hasInviteLink, setHasInviteLink] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [presenceMembers, setPresenceMembers] = useState<
    readonly PresenceMember[]
  >([]);
  const [remoteCursors, setRemoteCursors] = useState<
    ReadonlyMap<string, RemoteCursor>
  >(new Map());
  const [chatMessages, setChatMessages] = useState<readonly ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
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
  const [roomTime, setRoomTime] = useState<RoomTimeMessage | undefined>();
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

  useEffect(() => {
    const element = chatMessagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chatMessages]);

  useEffect(() => {
    const canvas = baseCanvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
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
        setHasInviteLink(true);
        sessionStorage.setItem(`koge-room-invite:${roomSlug}`, fragmentInvite);
      } else {
        const storedInvite = sessionStorage.getItem(
          `koge-room-invite:${roomSlug}`,
        );
        inviteTokenRef.current = storedInvite
          && /^[a-f0-9]{64}$/.test(storedInvite)
          ? storedInvite
          : undefined;
        setHasInviteLink(Boolean(inviteTokenRef.current));
      }
      if (fragment.has("invite")) {
        history.replaceState(
          history.state,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
      }
      const storedRole = sessionStorage.getItem(`koge-room-role:${roomSlug}`);
      if (storedRole === "participant" || storedRole === "viewer") {
        setRequestedRole(storedRole);
      } else {
        setConnectionStatus("choosing");
      }
      return;
    }
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.get("sync") !== "1") return;
    setSyncEnabled(true);
  }, [roomSlug]);

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
    setRealtimeNotice(undefined);
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
              setRealtimeNotice(
                errorBody?.error === "SERVICE_BANNED"
                  ? "現在、このサービスのルームには入室できません。"
                  : "このルームには入室できません。招待リンクまたは参加権限を確認してください。",
              );
              return;
            }
            if (response.status === 404) {
              setConnectionStatus("disconnected");
              setRealtimeNotice("このルームは終了したか、見つかりません。");
              return;
            }
            if (
              response.status === 503
              && errorBody?.error === "ROOM_ENTRY_PAUSED"
            ) {
              setConnectionStatus("disconnected");
              setRealtimeNotice(
                "現在、緊急対応のため新しい入室を一時停止しています。自動的に再試行します。",
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
            setChatMessages(serverMessage.messages);
          } else if (serverMessage.type === "chat.message") {
            setChatMessages((current) => {
              if (current.some(({ id }) => id === serverMessage.message.id)) {
                return current;
              }
              return [
                ...current,
                serverMessage.message,
              ].slice(-PROTOCOL_LIMITS.maxChatMessages);
            });
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
            setRealtimeNotice(
              serverMessage.acceptingNewStrokes
                ? `このルームで描ける量は残り約${100 - serverMessage.level}%です。`
                : "描画量の上限に達しました。今の線を描き終えるとルームが終了します。",
            );
          } else if (serverMessage.type === "room.time") {
            setRoomTime(serverMessage);
            setRealtimeNotice(
              `ルーム終了まで約${serverMessage.warningMinutes}分です。`,
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
            setRealtimeNotice(notice);
          } else if (serverMessage.type === "room.removed") {
            terminal = true;
            setRealtimeNotice(
              serverMessage.reason === "service_banned"
                ? "管理者によりサービスから退出となりました。現在は再入室できません。"
                : serverMessage.reason === "room_banned"
                ? "このルームから退出となり、ルーム終了まで再入室できません。"
                : "このルームから退出となりました。必要であれば再入室できます。",
            );
          } else if (serverMessage.type === "room.closed") {
            terminal = true;
            setRoomLifecycleStatus("closing");
            setRealtimeNotice(
              "ルームは終了しました。このルームには再入室できません。",
            );
          } else if (serverMessage.status === "closing") {
            setRoomLifecycleStatus("closing");
            setRealtimeNotice(
              "ルームが終了処理に入りました。新しい描画はできません。",
            );
          } else if (serverMessage.status === "suspended") {
            terminal = true;
            setRoomLifecycleStatus("suspended");
            setRealtimeNotice(
              "このルームは管理者により停止されました。描画やチャットはできません。",
            );
          } else {
            setRoomLifecycleStatus(serverMessage.status);
            setRealtimeNotice(
              serverMessage.status === "waiting"
                ? "ホストがルームを開始するまでお待ちください。"
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
        && !(event.target instanceof HTMLInputElement)
        && !(event.target instanceof HTMLTextAreaElement)
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

  const showZoomHud = useCallback(() => {
    setZooming(true);
    if (zoomHudTimerRef.current) clearTimeout(zoomHudTimerRef.current);
    zoomHudTimerRef.current = setTimeout(() => setZooming(false), 700);
  }, []);

  useEffect(() => () => {
    if (zoomHudTimerRef.current) clearTimeout(zoomHudTimerRef.current);
  }, []);

  const canvasPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.round(((event.clientX - rect.left) / rect.width) * PROTOCOL_LIMITS.canvasWidth * 100) / 100,
      Math.round(((event.clientY - rect.top) / rect.height) * PROTOCOL_LIMITS.canvasHeight * 100) / 100,
      0,
    ];
  }, []);

  const sendCursor = useCallback((
    message:
      | { visible: true; x: number; y: number }
      | { visible: false },
  ) => {
    const socket = socketRef.current;
    if (!roomSlug || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeClientCursorMessage({
      v: 1,
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
      v: 1,
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
      const context = baseCanvasRef.current?.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      const [red, green, blue] = context.getImageData(
        Math.floor(point[0]),
        Math.floor(point[1]),
        1,
        1,
      ).data;
      if (red === undefined || green === undefined || blue === undefined) return;
      setColor(`#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
      setTool("brush");
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
    setRealtimeNotice(undefined);
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
    if (!roomSlug || !inviteTokenRef.current) return;
    const inviteUrl = new URL(
      `/rooms/${encodeURIComponent(roomSlug)}`,
      window.location.origin,
    );
    inviteUrl.hash = `invite=${inviteTokenRef.current}`;
    try {
      await navigator.clipboard.writeText(inviteUrl.toString());
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 1_500);
    } catch (error) {
      console.error("koge invite link copy failed", error);
      setRealtimeNotice("招待リンクをコピーできませんでした。");
    }
  };

  const startRoom = () => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeClientRoomStartMessage({
      v: 1,
      type: "room.start",
      requestId: `start_${crypto.randomUUID().replaceAll("-", "")}`,
    }));
  };

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
      v: 1,
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
      setRealtimeNotice("通報を受け付けました。確認用データを安全に保存しています。");
    } catch (error) {
      console.error("koge room report failed", error);
      setRealtimeNotice(
        "通報を送信できませんでした。時間をおいてもう一度お試しください。",
      );
    } finally {
      setReportSubmitting(false);
    }
  };

  return (
    <main className="drawing-app" data-recovery-source={recoverySource}>
      <header className="app-header">
        <a className="brand" href="/" aria-label="koge ホーム">koge</a>
        <div className="room-status-group">
          <div className="room-status">
            <span className="status-dot" />
            {rendererError
              ? "描画準備エラー"
              : !rendererReady
                ? "描画準備中"
                : roomLifecycleStatus === "suspended"
                  ? "管理停止中"
                : connectionStatus === "local"
                  ? "ローカル描画"
                  : connectionStatus === "choosing"
                    ? "参加方法を選択"
                  : connectionStatus === "connected"
                      ? roomLifecycleStatus === "waiting"
                        ? "開始待ち"
                        : roomLifecycleStatus === "idle"
                          ? "ひと休み中"
                          : "同期中"
                      : connectionStatus === "recovering"
                        ? "復元中"
                        : connectionStatus === "connecting"
                          ? "接続中"
                          : "再接続中"}
          </div>
          {assignedRole ? (
            <button
              className={`room-role role-${assignedRole}`}
              type="button"
              onClick={reopenRolePicker}
              title={roomSlug ? "参加方法を変更" : undefined}
            >
              {assignedRole === "host"
                ? "ホスト"
                : assignedRole === "participant"
                  ? "描く人"
                  : "見る人"}
            </button>
          ) : null}
          {roomSlug && presenceMembers.length > 0 ? (
            <span className="room-presence" aria-label="接続中の人数">
              {presenceMembers.length}人
            </span>
          ) : null}
          {roomActivity ? (
            <span
              className={`room-activity level-${roomActivity.level}`}
              aria-label="ルームの描画可能量"
            >
              {roomActivity.acceptingNewStrokes
                ? `残り約${100 - roomActivity.level}%`
                : "終了準備中"}
            </span>
          ) : null}
          {roomTime ? (
            <span className="room-time" aria-label="ルーム終了までの時間">
              終了まで{roomTime.warningMinutes}分以内
            </span>
          ) : null}
        </div>
        <div className="room-header-actions">
          {assignedRole === "host" && roomLifecycleStatus === "waiting" ? (
            <button
              className="room-start-button"
              type="button"
              onClick={startRoom}
            >
              ルームを開始
            </button>
          ) : null}
          {hasInviteLink ? (
            <button
              className="room-invite-button"
              type="button"
              onClick={() => void copyInviteLink()}
            >
              {inviteCopied ? "コピーしました" : "招待リンクをコピー"}
            </button>
          ) : null}
          {assignedRole === "host"
            && connectionStatus === "connected"
            && roomLifecycleStatus !== undefined
            && roomLifecycleStatus !== "closing" ? (
            <button
              className="room-close-button"
              type="button"
              onClick={closeRoom}
            >
              ルームを終了
            </button>
          ) : null}
          {roomSlug && assignedRole && connectionStatus === "connected" ? (
            <button
              className="room-report-button"
              type="button"
              onClick={() => setReportOpen(true)}
            >
              通報
            </button>
          ) : null}
          <span className="event-counter">{eventCount} events</span>
        </div>
      </header>

      <section
        ref={workspaceRef}
        className={`drawing-workspace${spacePressed ? " is-hand" : ""}`}
        aria-label="お絵描きエリア"
        onPointerDown={beginWorkspaceDrag}
        onPointerMove={moveWorkspaceDrag}
        onPointerUp={endWorkspaceDrag}
        onPointerCancel={endWorkspaceDrag}
        onWheel={onWheel}
      >
        <nav className="tool-switcher" aria-label="描画ツール">
          {(["brush", "eraser", "eyedropper", "zoom"] as const).map((candidate) => (
            <button
              key={candidate}
              className={tool === candidate ? "is-selected" : ""}
              type="button"
              aria-label={candidate}
              aria-pressed={tool === candidate}
              disabled={
                (candidate === "brush" || candidate === "eraser")
                && !canDraw
              }
              onClick={() => setTool(candidate)}
            >
              <ToolIcon tool={candidate} />
            </button>
          ))}
        </nav>

        <aside className="brush-rail" aria-label="ブラシ調整">
          <label>
            <span className="sr-only">ブラシサイズ</span>
            <input
              type="range"
              min={PROTOCOL_LIMITS.minBrushSize}
              max={PROTOCOL_LIMITS.maxBrushSize}
              value={size}
              disabled={!canDraw}
              onInput={(event) => setSize(Number(event.currentTarget.value))}
            />
          </label>
          <button
            type="button"
            className={tool === "eyedropper" ? "is-selected" : ""}
            aria-label="スポイト"
            onClick={() => setTool("eyedropper")}
          >
            <ToolIcon tool="eyedropper" />
          </button>
          <label>
            <span className="sr-only">濃度</span>
            <input
              type="range"
              min={5}
              max={100}
              value={Math.round(opacity * 100)}
              disabled={!canDraw}
              onInput={(event) => setOpacity(Number(event.currentTarget.value) / 100)}
            />
          </label>
        </aside>

        <div
          className={`canvas-stage tool-${tool}`}
          style={{
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <canvas
            ref={baseCanvasRef}
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
            onPointerLeave={() => sendCursor({ visible: false })}
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

        <label className="color-control" aria-label="現在の色">
          <input
            type="color"
            value={color}
            disabled={!canDraw}
            onChange={(event) => setColor(event.currentTarget.value)}
          />
        </label>

        {roomSlug && requestedRole !== undefined ? (
          <aside className="room-chat" aria-label="チャット">
            <header>
              <strong>チャット</strong>
              <span>{presenceMembers.length}人</span>
            </header>
            <div className="room-chat-messages" ref={chatMessagesRef}>
              {chatMessages.length === 0 ? (
                <p className="room-chat-empty">まだメッセージはありません</p>
              ) : chatMessages.map((message) => {
                const mine = message.actor === currentActorRef.current;
                const label = mine
                  ? "あなた"
                  : message.role === "host"
                    ? "ホスト"
                    : message.role === "viewer"
                      ? "見る人"
                      : "描く人";
                return (
                  <article
                    className={`room-chat-message${mine ? " is-mine" : ""}`}
                    key={message.id}
                  >
                    <div>
                      <strong>{label}</strong>
                      <time dateTime={new Date(message.createdAt).toISOString()}>
                        {new Date(message.createdAt).toLocaleTimeString(
                          "ja-JP",
                          { hour: "2-digit", minute: "2-digit" },
                        )}
                      </time>
                    </div>
                    <p>{message.text}</p>
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
                aria-label="チャットメッセージ"
                disabled={!canSendChat || connectionStatus !== "connected"}
                placeholder={roomLifecycleStatus === "waiting"
                  ? "ルーム開始後に送信できます"
                  : canChat
                  ? "メッセージを送る…"
                  : "見る人のチャットは無効です"}
                rows={2}
                value={chatText}
                onChange={(event) => setChatText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
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
                送信
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
                描く人はキャンバスに参加できます。見る人は安全な閲覧専用です。
              </p>
              <div className="room-entry-actions">
                <button
                  className="room-entry-choice is-drawing"
                  type="button"
                  onClick={() => chooseRole("participant")}
                >
                  <strong>描く人として参加</strong>
                  <span>ブラシと消しゴムを使う</span>
                </button>
                <button
                  className="room-entry-choice"
                  type="button"
                  onClick={() => chooseRole("viewer")}
                >
                  <strong>見る人として参加</strong>
                  <span>閲覧のみ・あとから変更できます</span>
                </button>
              </div>
              <a href="/">ルーム一覧へ戻る</a>
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
          <p className="realtime-notice" role="status">
            {realtimeNotice}
          </p>
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
