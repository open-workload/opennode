export type ReplicationStrategy = "eager" | "lazy" | "manual";
export type RetentionPolicy = "ttl" | "count" | "size" | "none";

export interface ReplicationMetadata {
  readonly strategy: ReplicationStrategy;
  readonly targetReplicas: number;
  readonly currentReplicas: readonly ReplicaInfo[];
  readonly quorumRequired: number;
  readonly lastSync: number | null;
}

export interface ReplicaInfo {
  readonly nodeId: string;
  readonly address: string;
  readonly status: "healthy" | "degraded" | "offline";
  readonly lastSeen: number;
  readonly lag: number;
}

export interface RetentionMetadata {
  readonly policy: RetentionPolicy;
  readonly ttlMs?: number;
  readonly maxCount?: number;
  readonly maxSizeBytes?: number;
  readonly createdAt: number;
  readonly lastAccessed: number;
  readonly accessCount: number;
}

export interface ChunkMetadata {
  readonly replication: ReplicationMetadata;
  readonly retention: RetentionMetadata;
  readonly tags: readonly string[];
  readonly owner: string;
  readonly classification: "public" | "internal" | "confidential" | "restricted";
}

export interface MetadataStore {
  get(address: string): Promise<ChunkMetadata | undefined>;
  set(address: string, metadata: ChunkMetadata): Promise<void>;
  delete(address: string): Promise<void>;
  query(filter: MetadataQuery): Promise<ChunkMetadata[]>;
}

export interface MetadataQuery {
  readonly owner?: string;
  readonly classification?: ChunkMetadata["classification"];
  readonly tags?: readonly string[];
  readonly replicationStrategy?: ReplicationStrategy;
  readonly retentionPolicy?: RetentionPolicy;
  readonly olderThan?: number;
  readonly accessedBefore?: number;
}

export function createDefaultReplicationMetadata(
  strategy: ReplicationStrategy = "lazy",
  targetReplicas: number = 3,
): ReplicationMetadata {
  return Object.freeze({
    strategy,
    targetReplicas,
    currentReplicas: Object.freeze([]),
    quorumRequired: Math.floor(targetReplicas / 2) + 1,
    lastSync: null,
  });
}

export function createDefaultRetentionMetadata(
  policy: RetentionPolicy = "ttl",
  options: Partial<RetentionMetadata> = {},
): RetentionMetadata {
  const now = Date.now();
  return Object.freeze({
    policy,
    ttlMs: options.ttlMs ?? 30 * 24 * 60 * 60 * 1000,
    maxCount: options.maxCount,
    maxSizeBytes: options.maxSizeBytes,
    createdAt: now,
    lastAccessed: now,
    accessCount: 0,
  });
}

export function createChunkMetadata(
  owner: string,
  options: {
    readonly replication?: Partial<ReplicationMetadata>;
    readonly retention?: Partial<RetentionMetadata>;
    readonly tags?: readonly string[];
    readonly classification?: ChunkMetadata["classification"];
  } = {},
): ChunkMetadata {
  return Object.freeze({
    replication: createDefaultReplicationMetadata(
      options.replication?.strategy,
      options.replication?.targetReplicas,
    ),
    retention: createDefaultRetentionMetadata(
      options.retention?.policy,
      options.retention,
    ),
    tags: Object.freeze(options.tags ?? []),
    owner,
    classification: options.classification ?? "internal",
  });
}

export function updateReplicaStatus(
  metadata: ChunkMetadata,
  nodeId: string,
  status: ReplicaInfo["status"],
  lag: number = 0,
): ChunkMetadata {
  const existingIndex = metadata.replication.currentReplicas.findIndex((r) => r.nodeId === nodeId);
  const now = Date.now();

  let replicas: readonly ReplicaInfo[];
  if (existingIndex >= 0) {
    replicas = metadata.replication.currentReplicas.map((r, i) =>
      i === existingIndex
        ? Object.freeze({ ...r, status, lastSeen: now, lag })
        : r,
    );
  } else {
    replicas = Object.freeze([
      ...metadata.replication.currentReplicas,
      Object.freeze({
        nodeId,
        address: "",
        status,
        lastSeen: now,
        lag,
      }),
    ]);
  }

  return Object.freeze({
    ...metadata,
    replication: Object.freeze({
      ...metadata.replication,
      currentReplicas: replicas,
      lastSync: now,
    }),
  });
}

export function incrementAccess(metadata: ChunkMetadata): ChunkMetadata {
  return Object.freeze({
    ...metadata,
    retention: Object.freeze({
      ...metadata.retention,
      lastAccessed: Date.now(),
      accessCount: metadata.retention.accessCount + 1,
    }),
  });
}

export function isRetentionExpired(metadata: ChunkMetadata): boolean {
  const { policy } = metadata.retention;
  const now = Date.now();

  switch (policy) {
    case "ttl":
      return metadata.retention.ttlMs !== undefined &&
        now - metadata.retention.createdAt > metadata.retention.ttlMs;
    case "count":
      return metadata.retention.maxCount !== undefined &&
        metadata.retention.accessCount > metadata.retention.maxCount;
    case "size":
      return false;
    case "none":
      return false;
  }
}

export function replicationQuorumMet(metadata: ChunkMetadata): boolean {
  const healthy = metadata.replication.currentReplicas.filter(
    (r) => r.status === "healthy",
  ).length;
  return healthy >= metadata.replication.quorumRequired;
}

export function encodeMetadata(metadata: ChunkMetadata): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata));
}

export function decodeMetadata(data: Uint8Array): ChunkMetadata {
  return JSON.parse(new TextDecoder().decode(data)) as ChunkMetadata;
}