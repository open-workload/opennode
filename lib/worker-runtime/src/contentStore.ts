/**
 * Per-chunk encryption (each chunk key wrapped by the master key), plus
 * in-memory replication bookkeeping and per-attempt download grants.
 *
 *   plaintext ─▶ chunkKey ─▶ AES-GCM ─▶ ciphertext ─▶ address
 *                  │                       │
 *                  └──── wrapped by master ┘
 *
 *   decrypt ─▶ unwrap (masterKeyId must match) ─▶ checksum ─▶ plaintext | throw
 *
 *   recordReplication ─▶ ReplicationTracker (in-memory Map)
 *   authorize/checkAccess ─▶ DownloadAuthz (jobId:attemptId -> worker set)
 */

import { Encryptor, EncryptedData, createAesGcmEncryptor } from "@workspace/content-store/encryption";
import { contentAddress, verifyChecksum } from "@workspace/content-store/hash";
import { WorkerRuntimeError } from "./errors";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface MasterKey {
  readonly key: Uint8Array;
  readonly id: string;
}

export interface WrappedKey {
  readonly wrappedKey: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly masterKeyId: string;
}

export interface ChunkEncryptionResult {
  readonly encryptedData: EncryptedData;
  readonly wrappedKey: WrappedKey;
  readonly checksum: string;
  readonly address: string;
}

export interface ChunkDecryptionInput {
  readonly encryptedData: EncryptedData;
  readonly wrappedKey: WrappedKey;
  readonly expectedChecksum: string;
}

export interface ContentStoreClientOptions {
  readonly masterKey: MasterKey;
  readonly encryptor?: Encryptor;
  readonly maxChunkSize?: number;
}

export class ContentStoreClient {
  private readonly masterKey: MasterKey;
  private readonly encryptor: Encryptor;
  private readonly maxChunkSize: number;
  private readonly chunkEncryptor: Encryptor;

  constructor(options: ContentStoreClientOptions) {
    this.masterKey = options.masterKey;
    this.encryptor = options.encryptor ?? createAesGcmEncryptor();
    this.chunkEncryptor = createAesGcmEncryptor();
    this.maxChunkSize = options.maxChunkSize ?? 1024 * 1024;
  }

  async encryptChunk(data: Uint8Array): Promise<ChunkEncryptionResult> {
    if (data.length > this.maxChunkSize) {
      throw new WorkerRuntimeError(`Chunk size ${data.length} exceeds maximum ${this.maxChunkSize}`, "chunk_too_large");
    }

    const chunkKey = await this.chunkEncryptor.generateKey();
    const checksum = contentAddress(data);

    const encrypted = await this.chunkEncryptor.encrypt(data, chunkKey);
    const wrappedKey = await this.wrapKey(chunkKey);

    const address = contentAddress(encrypted.ciphertext);

    return {
      encryptedData: encrypted,
      wrappedKey,
      checksum,
      address,
    };
  }

  async decryptChunk(input: ChunkDecryptionInput): Promise<Uint8Array> {
    const chunkKey = await this.unwrapKey(input.wrappedKey);
    const decrypted = await this.chunkEncryptor.decrypt(input.encryptedData, chunkKey);

    if (!verifyChecksum(decrypted, input.expectedChecksum)) {
      throw new WorkerRuntimeError(`Checksum mismatch for chunk`, "checksum_mismatch");
    }

    return decrypted;
  }

  private async wrapKey(key: Uint8Array): Promise<WrappedKey> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey.key, iv);
    const wrapped = Buffer.concat([cipher.update(key), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      wrappedKey: new Uint8Array(wrapped),
      iv,
      authTag: new Uint8Array(authTag),
      masterKeyId: this.masterKey.id,
    };
  }

  private async unwrapKey(wrapped: WrappedKey): Promise<Uint8Array> {
    if (wrapped.masterKeyId !== this.masterKey.id) {
      throw new WorkerRuntimeError(`Master key ID mismatch: expected ${this.masterKey.id}, got ${wrapped.masterKeyId}`, "master_key_mismatch");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey.key, wrapped.iv);
    decipher.setAuthTag(Buffer.from(wrapped.authTag));
    const key = Buffer.concat([decipher.update(Buffer.from(wrapped.wrappedKey)), decipher.final()]);
    return new Uint8Array(key);
  }

  static generateMasterKey(id?: string): MasterKey {
    return {
      key: randomBytes(32),
      id: id ?? `master-${randomBytes(8).toString("hex")}`,
    };
  }
}

export interface ReplicationMetadata {
  readonly chunkAddress: string;
  readonly replicas: readonly ReplicaInfo[];
  readonly replicationFactor: number;
  readonly createdAt: number;
}

export interface ReplicaInfo {
  readonly nodeId: string;
  readonly storedAt: number;
  readonly verified: boolean;
}

export class ReplicationTracker {
  private metadata = new Map<string, ReplicationMetadata>();

  recordReplication(chunkAddress: string, nodeId: string, verified: boolean): void {
    const existing = this.metadata.get(chunkAddress);
    const replica: ReplicaInfo = { nodeId, storedAt: Date.now(), verified };
    const replicas = existing ? [...existing.replicas, replica] : [replica];
    this.metadata.set(chunkAddress, {
      chunkAddress,
      replicas,
      replicationFactor: replicas.length,
      createdAt: existing?.createdAt ?? Date.now(),
    });
  }

  getMetadata(chunkAddress: string): ReplicationMetadata | undefined {
    return this.metadata.get(chunkAddress);
  }

  getReplicas(chunkAddress: string): readonly ReplicaInfo[] {
    return this.metadata.get(chunkAddress)?.replicas ?? [];
  }

  verifyReplica(chunkAddress: string, nodeId: string): void {
    const meta = this.metadata.get(chunkAddress);
    if (meta) {
      const updated = meta.replicas.map((r) => (r.nodeId === nodeId ? { ...r, verified: true } : r));
      this.metadata.set(chunkAddress, { ...meta, replicas: updated });
    }
  }
}

export interface DownloadAuthContext {
  readonly workerNodeId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly chunkAddress: string;
}

export class DownloadAuthz {
  private readonly allowedWorkers = new Map<string, Set<string>>();

  authorize(workerNodeId: string, jobId: string, attemptId: string, chunkAddresses: readonly string[]): void {
    const key = `${jobId}:${attemptId}`;
    if (!this.allowedWorkers.has(key)) this.allowedWorkers.set(key, new Set());
    this.allowedWorkers.get(key)!.add(workerNodeId);
  }

  checkAccess(context: DownloadAuthContext): boolean {
    const key = `${context.jobId}:${context.attemptId}`;
    const allowed = this.allowedWorkers.get(key);
    return allowed?.has(context.workerNodeId) ?? false;
  }

  revokeAccess(jobId: string, attemptId: string): void {
    this.allowedWorkers.delete(`${jobId}:${attemptId}`);
  }
}