import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createClusterSnapshot,
  createHmacSigner,
  createHmacVerifier,
  type ClusterSnapshot,
} from "@workspace/sync-engine";
import { createClusterId } from "@workspace/opennode-domain";
import { restoreBackup, verifyRestore } from "./backup";
import type { BackupManifest, NodeStoreManifest } from "./backup";

const CLUSTER_ID = createClusterId("test-cluster");
const CORRECT_SECRET = "node-a-secret-key-12345678901234567890123456789012";
const WRONG_SECRET = "node-a-secret-key-00000000000000000000000000000000";
const SIGNER_ID = "node-a";

const nodeStoreManifest: NodeStoreManifest = {
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  tableCount: 0,
  rowCount: 0,
  checksum: "node-store-checksum",
};

function buildManifest(
  overrides: {
    readonly signerId?: string;
    readonly secret?: string;
    readonly clusterIdValue?: string;
    readonly height?: number;
    readonly epoch?: number;
    readonly approved?: boolean;
  } = {}
): BackupManifest {
  const signer = createHmacSigner(overrides.signerId ?? SIGNER_ID, overrides.secret ?? CORRECT_SECRET);
  const syncSnapshot: ClusterSnapshot = createClusterSnapshot({
    clusterId: createClusterId(overrides.clusterIdValue ?? CLUSTER_ID.value),
    membershipEpoch: overrides.epoch ?? 1,
    height: overrides.height ?? 0,
    tipHash: null,
    entryHashes: [],
    approved: overrides.approved ?? true,
    signer,
  });
  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    nodeStoreManifest,
    syncSnapshot,
    combinedChecksum: "combined-checksum",
  };
}

async function writeManifest(manifest: BackupManifest): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opennode-backup-"));
  const path = join(dir, "backup-manifest-test.json");
  await writeFile(path, JSON.stringify(manifest, null, 2));
  return path;
}

function restoreStore() {
  const restoreFromFile = vi.fn(async () => nodeStoreManifest);
  return { restoreFromFile, store: { restoreFromFile } };
}

