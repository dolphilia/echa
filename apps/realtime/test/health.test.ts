import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ROOM_MAX_DURATION_MS,
  ROOM_PARTICIPANT_LIMIT,
  ROOM_PROVISIONING_VERSION,
  ROOM_TICKET_TTL_MS,
  ROOM_TICKET_VERSION,
  ROOM_VIEWER_LIMIT,
  type RoomProvisioningRequest,
  type RoomTicketRegistrationResult,
} from "@koge/protocol";

describe("phase 0 health", () => {
  it("reports the Worker and local bindings as healthy", async () => {
    const response = await exports.default.fetch("http://example.test/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "koge-realtime",
      environment: "local",
    });
  });

  it("reports cleanup queue, DLQ, and projection health", async () => {
    const response = await exports.default.fetch(
      "http://example.test/health/cleanup",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "koge-realtime-cleanup",
      environment: "local",
      approximate: true,
      queue: {
        backlogCount: 0,
        backlogBytes: 0,
      },
      dlq: {
        backlogCount: 0,
        backlogBytes: 0,
      },
      projection: {
        pendingCount: 0,
        stuckCount: 0,
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports evidence queue, DLQ, and projection health", async () => {
    const response = await exports.default.fetch(
      "http://example.test/health/evidence",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "koge-realtime-evidence",
      environment: "local",
      approximate: true,
      queue: {
        backlogCount: 0,
        backlogBytes: 0,
      },
      dlq: {
        backlogCount: 0,
        backlogBytes: 0,
      },
      projection: {
        pendingCount: 0,
        stuckCount: 0,
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports read-only orphan snapshot inventory health", async () => {
    const response = await exports.default.fetch(
      "http://example.test/health/orphan-snapshots",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "koge-realtime-orphan-snapshots",
      environment: "local",
      automaticDeletion: false,
      latest: null,
      inventory: {
        count: 0,
        bytes: 0,
        roomMissingCount: 0,
        unreferencedCount: 0,
      },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("initializes isolated SQLite-backed room objects", async () => {
    const firstRoom = env.DRAWING_ROOM.getByName("phase0-first");
    const secondRoom = env.DRAWING_ROOM.getByName("phase0-second");

    await expect(firstRoom.health()).resolves.toEqual({
      ok: true,
      schemaVersion: 28,
    });
    await expect(secondRoom.health()).resolves.toEqual({
      ok: true,
      schemaVersion: 28,
    });
  });

  it("initializes room metadata through an idempotent service RPC", async () => {
    const createdAt = Date.now();
    const request = {
      v: ROOM_PROVISIONING_VERSION,
      roomId: "room-provisioning-test",
      publicSlug: "0123456789abcdef0123456789abcdef",
      ownerUserId: "owner-provisioning-test",
      name: "RPC room",
      visibility: "public",
      participantLimit: ROOM_PARTICIPANT_LIMIT,
      viewerLimit: ROOM_VIEWER_LIMIT,
      viewerChatEnabled: false,
      viewerStampEnabled: false,
      createdAt,
      maxEndsAt: createdAt + ROOM_MAX_DURATION_MS,
    } as const satisfies RoomProvisioningRequest;

    await expect(
      exports.RoomProvisioningService.fetch(
        "http://internal.test/rooms/initialize",
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      ).then((response) => response.json()),
    ).resolves.toMatchObject({
      status: "initialized",
      roomId: request.roomId,
    });
    await expect(
      exports.RoomProvisioningService.fetch(
        "http://internal.test/rooms/initialize",
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      ).then((response) => response.json()),
    ).resolves.toMatchObject({
      status: "already_initialized",
      roomId: request.roomId,
    });

    const ticketRequest = {
      v: ROOM_TICKET_VERSION,
      roomId: request.roomId,
      actorId: "actor-ticket-health-test",
      connectionId: "connection-ticket-health-test",
      role: "viewer",
      sessionBindingHash: "a".repeat(64),
      issuedAt: createdAt,
      expiresAt: createdAt + ROOM_TICKET_TTL_MS,
    } as const;
    const ticketResponse = await exports.RoomProvisioningService.fetch(
      "http://internal.test/rooms/tickets/register",
      {
        method: "POST",
        body: JSON.stringify(ticketRequest),
      },
    );
    expect(ticketResponse.status).toBe(200);
    const ticket = await ticketResponse.json<RoomTicketRegistrationResult>();
    expect(ticket).toMatchObject({
      actorId: ticketRequest.actorId,
      role: "viewer",
    });

    const room = env.DRAWING_ROOM.getByName(request.roomId);
    const connect = () => room.fetch(
      new Request("http://internal.test/connect", {
        headers: {
          Upgrade: "websocket",
          "x-koge-room-id": request.roomId,
          "x-koge-room-ticket": ticket.ticket,
        },
      }),
    );
    const accepted = await connect();
    expect(accepted.status).toBe(101);
    accepted.webSocket?.accept();
    accepted.webSocket?.close(1000, "test complete");
    const replayed = await connect();
    expect(replayed.status).toBe(401);
    await expect(replayed.json()).resolves.toEqual({
      error: "ROOM_TICKET_REJECTED",
    });
  });
});
