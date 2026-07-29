import { describe, expect, it } from "vitest";
import { shouldAutoStartRoom } from "../app/room-auto-start";

const readyHost = {
  roomSlug: "auto-start-room",
  assignedRole: "host",
  lifecycleStatus: "waiting",
  connectionStatus: "connected",
  rendererReady: true,
  rendererFailed: false,
} as const;

describe("room auto start readiness", () => {
  it("starts once the host connection and renderer are ready", () => {
    expect(shouldAutoStartRoom(readyHost)).toBe(true);
  });

  it("does not let a participant or viewer start the room", () => {
    expect(shouldAutoStartRoom({
      ...readyHost,
      assignedRole: "participant",
    })).toBe(false);
    expect(shouldAutoStartRoom({
      ...readyHost,
      assignedRole: "viewer",
    })).toBe(false);
  });

  it("waits for recovery, rendering, and the waiting lifecycle state", () => {
    expect(shouldAutoStartRoom({
      ...readyHost,
      connectionStatus: "recovering",
    })).toBe(false);
    expect(shouldAutoStartRoom({
      ...readyHost,
      rendererReady: false,
    })).toBe(false);
    expect(shouldAutoStartRoom({
      ...readyHost,
      lifecycleStatus: "active",
    })).toBe(false);
  });
});
