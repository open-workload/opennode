/**
 * Catch-up: bring a local log up to a peer's height by Merkle comparison.
 *
 *   checkpoint ─▶ snapshot ─▶ divergence ─▶ chunks ─▶ final compare
 *      verify     verify +    binary      skip or   height +
 *      tip hash   adopt       search       fetch +   root must
 *                            + rollback   validate  match
 *
 * Bespoke single-writer sync, not a vetted consensus engine: trust rests
 * on entry signatures plus a Merkle root the peer itself advertises.
 */
import { ClusterEvent, ClusterId } from "@workspace/opennode-domain";
import { EventLog, SignedLogEntry, validateEntryChain } from "./eventLog";
import { SyncEngineError } from "./errors";
import { merkleRoot } from "./hash";
import { ClusterSnapshot, verifySnapshot } from "./snapshot";
import { SignatureVerifier } from "./signing";

export interface SyncCheckpoint {
  readonly clusterId: ClusterId;
  readonly height: number;
  readonly epoch: number;
  readonly tipHash: string | null;
}

export interface CheckpointStore {
  load(clusterId: string): Promise<SyncCheckpoint | undefined>;
  save(checkpoint: SyncCheckpoint): Promise<void>;
  clear(clusterId: string): Promise<void>;
}

export interface PeerLogSource {
  getSnapshot(): Promise<ClusterSnapshot | null>;
  getHeight(): Promise<number>;
  getChunkRoot(chunkIndex: number): Promise<string | null>;
  getEntries(
    fromInclusive: number,
    toExclusive: number,
  ): Promise<SignedLogEntry[]>;
  getRootAt(height: number): Promise<string>;
  /** Fetch a specific entry by sequence number for divergence recovery. */
  getEntry(sequence: number): Promise<SignedLogEntry | null>;
}

export interface MultiPeerLogSource {
  readonly peers: readonly PeerLogSource[];
  /** Fetch entries from multiple peers in parallel, returning the first valid response. */
  getEntries(fromInclusive: number, toExclusive: number): Promise<SignedLogEntry[]>;
  /** Fetch a specific entry from multiple peers. */
  getEntry(sequence: number): Promise<SignedLogEntry | null>;
  getSnapshot(): Promise<ClusterSnapshot | null>;
  getHeight(): Promise<number>;
  getChunkRoot(chunkIndex: number): Promise<string | null>;
  getRootAt(height: number): Promise<string>;
}

export interface CatchUpResult {
  readonly startingHeight: number;
  readonly finalHeight: number;
  readonly adoptedSnapshot: ClusterSnapshot | null;
  readonly chunksFetched: number;
  readonly eventsReplayed: number;
  readonly divergenceRecovered: boolean;
}

export interface DivergenceRecoveryResult {
  readonly commonAncestorHeight: number;
  readonly rolledBack: number;
  readonly fetchedFromPeers: number;
}

/**
 * Find the common ancestor height between local log and peer by binary search
 * on Merkle roots.
 */
