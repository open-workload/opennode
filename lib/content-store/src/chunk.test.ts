import { describe, it, expect } from "vitest";
import { createChunker } from "./chunk";
import { createStubEncryptor } from "./encryption";
import { InMemoryChunkStore } from "./store";
import { readStream } from "./stream";

const key = new Uint8Array(32);

function makeChunker() {
  return createChunker({ encryptor: createStubEncryptor(), key });
}

describe("chunker.verifyRef", () => {
  it("fails closed when no expected address is supplied", async () => {
    const chunker = makeChunker();
    const stored = await chunker.chunk(new Uint8Array([1, 2, 3]), "attempt-1", "logs");

    // @ts-expect-error the expected address is required for verification
    expect(chunker.verifyRef(stored)).toBe(false);
  });

  it("rejects a tampered chunk whose metadata is unchanged", async () => {
    const chunker = makeChunker();
    const stored = await chunker.chunk(new Uint8Array([1, 2, 3]), "attempt-1", "logs");
    const tampered = {
      ...stored,
      encryptedData: { ...stored.encryptedData, ciphertext: new Uint8Array([9, 9, 9]) },
    };

    expect(chunker.verifyRef(tampered, stored.address)).toBe(false);
  });

  it("verifies an intact chunk against its requested address", async () => {
    const chunker = makeChunker();
    const stored = await chunker.chunk(new Uint8Array([1, 2, 3]), "attempt-1", "logs");

    expect(chunker.verifyRef(stored, stored.address)).toBe(true);
  });

  it("readStream rejects a chunk whose ciphertext was tampered", async () => {
    const chunker = makeChunker();
    const store = new InMemoryChunkStore();
    const stored = await chunker.chunk(new Uint8Array([1, 2, 3]), "attempt-1", "logs");
    await store.put({
      ...stored,
      encryptedData: { ...stored.encryptedData, ciphertext: new Uint8Array([9, 9, 9]) },
    });

    const drain = async () => {
      for await (const _chunk of readStream({
        attemptId: "attempt-1",
        streamType: "logs",
        chunker,
        store,
        chunkRefs: [chunker.createRef(stored)],
      })) {
        // drain the reader so the integrity check runs
      }
    };

    await expect(drain()).rejects.toThrow("Checksum mismatch");
  });
});
