import { metricsRegistry } from "@workspace/observability";
import { ListableChunkStore } from "./store";

export interface ChunkRetentionPolicy {
  readonly ttlMs: number;
}

export const DEFAULT_CHUNK_RETENTION_POLICY: ChunkRetentionPolicy = Object.freeze({
  ttlMs: 30 * 24 * 60 * 60 * 1000,
});

export interface PruneOptions {
  readonly policy?: ChunkRetentionPolicy;
  readonly now?: number;
}

export async function pruneExpiredChunks(
  chunkStore: ListableChunkStore,
  options: PruneOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const ttlMs = (options.policy ?? DEFAULT_CHUNK_RETENTION_POLICY).ttlMs;

  let deleted = 0;
  for (const chunk of await chunkStore.list()) {
    if (now - chunk.metadata.timestamp > ttlMs) {
      try {
        await chunkStore.delete(chunk.address);
        deleted += 1;
      } catch (error) {
        metricsRegistry.increment("content_store.orphan_cleanup_errors");
        throw error;
      }
    }
  }
  return deleted;
}