describe("restoreBackup", () => {
  it("aborts before the destructive restore when the snapshot signature does not verify", async () => {
    const backupPath = await writeManifest(buildManifest({ secret: WRONG_SECRET }));
    const verifier = createHmacVerifier({ [SIGNER_ID]: CORRECT_SECRET });
    const { restoreFromFile, store } = restoreStore();
    const reDeriveLocalIdentity = vi.fn(async () => {});

    await expect(
      restoreBackup({
        backupPath,
        clusterId: CLUSTER_ID.value,
        verifier,
        nodeStore: store,
        getCurrentState: async () => ({ height: 0, membershipEpoch: 1 }),
        getReadiness: async () => ({ quiesced: true, advertisingCapacity: false }),
        reDeriveLocalIdentity,
      })
    ).rejects.toThrow(/verif|abort/i);

    expect(restoreFromFile).not.toHaveBeenCalled();
    expect(reDeriveLocalIdentity).not.toHaveBeenCalled();
  });

  it("refuses to restore unless the node is quiesced and not advertising capacity", async () => {
    const verifier = createHmacVerifier({ [SIGNER_ID]: CORRECT_SECRET });
    const base = {
      clusterId: CLUSTER_ID.value,
      verifier,
      getCurrentState: async () => ({ height: 0, membershipEpoch: 1 }),
      reDeriveLocalIdentity: async () => {},
    };

    const notQuiesced = restoreStore();
    const backupPath = await writeManifest(buildManifest());
    await expect(
      restoreBackup({
        ...base,
        backupPath,
        nodeStore: notQuiesced.store,
        getReadiness: async () => ({ quiesced: false, advertisingCapacity: false }),
      })
    ).rejects.toThrow(/quiesc/i);
    expect(notQuiesced.restoreFromFile).not.toHaveBeenCalled();

    const stillAdvertising = restoreStore();
    await expect(
      restoreBackup({
        ...base,
        backupPath,
        nodeStore: stillAdvertising.store,
        getReadiness: async () => ({ quiesced: true, advertisingCapacity: true }),
      })
    ).rejects.toThrow(/capacity/i);
    expect(stillAdvertising.restoreFromFile).not.toHaveBeenCalled();
  });

  it("restores the payload then re-derives the local identity locally", async () => {
    const backupPath = await writeManifest(buildManifest());
    const verifier = createHmacVerifier({ [SIGNER_ID]: CORRECT_SECRET });
    const { restoreFromFile, store } = restoreStore();
    const order: string[] = [];
    restoreFromFile.mockImplementation(async () => {
      order.push("restore");
      return nodeStoreManifest;
    });
    const reDeriveLocalIdentity = vi.fn(async () => {
      order.push("re-derive");
    });

    await restoreBackup({
      backupPath,
      clusterId: CLUSTER_ID.value,
      verifier,
      nodeStore: store,
      getCurrentState: async () => ({ height: 0, membershipEpoch: 1 }),
      getReadiness: async () => ({ quiesced: true, advertisingCapacity: false }),
      reDeriveLocalIdentity,
    });

    expect(restoreFromFile).toHaveBeenCalledTimes(1);
    expect(reDeriveLocalIdentity).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["restore", "re-derive"]);
  });

  it("refuses a restore whose backup belongs to a different cluster", async () => {
    const backupPath = await writeManifest(buildManifest({ clusterIdValue: "another-cluster" }));
    const verifier = createHmacVerifier({ [SIGNER_ID]: CORRECT_SECRET });
    const { restoreFromFile, store } = restoreStore();

    await expect(
      restoreBackup({
        backupPath,
        clusterId: CLUSTER_ID.value,
        verifier,
        nodeStore: store,
        getCurrentState: async () => ({ height: 0, membershipEpoch: 1 }),
        getReadiness: async () => ({ quiesced: true, advertisingCapacity: false }),
        reDeriveLocalIdentity: async () => {},
      })
    ).rejects.toThrow(/cluster|abort/i);

    expect(restoreFromFile).not.toHaveBeenCalled();
  });

  it("applies the destructive restore exactly once on a fully verified backup", async () => {
    const backupPath = await writeManifest(buildManifest());
    const verifier = createHmacVerifier({ [SIGNER_ID]: CORRECT_SECRET });
    const { restoreFromFile, store } = restoreStore();

    const manifest = await restoreBackup({
      backupPath,
      clusterId: CLUSTER_ID.value,
      verifier,
      nodeStore: store,
      getCurrentState: async () => ({ height: 0, membershipEpoch: 1 }),
      getReadiness: async () => ({ quiesced: true, advertisingCapacity: false }),
      reDeriveLocalIdentity: async () => {},
    });

    expect(restoreFromFile).toHaveBeenCalledTimes(1);
    expect(restoreFromFile).toHaveBeenCalledWith(backupPath.replace("backup-manifest-", "node-store-").replace(".json", ".bak"));
    expect(manifest.syncSnapshot.clusterId.value).toBe(CLUSTER_ID.value);
  });
});

describe("verifyRestore", () => {
  const liveState = async () => ({ height: 0, membershipEpoch: 1 });

  it("verifies against the real cluster key material, never a placeholder", async () => {
    const manifest = buildManifest();

    const valid = await verifyRestore(manifest, liveState, {
      clusterId: CLUSTER_ID,
      verifier: createHmacVerifier({ [SIGNER_ID]: CORRECT_SECRET }),
    });
    expect(valid.success).toBe(true);
    expect(valid.snapshotValid).toBe(true);

    const forged = await verifyRestore(manifest, liveState, {
      clusterId: CLUSTER_ID,
      verifier: createHmacVerifier({ [SIGNER_ID]: WRONG_SECRET }),
    });
    expect(forged.success).toBe(false);
    expect(forged.snapshotValid).toBe(false);
  });

  it("reports a consensus height/epoch mismatch against the live cluster", async () => {
    const manifest = buildManifest({ height: 0, epoch: 1 });
    const result = await verifyRestore(manifest, async () => ({ height: 5, membershipEpoch: 2 }), {
      clusterId: CLUSTER_ID,
      verifier: createHmacVerifier({ [SIGNER_ID]: CORRECT_SECRET }),
    });

    expect(result.success).toBe(false);
    expect(result.heightMatch).toBe(false);
    expect(result.epochMatch).toBe(false);
    expect(result.snapshotValid).toBe(true);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a snapshot carrying an unsupported schema version", async () => {
    const base = buildManifest();
    const tampered = {
      ...base,
      syncSnapshot: { ...base.syncSnapshot, schemaVersion: 999 },
    } as unknown as BackupManifest;

    const result = await verifyRestore(tampered, liveState, {
      clusterId: CLUSTER_ID,
      verifier: createHmacVerifier({ [SIGNER_ID]: CORRECT_SECRET }),
    });

    expect(result.success).toBe(false);
    expect(result.snapshotValid).toBe(false);
  });
});
