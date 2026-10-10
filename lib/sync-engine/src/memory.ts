/**
 * In-memory test doubles for the sync engine's stores and peer source.
 *
 *   entries ──▶ EventLogStore ──▶ EventLog read/write during catch-up
 *   checkpoint ─▶ CheckpointStore ─▶ resume position per cluster
 *   entries ──▶ PeerLogSource ──▶ roots, chunks, prefix, single entry
 *
 * Not durable and not shared across processes: each factory closes over
 * a fresh array or Map. assertValidPrefix revalidates a chain from zero.
 */
import { merkleRoot } from "./hash";
import { SignedLogEntry, EventLogStore, validateEntryChain } from "./eventLog";
import { ClusterId } from "@workspace/opennode-domain";
import { SignatureVerifier } from "./signing";
import { CheckpointStore, PeerLogSource, SyncCheckpoint } from "./catchup";
import { SyncEngineError } from "./errors";
import { ClusterSnapshot } from "./snapshot";

export function createInMemoryEventLogStore(): EventLogStore {
  let entries: SignedLogEntry[] = [];
  return {
    async getHeight() {
      return entries.length;
    },
    async getEntry(sequence) {
      return entries[sequence];
    },
    async getRange(fromInclusive, toExclusive) {
      return entries.slice(fromInclusive, toExclusive);
    },
    async append(newEntries) {
      entries = entries.concat([...newEntries]);
    },
    async truncateTo(height) {
      entries = entries.slice(0, height);
    },
    async replace(newEntries) {
      entries = [...newEntries];
    },
  };
}

export function createInMemoryCheckpointStore(): CheckpointStore {
  const map = new Map<string, SyncCheckpoint>();
  return {
    async load(clusterIdValue) {
      return map.get(clusterIdValue);
    },
    async save(checkpoint) {
      map.set(checkpoint.clusterId.value, checkpoint);
    },
    async clear(clusterIdValue) {
      map.delete(clusterIdValue);
    },
  };
}

export function createInMemoryPeerLogSource(input: {
  readonly clusterId: ClusterId;
  readonly entries: readonly SignedLogEntry[];
  readonly snapshot: ClusterSnapshot | null;
  readonly chunkSize: number;
}): PeerLogSource {
  const entries = [...input.entries];
  const chunkSize = input.chunkSize;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new SyncEngineError("INCOMPLETE_CHUNK", "chunkSize must be positive.");
  }
  return {
    async getSnapshot() {
      return input.snapshot;
    },
    async getHeight() {
      return entries.length;
    },
    async getChunkRoot(chunkIndex) {
      const from = chunkIndex * chunkSize;
      const to = from + chunkSize;
      const slice = entries.slice(from, to);
      if (slice.length === 0) return null;
      return merkleRoot(slice.map((e) => e.hash));
    },
    async getEntries(fromInclusive, toExclusive) {
      return entries.slice(fromInclusive, toExclusive);
    },
    async getRootAt(height) {
      return merkleRoot(entries.slice(0, height).map((e) => e.hash));
    },
    async getEntry(sequence) {
      return entries[sequence] ?? null;
    },
  };
}

export function assertValidPrefix(
  entries: readonly SignedLogEntry[],
  clusterId: ClusterId,
  verifier: SignatureVerifier,
): void {
  validateEntryChain(entries, {
    clusterId,
    verifier,
    fromSequence: 0,
    prevHash: null,
  });
}
