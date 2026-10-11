/**
 * Cluster backup and pre-verified restore.
 *
 *   createBackup ──▶ node-store dump + signed sync snapshot ──▶ manifest
 *
 *   restoreBackup ──▶ read manifest
 *        │
 *        ├─ readiness guard: quiesced, not advertising capacity
 *        ├─ verifyRestore: signature + cluster id + schema + height/epoch
 *        │        └─ any mismatch ──▶ abort, node untouched
 *        ├─ node-store restore (destructive)   ◀── only after the gate
 *        └─ re-derive local_node_identity locally
 *
 *   verifyRestore verifies against injected real cluster key material,
 *   never a placeholder.
 */
import {
  createClusterSnapshot,
  createHmacSigner,
  sha256Hex,
  stableStringify,
  verifySnapshot,
  type ClusterSnapshot,
  type SignatureVerifier,
} from "@workspace/sync-engine";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createClusterId, type ClusterId } from "@workspace/opennode-domain";

export interface NodeStoreManifest {
  readonly version: number;
  readonly createdAt: string;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly checksum: string;
}

export interface BackupStore {
  backupToFile(path: string): Promise<NodeStoreManifest>;
}

export interface RestoreStore {
  restoreFromFile(path: string): Promise<NodeStoreManifest>;
}

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
  readonly nodeStore?: BackupStore;
}

export interface RestoreClusterState {
  readonly height: number;
  readonly membershipEpoch: number;
}

export interface RestoreReadiness {
  readonly quiesced: boolean;
  readonly advertisingCapacity: boolean;
}

export interface RestoreConfig {
  readonly backupPath: string;
  readonly clusterId: string;
  readonly verifier: SignatureVerifier;
  readonly requireApproved?: boolean;
  readonly nodeStore?: RestoreStore;
  readonly getCurrentState: () => Promise<RestoreClusterState>;
  readonly getReadiness: () => Promise<RestoreReadiness>;
  readonly reDeriveLocalIdentity: () => Promise<void>;
}

export interface BackupManifest {
  readonly version: number;
  readonly createdAt: string;
  readonly nodeStoreManifest: NodeStoreManifest;
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

function computeCombinedChecksum(nodeStoreManifest: NodeStoreManifest, syncSnapshot: ClusterSnapshot): string {
  return sha256Hex(
    stableStringify({
      nodeStoreChecksum: nodeStoreManifest.checksum,
      snapshotId: syncSnapshot.snapshotId,
      snapshotHeight: syncSnapshot.height,
      snapshotMerkleRoot: syncSnapshot.merkleRoot,
    })
  );
}

async function loadDefaultNodeStore(): Promise<BackupStore & RestoreStore> {
  const { DrizzleNodeStore } = await import("@workspace/node-store");
  return new DrizzleNodeStore();
}

export async function createBackup(config: BackupConfig): Promise<BackupManifest> {
  await mkdir(config.outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const nodeStoreBackupPath = `${config.outputDir}/node-store-${timestamp}.bak`;
  const syncSnapshotPath = `${config.outputDir}/sync-snapshot-${timestamp}.json`;

  const nodeStore = config.nodeStore ?? (await loadDefaultNodeStore());
  const nodeStoreManifest = await nodeStore.backupToFile(nodeStoreBackupPath);

  const signer = createHmacSigner(config.signerId, config.secretKey);
  const clusterId = createClusterId(config.clusterId);

  const syncSnapshot = createClusterSnapshot({
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

function toNodeStoreBackupPath(backupPath: string): string {
  return backupPath.replace("backup-manifest-", "node-store-").replace(".json", ".bak");
}

export async function restoreBackup(config: RestoreConfig): Promise<BackupManifest> {
  const raw = await readFile(config.backupPath, "utf8");
  const manifest = JSON.parse(raw) as BackupManifest;

  await assertRestoreAllowed(config.getReadiness);

  const verification = await verifyRestore(manifest, config.getCurrentState, {
    clusterId: createClusterId(config.clusterId),
    verifier: config.verifier,
    requireApproved: config.requireApproved,
  });
  if (!verification.success) {
    throw new Error(`Restore aborted before applying backup: ${verification.errors.join("; ")}`);
  }

  const nodeStore = config.nodeStore ?? (await loadDefaultNodeStore());
  await nodeStore.restoreFromFile(toNodeStoreBackupPath(config.backupPath));

  await config.reDeriveLocalIdentity();

  return manifest;
}

async function assertRestoreAllowed(getReadiness: () => Promise<RestoreReadiness>): Promise<void> {
  const readiness = await getReadiness();
  if (!readiness.quiesced) {
    throw new Error("Restore refused: node is not quiesced.");
  }
  if (readiness.advertisingCapacity) {
    throw new Error("Restore refused: node is still advertising capacity.");
  }
}

export async function verifyRestore(
  manifest: BackupManifest,
  getCurrentState: () => Promise<RestoreClusterState>,
  keyMaterial: {
    readonly clusterId: ClusterId;
    readonly verifier: SignatureVerifier;
    readonly requireApproved?: boolean;
  }
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
    verifySnapshot(manifest.syncSnapshot, {
      clusterId: keyMaterial.clusterId,
      verifier: keyMaterial.verifier,
      requireApproved: keyMaterial.requireApproved,
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
