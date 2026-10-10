/**
 * Hash-chained, signed event log, plus the store interface behind it.
 *
 *   ClusterEvent ──▶ entryHash ──▶ signer ──▶ SignedLogEntry ──▶ store
 *                        ▲                          │
 *                        └────── prevHash ◀─────────┘
 *
 *   validateEntry re-checks schema, cluster, sequence, prevHash, epoch,
 *   the recomputed hash and the signature. Nothing is appended that has
 *   not already passed all seven.
 */
import {
  ClusterEvent,
  ClusterId,
  SCHEMA_VERSION,
} from "@workspace/opennode-domain";
import { SyncEngineError } from "./errors";
import { merkleRoot, sha256Hex, stableStringify } from "./hash";
import { Signer, SignatureVerifier } from "./signing";

export interface SignedLogEntry<TPayload = unknown> {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly event: ClusterEvent<TPayload>;
  readonly prevHash: string | null;
  readonly hash: string;
  readonly signerId: string;
  readonly signature: string;
}

export function entryHash(
  event: ClusterEvent,
  prevHash: string | null,
): string {
  return sha256Hex(
    stableStringify({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      clusterId: event.clusterId,
      sequence: event.sequence,
      epoch: event.epoch,
      kind: event.kind,
      correlationId: event.correlationId,
      payload: event.payload,
      prevHash,
    }),
  );
}

export function signEntry(
  event: ClusterEvent,
  prevHash: string | null,
  signer: Signer,
): SignedLogEntry {
  const hash = entryHash(event, prevHash);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    event,
    prevHash,
    hash,
    signerId: signer.signerId,
    signature: signer.sign(hash),
  });
}

export interface EntryContext {
  readonly clusterId: ClusterId;
  readonly verifier: SignatureVerifier;
  readonly expectedSequence: number;
  readonly expectedPrevHash: string | null;
  readonly previousEpoch: number | null;
}

export function validateEntry(
  entry: SignedLogEntry,
  ctx: EntryContext,
): void {
  if (entry.schemaVersion !== SCHEMA_VERSION) {
    throw new SyncEngineError(
      "SCHEMA_VERSION_MISMATCH",
      `Entry schema version ${String(entry.schemaVersion)} is not supported.`,
    );
  }
  if (entry.event.schemaVersion !== SCHEMA_VERSION) {
    throw new SyncEngineError(
      "SCHEMA_VERSION_MISMATCH",
      `Event schema version ${String(entry.event.schemaVersion)} is not supported.`,
    );
  }
  if (entry.event.clusterId.value !== ctx.clusterId.value) {
    throw new SyncEngineError(
      "WRONG_CLUSTER",
      "Entry event belongs to a different cluster.",
    );
  }
  if (entry.event.sequence !== ctx.expectedSequence) {
    throw new SyncEngineError(
      "SEQUENCE_GAP",
      `Expected sequence ${ctx.expectedSequence}, got ${entry.event.sequence}.`,
    );
  }
  if (entry.prevHash !== ctx.expectedPrevHash) {
    throw new SyncEngineError(
      "BROKEN_HASH_LINK",
      "Entry prevHash does not match the previous entry hash.",
    );
  }
  if (ctx.previousEpoch !== null && entry.event.epoch < ctx.previousEpoch) {
    throw new SyncEngineError(
      "EPOCH_REGRESSION",
      `Epoch regressed from ${ctx.previousEpoch} to ${entry.event.epoch}.`,
    );
  }
  const expectedHash = entryHash(entry.event, entry.prevHash);
  if (expectedHash !== entry.hash) {
    throw new SyncEngineError(
      "BROKEN_HASH_LINK",
      "Entry hash does not match its canonical payload.",
    );
  }
  if (!ctx.verifier.verify(entry.signerId, entry.hash, entry.signature)) {
    throw new SyncEngineError(
      "SIGNATURE_INVALID",
      `Entry signature from ${entry.signerId} does not verify.`,
    );
  }
}

export interface ChainContext {
  readonly clusterId: ClusterId;
  readonly verifier: SignatureVerifier;
  readonly fromSequence: number;
  readonly prevHash: string | null;
}

