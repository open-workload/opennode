/**
 * Signed cluster snapshots: a compacted, Merkle-rooted view of the log.
 *
 *   entry hashes ──▶ merkle root ──▶ snapshotId ──▶ signer ──▶ ClusterSnapshot
 *        │
 *   height and epoch must be non-negative safe integers, else SNAPSHOT_INVALID
 *
 *   verifySnapshot re-checks schema, cluster, approval and the signature
 *   over the same canonical payload; each failure throws.
 */
import {
  ClusterId,
  SCHEMA_VERSION,
} from "@workspace/opennode-domain";
import { SyncEngineError } from "./errors";
import { merkleRoot, sha256Hex, stableStringify } from "./hash";
import { Signer, SignatureVerifier } from "./signing";

export interface ClusterSnapshot {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly clusterId: ClusterId;
  readonly snapshotId: string;
  readonly membershipEpoch: number;
  readonly height: number;
  readonly tipHash: string | null;
  readonly merkleRoot: string;
  readonly approved: boolean;
  readonly signerId: string;
  readonly signature: string;
}

export function snapshotPayload(snapshot: {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly clusterId: ClusterId;
  readonly snapshotId: string;
  readonly membershipEpoch: number;
  readonly height: number;
  readonly tipHash: string | null;
  readonly merkleRoot: string;
  readonly approved: boolean;
}): string {
  return stableStringify({
    schemaVersion: snapshot.schemaVersion,
    clusterId: snapshot.clusterId,
    snapshotId: snapshot.snapshotId,
    membershipEpoch: snapshot.membershipEpoch,
    height: snapshot.height,
    tipHash: snapshot.tipHash,
    merkleRoot: snapshot.merkleRoot,
    approved: snapshot.approved,
  });
}

export function createClusterSnapshot(input: {
  readonly clusterId: ClusterId;
  readonly membershipEpoch: number;
  readonly height: number;
  readonly tipHash: string | null;
  readonly entryHashes: readonly string[];
  readonly approved: boolean;
  readonly signer: Signer;
}): ClusterSnapshot {
  if (!Number.isSafeInteger(input.height) || input.height < 0) {
    throw new SyncEngineError(
      "SNAPSHOT_INVALID",
      "Snapshot height must be a non-negative safe integer.",
    );
  }
  if (!Number.isSafeInteger(input.membershipEpoch) || input.membershipEpoch < 0) {
    throw new SyncEngineError(
      "SNAPSHOT_INVALID",
      "Snapshot membership epoch must be a non-negative safe integer.",
    );
  }
  const entryHashes = input.entryHashes.slice(0, input.height);
  const root = merkleRoot(entryHashes);
  const snapshotId = sha256Hex(
    stableStringify({
      schemaVersion: SCHEMA_VERSION,
      clusterId: input.clusterId,
      membershipEpoch: input.membershipEpoch,
      height: input.height,
      tipHash: input.tipHash,
      merkleRoot: root,
    }),
  );
  const payload = snapshotPayload({
    schemaVersion: SCHEMA_VERSION,
    clusterId: input.clusterId,
    snapshotId,
    membershipEpoch: input.membershipEpoch,
    height: input.height,
    tipHash: input.tipHash,
    merkleRoot: root,
    approved: input.approved,
  });
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    clusterId: input.clusterId,
    snapshotId,
    membershipEpoch: input.membershipEpoch,
    height: input.height,
    tipHash: input.tipHash,
    merkleRoot: root,
    approved: input.approved,
    signerId: input.signer.signerId,
    signature: input.signer.sign(payload),
  });
}

export function verifySnapshot(
  snapshot: ClusterSnapshot,
  opts: {
    readonly clusterId: ClusterId;
    readonly verifier: SignatureVerifier;
    readonly requireApproved?: boolean;
  },
): void {
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw new SyncEngineError(
      "SCHEMA_VERSION_MISMATCH",
      "Snapshot schema version is not supported.",
    );
  }
  if (snapshot.clusterId.value !== opts.clusterId.value) {
    throw new SyncEngineError(
      "WRONG_CLUSTER",
      "Snapshot belongs to a different cluster.",
    );
  }
  if (!Number.isSafeInteger(snapshot.height) || snapshot.height < 0) {
    throw new SyncEngineError(
      "SNAPSHOT_INVALID",
      "Snapshot height must be a non-negative safe integer.",
    );
  }
  if (
    !Number.isSafeInteger(snapshot.membershipEpoch) ||
    snapshot.membershipEpoch < 0
  ) {
    throw new SyncEngineError(
      "SNAPSHOT_INVALID",
      "Snapshot membership epoch must be a non-negative safe integer.",
    );
  }
  if (opts.requireApproved !== false && snapshot.approved !== true) {
    throw new SyncEngineError(
      "SNAPSHOT_UNAPPROVED",
      "Snapshot is not marked approved by consensus.",
    );
  }
  const payload = snapshotPayload(snapshot);
  if (!opts.verifier.verify(snapshot.signerId, payload, snapshot.signature)) {
    throw new SyncEngineError(
      "SNAPSHOT_SIGNATURE_INVALID",
      "Snapshot signature does not verify.",
    );
  }
}
