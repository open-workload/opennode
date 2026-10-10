import { describe, it, expect } from "vitest";
import { InMemoryChunkStore } from "./store";
import { pruneExpiredChunks, DEFAULT_CHUNK_RETENTION_POLICY } from "./retention";
import type { StoredChunk } from "./chunk";

function makeChunk(address: string, timestamp: number): StoredChunk {
  return {
    address,
    encryptedData: {
      ciphertext: new Uint8Array([1, 2, 3]),
      iv: new Uint8Array(12),
      authTag: new Uint8Array(16),
      algorithm: "aes-256-gcm",
    },
    metadata: {
      attemptId: "attempt-1",
      streamType: "logs",
      timestamp,
      checksum: address,
      size: 3,
      encryption: { algorithm: "aes-256-gcm", iv: "00", authTag: "00" },
    },
  };
}

describe("chunk retention", () => {
  it("deletes chunks older than the retention window and keeps fresh ones", async () => {
    const store = new InMemoryChunkStore();
    const now = 1_000_000_000_000;
    const oldAddress = "old-chunk";
    const freshAddress = "fresh-chunk";

    await store.put(makeChunk(oldAddress, now - DEFAULT_CHUNK_RETENTION_POLICY.ttlMs - 1));
    await store.put(makeChunk(freshAddress, now - 1_000));

    const deleted = await pruneExpiredChunks(store, { now });

    expect(deleted).toBe(1);
    expect(await store.has(oldAddress)).toBe(false);
    expect(await store.has(freshAddress)).toBe(true);
    expect(store.count()).toBe(1);
  });
});
