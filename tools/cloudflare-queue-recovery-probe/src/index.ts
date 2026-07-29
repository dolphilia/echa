type ProbeEnv = {
  TARGET_QUEUE: Queue;
  PROBE_TOKEN: string;
};

function isProbeMessage(value: unknown): value is {
  kind: "moderation.evidence.delete";
  evidenceId: string;
} {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && value.kind === "moderation.evidence.delete"
    && "evidenceId" in value
    && typeof value.evidenceId === "string"
    && value.evidenceId.startsWith("evidence_dlq_probe_");
}

function isEvidenceDuplicate(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && value.kind === "moderation.evidence"
    && "jobId" in value
    && typeof value.jobId === "string"
    && "evidenceId" in value
    && value.evidenceId === value.jobId;
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (
      request.method !== "POST"
      || !env.PROBE_TOKEN
      || request.headers.get("x-koge-queue-probe-token") !== env.PROBE_TOKEN
    ) {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const body: unknown = await request.json();
    if (!isProbeMessage(body) && !isEvidenceDuplicate(body)) {
      return Response.json({ error: "INVALID_PROBE" }, { status: 400 });
    }
    await env.TARGET_QUEUE.send(body);
    return Response.json({ enqueued: true });
  },

  async queue(batch: MessageBatch, env: ProbeEnv): Promise<void> {
    for (const message of batch.messages) {
      if (!isProbeMessage(message.body)) {
        message.retry({ delaySeconds: 60 });
        continue;
      }
      // Reinsert the exact body. Product-side idempotency decides whether it
      // is safe to acknowledge.
      // oxlint-disable-next-line no-await-in-loop
      await env.TARGET_QUEUE.send(message.body);
      message.ack();
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
