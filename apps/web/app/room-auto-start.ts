import type { RoomRole } from "@koge/protocol";

export type RoomAutoStartReadiness = {
  readonly roomSlug: string | undefined;
  readonly assignedRole: RoomRole | undefined;
  readonly lifecycleStatus:
    | "waiting"
    | "active"
    | "idle"
    | "closing"
    | "suspended"
    | undefined;
  readonly connectionStatus:
    | "local"
    | "choosing"
    | "connecting"
    | "recovering"
    | "connected"
    | "disconnected";
  readonly rendererReady: boolean;
  readonly rendererFailed: boolean;
};

export function shouldAutoStartRoom(
  readiness: RoomAutoStartReadiness,
): boolean {
  return Boolean(readiness.roomSlug)
    && readiness.assignedRole === "host"
    && readiness.lifecycleStatus === "waiting"
    && readiness.connectionStatus === "connected"
    && readiness.rendererReady
    && !readiness.rendererFailed;
}
