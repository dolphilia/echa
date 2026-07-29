interface RateAbuseMetricsService {
  capture(): Promise<unknown>;
}

interface Env {
  REALTIME: RateAbuseMetricsService;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/capture") {
      return Response.json(await env.REALTIME.capture());
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "rate-abuse-metrics" });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
