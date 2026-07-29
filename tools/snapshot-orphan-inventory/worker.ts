interface SnapshotOrphanScanService {
  scanRuntimeSnapshotOrphans(): Promise<unknown>;
  createDeletionPlan(): Promise<unknown>;
  deleteApprovedPlan(input: {
    readonly plan: unknown;
    readonly confirmation: unknown;
  }): Promise<unknown>;
}

interface Env {
  REALTIME: SnapshotOrphanScanService;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/scan") {
      return Response.json(await env.REALTIME.scanRuntimeSnapshotOrphans());
    }
    if (request.method === "POST" && url.pathname === "/plan") {
      return Response.json(await env.REALTIME.createDeletionPlan());
    }
    if (request.method === "POST" && url.pathname === "/apply") {
      const input: unknown = await request.json();
      if (!input || typeof input !== "object") {
        return Response.json({ error: "INVALID_INPUT" }, { status: 400 });
      }
      const { plan, confirmation } = input as Record<string, unknown>;
      return Response.json(
        await env.REALTIME.deleteApprovedPlan({ plan, confirmation }),
      );
    }
    if (request.method !== "GET" || url.pathname !== "/health") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    return Response.json({ ok: true, service: "snapshot-orphan-operator" });
  },
} satisfies ExportedHandler<Env>;
