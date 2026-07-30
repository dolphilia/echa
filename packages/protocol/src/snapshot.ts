import { PROTOCOL_VERSION, type AcceptedStrokeEvent } from "./types";

export const SNAPSHOT_JOB_VERSION = 1 as const;
export const SNAPSHOT_RENDERER_VERSION = 1 as const;
export const SNAPSHOT_CODEC = "koge-rgba-deflate-v1" as const;
export const SNAPSHOT_EVENT_CHUNK_LIMIT = 500 as const;
export const SNAPSHOT_CANVAS_GENERATION = 2 as const;

export type SnapshotJob = {
  readonly v: typeof SNAPSHOT_JOB_VERSION;
  readonly jobId: string;
  readonly roomId: string;
  readonly targetRoomSeq: number;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly rendererVersion: typeof SNAPSHOT_RENDERER_VERSION;
  readonly canvasGeneration: typeof SNAPSHOT_CANVAS_GENERATION;
  readonly generation: number;
  readonly requestedAt: number;
  /**
   * Immutable input selected when the job is created. Missing is accepted only
   * for version-1 jobs created before incremental generation and means a full
   * replay from room sequence zero.
   */
  readonly sourceSnapshotJobId?: string;
  readonly sourceBaseRoomSeq?: number;
};

export type SnapshotEventChunk = {
  readonly job: SnapshotJob;
  readonly events: readonly AcceptedStrokeEvent[];
  readonly nextAfterRoomSeq: number;
  readonly done: boolean;
};

export type SnapshotManifest = {
  readonly v: typeof SNAPSHOT_JOB_VERSION;
  readonly jobId: string;
  readonly roomId: string;
  readonly baseRoomSeq: number;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly rendererVersion: typeof SNAPSHOT_RENDERER_VERSION;
  readonly canvasGeneration: typeof SNAPSHOT_CANVAS_GENERATION;
  readonly generation: number;
  readonly codec: typeof SNAPSHOT_CODEC;
  readonly width: number;
  readonly height: number;
  readonly objectKey: string;
  readonly objectBytes: number;
  readonly objectHash: string;
  readonly rgbaHash: string;
  readonly createdAt: number;
};

export type PublicSnapshotManifest = Omit<SnapshotManifest, "objectKey">;

export type SnapshotReadGrant = {
  readonly manifest: SnapshotManifest;
  readonly expiresAt: number;
};

export type SnapshotCommitResult = {
  readonly status: "committed" | "already_committed" | "superseded";
  readonly manifest?: SnapshotManifest;
};

export type SnapshotCompactionMode = "shadow" | "snapshot_compacted";

export type SnapshotCompactionState = {
  readonly mode: SnapshotCompactionMode;
  readonly compactedThroughRoomSeq: number;
  readonly currentJobId?: string;
  readonly currentBaseRoomSeq?: number;
  readonly previousJobId?: string;
  readonly previousBaseRoomSeq?: number;
  readonly safeThroughRoomSeq: number;
  readonly blockedByQueuedJobId?: string;
};

export type SnapshotCompactionChunk = SnapshotCompactionState & {
  readonly status:
    | "compacted"
    | "blocked"
    | "not_ready"
    | "stale"
    | "room_closing";
  readonly deletedEventCount: number;
  readonly done: boolean;
};

export interface SnapshotRoomRpc {
  snapshotSource(jobId: string): Promise<SnapshotManifest | undefined>;
  snapshotEvents(
    jobId: string,
    afterRoomSeq: number,
    limit?: number,
  ): Promise<SnapshotEventChunk>;
  commitSnapshot(manifest: SnapshotManifest): Promise<SnapshotCommitResult>;
}

export interface SnapshotObjectInventoryRoomRpc {
  runtimeSnapshotObjectKeys(roomId: string): Promise<readonly string[]>;
}