export function validateEntryChain(
  entries: readonly SignedLogEntry[],
  ctx: ChainContext,
): void {
  let expectedSequence = ctx.fromSequence;
  let expectedPrevHash = ctx.prevHash;
  let previousEpoch: number | null = null;
  for (const entry of entries) {
    validateEntry(entry, {
      clusterId: ctx.clusterId,
      verifier: ctx.verifier,
      expectedSequence,
      expectedPrevHash,
      previousEpoch,
    });
    expectedSequence += 1;
    expectedPrevHash = entry.hash;
    previousEpoch = entry.event.epoch;
  }
}

export interface EventLogStore {
  getHeight(): Promise<number>;
  getEntry(sequence: number): Promise<SignedLogEntry | undefined>;
  getRange(
    fromInclusive: number,
    toExclusive: number,
  ): Promise<SignedLogEntry[]>;
  append(entries: readonly SignedLogEntry[]): Promise<void>;
  truncateTo(height: number): Promise<void>;
  replace(entries: readonly SignedLogEntry[]): Promise<void>;
}

export class EventLog {
  constructor(
    private readonly store: EventLogStore,
    private readonly clusterId: ClusterId,
    private readonly verifier: SignatureVerifier,
  ) {}

  async getHeight(): Promise<number> {
    return this.store.getHeight();
  }

  async getEntry(sequence: number): Promise<SignedLogEntry | undefined> {
    return this.store.getEntry(sequence);
  }

  async getRange(
    fromInclusive: number,
    toExclusive: number,
  ): Promise<SignedLogEntry[]> {
    return this.store.getRange(fromInclusive, toExclusive);
  }

  async getTip(): Promise<{ height: number; tipHash: string | null }> {
    const height = await this.store.getHeight();
    if (height === 0) return { height: 0, tipHash: null };
    const tip = await this.store.getEntry(height - 1);
    return { height, tipHash: tip === undefined ? null : tip.hash };
  }

  async entriesAfter(sequence: number): Promise<SignedLogEntry[]> {
    const height = await this.store.getHeight();
    return this.store.getRange(sequence, height);
  }

  async appendEvent(
    event: ClusterEvent,
    signer: Signer,
  ): Promise<SignedLogEntry> {
    const tip = await this.getTip();
    if (event.sequence !== tip.height) {
      throw new SyncEngineError(
        "SEQUENCE_GAP",
        `Cannot append event with sequence ${event.sequence} after height ${tip.height}.`,
      );
    }
    if (event.clusterId.value !== this.clusterId.value) {
      throw new SyncEngineError("WRONG_CLUSTER", "Event clusterId mismatch.");
    }
    const entry = signEntry(event, tip.tipHash, signer);
    validateEntry(entry, {
      clusterId: this.clusterId,
      verifier: this.verifier,
      expectedSequence: tip.height,
      expectedPrevHash: tip.tipHash,
      previousEpoch:
        tip.height === 0
          ? null
          : (await this.store.getEntry(tip.height - 1))?.event.epoch ?? null,
    });
    await this.store.append([entry]);
    return entry;
  }

  async appendVerified(entries: readonly SignedLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const tip = await this.getTip();
    const last =
      tip.height === 0 ? undefined : await this.store.getEntry(tip.height - 1);
    validateEntryChain(entries, {
      clusterId: this.clusterId,
      verifier: this.verifier,
      fromSequence: tip.height,
      prevHash: tip.tipHash,
    });
    const firstPrev = entries[0].prevHash;
    if (firstPrev !== tip.tipHash) {
      throw new SyncEngineError("BROKEN_HASH_LINK", "Entry chain starts off-tip.");
    }
    if (last !== undefined && entries[0].event.epoch < last.event.epoch) {
      throw new SyncEngineError("EPOCH_REGRESSION", "Appended epoch regressed.");
    }
    await this.store.append(entries);
  }

  async truncateTo(height: number): Promise<void> {
    await this.store.truncateTo(height);
  }

  async replace(entries: readonly SignedLogEntry[]): Promise<void> {
    validateEntryChain(entries, {
      clusterId: this.clusterId,
      verifier: this.verifier,
      fromSequence: 0,
      prevHash: null,
    });
    await this.store.replace(entries);
  }

  async rootAt(height: number): Promise<string> {
    const entries = await this.store.getRange(0, height);
    return merkleRoot(entries.map((e) => e.hash));
  }

  async chunkRoot(chunkIndex: number, chunkSize: number): Promise<string | null> {
    const from = chunkIndex * chunkSize;
    const to = from + chunkSize;
    const entries = await this.store.getRange(from, to);
    if (entries.length === 0) return null;
    return merkleRoot(entries.map((e) => e.hash));
  }
}
