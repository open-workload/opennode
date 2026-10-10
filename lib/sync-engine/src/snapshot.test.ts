import { describe, it, expect } from "vitest";
import { createClusterId } from "@workspace/opennode-domain";
import { SyncEngineError, type SyncEngineErrorCode } from "./errors";
import { sha256Hex } from "./hash";
import { createHmacSigner, createHmacVerifier, type Signer } from "./signing";
import {
  createClusterSnapshot,
  snapshotPayload,
  verifySnapshot,
  type ClusterSnapshot,
} from "./snapshot";

const SIGNER_ID = "node-a";
const SECRET = "test-secret";
const CLUSTER = "cluster-1";

function createFixtures() {
  const signer = createHmacSigner(SIGNER_ID, SECRET);
  const verifier = createHmacVerifier({ [SIGNER_ID]: SECRET });
  const clusterId = createClusterId(CLUSTER);
  const snapshot = createClusterSnapshot({
    clusterId,
    membershipEpoch: 1,
    height: 2,
    tipHash: sha256Hex("tip"),
    entryHashes: [sha256Hex("entry-0"), sha256Hex("entry-1")],
    approved: true,
    signer,
  });
  return { signer, verifier, clusterId, snapshot };
}

function resign(
  mutated: ClusterSnapshot,
  signer: Signer,
): ClusterSnapshot {
  return {
    ...mutated,
    signature: signer.sign(snapshotPayload(mutated)),
  };
}

function snapshotErrorCode(
  candidate: ClusterSnapshot,
  opts: Parameters<typeof verifySnapshot>[1],
): SyncEngineErrorCode | undefined {
  try {
    verifySnapshot(candidate, opts);
    return undefined;
  } catch (error) {
    if (error instanceof SyncEngineError) return error.code;
    throw error;
  }
}

describe("verifySnapshot stale snapshots", () => {
  it("accepts a well-formed approved snapshot", () => {
    const { verifier, clusterId, snapshot } = createFixtures();
    expect(
      snapshotErrorCode(snapshot, { clusterId, verifier }),
    ).toBeUndefined();
  });

  it("rejects an unsupported snapshot schema version (snapshot.ts:119)", () => {
    const { signer, verifier, clusterId, snapshot } = createFixtures();
    const version2 = {
      ...snapshot,
      schemaVersion: 2,
    } as unknown as ClusterSnapshot;
    const candidate = resign(version2, signer);
    expect(snapshotErrorCode(candidate, { clusterId, verifier })).toBe(
      "SCHEMA_VERSION_MISMATCH",
    );
  });

  it("rejects a snapshot from a different cluster (snapshot.ts:125)", () => {
    const { signer, verifier, clusterId } = createFixtures();
    const otherCluster = createClusterId("cluster-2");
    const candidate = createClusterSnapshot({
      clusterId: otherCluster,
      membershipEpoch: 1,
      height: 2,
      tipHash: sha256Hex("tip"),
      entryHashes: [sha256Hex("entry-0"), sha256Hex("entry-1")],
      approved: true,
      signer,
    });
    expect(snapshotErrorCode(candidate, { clusterId, verifier })).toBe(
      "WRONG_CLUSTER",
    );
  });

  it("rejects a snapshot that is not approved by consensus (snapshot.ts:146)", () => {
    const { signer, verifier, clusterId } = createFixtures();
    const candidate = createClusterSnapshot({
      clusterId,
      membershipEpoch: 1,
      height: 2,
      tipHash: sha256Hex("tip"),
      entryHashes: [sha256Hex("entry-0"), sha256Hex("entry-1")],
      approved: false,
      signer,
    });
    expect(snapshotErrorCode(candidate, { clusterId, verifier })).toBe(
      "SNAPSHOT_UNAPPROVED",
    );
  });

  it("allows an unapproved snapshot when approval is not required", () => {
    const { signer, verifier, clusterId } = createFixtures();
    const candidate = createClusterSnapshot({
      clusterId,
      membershipEpoch: 1,
      height: 2,
      tipHash: sha256Hex("tip"),
      entryHashes: [sha256Hex("entry-0"), sha256Hex("entry-1")],
      approved: false,
      signer,
    });
    expect(
      snapshotErrorCode(candidate, {
        clusterId,
        verifier,
        requireApproved: false,
      }),
    ).toBeUndefined();
  });

  it("rejects a tampered snapshot signature (snapshot.ts:153)", () => {
    const { verifier, clusterId, snapshot } = createFixtures();
    const candidate = {
      ...snapshot,
      signature: "00".repeat(32),
    } as ClusterSnapshot;
    expect(snapshotErrorCode(candidate, { clusterId, verifier })).toBe(
      "SNAPSHOT_SIGNATURE_INVALID",
    );
  });

  it("rejects a snapshot with a negative height (snapshot.ts:131)", () => {
    const { signer, verifier, clusterId, snapshot } = createFixtures();
    const candidate = resign(
      { ...snapshot, height: -1 } as unknown as ClusterSnapshot,
      signer,
    );
    expect(snapshotErrorCode(candidate, { clusterId, verifier })).toBe(
      "SNAPSHOT_INVALID",
    );
  });

  it("rejects a snapshot with a negative membership epoch (snapshot.ts:137)", () => {
    const { signer, verifier, clusterId, snapshot } = createFixtures();
    const candidate = resign(
      { ...snapshot, membershipEpoch: -1 } as unknown as ClusterSnapshot,
      signer,
    );
    expect(snapshotErrorCode(candidate, { clusterId, verifier })).toBe(
      "SNAPSHOT_INVALID",
    );
  });
});

describe("verifySnapshot protocol downgrade", () => {
  it("rejects a downgraded snapshot schema version (snapshot.ts:119)", () => {
    const { signer, verifier, clusterId, snapshot } = createFixtures();
    const version0 = {
      ...snapshot,
      schemaVersion: 0,
    } as unknown as ClusterSnapshot;
    const candidate = resign(version0, signer);
    expect(snapshotErrorCode(candidate, { clusterId, verifier })).toBe(
      "SCHEMA_VERSION_MISMATCH",
    );
  });
});
