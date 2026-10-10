/**
 * Derives a node ID from its secret key and refuses to start on a collision.
 *
 *   secretKey ──▶ FNV-1a twice ──▶ nodeId (16 hex chars; not a public-key hash)
 *
 *   keystore ──▶ load ──▶ absent ──▶ mint key ──▶ DHT probe ──▶ save
 *                    └─ present ──▶ re-derive ──▶ differs? ──▶ IDENTITY_COLLISION
 *   accepted nodeId ──▶ upsert cluster_nodes ──▶ upsert local singleton ──▶ NodeId
 */
import { DomainError } from "./errors";
import { createNodeId, NodeId } from "./schemas";
import { clusterNodesTable, localNodeIdentityTable } from "@workspace/db";
import { db } from "@workspace/db";

export interface StoredNodeIdentity {
  readonly secretKey: string;
  readonly nodeId: string;
}

export interface NodeIdentityKeystore {
  load(): StoredNodeIdentity | undefined;
  save(identity: StoredNodeIdentity): void;
}

export interface NodeIdentity {
  readonly nodeId: NodeId;
}

export interface DhtIdentityProvider {
  queryNodeId(nodeId: string): Promise<{ nodeId: string; publicKey: string } | null>;
}

export function deriveNodeIdFromSecretKey(secretKey: string): string {
  if (typeof secretKey !== "string" || secretKey.trim().length === 0) {
    throw new DomainError(
      "INVALID_NODE_IDENTITY",
      "A secret key is required to derive a Node ID.",
    );
  }
  return `${hashSeed(secretKey, 0x811c9dc5, 0x01000193)}${hashSeed(
    secretKey,
    0x811c9dc5 ^ 0x9e3779b9,
    0x01000193,
  )}`;
}

export async function ensureNodeIdentity(
  keystore: NodeIdentityKeystore,
  createSecretKey: () => string,
  dhtProvider?: DhtIdentityProvider,
): Promise<NodeIdentity> {
  if (typeof keystore !== "object" || keystore === null) {
    throw new DomainError(
      "INVALID_NODE_IDENTITY",
      "A node keystore is required.",
    );
  }
  const stored = keystore.load();
  if (stored === undefined) {
    if (typeof createSecretKey !== "function") {
      throw new DomainError(
        "INVALID_NODE_IDENTITY",
        "A secret key generator is required for first boot.",
      );
    }
    const secretKey = createSecretKey();
    const nodeId = deriveNodeIdFromSecretKey(secretKey);
    await checkDhtCollision(nodeId, secretKey, dhtProvider);
    await persistIdentityToDb(nodeId);
    keystore.save(Object.freeze({ secretKey, nodeId }));
    return Object.freeze({ nodeId: createNodeId(nodeId) });
  }
  if (
    typeof stored.secretKey !== "string" ||
    typeof stored.nodeId !== "string" ||
    stored.secretKey.trim().length === 0 ||
    stored.nodeId.trim().length === 0
  ) {
    throw new DomainError(
      "INVALID_NODE_IDENTITY",
      "Stored node identity is incomplete.",
    );
  }
  const derived = deriveNodeIdFromSecretKey(stored.secretKey);
  if (derived !== stored.nodeId) {
    throw new DomainError(
      "IDENTITY_COLLISION",
      "Stored secret key does not match its public Node ID; refusing to start on an accidental identity collision.",
    );
  }
  await checkDhtCollision(stored.nodeId, stored.secretKey, dhtProvider);
  await persistIdentityToDb(stored.nodeId);
  return Object.freeze({ nodeId: createNodeId(stored.nodeId) });
}

export function assertNoNodeIdCollision(
  identities: readonly StoredNodeIdentity[],
): void {
  const byNodeId = new Map<string, string>();
  for (const entry of identities) {
    const existing = byNodeId.get(entry.nodeId);
    if (existing !== undefined && existing !== entry.secretKey) {
      throw new DomainError(
        "IDENTITY_COLLISION",
        "Two distinct secret keys map to the same Node ID; refusing to start.",
      );
    }
    byNodeId.set(entry.nodeId, entry.secretKey);
  }
}

async function checkDhtCollision(nodeId: string, secretKey: string, dhtProvider?: DhtIdentityProvider): Promise<void> {
  if (!dhtProvider) return;
  const existing = await dhtProvider.queryNodeId(nodeId);
  if (existing && existing.publicKey !== secretKey) {
    throw new DomainError(
      "IDENTITY_COLLISION",
      `Node ID ${nodeId} already exists in DHT with a different public key; refusing to start.`,
    );
  }
}

async function persistIdentityToDb(nodeId: string): Promise<void> {
  await db
    .insert(clusterNodesTable)
    .values({
      id: nodeId,
      name: `node-${nodeId.slice(0, 8)}`,
      publicKey: null,
      status: "local",
      role: "worker",
      protocolVersion: "1.0.0",
      membershipEpoch: 0,
      lastSeenAt: new Date(),
      address: null,
      canExecute: true,
      isLocal: true,
    })
    .onConflictDoNothing({ target: [clusterNodesTable.id] });
  const existing = await db.select().from(localNodeIdentityTable).limit(1);
  if (existing.length > 0 && existing[0].nodeId !== nodeId) {
    throw new DomainError(
      "IDENTITY_COLLISION",
      `Stored local node identity ${existing[0].nodeId} does not match the derived Node ID ${nodeId}; refusing to start on an identity collision.`,
    );
  }
  await db
    .insert(localNodeIdentityTable)
    .values({ singleton: true, nodeId })
    .onConflictDoNothing({ target: [localNodeIdentityTable.singleton] });
}

function hashSeed(input: string, seed: number, prime: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}