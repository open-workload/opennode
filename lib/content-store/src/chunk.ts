import { Encryptor, EncryptedData } from "./encryption";
import { contentAddress, verifyChecksum, sha256Hex } from "./hash";
import { ContentStoreError } from "./errors";

export interface StreamChunkMetadata {
  readonly attemptId: string;
  readonly streamType: string;
  readonly timestamp: number;
  readonly checksum: string;
  readonly size: number;
  readonly encryption: {
    readonly algorithm: string;
    readonly iv: string;
    readonly authTag: string;
  };
}

export interface ChunkRef {
  readonly address: string;
  readonly metadata: StreamChunkMetadata;
}

export interface ChunkPayload {
  readonly data: Uint8Array;
  readonly metadata: StreamChunkMetadata;
}

export interface StoredChunk {
  readonly address: string;
  readonly encryptedData: EncryptedData;
  readonly metadata: StreamChunkMetadata;
}

export interface ChunkStore {
  put(chunk: StoredChunk): Promise<void>;
  get(address: string): Promise<StoredChunk | undefined>;
  delete(address: string): Promise<void>;
  has(address: string): Promise<boolean>;
}

export interface ChunkerOptions {
  readonly encryptor: Encryptor;
  readonly key: Uint8Array;
  readonly maxChunkSize?: number;
}

export function createChunker(opts: ChunkerOptions) {
  const { encryptor, key, maxChunkSize = 1024 * 1024 } = opts;

  return {
    async chunk(data: Uint8Array, attemptId: string, streamType: string): Promise<StoredChunk> {
      if (data.length > maxChunkSize) {
        throw new ContentStoreError("CHUNK_TOO_LARGE", `Chunk size ${data.length} exceeds maximum ${maxChunkSize}`);
      }

      const checksum = contentAddress(data);
      const timestamp = Date.now();
      const size = data.length;

      const encrypted = await encryptor.encrypt(data, key);

      const metadata: StreamChunkMetadata = {
        attemptId,
        streamType,
        timestamp,
        checksum,
        size,
        encryption: {
          algorithm: encrypted.algorithm,
          iv: Buffer.from(encrypted.iv).toString("hex"),
          authTag: Buffer.from(encrypted.authTag).toString("hex"),
        },
      };

      const address = contentAddress(encrypted.ciphertext);

      return Object.freeze({
        address,
        encryptedData: encrypted,
        metadata: Object.freeze(metadata),
      });
    },

    async unchunk(stored: StoredChunk): Promise<ChunkPayload> {
      const decrypted = await opts.encryptor.decrypt(stored.encryptedData, key);

      if (!verifyChecksum(decrypted, stored.metadata.checksum)) {
        throw new ContentStoreError("CHECKSUM_MISMATCH", `Checksum mismatch for chunk ${stored.address}`);
      }

      return Object.freeze({
        data: decrypted,
        metadata: stored.metadata,
      });
    },

    createRef(stored: StoredChunk): ChunkRef {
      return Object.freeze({
        address: stored.address,
        metadata: stored.metadata,
      });
    },

    verifyRef(ref: ChunkRef, expectedChecksum?: string): boolean {
      if (expectedChecksum && ref.metadata.checksum !== expectedChecksum) {
        return false;
      }
      return true;
    },
  };
}

export function computeChunkAddress(encryptedData: EncryptedData): string {
  return contentAddress(encryptedData.ciphertext);
}

export function encodeStreamMetadata(metadata: StreamChunkMetadata): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(metadata));
}

export function decodeStreamMetadata(data: Uint8Array): StreamChunkMetadata {
  return JSON.parse(new TextDecoder().decode(data)) as StreamChunkMetadata;
}