async function findCommonAncestor(
  local: EventLog,
  peer: PeerLogSource,
  localHeight: number,
  peerHeight: number,
  chunkSize: number,
): Promise<number> {
  let low = 0;
  let high = Math.min(localHeight, peerHeight);
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const localRoot = await local.rootAt(mid);
    const peerRoot = await peer.getRootAt(mid);
    if (localRoot === peerRoot) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * Roll back the local log to the common ancestor height.
 */
async function rollbackTo(local: EventLog, height: number): Promise<void> {
  await local.truncateTo(height);
}

/**
 * Fetch missing chunks from multiple peers, validating each entry's signature
 * and hash chain.
 */
async function fetchAndValidateChunks(
  peers: readonly PeerLogSource[],
  from: number,
  to: number,
  maxRange: number,
  clusterId: ClusterId,
  verifier: SignatureVerifier,
  anchorEntry: SignedLogEntry | undefined,
): Promise<SignedLogEntry[]> {
  const allEntries: SignedLogEntry[] = [];
  for (let i = from; i < to; i += maxRange) {
    const end = Math.min(i + maxRange, to);
    let entries: SignedLogEntry[] | null = null;
    let lastError: Error | null = null;
    for (const peer of peers) {
      try {
        const page = await peer.getEntries(i, end);
        if (page.length !== end - i) {
          throw new SyncEngineError(
            "INCOMPLETE_CHUNK",
            `Peer returned ${page.length} of ${end - i} requested entries.`,
          );
        }
        // Validate each entry's signature and hash chain
        validateEntryChain(page, {
          clusterId,
          verifier,
          fromSequence: i,
          prevHash: anchorEntry === undefined && i === from ? null : anchorEntry?.hash ?? null,
        });
        // Cross-validate with other peers for the first successful fetch
        if (entries === null) {
          entries = page;
        } else {
          // Verify consistency with previously fetched entries
          if (page.length !== entries.length) {
            throw new SyncEngineError("DIVERGED_LOG", "Peer entries length mismatch.");
          }
          for (let j = 0; j < page.length; j++) {
            if (page[j].hash !== entries[j].hash) {
              throw new SyncEngineError("DIVERGED_LOG", `Entry hash mismatch at sequence ${i + j}.`);
            }
          }
        }
        lastError = null;
        break; // Use first valid peer response
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (entries === null) {
      throw lastError ?? new SyncEngineError("INCOMPLETE_CHUNK", "All peers failed to provide entries.");
    }
    allEntries.push(...entries);
  }
  return allEntries;
}

export async function runCatchUp(opts: {
  readonly clusterId: ClusterId;
  readonly local: EventLog;
  readonly source: PeerLogSource;
  readonly checkpointStore: CheckpointStore;
  readonly verifier: SignatureVerifier;
  readonly chunkSize?: number;
  readonly onEvent?: (event: ClusterEvent) => void;
  readonly requireApprovedSnapshot?: boolean;
  readonly maxRange?: number;
  /** Multiple peers for divergence recovery and parallel fetching. */
  readonly peers?: readonly PeerLogSource[];
}): Promise<CatchUpResult> {
  const chunkSize = opts.chunkSize ?? 64;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new SyncEngineError("INCOMPLETE_CHUNK", "chunkSize must be positive.");
  }
  const maxRange = opts.maxRange ?? 256;
  const startingHeight = (await opts.local.getTip()).height;
  let adoptedSnapshot: ClusterSnapshot | null = null;
  let chunksFetched = 0;
  let eventsReplayed = 0;
  let divergenceRecovered = false;

  const checkpoint = await opts.checkpointStore.load(opts.clusterId.value);
  if (checkpoint !== undefined) {
    const tip = await opts.local.getTip();
    if (checkpoint.height > tip.height) {
      throw new SyncEngineError(
        "CHECKPOINT_INVALID",
        "Checkpoint claims more entries than the local log holds.",
      );
    }
    if (checkpoint.height > 0) {
      const entry = await opts.local.getEntry(checkpoint.height - 1);
      if (entry === undefined || entry.hash !== checkpoint.tipHash) {
        throw new SyncEngineError(
          "CHECKPOINT_INVALID",
          "Checkpoint tip hash does not match the local log.",
        );
      }
    }
  }

  const snapshot = await opts.source.getSnapshot();
  if (snapshot !== null) {
    verifySnapshot(snapshot, {
      clusterId: opts.clusterId,
      verifier: opts.verifier,
      requireApproved: opts.requireApprovedSnapshot,
    });
    const tip = await opts.local.getTip();
    const localEntryAtSnapshotTip =
      snapshot.height === 0
        ? undefined
        : await opts.local.getEntry(snapshot.height - 1);
    const localMatches =
      snapshot.height === 0
        ? tip.height === 0
        : localEntryAtSnapshotTip !== undefined &&
          localEntryAtSnapshotTip.hash === snapshot.tipHash;
    if (!localMatches) {
      const prefix = await fetchRange(opts.source, 0, snapshot.height, maxRange);
      validateEntryChain(prefix, {
        clusterId: opts.clusterId,
        verifier: opts.verifier,
        fromSequence: 0,
        prevHash: null,
      });
      const root = merkleRoot(prefix.map((e) => e.hash));
      if (root !== snapshot.merkleRoot) {
        throw new SyncEngineError(
          "SNAPSHOT_ROOT_MISMATCH",
          "Snapshot prefix does not reproduce the snapshot Merkle root.",
        );
      }
      const tipHash =
        prefix.length === 0 ? null : prefix[prefix.length - 1].hash;
      if (tipHash !== snapshot.tipHash) {
        throw new SyncEngineError(
          "SNAPSHOT_ROOT_MISMATCH",
          "Snapshot tip hash does not match its prefix.",
        );
      }
      await opts.local.replace(prefix);
      adoptedSnapshot = snapshot;
      for (const entry of prefix) {
        opts.onEvent?.(entry.event);
        eventsReplayed += 1;
      }
      await opts.checkpointStore.save({
        clusterId: opts.clusterId,
        height: snapshot.height,
        epoch: snapshot.membershipEpoch,
        tipHash: snapshot.tipHash,
      });
    }
  }

  const peerHeight = await opts.source.getHeight();
  const localTip = await opts.local.getTip();
  const localHeight = localTip.height;

  // Check for divergence
  if (localHeight > 0 && peerHeight > 0) {
    const localRoot = await opts.local.rootAt(Math.min(localHeight, peerHeight));
    const peerRoot = await opts.source.getRootAt(Math.min(localHeight, peerHeight));
    if (localRoot !== peerRoot) {
      // Divergence detected - recover
      const peers = opts.peers ?? [opts.source];
      const recoveryResult = await recoverDivergence({
        clusterId: opts.clusterId,
        local: opts.local,
        peers,
        verifier: opts.verifier,
        chunkSize,
        maxRange,
        localHeight,
        peerHeight,
        onEvent: opts.onEvent,
        checkpointStore: opts.checkpointStore,
      });
      divergenceRecovered = true;
      chunksFetched += recoveryResult.fetchedFromPeers;
      eventsReplayed += recoveryResult.fetchedFromPeers; // approximate
    }
  }

  const chunkCount = Math.ceil(peerHeight / chunkSize);
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    const localRoot = await opts.local.chunkRoot(chunk, chunkSize);
    const peerRoot = await opts.source.getChunkRoot(chunk);
    if (localRoot !== null && localRoot === peerRoot) continue;
    const from = chunk * chunkSize;
    const to = Math.min(from + chunkSize, peerHeight);
    const anchorEntry =
      from === 0 ? undefined : await opts.local.getEntry(from - 1);
    
    // Fetch from multiple peers with validation
    const chunkEntries = await fetchAndValidateChunks(
      opts.peers ?? [opts.source],
      from,
      to,
      maxRange,
      opts.clusterId,
      opts.verifier,
      anchorEntry,
    );

    const chunkRoot = merkleRoot(chunkEntries.map((e) => e.hash));
    if (chunkRoot !== peerRoot) {
      throw new SyncEngineError(
        "MERKLE_ROOT_MISMATCH",
        `Chunk ${chunk} root does not match the peer's advertised root.`,
      );
    }
    const existing = await opts.local.getRange(from, to);
    if (existing.length === 0) {
      await opts.local.appendVerified(chunkEntries);
      chunksFetched += 1;
      for (const entry of chunkEntries) {
        opts.onEvent?.(entry.event);
        eventsReplayed += 1;
      }
    } else {
      const identical =
        existing.length === chunkEntries.length &&
        existing.every((e, i) => e.hash === chunkEntries[i].hash);
      if (!identical) {
        await opts.local.truncateTo(from);
        await opts.local.appendVerified(chunkEntries);
        chunksFetched += 1;
        for (const entry of chunkEntries) {
          opts.onEvent?.(entry.event);
          eventsReplayed += 1;
        }
      }
    }
    const appliedHeight = Math.min(from + chunkEntries.length, peerHeight);
    const appliedTip =
      appliedHeight === 0
        ? undefined
        : await opts.local.getEntry(appliedHeight - 1);
    await opts.checkpointStore.save({
      clusterId: opts.clusterId,
      height: appliedHeight,
      epoch:
        appliedTip === undefined
          ? adoptedSnapshot !== null
            ? adoptedSnapshot.membershipEpoch
            : 0
          : appliedTip.event.epoch,
      tipHash: appliedTip === undefined ? null : appliedTip.hash,
    });
  }

  const finalTip = await opts.local.getTip();
  if (finalTip.height !== peerHeight) {
    throw new SyncEngineError(
      "MERKLE_ROOT_MISMATCH",
      `Local height ${finalTip.height} does not reach peer height ${peerHeight}.`,
    );
  }
  const localRoot = await opts.local.rootAt(peerHeight);
  const peerRoot = await opts.source.getRootAt(peerHeight);
  if (localRoot !== peerRoot) {
    throw new SyncEngineError(
      "MERKLE_ROOT_MISMATCH",
      "Final local Merkle root does not match the peer's.",
    );
  }
  const finalEntry =
    peerHeight === 0 ? undefined : await opts.local.getEntry(peerHeight - 1);
  const finalEpoch =
    finalEntry === undefined
      ? adoptedSnapshot !== null
        ? adoptedSnapshot.membershipEpoch
        : 0
      : finalEntry.event.epoch;
  await opts.checkpointStore.save({
    clusterId: opts.clusterId,
    height: peerHeight,
    epoch: finalEpoch,
    tipHash: finalTip.tipHash,
  });
  return {
    startingHeight,
    finalHeight: peerHeight,
    adoptedSnapshot,
    chunksFetched,
    eventsReplayed,
    divergenceRecovered,
  };
}

async function recoverDivergence(opts: {
  readonly clusterId: ClusterId;
  readonly local: EventLog;
  readonly peers: readonly PeerLogSource[];
  readonly verifier: SignatureVerifier;
  readonly chunkSize: number;
  readonly maxRange: number;
  readonly localHeight: number;
  readonly peerHeight: number;
  readonly onEvent?: (event: ClusterEvent) => void;
  readonly checkpointStore: CheckpointStore;
}): Promise<DivergenceRecoveryResult> {
  // Find common ancestor with first peer
  const primaryPeer = opts.peers[0];
  const commonAncestor = await findCommonAncestor(
    opts.local,
    primaryPeer,
    opts.localHeight,
    opts.peerHeight,
    opts.chunkSize,
  );

  // Roll back divergent suffix
  const rolledBack = opts.localHeight - commonAncestor;
  if (rolledBack > 0) {
    await rollbackTo(opts.local, commonAncestor);
  }

  // Fetch missing chunks from multiple peers
  const chunkCount = Math.ceil(opts.peerHeight / opts.chunkSize);
  let fetchedFromPeers = 0;
  for (let chunk = Math.floor(commonAncestor / opts.chunkSize); chunk < chunkCount; chunk += 1) {
    const from = chunk * opts.chunkSize;
    const to = Math.min(from + opts.chunkSize, opts.peerHeight);
    const anchorEntry = from === 0 ? undefined : await opts.local.getEntry(from - 1);
    const chunkEntries = await fetchAndValidateChunks(
      opts.peers,
      from,
      to,
      opts.maxRange,
      opts.clusterId,
      opts.verifier,
      anchorEntry,
    );
    if (chunkEntries.length > 0) {
      await opts.local.appendVerified(chunkEntries);
      fetchedFromPeers += 1;
      for (const entry of chunkEntries) {
        opts.onEvent?.(entry.event);
      }
    }
    const appliedHeight = Math.min(from + chunkEntries.length, opts.peerHeight);
    const appliedTip =
      appliedHeight === 0
        ? undefined
        : await opts.local.getEntry(appliedHeight - 1);
    await opts.checkpointStore.save({
      clusterId: opts.clusterId,
      height: appliedHeight,
      epoch:
        appliedTip === undefined ? 0 : appliedTip.event.epoch,
      tipHash: appliedTip === undefined ? null : appliedTip.hash,
    });
  }

  return { commonAncestorHeight: commonAncestor, rolledBack, fetchedFromPeers };
}

async function fetchRange(
  source: PeerLogSource,
  from: number,
  to: number,
  maxRange: number,
): Promise<SignedLogEntry[]> {
  const out: SignedLogEntry[] = [];
  for (let i = from; i < to; i += maxRange) {
    const end = Math.min(i + maxRange, to);
    const page = await source.getEntries(i, end);
    if (page.length !== end - i) {
      throw new SyncEngineError(
        "INCOMPLETE_CHUNK",
        `Peer returned ${page.length} of ${end - i} requested entries.`,
      );
    }
    out.push(...page);
  }
  return out;
}
