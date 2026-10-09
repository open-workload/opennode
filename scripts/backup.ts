import { DrizzleNodeStore } from "@workspace/node-store";
import {
  EventLog,
  createInMemoryEventLogStore,
  createHmacSigner,
  createHmacVerifier,
  type ClusterSnapshot,
  type Signer,
  type SignatureVerifier,
} from "@workspace/sync-engine";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ClusterId, SCHEMA_VERSION } from "@workspace/opennode-domain";
import { merkleRoot, sha256Hex, stableStringify } from "@workspace/sync-engine/hash";

export interface BackupConfig {
  readonly outputDir: string;
  readonly clusterId: string;
  readonly signerId: string;
  readonly secretKey: string;
  readonly membershipEpoch: number;
  readonly eventLogHeight: number;
  readonly tipHash: string | null;
  readonly entryHashes: readonly string[];
  readonly approved: boolean;
}

export interface RestoreConfig {
  readonly backupPath: string;
  readonly clusterId: string;
  readonly verifier: SignatureVerifier;
  readonly requireApproved?: boolean;
}

export interface BackupManifest {
  readonly version: number;
  readonly createdAt: string;
  readonly nodeStoreManifest: {
    readonly version: number;
    readonly createdAt: string;
    readonly tableCount: number;
    readonly rowCount: number;
    readonly checksum: string;
  };
  readonly syncSnapshot: ClusterSnapshot;
  readonly combinedChecksum: string;
}

export interface RestoreVerification {
  readonly success: boolean;
  readonly currentHeight: number;
  readonly backupHeight: number;
  readonly heightMatch: boolean;
  readonly currentEpoch: number;
  readonly backupEpoch: number;
  readonly epochMatch: boolean;
  readonly snapshotValid: boolean;
  readonly errors: string[];
}

function computeCombinedChecksum(nodeStoreManifest: BackupManifest["nodeStoreManifest"], syncSnapshot: ClusterSnapshot): string {
  return sha256Hex(
    stableStringify({
      nodeStoreChecksum: nodeStoreManifest.checksum,
      snapshotId: syncSnapshot.snapshotId,
      snapshotHeight: syncSnapshot.height,
      snapshotMerkleRoot: syncSnapshot.merkleRoot,
    })
  );
}

export async function createBackup(config: BackupConfig): Promise<BackupManifest> {
  await mkdir(config.outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const nodeStoreBackupPath = `${config.outputDir}/node-store-${timestamp}.bak`;
  const syncSnapshotPath = `${config.outputDir}/sync-snapshot-${timestamp}.json`;

  const nodeStore = new DrizzleNodeStore();
  const nodeStoreManifest = await nodeStore.backupToFile(nodeStoreBackupPath);

  const signer = createHmacSigner(config.signerId, config.secretKey);
  const clusterId = new ClusterId(config.clusterId);

  const syncSnapshot = createSyncSnapshot({
    clusterId,
    membershipEpoch: config.membershipEpoch,
    height: config.eventLogHeight,
    tipHash: config.tipHash,
    entryHashes: config.entryHashes,
    approved: config.approved,
    signer,
  });

  await writeFile(syncSnapshotPath, JSON.stringify(syncSnapshot, null, 2));

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    nodeStoreManifest,
    syncSnapshot,
    combinedChecksum: computeCombinedChecksum(nodeStoreManifest, syncSnapshot),
  };

  const manifestPath = `${config.outputDir}/backup-manifest-${timestamp}.json`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return manifest;
}

