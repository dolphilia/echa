const ROOM_PATTERN = /^snapshot-probe-[a-f0-9]{16}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("room");
    if (!roomId || !ROOM_PATTERN.test(roomId)) {
      return Response.json({ error: "INVALID_PROBE_ROOM" }, { status: 400 });
    }
    const room = env.DRAWING_ROOM.getByName(roomId);
    if (request.method === "POST" && url.pathname === "/run") {
      return Response.json(await room.requestSnapshot(roomId), { status: 202 });
    }
    if (request.method === "POST" && url.pathname === "/run-close") {
      const job = await room.requestSnapshot(roomId);
      const close = await room.beginRoomClose({
        closeRequestId: `close_${crypto.randomUUID().replaceAll("-", "")}`,
        reason: "probe",
      });
      return Response.json({ job, close }, { status: 202 });
    }
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        lifecycle: await room.roomLifecycleState(),
        manifest: await room.currentSnapshot() ?? null,
        compaction: await room.snapshotCompactionState(),
        automation: await room.snapshotAutomationState(),
        stats: await room.stats(),
      });
    }
    if (request.method === "POST" && url.pathname === "/compact") {
      const manifest = await room.currentSnapshot();
      if (!manifest) {
        return Response.json({ error: "SNAPSHOT_NOT_READY" }, { status: 409 });
      }
      const limit = Number(url.searchParams.get("limit") ?? "500");
      return Response.json(
        await room.compactSnapshotEvents(manifest.jobId, limit),
      );
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
};
