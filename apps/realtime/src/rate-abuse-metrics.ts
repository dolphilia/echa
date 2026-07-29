import type { DurableObject as DurableObjectBase } from "cloudflare:workers";

export type RateAbuseCounters = {
  readonly acceptedCount: number;
  readonly rejectCount: number;
  readonly rateLimitedCount: number;
  readonly shortMuteCount: number;
  readonly abuseDisconnectCount: number;
};

type RoomStats = RateAbuseCounters & {
  readonly eventCount: number;
  readonly activeStrokeCount: number;
  readonly connectionCount: number;
  readonly lastRoomSeq: number;
  readonly broadcastCount: number;
  readonly replayEventCount: number;
  readonly totalPayloadBytes: number;
};

type MetricsRoomTarget = DurableObjectBase<Env> & {
  stats(): Promise<RoomStats>;
};

type LiveRoomRow = {
  id: string;
};

type OutcomeRow = {
  cleanup_job_id: string;
  room_digest: string;
  accepted_count: number;
  reject_count: number;
  rate_limited_count: number;
  short_mute_count: number;
  abuse_disconnect_count: number;
};

export type RateAbuseMetricsCapture = {
  readonly schema: "koge.rate-abuse-metrics-capture.v1";
  readonly environment: string;
  readonly capturedAt: number;
  readonly retentionDays: 30;
  readonly liveRooms: readonly ({
    readonly roomDigest: string;
  } & RateAbuseCounters)[];
  readonly outcomes: readonly ({
    readonly outcomeDigest: string;
    readonly roomDigest: string;
  } & RateAbuseCounters)[];
};

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_LIVE_ROOMS = 200;
const MAX_OUTCOMES = 1_000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function counters(stats: RateAbuseCounters): RateAbuseCounters {
  return {
    acceptedCount: stats.acceptedCount,
    rejectCount: stats.rejectCount,
    rateLimitedCount: stats.rateLimitedCount,
    shortMuteCount: stats.shortMuteCount,
    abuseDisconnectCount: stats.abuseDisconnectCount,
  };
}

export async function captureRateAbuseRoomOutcome(
  database: D1Database,
  cleanupJobId: string,
  roomId: string,
  stats: RateAbuseCounters,
  now = Date.now(),
): Promise<void> {
  await database.prepare(
    `INSERT INTO rate_abuse_room_outcomes (
       cleanup_job_id, room_digest, captured_at, accepted_count, reject_count,
       rate_limited_count, short_mute_count, abuse_disconnect_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cleanup_job_id) DO NOTHING`,
  ).bind(
    cleanupJobId,
    await sha256Hex(roomId),
    now,
    stats.acceptedCount,
    stats.rejectCount,
    stats.rateLimitedCount,
    stats.shortMuteCount,
    stats.abuseDisconnectCount,
  ).run();
}

export async function deleteExpiredRateAbuseOutcomes(
  database: D1Database,
  now = Date.now(),
): Promise<number> {
  const result = await database.prepare(
    "DELETE FROM rate_abuse_room_outcomes WHERE captured_at < ?",
  ).bind(now - RETENTION_MS).run();
  return result.meta.changes;
}

export async function collectRateAbuseMetrics(
  env: Env,
  now = Date.now(),
): Promise<RateAbuseMetricsCapture> {
  const liveRows = await env.DB.prepare(
    `SELECT id
     FROM rooms room
     WHERE room.status IN ('waiting', 'active', 'idle', 'suspended', 'closing')
       AND NOT EXISTS (
         SELECT 1 FROM rate_abuse_room_outcomes outcome
         WHERE outcome.cleanup_job_id = room.cleanup_job_id
       )
     ORDER BY room.created_at, room.id
     LIMIT ?`,
  ).bind(MAX_LIVE_ROOMS + 1).all<LiveRoomRow>();
  if (liveRows.results.length > MAX_LIVE_ROOMS) {
    throw new Error("rate abuse live room collection limit exceeded");
  }
  const outcomeRows = await env.DB.prepare(
    `SELECT cleanup_job_id, room_digest, accepted_count, reject_count,
            rate_limited_count, short_mute_count, abuse_disconnect_count
     FROM rate_abuse_room_outcomes
     WHERE captured_at >= ?
     ORDER BY captured_at, cleanup_job_id
     LIMIT ?`,
  ).bind(now - RETENTION_MS, MAX_OUTCOMES + 1).all<OutcomeRow>();
  if (outcomeRows.results.length > MAX_OUTCOMES) {
    throw new Error("rate abuse outcome collection limit exceeded");
  }

  const rooms = env.DRAWING_ROOM as DurableObjectNamespace<MetricsRoomTarget>;
  const liveRooms: RateAbuseMetricsCapture["liveRooms"][number][] = [];
  for (const row of liveRows.results) {
    const room = rooms.getByName(row.id, { locationHint: "apac-ne" });
    // oxlint-disable-next-line no-await-in-loop -- bounded to avoid RPC fan-out.
    const stats = await room.stats();
    // oxlint-disable-next-line no-await-in-loop -- digest follows the same room.
    const roomDigest = await sha256Hex(row.id);
    liveRooms.push({ roomDigest, ...counters(stats) });
  }
  const outcomes = await Promise.all(outcomeRows.results.map(async (row) => ({
    outcomeDigest: await sha256Hex(row.cleanup_job_id),
    roomDigest: row.room_digest,
    acceptedCount: row.accepted_count,
    rejectCount: row.reject_count,
    rateLimitedCount: row.rate_limited_count,
    shortMuteCount: row.short_mute_count,
    abuseDisconnectCount: row.abuse_disconnect_count,
  })));
  return {
    schema: "koge.rate-abuse-metrics-capture.v1",
    environment: env.APP_ENV,
    capturedAt: now,
    retentionDays: 30,
    liveRooms,
    outcomes,
  };
}