function createSyncSnapshot(input: {
  readonly clusterId: ClusterId;
  readonly membershipEpoch: number;
  readonly height: number;
  readonly tipHash: string | null;
  readonly entryHashes: readonly string[];
  readonly approved: boolean;
  readonly signer: Signer;
}): ClusterSnapshot {
  if (!Number.isSafeInteger(input.height) || input.height < 0) {
    throw new Error("Snapshot height must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(input.membershipEpoch) || input.membershipEpoch < 0) {
    throw new Error("Snapshot membership epoch must be a non-negative safe integer.");
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
    })
  );
  const payload = stableStringify({
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

export async function restoreBackup(config: RestoreConfig): Promise<BackupManifest> {
  const raw = await readFile(config.backupPath, "utf8");
  const manifest = JSON.parse(raw) as BackupManifest;

  const nodeStore = new DrizzleNodeStore();
  await nodeStore.restoreFromFile(config.backupPath.replace("backup-manifest-", "node-store-").replace(".json", ".bak"));

  verifySnapshot(manifest.syncSnapshot, {
    clusterId: new ClusterId(config.clusterId),
    verifier: config.verifier,
    requireApproved: config.requireApproved,
  });

  return manifest;
}

export async function verifyRestore(
  manifest: BackupManifest,
  getCurrentState: () => Promise<{ height: number; membershipEpoch: number }>
): Promise<RestoreVerification> {
  const errors: string[] = [];
  const currentState = await getCurrentState();

  const heightMatch = manifest.syncSnapshot.height === currentState.height;
  const epochMatch = manifest.syncSnapshot.membershipEpoch === currentState.membershipEpoch;

  if (!heightMatch) {
    errors.push(
      `Height mismatch: backup has height ${manifest.syncSnapshot.height}, current consensus is at ${currentState.height}`
    );
  }
  if (!epochMatch) {
    errors.push(
      `Epoch mismatch: backup has epoch ${manifest.syncSnapshot.membershipEpoch}, current consensus is at ${currentState.membershipEpoch}`
    );
  }

  let snapshotValid = false;
  try {
    const { createHmacVerifier } = await import("@workspace/sync-engine");
    const verifier = createHmacVerifier({ [manifest.syncSnapshot.signerId]: "dummy" });
    verifySnapshot(manifest.syncSnapshot, {
      clusterId: manifest.syncSnapshot.clusterId,
      verifier,
      requireApproved: true,
    });
    snapshotValid = true;
  } catch (err) {
    errors.push(`Snapshot verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    success: errors.length === 0,
    currentHeight: currentState.height,
    backupHeight: manifest.syncSnapshot.height,
    heightMatch,
    currentEpoch: currentState.membershipEpoch,
    backupEpoch: manifest.syncSnapshot.membershipEpoch,
    epochMatch,
    snapshotValid,
    errors,
  };
}

function verifySnapshot(
  snapshot: ClusterSnapshot,
  opts: {
    readonly clusterId: ClusterId;
    readonly verifier: SignatureVerifier;
    readonly requireApproved?: boolean;
  }
): void {
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Snapshot schema version is not supported.");
  }
  if (snapshot.clusterId.value !== opts.clusterId.value) {
    throw new Error("Snapshot belongs to a different cluster.");
  }
  if (!Number.isSafeInteger(snapshot.height) || snapshot.height < 0) {
    throw new Error("Snapshot height must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(snapshot.membershipEpoch) || snapshot.membershipEpoch < 0) {
    throw new Error("Snapshot membership epoch must be a non-negative safe integer.");
  }
  if (opts.requireApproved !== false && snapshot.approved !== true) {
    throw new Error("Snapshot is not marked approved by consensus.");
  }
  const payload = stableStringify({
    schemaVersion: snapshot.schemaVersion,
    clusterId: snapshot.clusterId,
    snapshotId: snapshot.snapshotId,
    membershipEpoch: snapshot.membershipEpoch,
    height: snapshot.height,
    tipHash: snapshot.tipHash,
    merkleRoot: snapshot.merkleRoot,
    approved: snapshot.approved,
  });
  if (!opts.verifier.verify(snapshot.signerId, payload, snapshot.signature)) {
    throw new Error("Snapshot signature does not verify.");
  }
}

export async function listBackups(backupDir: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(backupDir);
    return files
      .filter((f) => f.startsWith("backup-manifest-") && f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function getLatestBackupPath(backupDir: string): Promise<string | null> {
  const backups = await listBackups(backupDir);
  if (backups.length === 0) return null;
  return `${backupDir}/${backups[0]}`;
}